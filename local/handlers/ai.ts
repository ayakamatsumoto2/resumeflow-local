/**
 * AI 能力（润色 / JD 分析 / 标签 / 招呼语 / 个人评价 / 文本拆分）。
 * 移植自 backend/app/domain/ai 的 ai_router.py、ai_service.py、jd_analysis_service.py、
 * star_polish_utils.py、response_normalizers.py；模型调用改为从本机直连。
 */
import { badRequest, HttpError, route, type Emit, type LocalRequest, type LocalResult } from '../http';
import { chatJson, type ChatMessage } from '../ai/llm';
import { AI_PROMPTS } from '../ai/prompts.generated';
import { extractAttachmentText } from '../ai/documentText';
import { persistBossGreeting } from './resumes';
import { isPlainObject } from './shared';
import type { Row } from '../store';

type Thought = (event: { type: string; summary?: string }) => void;

const requireText = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new HttpError(422, `缺少参数 ${field}。`);
  return value;
};

/** 统一的流式外壳：先发进度事件，再执行任务，最后发 final。 */
const streamTask = (
  before: Array<[string, string]>,
  after: Array<[string, string]>,
  run: (emit: Emit, signal: AbortSignal) => Promise<Row>,
): LocalResult => ({
  stream: async (emit, signal) => {
    for (const [node, title] of before) emit({ type: 'progress', node, title });
    const result = await run(emit, signal);
    for (const [node, title] of after) emit({ type: 'progress', node, title });
    emit({ type: 'final', result });
  },
});

/* ------------------------------- 润色 ------------------------------- */

const MAX_SMART_COMPLETE_FOLLOW_UP_QUESTIONS = 3;
const DEFAULT_JD_EXTRA_BOLD_LIMIT = 3;
const STAR_KEYS = ['s', 't', 'a', 'r'] as const;
const OFF_SCOPE_TERMS = [
  '其他项目', '其它项目', '非本项目', '非当前项目', '本项目以外', '项目以外', '非该项目',
  '课程项目', '个人练习', '个人项目', '专业背景', '其他案例', '其它案例',
];

export const isOffScopeSmartCompleteQuestion = (question: string): boolean => {
  const normalized = question.replace(/\s+/g, '');
  if (!normalized) return true;
  if (OFF_SCOPE_TERMS.some((term) => normalized.includes(term))) return true;
  if ((normalized.includes('其他') || normalized.includes('其它'))
    && (normalized.includes('项目') || normalized.includes('案例'))) return true;
  return normalized.includes('是否有过任何');
};

const normalizeMode = (mode: unknown) => (typeof mode === 'string' && mode.trim() ? mode.trim().toLowerCase() : 'default');
const isCampusMode = (mode: unknown) => normalizeMode(mode) === 'campus_recruitment';
const isSmartCompleteMode = (mode: unknown) => ['smart_complete', 'smart_completion'].includes(normalizeMode(mode));
const isHighlightMode = (mode: unknown) => ['highlight', 'match_highlight'].includes(normalizeMode(mode));

const stripBoldMarkers = (value: string) => value
  .replace(/(\*\*|＊＊)([^\r\n]+?)\1/g, '$2')
  .replace(/<\/?(?:strong|b)\b[^>]*>/gi, '');

const buildPolishPrompt = (mode: unknown, jdText: unknown, customPrompt: unknown): string => {
  const hasJd = typeof jdText === 'string' && !!jdText.trim();
  const normalized = normalizeMode(mode);
  let base: string;
  if (isCampusMode(mode)) base = AI_PROMPTS.STAR_CAMPUS_RECRUITMENT_REWRITE;
  else if (isSmartCompleteMode(mode)) base = AI_PROMPTS.STAR_SMART_COMPLETE_REWRITE;
  else if (normalized === 'default') base = hasJd ? AI_PROMPTS.STAR_RESUME_READY_REWRITE : AI_PROMPTS.STAR_GENERAL_REWRITE_NO_JD;
  else if (isHighlightMode(mode)) base = hasJd ? AI_PROMPTS.STAR_HIGHLIGHT : AI_PROMPTS.STAR_HIGHLIGHT_NO_JD;
  else base = AI_PROMPTS.STAR_POLISH;
  const parts = [base];
  const skipInstruction = isHighlightMode(mode) || (normalized === 'default' && !hasJd);
  const instruction = skipInstruction
    ? undefined
    : (AI_PROMPTS.POLISH_MODE_INSTRUCTIONS as Record<string, string>)[normalized];
  if (instruction) parts.push(instruction);
  if (typeof customPrompt === 'string' && customPrompt.trim()) {
    parts.push(`Additional user instruction for this rewrite: ${customPrompt.trim()}`);
  }
  return parts.join(' ');
};

