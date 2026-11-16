/**
 * 经历库（工作 / 项目 / 教育）与经历草稿 —— 移植自 backend/app/domain/experience。
 */
import { badRequest, HttpError, notFound, route } from '../http';
import { nowIso, save, table, uuid, type Row } from '../store';
import {
  invalidateResumeAnalyses,
  isPlainObject,
  LOCAL_USER_ID,
  normalizeMonthDate,
} from './shared';

const CATEGORIES = new Set(['work', 'project', 'education']);
const JD_MATCH_CATEGORIES = new Set(['work', 'project']);

export const versionToRead = (version: Row) => ({
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
  created_at: version.created_at,
});

export const masterToRead = (master: Row) => ({
  id: master.id,
  category: master.category,
  latest_version_id: master.latest_version_id ?? null,
  is_archived: !!master.is_archived,
  created_at: master.created_at,
  updated_at: master.updated_at,
});

export const findMaster = (masterId: string): Row => {
  const master = table('masters').find((item) => item.id === masterId);
  if (!master) throw notFound('Master experience not found');
  return master;
};

export const findVersion = (versionId: string): Row => {
  const version = table('versions').find((item) => item.id === versionId);
  if (!version) throw notFound('Experience version not found');
  return version;
};

export const latestVersionOf = (master: Row): Row | null => (
  master.latest_version_id
    ? table('versions').find((item) => item.id === master.latest_version_id) ?? null
    : null
);


export const buildVersion = (masterId: string, versionNumber: number, payload: Row): Row => ({
  id: uuid(),
  master_experience_id: masterId,
  version: versionNumber,
  title: String(payload.title ?? ''),
  org: payload.org ?? null,
  location: payload.location ?? null,
  start_date: normalizeMonthDate(payload.start_date),
  end_date: normalizeMonthDate(payload.end_date),
  is_current: !!payload.is_current,
  summary: payload.summary ?? null,
  highlights: Array.isArray(payload.highlights) ? payload.highlights.map(String) : [],
  tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
  star: isPlainObject(payload.star) ? payload.star : {},
  created_at: nowIso(),
});

export const nextVersionNumber = (masterId: string): number => table('versions')
  .filter((item) => item.master_experience_id === masterId)
  .reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1;

/** 新建经历（供路由与 AI 助理「应用草稿」共用）。 */
export const createExperienceRecord = (category: string, versionPayload: Row) => {
  const createdAt = nowIso();
  const master: Row = {
    id: uuid(),
    user_id: LOCAL_USER_ID,
    category,
    latest_version_id: null,
    is_archived: false,
    created_at: createdAt,
    updated_at: createdAt,
  };
  const version = buildVersion(master.id, 1, versionPayload);
  master.latest_version_id = version.id;
  master.updated_at = nowIso();
  table('masters').push(master);
  table('versions').push(version);
  invalidateResumeAnalyses({ invalidateMatch: JD_MATCH_CATEGORIES.has(category) });
  return { master, version };
};

/** 给已有经历追加一个新版本。 */
export const appendExperienceVersion = (master: Row, versionPayload: Row) => {
  const version = buildVersion(master.id, nextVersionNumber(master.id), versionPayload);
  table('versions').push(version);
  master.latest_version_id = version.id;
  master.updated_at = nowIso();
  invalidateResumeAnalyses({ invalidateMatch: JD_MATCH_CATEGORIES.has(master.category) });
  return version;
};

const detailOf = (master: Row) => {
  const versions = table('versions')
    .filter((item) => item.master_experience_id === master.id)
    .sort((left, right) => right.version - left.version);
  const latest = versions.find((item) => item.id === master.latest_version_id) ?? null;
  return {
    master: masterToRead(master),
    latest_version: latest ? versionToRead(latest) : null,
    versions: versions.map(versionToRead),
  };
};

route('GET', '/experiences', ({ query }) => {
  const category = query.get('category');
  const keyword = (query.get('q') || '').toLowerCase();
  const includeArchived = query.get('include_archived') !== 'false';
  const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(query.get('offset')) || 0, 0);
  const rows = table('masters')
    .filter((master) => !category || master.category === category)
    .filter((master) => includeArchived || !master.is_archived)
    .map((master) => ({ master, version: latestVersionOf(master) }))
    .filter(({ version }) => {
      if (!keyword) return true;
      if (!version) return false;
      return [version.title, version.org, version.summary]
        .some((field) => typeof field === 'string' && field.toLowerCase().includes(keyword));
    })
    .sort((left, right) => (
      String(right.master.updated_at).localeCompare(String(left.master.updated_at))
      || String(right.master.id).localeCompare(String(left.master.id))
    ))
    .slice(offset, offset + limit);
  return {
    json: rows.map(({ master, version }) => ({
      master: masterToRead(master),
      latest_version: version ? versionToRead(version) : null,
    })),
  };
});

