/**
 * 个人资料 —— 移植自 backend/app/domain/profile。
 */
import { conflict, route } from '../http';
import { nowIso, sameInstant, save, table, type Row } from '../store';
import { isPlainObject, LOCAL_USER_ID } from './shared';

const EVALUATION_FIELDS = ['full_name', 'email', 'phone', 'location', 'summary', 'social_links'];
const UPDATABLE_FIELDS = [
  'full_name', 'title', 'summary', 'location', 'phone', 'email', 'social_links', 'extra_json',
];

export const getProfileRow = (): Row => {
  const rows = table('profile');
  if (!rows.length) {
    rows.push({
      user_id: LOCAL_USER_ID,
      full_name: null,
      title: null,
      summary: null,
      location: null,
      phone: null,
      email: null,
      social_links: {},
      extra_json: {},
      updated_at: nowIso(),
    });
  }
  return rows[0];
};

const buildLegacyLinks = (socialLinks: Row) => Object.entries(socialLinks || {})
  .filter(([, data]) => isPlainObject(data) && data.url)
  .map(([label, data]) => ({
    label,
    url: (data as Row).url,
    position: Number.isInteger((data as Row).position) ? (data as Row).position : 0,
  }))
  .sort((left, right) => left.position - right.position);

export const profileToRead = (profile: Row) => ({
  user_id: profile.user_id,
  full_name: profile.full_name ?? null,
  title: profile.title ?? null,
  summary: profile.summary ?? null,
  location: profile.location ?? null,
  phone: profile.phone ?? null,
  email: profile.email ?? null,
  social_links: profile.social_links || {},
  links: buildLegacyLinks(profile.social_links || {}),
  extra_json: profile.extra_json || {},
  updated_at: profile.updated_at,
});

const socialLinkUrl = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (isPlainObject(value)) return value.url !== null && value.url !== undefined ? String(value.url) : '';
  return '';
};

const editorSnapshot = (profile: Row) => ({
  name: String(profile.full_name || ''),
  email: String(profile.email || ''),
  phone: String(profile.phone || ''),
  location: String(profile.location || ''),
  linkedin: socialLinkUrl((profile.social_links || {}).linkedin),
  summary: String(profile.summary || ''),
  avatarDataUrl: String((profile.extra_json || {}).avatar_data_url || ''),
});

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const syncGlobalResumes = (
  previous: ReturnType<typeof editorSnapshot>,
  invalidateEvaluations: boolean,
  updatedAt: string,
) => {
  let changed = false;
  for (const resume of table('resumes')) {
    const config: Row = isPlainObject(resume.config) ? resume.config : {};
    const hasMode = 'profileSyncMode' in config;
    const hasProfile = 'profile' in config;
    const embedded: Row = isPlainObject(config.profile) ? config.profile : {};
    const matchesLegacy = !hasMode && hasProfile
      && (Object.keys(previous) as Array<keyof typeof previous>).every(
        (key) => String(embedded[key] ?? '') === previous[key],
      );
    const isGlobal = config.profileSyncMode === 'global' || (!hasMode && !hasProfile) || matchesLegacy;
    if (!isGlobal) continue;
    const nextConfig: Row = { ...config, profileSyncMode: 'global' };
    delete nextConfig.profile;
    if (invalidateEvaluations && isPlainObject(nextConfig.jdAnalysis)) {
      nextConfig.jdAnalysis = { ...nextConfig.jdAnalysis, evaluationIsOutdated: true };
    }
    resume.config = nextConfig;
    resume.updated_at = updatedAt;
    changed = true;
  }
  return changed;
};

route('GET', '/profile', async () => {
  const existed = table('profile').length > 0;
  const profile = getProfileRow();
  if (!existed) await save('profile');
  return { json: profileToRead(profile) };
});

route('PATCH', '/profile', async ({ body }) => {
  const payload: Row = isPlainObject(body) ? body : {};
  const profile = getProfileRow();
  if (payload.expected_updated_at && !sameInstant(profile.updated_at, payload.expected_updated_at)) {
    throw conflict('Profile changed since it was loaded');
  }
  const update: Row = {};
  for (const field of UPDATABLE_FIELDS) {
    if (field in payload) update[field] = payload[field];
  }
  if (Array.isArray(payload.links) && (update.social_links === undefined || update.social_links === null)) {
    update.social_links = Object.fromEntries(
      payload.links
        .filter((link: unknown) => isPlainObject(link) && link.label)
        .map((link: Row) => [link.label, { url: link.url, position: link.position ?? 0 }]),
    );
  }
  for (const jsonField of ['social_links', 'extra_json']) {
    if (jsonField in update && update[jsonField] === null) update[jsonField] = {};
  }
  const previous = editorSnapshot(profile);
  const invalidates = EVALUATION_FIELDS.some(
    (field) => field in update && !sameJson(profile[field], update[field]),
  );
  Object.assign(profile, update);
  const updatedAt = nowIso();
  const next = editorSnapshot(profile);
  const resumesChanged = !sameJson(previous, next)
    && syncGlobalResumes(previous, invalidates, updatedAt);
  profile.updated_at = updatedAt;
  await save(...(resumesChanged ? ['profile', 'resumes'] as const : ['profile'] as const));
  return { json: profileToRead(profile) };
});