const limitDefaultJdExtraBold = (result: Row): Row => {
  let remaining = DEFAULT_JD_EXTRA_BOLD_LIMIT;
  const normalized = { ...result };
  for (const key of STAR_KEYS) {
    const value = normalized[key];
    if (typeof value !== 'string' || !value) continue;
    normalized[key] = value.replace(
      /(\*\*|＊＊)([^\r\n]+?)\1/g,
      (match: string, _marker: string, inner: string, offset: number) => {
        const lineStart = value.lastIndexOf('\n', offset - 1) + 1;
        const isActionLabel = key === 'a'
          && !value.slice(lineStart, offset).trim()
          && /^[一-鿿]{4}$/.test(inner.trim())
          && /^\s*[:：]/.test(value.slice(offset + match.length));
        if (isActionLabel) return match;
        if (remaining > 0) {
          remaining -= 1;
          return match;
        }
        return inner;
      },
    );
  }
  return normalized;
};

const normalizePolishResult = (result: Row, mode: unknown, hasJd: boolean): Row => {
  if (isSmartCompleteMode(mode)) {
    const raw = Array.isArray(result.followUpQuestions)
      ? result.followUpQuestions
      : typeof result.followUpQuestions === 'string' && result.followUpQuestions.trim()
        ? [result.followUpQuestions]
        : [];
    const questions: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const question = item.trim();
      if (!question || isOffScopeSmartCompleteQuestion(question)) continue;
      const key = question.replace(/\s+/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push(question);
      if (questions.length >= MAX_SMART_COMPLETE_FOLLOW_UP_QUESTIONS) break;
    }
    return { ...result, followUpQuestions: questions };
  }
  if (isCampusMode(mode)) {
    const normalized = { ...result };
    if (typeof normalized.a === 'string' && normalized.a) {
      normalized.a = normalized.a.replace(/(^|\n)(\*\*|＊＊)([一-鿿]{4})\2(?=：)/g, '$1$3');
    }
    return normalized;
  }
  if (normalizeMode(mode) === 'default' && hasJd) return limitDefaultJdExtraBold(result);
  return result;
};

const polishExperience = async (payload: Row, signal?: AbortSignal, emitThought?: Thought) => {
  if (!isPlainObject(payload.content)) throw new HttpError(422, '缺少参数 content。');
  const { mode, jd_text: jdText, custom_prompt: customPrompt } = payload;
  const hasJd = typeof jdText === 'string' && !!jdText.trim();
  const content: Row = { ...payload.content };
  if (isCampusMode(mode)) {
    for (const key of STAR_KEYS) {
      if (typeof content[key] === 'string' && content[key]) content[key] = stripBoldMarkers(content[key]);
    }
  }
  if (jdText) content.jd_text = jdText;
  if (mode) content.polish_mode = mode;
  if (customPrompt) content.custom_prompt = customPrompt;
  const result = await chatJson([
    { role: 'system', content: buildPolishPrompt(mode, jdText, customPrompt) },
    { role: 'user', content: JSON.stringify(content) },
  ], { signal, emitThought });
  return normalizePolishResult(result, mode, hasJd);
};

route('POST', '/api/polish-text', async ({ body, signal }) => ({
  json: await polishExperience(isPlainObject(body) ? body : {}, signal),
}));

