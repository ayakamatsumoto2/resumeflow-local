/**
 * 简历与简历-经历装配 —— 移植自 backend/app/domain/resume/resume_service.py。
 */
import { badRequest, conflict, notFound, route } from '../http';
import {
  deepClone, nowIso, sameInstant, save, table, uuid, type Row,
} from '../store';
import { findVersion } from './experiences';
import { isPlainObject, LOCAL_USER_ID, normalizeMonthDate } from './shared';

const ALLOWED_OVERRIDE_KEYS = new Set([
  'title', 'org', 'location', 'start_date', 'end_date', 'is_current',
  'summary', 'highlights', 'tags', 'star',
]);

export const resumeToRead = (resume: Row) => ({
  id: resume.id,
  user_id: resume.user_id,
  title: resume.title,
  target_role: resume.target_role ?? null,
  config: resume.config || {},
  created_at: resume.created_at,
  updated_at: resume.updated_at,
});

export const findResume = (resumeId: string): Row => {
  const resume = table('resumes').find((item) => item.id === resumeId);
  if (!resume) throw notFound('Resume not found');
  return resume;
};

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

const targetRoleSignature = (targetRole: unknown) => JSON.stringify({
  targetRole: String(targetRole || '').trim(),
});

const markEvaluationOutdated = (config: unknown) => {
  if (!isPlainObject(config) || !isPlainObject(config.jdAnalysis)) return config;
  if (config.jdAnalysis.evaluationIsOutdated === true) return config;
  return { ...config, jdAnalysis: { ...config.jdAnalysis, evaluationIsOutdated: true } };
};

const markAnalysisOutdated = (config: unknown) => {
  if (!isPlainObject(config) || !isPlainObject(config.jdAnalysis)) return config;
  const analysis = config.jdAnalysis;
  if (analysis.isOutdated === true && analysis.evaluationIsOutdated === true) return config;
  return { ...config, jdAnalysis: { ...analysis, isOutdated: true, evaluationIsOutdated: true } };
};

const presence = (mapping: unknown, key: string) => (
  isPlainObject(mapping)
    ? { present: key in mapping, value: mapping[key] ?? null }
    : { present: false, value: null }
);

const selectionPresence = (mapping: unknown, key: string) => {
  const projected = presence(mapping, key);
  if (Array.isArray(projected.value)) {
    projected.value = [...new Set(projected.value.map(String).filter(Boolean))].sort();
  }
  return projected;
};

/** 只投影会影响「被评估的简历快照」的配置字段。 */
const evaluationProjection = (config: unknown) => {
  if (!isPlainObject(config)) return {};
  const layout = config.layout;
  const summaryVisible = !(isPlainObject(layout) && layout.isSummaryVisible === false);
  const profile = config.profile;
  let profileProjection: Row | null = null;
  if (config.profileSyncMode !== 'global' && isPlainObject(profile)) {
    profileProjection = {};
    for (const key of ['name', 'email', 'phone', 'location', 'linkedin', ...(summaryVisible ? ['summary'] : [])]) {
      profileProjection[key] = profile[key] ?? null;
    }
  }
  return {
    profileSyncMode: presence(config, 'profileSyncMode'),
    careerStage: config.careerStage ?? 'unspecified',
    skillOverrides: config.skillOverrides ?? {},
    educationOverrides: config.educationOverrides ?? {},
    localSkills: config.localSkills ?? {},
    profile: profileProjection,
    personalSummary: summaryVisible ? presence(config, 'personalSummary') : { present: false, value: null },
    selection: Object.fromEntries(
      ['experienceIds', 'educationIds', 'certificationIds', 'skillIds']
        .map((key) => [key, selectionPresence(config.selection, key)]),
    ),
    layout: Object.fromEntries(
      ['sectionOrder', 'isSummaryVisible', 'orders'].map((key) => [key, presence(layout, key)]),
    ),
  };
};

const invalidateForConfigChange = (previousConfig: unknown, nextConfig: unknown) => {
  const previousAnalysis = isPlainObject(previousConfig) ? previousConfig.jdAnalysis : null;
  const nextAnalysis = isPlainObject(nextConfig) ? nextConfig.jdAnalysis : null;
  if (!isPlainObject(previousAnalysis) || !isPlainObject(nextAnalysis)) return nextConfig;
  if (stable(evaluationProjection(previousConfig)) === stable(evaluationProjection(nextConfig))) {
    return nextConfig;
  }
  return markEvaluationOutdated(nextConfig);
};

const invalidateForTargetRole = (config: unknown, targetRole: unknown, previousTargetRole: unknown) => {
  if (!isPlainObject(config) || !isPlainObject(config.jdAnalysis)) return config;
  const expected = targetRoleSignature(targetRole);
  if (config.jdAnalysis.targetRoleSignature !== expected) return markEvaluationOutdated(config);
  if (targetRoleSignature(previousTargetRole) === expected) return config;
  return markEvaluationOutdated(config);
};

