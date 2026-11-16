/**
 * 技能与证书 —— 移植自 backend/app/domain/skills、domain/certifications。
 */
import { badRequest, notFound, route } from '../http';
import { nowIso, save, table, uuid, type Row } from '../store';
import { invalidateResumeAnalyses, isPlainObject, LOCAL_USER_ID } from './shared';

/* ------------------------------- 技能 ------------------------------- */

export const skillToRead = (skill: Row) => ({
  id: skill.id,
  user_id: skill.user_id,
  skill_id: skill.skill_id,
  name: skill.name,
  category: skill.category ?? null,
  proficiency: skill.proficiency ?? null,
});

/** 同名同分类的技能共用一个 skill_id（对应原版 skills 字典表）。 */
const resolveSkillId = (name: string, category: string | null): string => {
  const existing = table('userSkills').find(
    (item) => item.name === name && (item.category ?? null) === category,
  );
  return existing?.skill_id ?? uuid();
};

export const createUserSkillRecord = (name: string, category: string | null, proficiency: number | null = null) => {
  const skill: Row = {
    id: uuid(),
    user_id: LOCAL_USER_ID,
    skill_id: resolveSkillId(name, category),
    name,
    category,
    proficiency,
  };
  table('userSkills').push(skill);
  invalidateResumeAnalyses();
  return skill;
};

const findSkill = (id: string): Row => {
  const skill = table('userSkills').find((item) => item.id === id);
  if (!skill) throw notFound(`UserSkill ${id} not found`);
  return skill;
};

route('GET', '/skills', () => ({ json: table('userSkills').map(skillToRead) }));

route('POST', '/skills', async ({ body }) => {
  if (!isPlainObject(body) || typeof body.name !== 'string') throw badRequest('技能名称不能为空。');
  const skill = createUserSkillRecord(body.name, body.category ?? null, body.proficiency ?? null);
  await save('userSkills', 'resumes');
  return { json: skillToRead(skill) };
});

route('GET', '/skills/:id', ({ params }) => ({ json: skillToRead(findSkill(params.id)) }));

route('PATCH', '/skills/:id', async ({ params, body }) => {
  const skill = findSkill(params.id);
  const payload: Row = isPlainObject(body) ? body : {};
  if (payload.name || payload.category) {
    const name = payload.name || skill.name;
    const category = payload.category !== undefined && payload.category !== null
      ? payload.category
      : skill.category ?? null;
    skill.skill_id = resolveSkillId(name, category);
    skill.name = name;
    skill.category = category;
  }
  if (payload.proficiency !== undefined && payload.proficiency !== null) {
    skill.proficiency = payload.proficiency;
  }
  invalidateResumeAnalyses();
  await save('userSkills', 'resumes');
  return { json: skillToRead(skill) };
});

route('DELETE', '/skills/:id', async ({ params }) => {
  const skills = table('userSkills');
  skills.splice(skills.indexOf(findSkill(params.id)), 1);
  invalidateResumeAnalyses();
  await save('userSkills', 'resumes');
  return { status: 204 };
});

/* ------------------------------- 证书 ------------------------------- */

const CERT_FIELDS = [
  'name', 'issuer', 'issue_date', 'expiry_date', 'credential_id', 'credential_url', 'description',
];

export const certToRead = (cert: Row) => ({
  id: cert.id,
  user_id: cert.user_id,
  name: cert.name,
  issuer: cert.issuer ?? null,
  issue_date: cert.issue_date ?? null,
  expiry_date: cert.expiry_date ?? null,
  credential_id: cert.credential_id ?? null,
  credential_url: cert.credential_url ?? null,
  description: cert.description ?? null,
  created_at: cert.created_at,
  updated_at: cert.updated_at,
});

const normalizeCertDate = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const match = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/.exec(text);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${(match[3] || '1').padStart(2, '0')}`;
};

export const createCertificationRecord = (payload: Row) => {
  const now = nowIso();
  const cert: Row = {
    id: uuid(),
    user_id: LOCAL_USER_ID,
    name: String(payload.name),
    issuer: payload.issuer ?? null,
    issue_date: normalizeCertDate(payload.issue_date),
    expiry_date: normalizeCertDate(payload.expiry_date),
    credential_id: payload.credential_id ?? null,
    credential_url: payload.credential_url ?? null,
    description: payload.description ?? null,
    created_at: now,
    updated_at: now,
  };
  table('certifications').push(cert);
  invalidateResumeAnalyses();
  return cert;
};

const findCert = (id: string): Row => {
  const cert = table('certifications').find((item) => item.id === id);
  if (!cert) throw notFound(`Certification ${id} not found`);
  return cert;
};

route('GET', '/certifications', () => {
  const rows = [...table('certifications')].sort((left, right) => {
    if (!left.issue_date && !right.issue_date) return 0;
    if (!left.issue_date) return 1;
    if (!right.issue_date) return -1;
    return String(right.issue_date).localeCompare(String(left.issue_date));
  });
  return { json: rows.map(certToRead) };
});

route('POST', '/certifications', async ({ body }) => {
  if (!isPlainObject(body) || typeof body.name !== 'string') throw badRequest('证书名称不能为空。');
  const cert = createCertificationRecord(body);
  await save('certifications', 'resumes');
  return { json: certToRead(cert) };
});

route('GET', '/certifications/:id', ({ params }) => ({ json: certToRead(findCert(params.id)) }));

route('PATCH', '/certifications/:id', async ({ params, body }) => {
  const cert = findCert(params.id);
  const payload: Row = isPlainObject(body) ? body : {};
  for (const field of CERT_FIELDS) {
    if (!(field in payload)) continue;
    cert[field] = field.endsWith('_date') ? normalizeCertDate(payload[field]) : payload[field];
  }
  cert.updated_at = nowIso();
  invalidateResumeAnalyses();
  await save('certifications', 'resumes');
  return { json: certToRead(cert) };
});

route('DELETE', '/certifications/:id', async ({ params }) => {
  const certs = table('certifications');
  certs.splice(certs.indexOf(findCert(params.id)), 1);
  invalidateResumeAnalyses();
  await save('certifications', 'resumes');
  return { status: 204 };
});