route('POST', '/api/polish-text/stream', ({ body }) => streamTask(
  [['prepare_context', '准备润色上下文'], ['request_ai', '调用 AI 进行润色']],
  [['persist_result', '整理润色结果']],
  (emit, signal) => polishExperience(isPlainObject(body) ? body : {}, signal, emit),
));

/* ----------------------------- 文本拆分 ----------------------------- */

const splitCache = new Map<string, Row>();

route('POST', '/api/split-experience-text', async ({ body, signal }) => {
  const payload: Row = isPlainObject(body) ? body : {};
  const rawText = requireText(payload.raw_text, 'raw_text');
  if (!rawText.trim()) return { json: { s: '', t: '', a: '', r: '' } };
  const request = {
    raw_text: rawText,
    category: String(payload.category ?? ''),
    org: payload.org || '',
    title: payload.title || '',
  };
  const cacheKey = JSON.stringify(request);
  const cached = splitCache.get(cacheKey);
  if (cached) return { json: { ...cached } };
  const result = await chatJson([
    { role: 'system', content: AI_PROMPTS.STAR_SPLIT_ONLY },
    { role: 'user', content: JSON.stringify(request) },
  ], { signal });
  const normalized: Row = {};
  for (const key of STAR_KEYS) {
    const value = result[key];
    normalized[key] = typeof value === 'string'
      ? value.split(/\r?\n/).map((line) => line.trim())
        .filter((line) => line && !/^\s*-{2,}\s*$/.test(line)).join('\n')
      : '';
  }
  splitCache.set(cacheKey, normalized);
  if (splitCache.size > 128) splitCache.delete(splitCache.keys().next().value as string);
  return { json: { ...normalized } };
});

/* ------------------------------- 标签 ------------------------------- */

route('POST', '/api/generate-tags', async ({ body, signal }) => ({
  json: await chatJson([
    { role: 'system', content: AI_PROMPTS.TAG_GENERATION },
    { role: 'user', content: requireText(isPlainObject(body) ? body.text : undefined, 'text') },
  ], { signal }),
}));

/* ------------------------------ JD 分析 ------------------------------ */

const safeParseResume = (resumeText: unknown): Row | null => {
  if (typeof resumeText !== 'string' || !resumeText) return null;
  try {
    const data = JSON.parse(resumeText);
    return isPlainObject(data) ? data : null;
  } catch {
    return null;
  }
};

const extractSkillIds = (resumeText: unknown): string[] => {
  const payload = safeParseResume(resumeText);
  if (!payload) return [];
  let skills: unknown = isPlainObject(payload.match_candidates) ? payload.match_candidates.skills : null;
  if (!Array.isArray(skills)) skills = payload.skills;
  if (!Array.isArray(skills)) skills = isPlainObject(payload.resume) ? payload.resume.skills : null;
  if (!Array.isArray(skills)) return [];
  const ids: string[] = [];
  for (const item of skills) {
    if (isPlainObject(item) && typeof item.id === 'string' && item.id && !ids.includes(item.id)) {
      ids.push(item.id);
    }
  }
  return ids;
};

const clampScore = (value: unknown): number | null => {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, Math.round(numeric)));
};

const finalizeJdAnalysis = (raw: Row, skillIds: string[]): Row => {
  const result: Row = { ...raw };
  const moveAlias = (camel: string, snake: string, accept: (value: unknown) => unknown) => {
    const value = accept(result[camel]) ?? accept(result[snake]);
    delete result[snake];
    if (value !== undefined && value !== null) result[camel] = value;
    else delete result[camel];
  };
  moveAlias('extractedJdText', 'extracted_jd_text', (value) => (
    typeof value === 'string' && value.trim() ? value.trim() : null
  ));
  moveAlias('jdInterpretation', 'jd_interpretation', (value) => (isPlainObject(value) ? value : null));
  moveAlias('capabilityAnalysis', 'capability_analysis', (value) => (isPlainObject(value) ? value : null));
  delete result.resumeEvaluation;
  delete result.resume_evaluation;
  if (skillIds.length) {
    const known = new Set(skillIds);
    const entries: Row[] = [];
    for (const item of Array.isArray(result.skillMatches) ? result.skillMatches : []) {
      if (!isPlainObject(item) || typeof item.id !== 'string' || !known.has(item.id)) continue;
      const score = clampScore(item.score);
      if (score === null) continue;
      entries.push({
        id: item.id,
        score,
        ...(typeof item.reason === 'string' && item.reason.trim() ? { reason: item.reason } : {}),
      });
    }
    const existing = new Set(entries.map((entry) => entry.id));
    for (const id of skillIds) {
      if (!existing.has(id)) entries.push({ id, score: 0 });
    }
    result.skillMatches = entries;
  }
  return result;
};

