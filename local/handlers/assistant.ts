/**
 * AI 助理（会话、流式对话、草稿卡片应用）。
 * 移植自 backend/app/domain/assistant 与 domain/ai 的 assistant_*.py。
 * 与原版的差异：附件只支持可提取文字的文件（不支持图片），会话存储不设配额。
 */
import {
  badRequest, HttpError, notFound, route, type Emit, type LocalRequest,
} from '../http';
import { chat, parseJsonObject, createThoughtForwarder } from '../ai/llm';
import { extractAttachmentText } from '../ai/documentText';
import { AI_PROMPTS, ASSISTANT_SKILL_PROMPTS } from '../ai/prompts.generated';
import {
  nowIso, save, table, uuid, type Row,
} from '../store';
import { isOffScopeSmartCompleteQuestion } from './ai';
import {
  appendExperienceVersion, createExperienceRecord, findMaster, latestVersionOf,
} from './experiences';
import { getProfileRow } from './profile';
import { createCertificationRecord, createUserSkillRecord } from './skillsCerts';
import { invalidateResumeAnalyses, isPlainObject, LOCAL_USER_ID } from './shared';

const MODES = new Set(['general', 'experience', 'certification', 'skill']);
const ENTRY_SOURCES = new Set(['direct', 'experience_bank', 'resume_editor']);
const SKILL_IDS = new Set(Object.keys(ASSISTANT_SKILL_PROMPTS));
const STAR_KEYS = ['s', 't', 'a', 'r'] as const;
const MAX_FILES_PER_TURN = 5;
const MAX_ATTACHMENT_TEXT_CHARS = 30_000;

const defaultTitle = (mode: string) => ({
  experience: '经历整理', certification: '证书整理', skill: '技能整理',
} as Record<string, string>)[mode] || 'AI 助理';