route('POST', '/experiences', async ({ body }) => {
  if (!isPlainObject(body) || !CATEGORIES.has(body.category) || !isPlainObject(body.version)
    || typeof body.version.title !== 'string') {
    throw new HttpError(422, '经历内容格式不正确。');
  }
  const { master, version } = createExperienceRecord(body.category, body.version);
  await save('masters', 'versions', 'resumes');
  return {
    json: {
      master: masterToRead(master),
      latest_version: versionToRead(version),
      versions: [versionToRead(version)],
    },
  };
});

route('GET', '/experiences/:masterId', ({ params }) => ({ json: detailOf(findMaster(params.masterId)) }));

route('PATCH', '/experiences/:masterId', async ({ params, body }) => {
  const master = findMaster(params.masterId);
  const payload: Row = isPlainObject(body) ? body : {};
  const previousCategory = master.category;
  let masterUpdated = false;
  if (payload.category !== undefined && payload.category !== null) {
    if (!CATEGORIES.has(payload.category)) throw badRequest('Unsupported experience category');
    master.category = payload.category;
    masterUpdated = true;
  }
  if (payload.is_archived !== undefined && payload.is_archived !== null) {
    master.is_archived = !!payload.is_archived;
    masterUpdated = true;
  }
  if (isPlainObject(payload.version)) {
    const version = buildVersion(master.id, nextVersionNumber(master.id), payload.version);
    table('versions').push(version);
    master.latest_version_id = version.id;
    masterUpdated = true;
  }
  if (masterUpdated) {
    master.updated_at = nowIso();
    invalidateResumeAnalyses({
      invalidateMatch: JD_MATCH_CATEGORIES.has(previousCategory) || JD_MATCH_CATEGORIES.has(master.category),
    });
    await save('masters', 'versions', 'resumes');
  }
  return { json: detailOf(master) };
});

route('DELETE', '/experiences/:masterId', async ({ params }) => {
  const master = findMaster(params.masterId);
  master.is_archived = true;
  master.updated_at = nowIso();
  invalidateResumeAnalyses({ invalidateMatch: JD_MATCH_CATEGORIES.has(master.category) });
  await save('masters', 'resumes');
  return { json: detailOf(master) };
});

route('GET', '/experience-versions/:versionId', ({ params }) => ({
  json: versionToRead(findVersion(params.versionId)),
}));

/* ------------------------------ 经历草稿 ------------------------------ */

const draftToRead = (draft: Row) => ({
  id: draft.id,
  category: draft.category,
  client_draft_key: draft.client_draft_key,
  mode: draft.mode === 'expert' ? 'expert' : 'simple',
  simple_text: draft.simple_text || '',
  card_data: draft.card_data || {},
  target_master_id: draft.target_master_id ?? null,
  updated_at: draft.updated_at,
});

const DRAFT_CATEGORIES = new Set(['work', 'project']);

route('GET', '/api/experience-drafts', ({ query }) => {
  const category = query.get('category') || '';
  if (!DRAFT_CATEGORIES.has(category)) {
    throw badRequest('Experience drafts only support work and project categories');
  }
  const drafts = table('drafts')
    .filter((draft) => draft.category === category)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  return { json: drafts.map(draftToRead) };
});

route('POST', '/api/experience-drafts', async ({ body }) => {
  const payload: Row = isPlainObject(body) ? body : {};
  const key = typeof payload.client_draft_key === 'string' ? payload.client_draft_key.trim() : '';
  if (!DRAFT_CATEGORIES.has(payload.category) || !key || key.length > 128) {
    throw badRequest('经历草稿参数不正确。');
  }
  const targetMasterId = payload.target_master_id || null;
  if (targetMasterId && !table('masters').some((master) => master.id === targetMasterId)) {
    throw notFound('Target experience not found');
  }
  const now = nowIso();
  let draft = table('drafts').find(
    (item) => item.category === payload.category && item.client_draft_key === key,
  );
  if (!draft) {
    draft = {
      id: uuid(),
      user_id: LOCAL_USER_ID,
      category: payload.category,
      client_draft_key: key,
      created_at: now,
    };
    table('drafts').push(draft);
  }
  draft.mode = payload.mode === 'expert' ? 'expert' : 'simple';
  draft.simple_text = typeof payload.simple_text === 'string' ? payload.simple_text : '';
  draft.card_data = isPlainObject(payload.card_data) ? payload.card_data : {};
  draft.target_master_id = targetMasterId;
  draft.updated_at = now;
  await save('drafts');
  return { json: draftToRead(draft) };
});

route('DELETE', '/api/experience-drafts/:draftId', async ({ params }) => {
  const drafts = table('drafts');
  const index = drafts.findIndex((draft) => draft.id === params.draftId);
  if (index < 0) throw notFound('Experience draft not found');
  const [removed] = drafts.splice(index, 1);
  await save('drafts');
  return { json: draftToRead(removed) };
});
