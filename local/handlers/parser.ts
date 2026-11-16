/**
 * 简历导入解析 —— 移植自 backend/app/domain/parser
 * （parser_router.py、parser_service.py、payload_normalization.py、duplicate_detection.py）。
 * 文件在本机提取文字后，仅把文字发给用户配置的模型。
 * 与原版的差异：超长简历不做分块合并（直接截断），不做 AI 语义查重（保留签名相似度查重）。
 */
import { badRequest, route, type Emit } from '../http';
import { chatJson } from '../ai/llm';
import { extractAttachmentText } from '../ai/documentText';
import { PARSER_PROMPTS } from '../ai/prompts.generated';
import { table, uuid, type Row } from '../store';
import { latestVersionOf } from './experiences';
import { isPlainObject, normalizeMonthDate } from './shared';

const MAX_RESUME_TEXT_CHARS = 60_000;
const PRESENT_MARKERS = new Set(['present', 'current', 'now', '至今', '目前']);
const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf';
const CJK_INLINE = `${CJK}\\u3000-\\u303f\\uff00-\\uffef·•`;
const CJK_ADJACENT = '\\(\\)\\[\\]（）【】《》<>·•';

const PROJECT_KEYWORDS = ['project', 'projects', 'side project', 'personal project', 'open source', 'opensource', 'github', '开源', '项目', '课程设计', '课程项目', '毕业设计', '竞赛', '比赛', '作品'];
const WORK_KEYWORDS = ['intern', 'internship', 'full-time', 'part-time', 'employment', 'company', 'client', '客户', '公司', '集团', '部门', '岗位', '实习', '任职'];
const WORK_ORG_HINTS = ['有限公司', '股份有限公司', '有限责任公司', '公司', '集团', 'inc', 'ltd', 'llc', 'corp'];
const PROJECT_TITLE_HINTS = ['项目', 'project'];
const PROJECT_NAME_HINTS = ['system', 'platform', 'project', 'app', 'website', 'web', 'service', 'tool', 'dashboard', '系统', '平台', '项目', '应用', '网站', '小程序', '服务', '工具', '后台', '管理后台', '商城', '门户', '客户端', 'gis', 'webgis'];
const PROJECT_ROLE_HINTS = ['owner', 'lead', 'leader', 'pm', 'project manager', 'tech lead', 'engineer', 'developer', 'maintainer', 'contributor', '负责人', '项目经理', '组长', '组员', '成员', '主导', '牵头', '独立开发', '核心开发', '开发'];
const DUPLICATE_ROLE_HINTS = ['owner', 'lead', 'leader', 'pm', 'project manager', '负责人', '发起人', '牵头人', '主导者', '项目经理', '组长', '成员', '组员'];

const normalizeText = (value: unknown): string => (
  typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : ''
);