const clip = (value: unknown, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit).trimEnd()}...`;
};

const normalizeSkillId = (value: unknown): string | null => (
  typeof value === 'string' && SKILL_IDS.has(value.trim()) ? value.trim() : null
);

/* --------------------------- 上下文规范化 --------------------------- */

const normalizeSelectedExperiences = (
  items: unknown,
  options: { includeFullText?: boolean; preserveStarText?: boolean } = {},
): Row[] => {
  if (!Array.isArray(items)) return [];
  const result: Row[] = [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const masterId = clip(item.masterId, 300);
    if (!masterId || !['work', 'project', 'education'].includes(item.category)) continue;
    const normalized: Row = { masterId, category: item.category, isCurrent: !!item.isCurrent };
    for (const key of ['org', 'title', 'startDate', 'endDate', 'summary']) {
      const clipped = clip(item[key], 300);
      if (clipped) normalized[key] = clipped;
    }
    if (isPlainObject(item.star)) {
      const star: Row = {};
      const fullStar: Row = {};
      for (const key of STAR_KEYS) {
        const raw = typeof item.star[key] === 'string' ? item.star[key].trim() : '';
        const value = options.preserveStarText ? raw : clip(item.star[key], 500);
        if (value) star[key] = value;
        if (options.includeFullText && raw) fullStar[key] = raw;
      }
      if (Object.keys(star).length) normalized.star = star;
      if (Object.keys(fullStar).length) normalized.full_text = { star: fullStar };
    }
    result.push(normalized);
    if (result.length >= 20) break;
  }
  return result;
};

const normalizeSnapshotList = (
  items: unknown,
  limit: number,
  build: (item: Row, id: string) => Row,
): Row[] => {
  const result: Row[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isPlainObject(item)) continue;
    const id = clip(item.id, 120);
    if (!id) continue;
    result.push(build(item, id));
    if (result.length >= limit) break;
  }
  return result;
};

const optionalFields = (item: Row, target: Row, fields: Array<[string, number]>) => {
  for (const [key, limit] of fields) {
    const value = clip(item[key], limit);
    if (value) target[key] = value;
  }
  return target;
};

const normalizeSelectedResume = (item: unknown): Row | null => {
  if (!isPlainObject(item)) return null;
  const resumeId = clip(item.resume_id || item.resumeId, 120);
  const resumeName = clip(item.resume_name || item.resumeName, 160);
  if (!resumeId || !resumeName) return null;
  const snapshot: Row = isPlainObject(item.snapshot) ? item.snapshot : {};
  const normalized: Row = {
    resume_id: resumeId,
    resume_name: resumeName,
    snapshot: {
      experiences: normalizeSnapshotList(snapshot.experiences, 40, (entry, id) => {
        const star: Row = {};
        if (isPlainObject(entry.star)) {
          for (const key of STAR_KEYS) {
            const value = clip(entry.star[key], 500);
            if (value) star[key] = value;
          }
        }
        return optionalFields(entry, {
          id, title: clip(entry.title, 300) || '', org: clip(entry.org, 300) || '', star,
        }, [['start_date', 300], ['end_date', 300]]);
      }),
      educations: normalizeSnapshotList(snapshot.educations, 20, (entry, id) => optionalFields(entry, {
        id,
        school: clip(entry.school, 300) || '',
        major: clip(entry.major, 300) || '',
        degree: clip(entry.degree, 300) || '',
      }, [['start_date', 300], ['end_date', 300], ['gpa', 300], ['courses', 500]])),
      certifications: normalizeSnapshotList(snapshot.certifications, 30, (entry, id) => optionalFields(entry, {
        id, name: clip(entry.name, 300) || '', issue_date: clip(entry.issue_date, 300) || '',
      }, [['issuer', 300]])),
      skills: normalizeSnapshotList(snapshot.skills, 60, (entry, id) => ({
        id, name: clip(entry.name, 300) || '', category: clip(entry.category, 300) || '',
      })),
    },
  };
  const masterId = clip(item.master_id || item.masterId, 120);
  if (masterId) normalized.master_id = masterId;
  const jdContext = clip(item.jd_context || item.jdContext, 4000);
  if (jdContext) normalized.jd_context = jdContext;
  const source = item.context_source || item.contextSource;
  if (['implicit_current_resume', 'explicit_resume_picker', 'history_replay'].includes(source)) {
    normalized.context_source = source;
  }
  const selection = item.selection;
  if (isPlainObject(selection) && ['all', 'subset'].includes(selection.mode)) {
    const ids = (raw: unknown, limit: number) => [...new Set(
      (Array.isArray(raw) ? raw : []).map((id) => clip(id, 120)).filter((id): id is string => !!id),
    )].slice(0, limit);
    const rawExperienceIds = selection.experienceIds ?? selection.experience_ids;
    if (Array.isArray(rawExperienceIds)) {
      const experienceIds = ids(rawExperienceIds, 40);
      const moduleIds = ids(selection.moduleIds ?? selection.module_ids, 91);
      if (experienceIds.length || moduleIds.length || selection.mode === 'all') {
        normalized.selection = {
          mode: selection.mode,
          experienceIds,
          ...(moduleIds.length ? { moduleIds } : {}),
        };
      }
    }
  }
  return normalized;
};

/* ------------------------------ 序列化 ------------------------------ */

const sessionToRead = (session: Row) => ({
  id: session.id,
  user_id: session.user_id,
  title: session.title,
  mode: session.mode,
  entry_source: session.entry_source,
  context_json: session.context_json || {},
  latest_preview: session.latest_preview || {},
  created_at: session.created_at,
  updated_at: session.updated_at,
});

const attachmentPreview = (attachment: unknown): Row | null => {
  if (!isPlainObject(attachment)) return null;
  const preview = { ...attachment };
  delete preview.imageB64;
  delete preview.text;
  return preview;
};

const sanitizeContent = (content: unknown): Row => {
  if (!isPlainObject(content)) return {};
  const sanitized: Row = { ...content };
  const single = attachmentPreview(content.attachment);
  if (single) sanitized.attachment = single;
  else delete sanitized.attachment;
  if (Array.isArray(content.attachments)) {
    const previews = content.attachments.map(attachmentPreview).filter(Boolean) as Row[];
    if (previews.length) {
      sanitized.attachments = previews;
      sanitized.attachment = previews[0];
    } else {
      delete sanitized.attachments;
    }
  }
  const experiences = normalizeSelectedExperiences(content.selected_experiences);
  if (experiences.length) sanitized.selected_experiences = experiences;
  else delete sanitized.selected_experiences;
  const resume = normalizeSelectedResume(content.selected_resume);
  if (resume) sanitized.selected_resume = resume;
  else delete sanitized.selected_resume;
  return sanitized;
};

const messageToRead = (message: Row) => ({
  id: message.id,
  role: message.role,
  message_type: message.message_type,
  content_json: sanitizeContent(message.content_json),
  created_at: message.created_at,
});

const findSession = (sessionId: string): Row => {
  const session = table('assistantSessions').find((item) => item.id === sessionId);
  if (!session) throw notFound(`Assistant session ${sessionId} not found`);
  return session;
};

const messagesOf = (sessionId: string) => table('assistantMessages')
  .filter((message) => message.session_id === sessionId)
  .sort((left, right) => (
    String(left.created_at).localeCompare(String(right.created_at)) || left.seq - right.seq
  ));

/* ----------------------------- 会话 CRUD ----------------------------- */

route('GET', '/api/assistant/sessions', () => ({
  json: [...table('assistantSessions')]
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .map(sessionToRead),
}));

route('POST', '/api/assistant/sessions', async ({ body }) => {
  const payload: Row = isPlainObject(body) ? body : {};
  const mode = MODES.has(payload.mode) ? payload.mode : 'general';
  const now = nowIso();
  const session: Row = {
    id: uuid(),
    user_id: LOCAL_USER_ID,
    title: (typeof payload.title === 'string' && payload.title.trim().slice(0, 120)) || defaultTitle(mode),
    mode,
    entry_source: ENTRY_SOURCES.has(payload.entry_source) ? payload.entry_source : 'direct',
    context_json: isPlainObject(payload.context_json) ? payload.context_json : {},
    latest_preview: {},
    created_at: now,
    updated_at: now,
  };
  table('assistantSessions').push(session);
  await save('assistantSessions');
  return { json: sessionToRead(session) };
});

route('GET', '/api/assistant/sessions/:sessionId', ({ params }) => {
  const session = findSession(params.sessionId);
  return {
    json: {
      session: sessionToRead(session),
      messages: messagesOf(session.id).map(messageToRead),
      truncated: false,
      next_cursor: null,
      storage_projection_truncated: false,
    },
  };
});

route('PATCH', '/api/assistant/sessions/:sessionId', async ({ params, body }) => {
  const session = findSession(params.sessionId);
  if (isPlainObject(body) && typeof body.title === 'string' && body.title.trim()) {
    session.title = body.title.trim().slice(0, 120);
    session.updated_at = nowIso();
    await save('assistantSessions');
  }
  return { json: sessionToRead(session) };
});

route('DELETE', '/api/assistant/sessions/:sessionId', async ({ params }) => {
  const session = findSession(params.sessionId);
  const sessions = table('assistantSessions');
  sessions.splice(sessions.indexOf(session), 1);
  const messages = table('assistantMessages');
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].session_id === session.id) messages.splice(index, 1);
  }
  await save('assistantSessions', 'assistantMessages');
  return { status: 204 };
});

/* ------------------------------ 流式对话 ------------------------------ */

const fullStarSnapshot = (raw: unknown): Row => {
  const snapshot: Row = {};
  if (isPlainObject(raw)) {
    for (const key of STAR_KEYS) {
      if (typeof raw[key] === 'string' && raw[key].trim()) snapshot[key] = raw[key].trim();
    }
  }
  return snapshot;
};

const buildBankContext = (): Row => {
  const profile = table('profile').length ? getProfileRow() : null;
  const profilePayload: Row = {};
  if (profile) {
    for (const key of ['full_name', 'title', 'location', 'email', 'phone']) {
      const value = clip(profile[key], 200);
      if (value) profilePayload[key] = value;
    }
    const summary = clip(profile.summary, 600);
    if (summary) profilePayload.summary = summary;
  }
  const experiences: Record<string, Row[]> = { work: [], project: [], education: [] };
  const rows = table('masters')
    .filter((master) => !master.is_archived)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  let count = 0;
  for (const master of rows) {
    const version = latestVersionOf(master);
    if (!version || !experiences[master.category] || count >= 60) continue;
    const item: Row = { masterId: master.id, isCurrent: !!version.is_current };
    for (const [key, limit] of [['title', 200], ['org', 200], ['summary', 400]] as Array<[string, number]>) {
      const value = clip(version[key], limit);
      if (value) item[key] = value;
    }
    if (version.start_date) item.startDate = version.start_date;
    if (version.end_date) item.endDate = version.end_date;
    const star: Row = {};
    if (isPlainObject(version.star)) {
      for (const key of STAR_KEYS) {
        const value = clip(version.star[key], 600);
        if (value) star[key] = value;
      }
    }
    if (Object.keys(star).length) item.star = star;
    experiences[master.category].push(item);
    count += 1;
  }
  const certifications = table('certifications').slice(0, 40).map((cert) => {
    const item: Row = { id: cert.id };
    for (const key of ['name', 'issuer']) {
      const value = clip(cert[key], 200);
      if (value) item[key] = value;
    }
    if (cert.issue_date) item.issueDate = cert.issue_date;
    if (cert.expiry_date) item.expiryDate = cert.expiry_date;
    const description = clip(cert.description, 300);
    if (description) item.description = description;
    return item;
  });
  const skills = table('userSkills').slice(0, 120)
    .filter((skill) => clip(skill.name, 200))
    .map((skill) => ({
      id: skill.id,
      name: clip(skill.name, 200),
      ...(clip(skill.category, 200) ? { category: clip(skill.category, 200) } : {}),
      ...(skill.proficiency !== null && skill.proficiency !== undefined ? { proficiency: skill.proficiency } : {}),
    }));
  return { profile: profilePayload, experiences, certifications, skills };
};

const attachmentContext = (attachment: Row, includeContent: boolean): Row => {
  const context: Row = {};
  for (const key of ['name', 'mimeType', 'size', 'kind']) {
    if (attachment[key] !== undefined) context[key] = attachment[key];
  }
  if (includeContent && typeof attachment.text === 'string') context.text = attachment.text;
  return context;
};

const buildHistory = (messages: Row[]): Row[] => messages.slice(-16).map((message) => {
  const content: Row = isPlainObject(message.content_json) ? { ...message.content_json } : {};
  if (Array.isArray(content.attachments)) {
    content.attachments = content.attachments.filter(isPlainObject).map((item: Row) => attachmentContext(item, false));
    delete content.attachment;
  } else if (isPlainObject(content.attachment)) {
    content.attachment = attachmentContext(content.attachment, false);
  }
  const experiences = normalizeSelectedExperiences(content.selected_experiences);
  if (experiences.length) content.selected_experiences = experiences;
  else delete content.selected_experiences;
  const resume = normalizeSelectedResume(content.selected_resume);
  if (resume) content.selected_resume = resume;
  else delete content.selected_resume;
  delete content.thinking;
  return { role: message.role, message_type: message.message_type, content_json: content };
});

const assistantPrompt = (mode: string, skillId: string | null): string => {
  let prompt: string = AI_PROMPTS.GENERAL_ASSISTANT_PROMPT;
  if (mode === 'experience') {
    prompt += " Current preferred topic: experience. Start by focusing on experience organization, but do not refuse other topics. "
      + "When 'context.masterId' exists, treat that record as the primary optimization target. "
      + "When 'bank_context' clearly matches an existing experience and the user wants to optimize it, return an experience draftCard with data.targetMasterId set to that record's masterId. "
      + "The experience draft data may include optional key 'targetMasterId' (string or null). Never fabricate a targetMasterId.";
  } else if (mode === 'certification') {
    prompt += ' Current preferred topic: certification. Start by focusing on certification organization, but do not refuse other topics.';
  } else if (mode === 'skill') {
    prompt += ' Current preferred topic: skill. Start by focusing on skill organization, but do not refuse other topics.';
  } else if (mode !== 'general') {
    throw badRequest(`Unsupported assistant mode: ${mode}`);
  }
  if (skillId) {
    prompt = `${prompt} ${(ASSISTANT_SKILL_PROMPTS as Record<string, { prompt: string }>)[skillId].prompt}`;
  }
  return prompt;
};

/* 草稿卡片规范化（assistant_action_utils.py） */

const isOrderedActionLine = (value: string) => {
  const match = /^\s*(\d+)([.、)）])\s*(.+)$/.exec(value);
  if (!match) return false;
  const content = (match[3] || '').trim();
  return !!content && match[1].length < 3 && !/^\d/.test(content);
};

const normalizeActionText = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  let lines = value.trim().split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && /^\s*\d+[.、)）]\s*.+$/.test(lines[0])) {
    const parts = lines[0].split(/(?=\d+[.、)）]\s+)/).map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(isOrderedActionLine)) lines = parts;
  }
  const stripped = lines.map((line) => {
    const ordered = /^\s*\d+[.、)）]\s*(.+)$/.exec(line);
    if (ordered && isOrderedActionLine(line)) return ordered[1].trim();
    const unordered = /^\s*([-*＊•·])\s*(.+)$/.exec(line);
    if (unordered) {
      const content = unordered[2].trim();
      const isItalic = ['*', '＊'].includes(unordered[1]) && /^\*[^*\r\n]+\*$/.test(line.trim());
      const isNegativeNumber = unordered[1] === '-' && /^\d/.test(content);
      if (content && !isItalic && !isNegativeNumber) return content;
    }
    return line.trim();
  }).filter(Boolean);
  return stripped.length ? stripped.join('\n') : null;
};

const draftText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export const normalizeDraftCard = (card: unknown): Row | null => {
  if (!isPlainObject(card)) return null;
  const normalized: Row = { ...card };
  const data: Row = isPlainObject(card.data) ? card.data : {};
  if (card.type === 'education') {
    const star: Row = isPlainObject(data.star) ? data.star : {};
    normalized.type = 'experience';
    normalized.data = {
      category: 'education',
      org: draftText(data.org),
      title: draftText(data.title),
      startDate: draftText(data.startDate),
      endDate: draftText(data.endDate),
      isCurrent: !!data.isCurrent,
      star: { s: draftText(star.s), t: draftText(star.t), a: draftText(star.a), r: draftText(star.r) },
      ...(draftText(data.targetMasterId) ? { targetMasterId: draftText(data.targetMasterId) } : {}),
    };
    return normalized;
  }
  if (card.type === 'skill_group') {
    if (!isPlainObject(card.data) || !Array.isArray(data.skills)) return null;
    const skills: Row[] = [];
    for (const raw of data.skills) {
      const name = draftText(typeof raw === 'string' ? raw : isPlainObject(raw) ? raw.name : '');
      if (!name) continue;
      const target = isPlainObject(raw) ? draftText(raw.targetUserSkillId) : '';
      skills.push({ name, ...(target ? { targetUserSkillId: target } : {}) });
    }
    if (!skills.length) return null;
    normalized.data = { category: draftText(data.category), skills };
    return normalized;
  }
  if (card.type !== 'experience') return card.type === 'certification' ? normalized : null;
  if (!isPlainObject(card.data) || data.category === 'education' || !isPlainObject(data.star)) return normalized;
  const star = { ...data.star };
  if (typeof star.a === 'string') star.a = normalizeActionText(star.a) || '';
  normalized.data = { ...data, star };
  return normalized;
};

const normalizeFollowups = (value: unknown, activeSkillId: string | null): Row[] => {
  const result: Row[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    if (!isPlainObject(item) || typeof item.label !== 'string' || typeof item.prompt !== 'string') continue;
    const label = item.label.trim();
    const prompt = item.prompt.trim();
    const skillId = normalizeSkillId(String(item.skillId || item.skill_id || ''));
    if (!label || !prompt || !skillId) continue;
    if (activeSkillId === 'experience_completion' && isOffScopeSmartCompleteQuestion(`${label} ${prompt}`)) continue;
    const key = prompt.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ label: label.slice(0, 16), prompt: prompt.slice(0, 220), skillId });
    if (result.length >= 3) break;
  }
  return result;
};

/**
 * 从流式 JSON 中增量提取 assistantText 字段，转成 assistant_delta 事件，
 * 让回复像原版一样逐字出现。
 */
const createAssistantTextStreamer = (emit: Emit) => {
  let emitted = 0;
  return (full: string) => {
    const keyMatch = /"assistantText"\s*:\s*"/.exec(full);
    if (!keyMatch) return;
    const start = keyMatch.index + keyMatch[0].length;
    let end = start;
    let escaped = false;
    for (; end < full.length; end += 1) {
      const char = full[end];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    let raw = full.slice(start, end);
    // 避免在半个转义序列处截断
    const trailing = /\\(u[0-9a-fA-F]{0,3})?$/.exec(raw);
    if (trailing && end >= full.length) raw = raw.slice(0, trailing.index);
    let decoded: string;
    try {
      decoded = JSON.parse(`"${raw}"`);
    } catch {
      return;
    }
    if (decoded.length > emitted) {
      emit({ type: 'assistant_delta', delta: decoded.slice(emitted) });
      emitted = decoded.length;
    }
  };
};

const parseTurnPayload = async (request: LocalRequest) => {
  let payload: Row;
  let files: File[] = [];
  if (request.form) {
    const form = request.form;
    files = form.getAll('files').filter((item): item is File => item instanceof File && !!item.name);
    if (!files.length) {
      const single = form.get('file');
      if (single instanceof File && single.name) files = [single];
    }
    if (files.length > MAX_FILES_PER_TURN) throw badRequest(`每次最多上传 ${MAX_FILES_PER_TURN} 个附件。`);
    const parseJson = (key: string, message: string) => {
      const raw = form.get(key);
      if (typeof raw !== 'string' || !raw.trim()) return null;
      try {
        return JSON.parse(raw);
      } catch {
        throw badRequest(message);
      }
    };
    const selectedExperiences = parseJson('selected_experiences', '所选经历参数不是有效 JSON。');
    const selectedResume = parseJson('selected_resume', '所选简历参数不是有效 JSON。');
    payload = {
      user_message: String(form.get('user_message') || ''),
      display_message: String(form.get('display_message') || ''),
      mode: String(form.get('mode') || '') || null,
      skill_id: String(form.get('skill_id') || '') || null,
      enable_thinking: ['1', 'true', 'yes', 'on'].includes(String(form.get('enable_thinking') || '').toLowerCase()),
      selected_experiences: Array.isArray(selectedExperiences) ? selectedExperiences : [],
      selected_resume: isPlainObject(selectedResume) ? selectedResume : null,
    };
  } else {
    payload = isPlainObject(request.body) ? request.body : {};
  }
  const normalized = {
    userMessage: typeof payload.user_message === 'string' ? payload.user_message : '',
    displayMessage: typeof payload.display_message === 'string' ? payload.display_message : '',
    mode: MODES.has(payload.mode) ? payload.mode as string : null,
    skillId: normalizeSkillId(payload.skill_id),
    enableThinking: !!payload.enable_thinking,
    selectedExperiences: normalizeSelectedExperiences(payload.selected_experiences),
    selectedResume: normalizeSelectedResume(payload.selected_resume),
    files,
  };
  if (!normalized.userMessage.trim() && !files.length
    && !normalized.selectedExperiences.length && !normalized.selectedResume) {
    throw badRequest('请输入消息、选择简历或上传附件后再发送。');
  }
  return normalized;
};

route('POST', '/api/assistant/sessions/:sessionId/stream', async (request) => {
  const turn = await parseTurnPayload(request);
  return {
    stream: async (emit, signal) => {
      const session = findSession(request.params.sessionId);
      const history = messagesOf(session.id);
      const attachments: Row[] = [];
      if (turn.files.length) {
        emit({ type: 'progress', node: 'read_attachment', title: '解析对话附件' });
        for (const file of turn.files) {
          const text = await extractAttachmentText(file, { purpose: '附件', maxChars: 200_000 });
          attachments.push({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            kind: 'document',
            text: text.slice(0, MAX_ATTACHMENT_TEXT_CHARS),
          });
        }
      }
      emit({ type: 'progress', node: 'prepare_context', title: '准备对话上下文' });
      const mode = turn.mode || session.mode;
      const hydrated = turn.selectedExperiences.map((item) => {
        const master = table('masters').find((candidate) => candidate.id === item.masterId);
        const star = master ? fullStarSnapshot(latestVersionOf(master)?.star) : {};
        return Object.keys(star).length ? { ...item, star } : item;
      });
      const payload: Row = {
        mode,
        session_title: session.title,
        entry_source: session.entry_source,
        context: session.context_json || {},
        history: buildHistory(history),
      };
      if (turn.skillId) {
        payload.skill_id = turn.skillId;
        payload.skill = {
          id: turn.skillId,
          title: (ASSISTANT_SKILL_PROMPTS as Record<string, { title: string }>)[turn.skillId].title,
        };
      }
      payload.bank_context = buildBankContext();
      const selected = normalizeSelectedExperiences(hydrated, { includeFullText: true });
      if (selected.length) payload.selected_experiences = selected;
      if (turn.selectedResume) payload.selected_resume = turn.selectedResume;
      if (attachments.length === 1) payload.attachment = attachmentContext(attachments[0], true);
      else if (attachments.length > 1) payload.attachments = attachments.map((item) => attachmentContext(item, true));
      payload.user_message = turn.userMessage;

      emit({ type: 'progress', node: 'request_ai', title: '调用 AI 助理' });
      const thinkingLines: string[] = [];
      const forwarder = createThoughtForwarder(turn.enableThinking ? (event) => {
        if (event.summary && thinkingLines[thinkingLines.length - 1] !== event.summary) {
          thinkingLines.push(event.summary);
        }
        emit(event as { type: string; summary?: string });
      } : undefined);
      if (turn.enableThinking) emit({ type: 'thought_status', summary: '正在分析上下文并组织回复' });
      const streamText = createAssistantTextStreamer(emit);
      const { content } = await chat([
        { role: 'system', content: assistantPrompt(mode, turn.skillId) },
        { role: 'user', content: JSON.stringify(payload) },
      ], {
        signal,
        thinking: turn.enableThinking,
        onReasoning: (delta) => forwarder.push(delta),
        onContent: (_delta, full) => streamText(full),
      });
      forwarder.end();

      const raw = parseJsonObject(content);
      const assistantText = typeof raw.assistantText === 'string' ? raw.assistantText.trim() : '';
      if (!assistantText) throw new HttpError(502, 'AI 助理未返回有效回复。');
      const result = {
        assistantText,
        draftCard: turn.skillId === 'mock_interview' ? null : normalizeDraftCard(raw.draftCard),
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'AI 助理',
        suggestedFollowups: normalizeFollowups(raw.suggestedFollowups, turn.skillId),
      };

      // 持久化这一轮对话（persist_assistant_turn）
      const userContent: Row = { text: turn.displayMessage.trim() ? turn.displayMessage : turn.userMessage };
      if (turn.skillId) userContent.skill_id = turn.skillId;
      if (attachments.length) {
        userContent.attachment = attachments[0];
        if (attachments.length > 1) userContent.attachments = attachments;
      }
      if (turn.selectedExperiences.length) userContent.selected_experiences = turn.selectedExperiences;
      if (turn.selectedResume) userContent.selected_resume = turn.selectedResume;
      const assistantContent: Row = { text: result.assistantText };
      if (thinkingLines.length) assistantContent.thinking = thinkingLines.join('\n').slice(0, 20_000);
      if (turn.skillId) assistantContent.skill_id = turn.skillId;
      if (result.suggestedFollowups.length) assistantContent.suggestedFollowups = result.suggestedFollowups;
      const baseSeq = table('assistantMessages').length;
      const append = (role: string, messageType: string, contentJson: Row, offset: number) => {
        table('assistantMessages').push({
          id: uuid(),
          session_id: session.id,
          role,
          message_type: messageType,
          content_json: contentJson,
          created_at: nowIso(),
          seq: baseSeq + offset,
        });
      };
      append('user', 'user_text', userContent, 0);
      append('assistant', 'assistant_text', assistantContent, 1);
      if (result.draftCard) append('assistant', 'draft_card', result.draftCard, 2);
      session.latest_preview = result.draftCard || {};
      if (typeof raw.title === 'string' && raw.title.trim()) session.title = raw.title.trim().slice(0, 120);
      session.updated_at = nowIso();
      await save('assistantSessions', 'assistantMessages');

      emit({ type: 'progress', node: 'persist_result', title: '保存会话记录' });
      emit({ type: 'final', result });
    },
  };
});

/* ----------------------------- 应用草稿卡片 ----------------------------- */

const contextString = (context: unknown, key: string): string | null => (
  isPlainObject(context) && typeof context[key] === 'string' && context[key].trim() ? context[key].trim() : null
);

const draftCategory = (data: Row): string => {
  if (['work', 'project', 'education'].includes(data.category)) return data.category;
  throw badRequest('Draft experience category is invalid');
};

const resolveBoundMasterId = (session: Row, data: Row, allowUnboundTarget: boolean): string | null => {
  const contextMasterId = contextString(session.context_json, 'masterId');
  const targetMasterId = typeof data.targetMasterId === 'string' && data.targetMasterId.trim()
    ? data.targetMasterId.trim()
    : null;
  if (contextMasterId) {
    if (targetMasterId && targetMasterId !== contextMasterId && session.entry_source !== 'experience_bank') {
      throw badRequest('Draft target does not match the current experience context');
    }
    return contextMasterId;
  }
  return allowUnboundTarget ? targetMasterId : null;
};

const navigation = (targetView: string, targetId?: string | null, category?: string | null, resumeId?: string | null) => ({
  targetView,
  ...(targetId ? { targetId } : {}),
  ...(resumeId ? { resumeId } : {}),
  ...(category ? { category } : {}),
});

const existingExperienceNavigation = (session: Row, data: Row, defaultView: string, allowUnboundTarget: boolean) => {
  const category = draftCategory(data);
  const masterId = resolveBoundMasterId(session, data, allowUnboundTarget);
  if (!masterId) return null;
  const resumeId = contextString(session.context_json, 'resumeId');
  return navigation(defaultView === 'resume_editor' && resumeId ? 'resume_editor' : defaultView, masterId, category, resumeId);
};

const hasText = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

const mergeStar = (incoming: unknown, category: string, latest: Row | null): Row => {
  const resolved: Row = latest && isPlainObject(latest.star) ? { ...latest.star } : {};
  if (!isPlainObject(incoming)) return resolved;
  if (category === 'education') {
    const existing = { ...resolved };
    for (const key of STAR_KEYS) delete resolved[key];
    for (const [sourceKey, targetKey] of [['s', 'degree'], ['t', 'gpa'], ['a', 'courses']]) {
      const value = [incoming[sourceKey], incoming[targetKey], existing[targetKey], existing[sourceKey]].find(hasText);
      if (value) resolved[targetKey] = value;
    }
    return resolved;
  }
  for (const key of STAR_KEYS) {
    const value = incoming[key];
    const normalized = key === 'a' ? normalizeActionText(value) : value;
    if (hasText(value)) resolved[key] = normalized;
    else if (!(key in resolved) && typeof value === 'string') resolved[key] = normalized;
  }
  return resolved;
};

const buildVersionPayload = (data: Row, category: string, latest: Row | null): Row => {
  const title = draftText(data.title);
  const org = draftText(data.org);
  const startDate = draftText(data.startDate);
  const endDate = draftText(data.endDate);
  const requestedCurrent = !!data.isCurrent;
  let start: unknown;
  let end: unknown;
  let isCurrent: boolean;
  if (latest && !startDate && !endDate && !requestedCurrent) {
    start = latest.start_date;
    end = latest.end_date;
    isCurrent = !!latest.is_current;
  } else {
    start = startDate || (latest ? latest.start_date : null);
    isCurrent = requestedCurrent;
    end = isCurrent ? null : (endDate || (latest && !latest.is_current ? latest.end_date : null));
  }
  const resolvedTitle = title || (latest ? latest.title : null);
  if (!resolvedTitle) throw badRequest('草稿缺少标题，无法保存到经历库。');
  return {
    title: resolvedTitle,
    org: org || (latest ? latest.org : null),
    location: latest ? latest.location : null,
    start_date: start,
    end_date: end,
    is_current: isCurrent,
    summary: latest ? latest.summary : null,
    highlights: latest ? latest.highlights : [],
    tags: latest ? latest.tags : [],
    star: mergeStar(data.star, category, latest),
  };
};

const mergeKey = (name: unknown, category: unknown) => {
  const normalize = (value: unknown) => (typeof value === 'string' ? value.trim().split(/\s+/).join(' ').toLowerCase() : '');
  return `${normalize(category)}\u0000${normalize(name)}`;
};

const applySkillGroup = (data: Row) => {
  const category = (typeof data.category === 'string' && data.category.trim().split(/\s+/).join(' ')) || null;
  if (!Array.isArray(data.skills) || !data.skills.length) throw badRequest('Draft skill group payload is invalid');
  const drafts = new Map<string, Row>();
  for (const raw of data.skills) {
    if (!isPlainObject(raw)) throw badRequest('Draft skill group payload is invalid');
    const name = typeof raw.name === 'string' ? raw.name.trim().split(/\s+/).join(' ') : '';
    if (!name) continue;
    drafts.set(mergeKey(name, category), {
      name,
      category,
      target: hasText(raw.targetUserSkillId) ? raw.targetUserSkillId.trim() : null,
    });
  }
  if (!drafts.size) throw badRequest('Draft skill group payload is invalid');
  const skills = table('userSkills');
  for (const [key, draft] of drafts) {
    const existing = (draft.target && skills.find((skill) => skill.id === draft.target))
      || skills.find((skill) => mergeKey(skill.name, skill.category) === key);
    if (existing) {
      existing.name = draft.name;
      existing.category = draft.category;
    } else {
      createUserSkillRecord(draft.name, draft.category);
    }
  }
  invalidateResumeAnalyses();
};

const applyDirectDraft = (session: Row, content: Row) => {
  const data = content.data;
  if (!isPlainObject(data)) throw badRequest('Draft card payload is invalid');
  if (content.type === 'experience') {
    const category = draftCategory(data);
    const targetMasterId = resolveBoundMasterId(session, data, true);
    if (targetMasterId) {
      const master = findMaster(targetMasterId);
      if (master.category !== category) {
        throw badRequest('Draft target category does not match the existing experience');
      }
      appendExperienceVersion(master, buildVersionPayload(data, category, latestVersionOf(master)));
      return navigation('experience_bank', master.id, master.category);
    }
    const { master } = createExperienceRecord(category, buildVersionPayload(data, category, null));
    return navigation('experience_bank', master.id, category);
  }
  if (content.type === 'certification') {
    if (!hasText(data.name)) throw badRequest('证书草稿缺少名称。');
    createCertificationRecord({
      name: data.name,
      issuer: data.issuer ?? null,
      issue_date: data.issueDate || null,
      expiry_date: data.expiryDate || null,
      credential_id: data.credentialId || null,
      credential_url: data.credentialUrl || null,
      description: data.description || null,
    });
    return null;
  }
  if (content.type === 'skill_group') {
    applySkillGroup(data);
    return null;
  }
  throw badRequest(`Unsupported draft card type: ${content.type}`);
};

route('POST', '/api/assistant/sessions/:sessionId/messages/:messageId/apply', async ({ params, query }) => {
  const session = findSession(params.sessionId);
  const message = table('assistantMessages').find(
    (item) => item.id === params.messageId && item.session_id === session.id,
  );
  if (!message) throw notFound(`Assistant message ${params.messageId} not found`);
  if (message.message_type !== 'draft_card') {
    throw badRequest('Only draft card messages can be marked as applied');
  }
  const previous: Row = isPlainObject(message.content_json) ? message.content_json : {};
  if (hasText(previous.applied_at)) {
    return { json: { message: messageToRead(message), navigation: previous.apply_navigation ?? null } };
  }
  const skipApply = ['true', '1'].includes((query.get('skip_apply') || '').toLowerCase());
  const contextMasterId = contextString(session.context_json, 'masterId');
  let applyNavigation: Row | null = null;
  if (skipApply) {
    if (session.entry_source === 'direct') {
      throw badRequest('Direct assistant sessions must apply content before marking as applied');
    }
    if (previous.type === 'experience' && isPlainObject(previous.data)) {
      applyNavigation = existingExperienceNavigation(session, previous.data, session.entry_source, false);
    }
  } else if (session.entry_source === 'direct') {
    const content = normalizeDraftCard(previous);
    if (!content) throw badRequest('Draft card payload is invalid');
    applyNavigation = applyDirectDraft(session, content);
  } else if (session.entry_source === 'experience_bank') {
    const content = normalizeDraftCard(previous);
    if (!content) throw badRequest('Draft card payload is invalid');
    if (content.type !== 'experience') {
      throw badRequest('Experience bank sessions only support experience draft cards');
    }
    if (!isPlainObject(content.data)) throw badRequest('Draft card payload is invalid');
    const masterId = resolveBoundMasterId(session, content.data, true);
    if (!masterId) {
      applyNavigation = applyDirectDraft(session, content);
    } else {
      const master = findMaster(masterId);
      const category = draftCategory(content.data);
      if (master.category !== category) {
        throw badRequest('Draft category does not match the current experience context');
      }
      appendExperienceVersion(master, buildVersionPayload(content.data, category, latestVersionOf(master)));
      applyNavigation = navigation('experience_bank', master.id, master.category);
    }
  } else if (session.entry_source === 'resume_editor') {
    if (previous.type === 'experience' && isPlainObject(previous.data)) {
      applyNavigation = existingExperienceNavigation(session, previous.data, 'resume_editor', !contextMasterId);
    }
  }
  const previewMatches = JSON.stringify(session.latest_preview || {}) === JSON.stringify(previous);
  const next: Row = { ...previous, applied_at: new Date().toISOString() };
  if (applyNavigation) next.apply_navigation = applyNavigation;
  message.content_json = next;
  if (previewMatches) session.latest_preview = next;
  await save('assistantMessages', 'assistantSessions', 'masters', 'versions', 'certifications', 'userSkills', 'resumes');
  return { json: { message: messageToRead(message), navigation: applyNavigation } };
});