const analyzeJd = async (
  params: {
    text: string;
    resumeText?: string | null;
    prevResult?: unknown;
    experienceText?: string | null;
    prevExperienceText?: string | null;
  },
  signal?: AbortSignal,
  emitThought?: Thought,
) => {
  const userContent = [
    `Job Description:\n${params.text}`,
    `Resume Content:\n${params.resumeText || 'Resume content not provided.'}`,
    `Current Experience Content:\n${params.experienceText || 'Experience content not provided.'}`,
    `Previous Experience Content:\n${params.prevExperienceText || 'None'}`,
    `Previous Result:\n${params.prevResult ? JSON.stringify(params.prevResult) : 'None'}`,
  ].join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: AI_PROMPTS.JD_ANALYSIS },
    { role: 'user', content: userContent },
  ];
  const result = await chatJson(messages, { signal, emitThought });
  return finalizeJdAnalysis(result, extractSkillIds(params.resumeText));
};

const jdParamsFromBody = (body: unknown) => {
  const payload: Row = isPlainObject(body) ? body : {};
  return {
    text: requireText(payload.text, 'text'),
    resumeText: payload.resume_text ?? null,
    prevResult: isPlainObject(payload.prev_result) ? payload.prev_result : null,
    experienceText: payload.experience_text ?? null,
    prevExperienceText: payload.prev_experience_text ?? null,
  };
};

const JD_AFTER: Array<[string, string]> = [
  ['merge_result', '合并分析结果'],
  ['apply_score', '生成 JD 匹配分与建议'],
  ['persist_result', '完成结果输出'],
];

route('POST', '/api/analyze-jd', async ({ body, signal }) => ({
  json: await analyzeJd(jdParamsFromBody(body), signal),
}));

route('POST', '/api/analyze-jd/stream', ({ body }) => streamTask(
  [['prepare_context', '准备分析上下文'], ['request_ai', '调用 AI 进行分析']],
  JD_AFTER,
  (emit, signal) => analyzeJd(jdParamsFromBody(body), signal, emit),
));

const analyzeJdAttachment = async (request: LocalRequest, signal?: AbortSignal, emit?: Emit) => {
  const form = request.form;
  const file = form?.get('file');
  if (!(file instanceof File)) throw badRequest('请先选择 JD 附件。');
  const formText = (key: string) => {
    const value = form?.get(key);
    return typeof value === 'string' && value ? value : null;
  };
  emit?.({ type: 'progress', node: 'prepare_context', title: '解析 JD 附件' });
  const extracted = (await extractAttachmentText(file, { purpose: 'JD' })).trim();
  const supplemental = (formText('jd_text') || '').trim();
  const combined = supplemental
    ? (extracted ? `${extracted}\n\n补充 JD 说明：\n${supplemental}` : supplemental)
    : extracted;
  let prevResult: unknown = null;
  try {
    const raw = formText('prev_result');
    prevResult = raw ? JSON.parse(raw) : null;
  } catch {
    prevResult = null;
  }
  emit?.({ type: 'progress', node: 'request_ai', title: '调用 AI 进行分析' });
  const result = await analyzeJd({
    text: combined,
    resumeText: formText('resume_text'),
    prevResult: isPlainObject(prevResult) ? prevResult : null,
    experienceText: formText('experience_text'),
    prevExperienceText: formText('prev_experience_text'),
  }, signal, emit);
  if (extracted) result.extracted_jd_text = extracted;
  return result;
};