const cleanInline = (value: string): string => value
  .replace(/\s+/g, ' ')
  .trim()
  .replace(new RegExp(`(?<=[${CJK_INLINE}])\\s+(?=[${CJK_INLINE}])`, 'g'), '')
  .replace(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK_ADJACENT}])`, 'g'), '')
  .replace(new RegExp(`(?<=[${CJK_ADJACENT}])\\s+(?=[${CJK}])`, 'g'), '');

const ensureStr = (value: unknown): string => (value === null || value === undefined ? '' : cleanInline(String(value)));
const ensureList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const textList = (value: unknown): string[] => ensureList(value)
  .filter((item): item is string => typeof item === 'string' && !!item.trim())
  .map(cleanInline);
const isPresent = (value: unknown) => !!value && PRESENT_MARKERS.has(String(value).trim().toLowerCase());
const normalizeDate = (value: unknown) => (isPresent(value) ? null : normalizeMonthDate(value));
const countHits = (text: string, keywords: string[]) => (text ? keywords.filter((keyword) => text.includes(keyword)).length : 0);

const starField = (value: unknown): string => {
  if (Array.isArray(value)) return textList(value).join('\n');
  if (value === null || value === undefined) return '';
  return String(value).split(/\r?\n/).map(cleanInline).filter(Boolean).join('\n');
};

const buildStar = (entry: Row) => {
  const source: Row = isPlainObject(entry.star) ? entry.star : {};
  let action = starField(source.a || entry.a);
  const highlights = textList(entry.highlights).join('\n');
  if (highlights && (!action || highlights.length > action.length)) action = highlights;
  return {
    s: starField(source.s || entry.s),
    t: starField(source.t || entry.t),
    a: action,
    r: starField(source.r || entry.r),
  };
};

const buildWorkVersion = (entry: Row): Row => ({
  title: ensureStr(entry.title) || '未命名经历',
  org: ensureStr(entry.org) || '未知机构',
  location: ensureStr(entry.location) || null,
  start_date: normalizeDate(entry.start_date),
  end_date: normalizeDate(entry.end_date),
  is_current: !!entry.is_current || isPresent(entry.end_date),
  summary: ensureStr(entry.summary) || null,
  highlights: textList(entry.highlights),
  tags: textList(entry.tags),
  star: buildStar(entry),
});

const buildProjectVersion = (entry: Row): Row => {
  const title = normalizeText(ensureStr(entry.title));
  const org = normalizeText(ensureStr(entry.org));
  if (title && org) {
    const swapScore = countHits(title, PROJECT_NAME_HINTS) + countHits(org, PROJECT_ROLE_HINTS);
    const keepScore = countHits(org, PROJECT_NAME_HINTS) + countHits(title, PROJECT_ROLE_HINTS);
    if (swapScore > keepScore && swapScore >= 1) {
      return buildWorkVersion({ ...entry, title: ensureStr(entry.org), org: ensureStr(entry.title) });
    }
  }
  return buildWorkVersion(entry);
};

const buildEducationVersion = (entry: Row): Row => {
  const degree = ensureStr(entry.degree);
  const star: Row = {};
  if (degree) star.degree = degree;
  const gpa = ensureStr(entry.gpa);
  if (gpa) star.gpa = gpa;
  let courses: unknown = '';
  if (Array.isArray(entry.courses)) courses = textList(entry.courses);
  else if (typeof entry.courses === 'string') {
    const items = entry.courses.split(/[,，;；/\n]/).filter((item: string) => item.trim()).map(cleanInline);
    courses = items.length ? items : cleanInline(entry.courses);
  }
  if (Array.isArray(courses) ? courses.length : courses) star.courses = courses;
  return {
    title: ensureStr(entry.major) || degree || '未命名专业',
    org: ensureStr(entry.school) || '未命名学校',
    location: null,
    start_date: normalizeDate(entry.start_date),
    end_date: normalizeDate(entry.end_date),
    is_current: !!entry.is_current || isPresent(entry.end_date),
    summary: null,
    highlights: [],
    tags: [],
    star,
  };
};

const inferCategory = (entry: Row): 'work' | 'project' => {
  const star: Row = isPlainObject(entry.star) ? entry.star : {};
  const text = normalizeText([
    ensureStr(entry.title), ensureStr(entry.org), ensureStr(entry.summary),
    textList(entry.highlights).join(' '),
    ensureStr(star.s), ensureStr(star.t), ensureStr(star.a), ensureStr(star.r),
  ].filter(Boolean).join(' '));
  let projectScore = countHits(text, PROJECT_KEYWORDS);
  let workScore = countHits(text, WORK_KEYWORDS);
  if (countHits(normalizeText(ensureStr(entry.org)), WORK_ORG_HINTS)) workScore += 1;
  if (countHits(normalizeText(ensureStr(entry.title)), PROJECT_TITLE_HINTS)) projectScore += 1;
  return projectScore >= 1 && projectScore > workScore ? 'project' : 'work';
};

const buildItems = (payload: Row): Row[] => {
  const items: Row[] = [];
  const push = (category: string, version: Row) => items.push({
    id: uuid(),
    category,
    version,
    duplicate: { is_duplicate: false, match_type: null, match_score: null, matched_existing_id: null, match_reason: null },
  });
  const workRaw = ensureList(payload.work_experiences).filter(isPlainObject);
  let work = workRaw;
  let projects: Row[] = [];
  if ('project_experiences' in payload) {
    projects = ensureList(payload.project_experiences).filter(isPlainObject);
  } else {
    work = workRaw.filter((entry) => inferCategory(entry) === 'work');
    projects = workRaw.filter((entry) => inferCategory(entry) === 'project');
  }
  work.forEach((entry) => push('work', buildWorkVersion(entry)));
  projects.forEach((entry) => push('project', buildProjectVersion(entry)));
  ensureList(payload.education).filter(isPlainObject).forEach((entry) => push('education', buildEducationVersion(entry)));
  return items;
};

/* ------------------------------ 查重 ------------------------------ */

const signature = (title: unknown, org: unknown) => {
  const titlePart = normalizeText(title);
  const orgPart = normalizeText(org);
  return titlePart || orgPart ? `${orgPart}::${titlePart}` : '';
};

const matchSignatures = (category: string, title: unknown, org: unknown): string[] => {
  const result = [signature(title, org)];
  const titleText = normalizeText(title);
  const orgText = normalizeText(org);
  if (titleText && orgText) {
    result.push(signature(org, title));
    result.push(signature(`${orgText} ${titleText}`, ''));
  }
  if (category === 'project' && orgText && DUPLICATE_ROLE_HINTS.some((hint) => titleText.includes(hint))) {
    result.push(`${orgText}::`);
  }
  return [...new Set(result.filter(Boolean))];
};

/** 近似 difflib.SequenceMatcher.ratio()：2 × 最长公共子序列 / 总长度。 */
const similarity = (left: string, right: string): number => {
  if (!left || !right) return 0;
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [0];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return (2 * previous[right.length]) / (left.length + right.length);
};

const applyDuplicateFlags = (items: Row[]) => {
  const buckets = new Map<string, string[]>();
  for (const master of table('masters')) {
    if (master.is_archived) continue;
    const version = latestVersionOf(master);
    if (!version) continue;
    const signatures = matchSignatures(master.category, version.title, version.org || '');
    for (const key of [master.category, '__all__']) {
      buckets.set(key, [...(buckets.get(key) || []), ...signatures]);
    }
  }
  const findIn = (signatures: string[], bucket?: string[]) => {
    let best: Row = { is_duplicate: false };
    if (!bucket?.length) return best;
    for (const candidate of signatures) {
      if (bucket.includes(candidate)) return { is_duplicate: true, match_type: 'exact', match_score: 1 };
      const score = bucket.reduce((max, existing) => Math.max(max, similarity(candidate, existing)), 0);
      if (score >= 0.86 && (best.match_score || 0) < score) {
        best = { is_duplicate: true, match_type: 'similar', match_score: Math.round(score * 100) / 100 };
      }
    }
    return best;
  };
  for (const item of items) {
    const signatures = matchSignatures(item.category, item.version.title, item.version.org);
    let match = findIn(signatures, buckets.get(item.category));
    if (!match.is_duplicate) match = findIn(signatures, buckets.get('__all__'));
    item.duplicate = {
      is_duplicate: !!match.is_duplicate,
      match_type: match.match_type ?? null,
      match_score: match.match_score ?? null,
      matched_existing_id: null,
      match_reason: null,
    };
  }
  return items;
};

/* --------------------------- 其他字段整理 --------------------------- */

const normalizePersonalInfo = (payload: Row) => {
  if (!isPlainObject(payload.personal_info)) return null;
  const info: Row = {};
  for (const field of ['full_name', 'email', 'phone', 'location']) {
    const value = ensureStr(payload.personal_info[field]);
    if (value) info[field] = value;
  }
  const rawLinks = payload.personal_info.links;
  const links = (Array.isArray(rawLinks) ? rawLinks : typeof rawLinks === 'string' ? [rawLinks] : [])
    .filter((item: unknown): item is string => typeof item === 'string')
    .flatMap((item: string) => item.split(/[\s,;，；]+/))
    .map((item: string) => item.trim())
    .filter(Boolean);
  if (links.length) info.links = links;
  if (!Object.keys(info).length) return null;
  return { full_name: null, email: null, phone: null, location: null, links: [], ...info };
};

const normalizeCertifications = (payload: Row) => {
  const seen = new Set<string>();
  const result: Row[] = [];
  for (const entry of ensureList(payload.certifications).filter(isPlainObject)) {
    const name = ensureStr(entry.name);
    if (!name) continue;
    const item = {
      name,
      issuer: ensureStr(entry.issuer) || null,
      issue_date: ensureStr(entry.issue_date) || null,
      expiry_date: ensureStr(entry.expiry_date) || null,
      credential_id: ensureStr(entry.credential_id) || null,
      credential_url: ensureStr(entry.credential_url) || null,
      description: ensureStr(entry.description) || null,
    };
    const key = [item.name, item.issuer, item.issue_date].map(normalizeText).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

const normalizeSkillGroups = (payload: Row) => {
  const grouped = new Map<string, { category: string; tags: string[] }>();
  for (const entry of ensureList(payload.skills).filter(isPlainObject)) {
    const category = ensureStr(entry.category) || '未分类';
    const tags = Array.isArray(entry.tags)
      ? textList(entry.tags)
      : typeof entry.tags === 'string'
        ? entry.tags.split(/[,，;；/\n、|]+/).map((item: string) => item.trim()).filter(Boolean)
        : [];
    if (!tags.length) continue;
    const key = normalizeText(category);
    const group = grouped.get(key) ?? { category, tags: [] };
    grouped.set(key, group);
    const seen = new Set(group.tags.map(normalizeText));
    for (const tag of tags) {
      const tagKey = normalizeText(tag);
      if (!tagKey || seen.has(tagKey)) continue;
      group.tags.push(tag);
      seen.add(tagKey);
    }
  }
  return [...grouped.values()];
};

/* ------------------------------- 路由 ------------------------------- */

const parseResumeFile = async (form: FormData | null, signal?: AbortSignal, emit?: Emit) => {
  const file = form?.get('file');
  if (!(file instanceof File)) throw badRequest('请先选择要导入的简历文件。');
  const enableThinking = ['true', '1', 'on'].includes(String(form?.get('enable_thinking') ?? '').toLowerCase());
  emit?.({ type: 'progress', node: 'receive_file', title: '接收简历附件' });
  emit?.({ type: 'progress', node: 'extract_text', title: '在本机提取简历文字' });
  const rawText = await extractAttachmentText(file, { purpose: '简历', maxChars: 400_000 });
  const cleaned = rawText.split(/\r?\n/).map((line) => (line.trim() ? cleanInline(line) : '')).join('\n');
  emit?.({ type: 'progress', node: 'ai_call', title: '调用 AI 解析简历结构' });
  const payload = await chatJson([
    { role: 'system', content: PARSER_PROMPTS.RESUME_PARSING_PROMPT },
    { role: 'user', content: cleaned.slice(0, MAX_RESUME_TEXT_CHARS) },
  ], { signal, thinking: enableThinking, emitThought: emit });
  emit?.({ type: 'progress', node: 'dedupe_result', title: '匹配并标记重复经历' });
  const items = applyDuplicateFlags(buildItems(payload));
  emit?.({ type: 'progress', node: 'finalize', title: '生成可导入结果' });
  return {
    items,
    personal_info: normalizePersonalInfo(payload),
    certifications: normalizeCertifications(payload),
    skills: normalizeSkillGroups(payload),
  };
};

route('POST', '/parser/parse', async ({ form, signal }) => ({ json: await parseResumeFile(form, signal) }));

route('POST', '/parser/parse/stream', ({ form }) => ({
  stream: async (emit, signal) => {
    const result = await parseResumeFile(form, signal, emit);
    emit({ type: 'final', result });
  },
}));