const filterOverrides = (overrides: unknown): Row => {
  const safe: Row = isPlainObject(overrides) ? { ...overrides } : {};
  for (const key of ['start_date', 'end_date']) {
    if (!(key in safe)) continue;
    const normalized = normalizeMonthDate(safe[key]);
    if (normalized) safe[key] = normalized;
    else delete safe[key];
  }
  return Object.fromEntries(Object.entries(safe).filter(([key]) => ALLOWED_OVERRIDE_KEYS.has(key)));
};

const linksOf = (resumeId: string) => table('links')
  .filter((link) => link.resume_id === resumeId)
  .sort((left, right) => left.display_order - right.display_order);

const buildResumeExperience = (link: Row) => {
  const version = table('versions').find((item) => item.id === link.experience_version_id);
  if (!version) return null;
  const merged: Row = {
    id: version.id,
    master_experience_id: version.master_experience_id,
    version: version.version,
    title: version.title,
    org: version.org ?? null,
    location: version.location ?? null,
    start_date: version.start_date ?? null,
    end_date: version.end_date ?? null,
    is_current: !!version.is_current,
    summary: version.summary ?? null,
    highlights: version.highlights || [],
    tags: version.tags || [],
    star: version.star || {},
  };
  for (const [key, value] of Object.entries(filterOverrides(link.overrides_json))) {
    if (key in merged) merged[key] = value;
  }
  merged.start_date = normalizeMonthDate(merged.start_date);
  merged.end_date = normalizeMonthDate(merged.end_date);
  return {
    id: link.id,
    resume_id: link.resume_id,
    experience_version_id: link.experience_version_id,
    display_order: link.display_order,
    overrides_json: link.overrides_json || {},
    experience: merged,
  };
};

export const resumeDetail = (resume: Row) => ({
  resume: resumeToRead(resume),
  experiences: linksOf(resume.id).map(buildResumeExperience).filter(Boolean),
});

const assertFresh = (resume: Row, expected: unknown, message: string) => {
  if (!sameInstant(resume.updated_at, expected)) throw conflict(message);
};

route('GET', '/resumes', ({ query }) => {
  const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(query.get('offset')) || 0, 0);
  const rows = [...table('resumes')]
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(offset, offset + limit);
  return { json: rows.map(resumeToRead) };
});

route('POST', '/resumes', async ({ body }) => {
  if (!isPlainObject(body) || typeof body.title !== 'string') throw badRequest('简历标题不能为空。');
  const now = nowIso();
  const resume: Row = {
    id: uuid(),
    user_id: LOCAL_USER_ID,
    title: body.title,
    target_role: body.target_role ?? null,
    config: isPlainObject(body.config) ? body.config : {},
    created_at: now,
    updated_at: now,
  };
  table('resumes').push(resume);
  await save('resumes');
  return { json: resumeToRead(resume) };
});

route('GET', '/resumes/:resumeId', ({ params }) => ({ json: resumeDetail(findResume(params.resumeId)) }));

route('PATCH', '/resumes/:resumeId', async ({ params, body }) => {
  const payload: Row = isPlainObject(body) ? body : {};
  const has = (key: string) => payload[key] !== undefined && payload[key] !== null;
  if (!has('expected_updated_at') && (has('title') || has('config') || has('target_role'))) {
    throw conflict('expected_updated_at is required when changing resume content.');
  }
  const resume = findResume(params.resumeId);
  if (has('expected_updated_at')) {
    assertFresh(resume, payload.expected_updated_at, 'Resume changed since it was loaded. Reload before saving again.');
  }
  const previousTitle = resume.title;
  const previousConfig = deepClone(resume.config);
  const previousTargetRole = resume.target_role;
  const targetRoleChanged = has('target_role') && resume.target_role !== payload.target_role;
  if (has('title')) resume.title = payload.title;
  if (has('target_role')) resume.target_role = payload.target_role;
  if (has('config')) {
    resume.config = invalidateForConfigChange(previousConfig, payload.config);
  }
  if (targetRoleChanged) {
    resume.config = invalidateForTargetRole(resume.config, resume.target_role, previousTargetRole);
  }
  const unchanged = resume.title === previousTitle
    && resume.target_role === previousTargetRole
    && stable(resume.config) === stable(previousConfig);
  if (!unchanged) {
    resume.updated_at = nowIso();
    await save('resumes');
  }
  return { json: resumeToRead(resume) };
});

route('DELETE', '/resumes/:resumeId', async ({ params }) => {
  const resume = findResume(params.resumeId);
  const resumes = table('resumes');
  resumes.splice(resumes.indexOf(resume), 1);
  const links = table('links');
  for (let index = links.length - 1; index >= 0; index -= 1) {
    if (links[index].resume_id === resume.id) links.splice(index, 1);
  }
  await save('resumes', 'links');
  return { status: 204 };
});