route('POST', '/api/analyze-jd-attachment', async (request) => ({
  json: await analyzeJdAttachment(request, request.signal),
}));

route('POST', '/api/analyze-jd-attachment/stream', (request) => streamTask(
  [],
  JD_AFTER,
  (emit, signal) => analyzeJdAttachment(request, signal, emit),
));

/* --------------------------- BOSS 招呼语 --------------------------- */

const generateBossGreeting = async (payload: Row, signal?: AbortSignal, emitThought?: Thought) => {
  const jdText = requireText(payload.jd_text, 'jd_text');
  const analysisSummary = requireText(payload.analysis_summary, 'analysis_summary');
  const result = await chatJson([
    { role: 'system', content: AI_PROMPTS.BOSS_GREETING_GENERATION },
    {
      role: 'user',
      content: JSON.stringify({
        jd_text: jdText,
        analysis_summary: analysisSummary,
        job_title: payload.job_title || '',
        company: payload.company || '',
        resume_text: safeParseResume(payload.resume_text) || {},
      }),
    },
  ], { signal, emitThought });
  const greeting = typeof result.greeting === 'string' ? result.greeting.trim() : '';
  const response: Row = { greeting };
  if (payload.resume_id && greeting) {
    const resume = await persistBossGreeting(
      String(payload.resume_id),
      greeting,
      typeof payload.signature === 'string' ? payload.signature : null,
      payload.expected_updated_at,
    );
    response.resume_updated_at = resume.updated_at;
  }
  return response;
};

route('POST', '/api/generate-boss-greeting', async ({ body, signal }) => ({
  json: await generateBossGreeting(isPlainObject(body) ? body : {}, signal),
}));

route('POST', '/api/generate-boss-greeting/stream', ({ body }) => streamTask(
  [['prepare_context', '准备 BOSS 招呼语上下文'], ['request_ai', '调用 AI 生成 BOSS 招呼语']],
  [['persist_result', '整理 BOSS 招呼语结果']],
  (emit, signal) => generateBossGreeting(isPlainObject(body) ? body : {}, signal, emit),
));

/* ----------------------------- 个人评价 ----------------------------- */

const generatePersonalSummary = async (payload: Row, signal?: AbortSignal, emitThought?: Thought) => {
  const result = await chatJson([
    { role: 'system', content: AI_PROMPTS.PERSONAL_SUMMARY_GENERATION },
    {
      role: 'user',
      content: JSON.stringify({
        mode: requireText(payload.mode, 'mode'),
        profile: payload.profile || {},
        work_experiences: payload.work_experiences || [],
        project_experiences: payload.project_experiences || [],
        education_experiences: payload.education_experiences || [],
        certifications: payload.certifications || [],
        skills: payload.skills || [],
        jd_text: payload.jd_text || '',
        polish_level: payload.polish_level || '标准',
      }),
    },
  ], { signal, emitThought });
  return { summary: typeof result.summary === 'string' ? result.summary.trim() : '' };
};

route('POST', '/api/generate-personal-summary', async ({ body, signal }) => ({
  json: await generatePersonalSummary(isPlainObject(body) ? body : {}, signal),
}));

route('POST', '/api/generate-personal-summary/stream', ({ body }) => streamTask(
  [['prepare_context', '准备个人评价上下文'], ['request_ai', '调用 AI 生成个人评价']],
  [['persist_result', '整理个人评价结果']],
  (emit, signal) => generatePersonalSummary(isPlainObject(body) ? body : {}, signal, emit),
));

/* ----------------------------- 六维评估 ----------------------------- */

const EVALUATION_UNAVAILABLE = '本地版暂未移植「六维深度评估」（原版依赖服务端的多轮校验流程）。JD 匹配分析、润色等功能不受影响。';

route('POST', '/api/resume-evaluation', () => {
  throw new HttpError(501, EVALUATION_UNAVAILABLE);
});
route('POST', '/api/resume-evaluation/stream', () => {
  throw new HttpError(501, EVALUATION_UNAVAILABLE);
});