route('POST', '/resumes/:resumeId/duplicate', async ({ params, body }) => {
  const source = findResume(params.resumeId);
  const config = isPlainObject(source.config) ? deepClone(source.config) : {};
  delete config.jdAnalysis;
  delete config.bossGreeting;
  const now = nowIso();
  const duplicated: Row = {
    id: uuid(),
    user_id: LOCAL_USER_ID,
    title: (isPlainObject(body) && typeof body.title === 'string' && body.title) || `${source.title} (副本)`,
    target_role: source.target_role ?? null,
    config,
    created_at: now,
    updated_at: now,
  };
  table('resumes').push(duplicated);
  for (const link of linksOf(source.id)) {
    table('links').push({
      id: uuid(),
      resume_id: duplicated.id,
      experience_version_id: link.experience_version_id,
      overrides_json: { ...(link.overrides_json || {}) },
      display_order: link.display_order,
      created_at: now,
    });
  }
  await save('resumes', 'links');
  return { json: resumeToRead(duplicated) };
});

const OP_REQUIREMENTS: Record<string, string[]> = {
  add: ['experience_version_id'],
  remove: ['resume_experience_id'],
  reorder: ['resume_experience_id', 'display_order'],
  override: ['resume_experience_id', 'overrides_json'],
};

route('PATCH', '/resumes/:resumeId/assembly', async ({ params, body }) => {
  const payload: Row = isPlainObject(body) ? body : {};
  if (payload.expected_updated_at === undefined || payload.expected_updated_at === null) {
    throw conflict('expected_updated_at is required when changing resume assembly.');
  }
  const resume = findResume(params.resumeId);
  assertFresh(resume, payload.expected_updated_at, 'Resume changed since it was loaded. Reload before saving again.');
  const operations: Row[] = Array.isArray(payload.operations) ? payload.operations : [];
  for (const op of operations) {
    const required = OP_REQUIREMENTS[op?.op];
    if (!required) throw badRequest(`Unsupported op: ${op?.op}`);
    const missing = required.filter((key) => !(key in op));
    if (missing.length) throw badRequest(`Missing fields for ${op.op}: ${missing.sort().join(', ')}`);
  }
  const links = table('links');
  const getLink = (linkId: string) => {
    const link = links.find((item) => item.id === linkId && item.resume_id === resume.id);
    if (!link) throw notFound('Resume experience not found');
    return link;
  };
  // 先在副本上执行全部操作，任何一步失败都不落盘（等价于原版的事务回滚）。
  const snapshot = deepClone(links);
  try {
    for (const op of operations) {
      if (op.op === 'add') {
        findVersion(op.experience_version_id);
        const displayOrder = 'display_order' in op
          ? Number(op.display_order)
          : linksOf(resume.id).reduce((max, link) => Math.max(max, link.display_order), -1) + 1;
        links.push({
          id: uuid(),
          resume_id: resume.id,
          experience_version_id: op.experience_version_id,
          overrides_json: {},
          display_order: displayOrder,
          created_at: nowIso(),
        });
      } else if (op.op === 'remove') {
        links.splice(links.indexOf(getLink(op.resume_experience_id)), 1);
      } else if (op.op === 'reorder') {
        getLink(op.resume_experience_id).display_order = Number(op.display_order);
      } else if (op.op === 'override') {
        const link = getLink(op.resume_experience_id);
        if (op.experience_version_id !== undefined && op.experience_version_id !== null) {
          findVersion(op.experience_version_id);
          link.experience_version_id = op.experience_version_id;
        }
        const overrides = filterOverrides(op.overrides_json || {});
        let existing: Row = isPlainObject(link.overrides_json) ? link.overrides_json : {};
        const clearKeys: string[] = Array.isArray(op.clear_override_keys)
          ? op.clear_override_keys.filter((key: unknown) => typeof key === 'string' && ALLOWED_OVERRIDE_KEYS.has(key))
          : [];
        if (clearKeys.length) {
          existing = Object.fromEntries(Object.entries(existing).filter(([key]) => !clearKeys.includes(key)));
        }
        link.overrides_json = { ...existing, ...overrides };
      }
    }
  } catch (error) {
    links.splice(0, links.length, ...snapshot);
    throw error;
  }
  if (operations.length) {
    resume.config = markAnalysisOutdated(resume.config);
  }
  resume.updated_at = nowIso();
  await save('resumes', 'links');
  return { json: resumeDetail(resume) };
});

/** 把 BOSS 招呼语写回简历配置（对应 persist_resume_boss_greeting）。 */
export const persistBossGreeting = async (
  resumeId: string,
  greeting: string,
  signature: string | null | undefined,
  expectedUpdatedAt: unknown,
): Promise<Row> => {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null) {
    throw conflict('expected_updated_at is required when persisting a boss greeting.');
  }
  const resume = findResume(resumeId);
  assertFresh(resume, expectedUpdatedAt, 'Resume changed while the boss greeting was generated. Regenerate it.');
  resume.config = {
    ...(isPlainObject(resume.config) ? resume.config : {}),
    bossGreeting: { greeting, ...(signature ? { signature } : {}) },
  };
  resume.updated_at = nowIso();
  await save('resumes');
  return resume;
};
