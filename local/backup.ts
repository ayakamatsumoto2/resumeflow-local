/**
 * ResumeFLOW Local Edition — 备份：按条目挑选导出，导入时挑选并合并。
 *
 * 导出：每份简历、每条经历、每个草稿、技能、证书、AI 对话都能单独勾选；
 *       选中的简历用到的经历、证书、技能会自动带上，保证导入后简历完整。
 * 导入：先列出备份里的条目，用户勾选要导入的；
 *       本机已有同一条目且内容不同 → 默认「另存一份」（新编号，简历和对话改名），也可选「覆盖」；
 *       本机已有相同内容 → 默认不导入。
 *       从不整体覆盖，本机原有的数据都会保留。
 *
 * 兼容第 1、2 版备份（那时按整块导出，格式里的 data 结构相同）。
 */
import {
  deepClone, getSettings, nowIso, ready, save, saveSettings, table, uuid,
  type CollectionName, type Row,
} from './store';

export const BACKUP_FORMAT = 'resumeflow-local-backup';
export const BACKUP_VERSION = 3;
const APP_NAME = '榫卯简历（ResumeFLOW 本地版）';

export type ItemKind = 'resume' | 'experience' | 'draft' | 'skill' | 'certification' | 'session';

export const ITEM_KINDS: Array<{ kind: ItemKind; label: string; hint?: string }> = [
  { kind: 'resume', label: '简历', hint: '含排版设置；会自动带上它用到的经历、证书和技能' },
  { kind: 'experience', label: '经历库', hint: '工作 / 项目 / 教育经历，含历史版本' },
  { kind: 'draft', label: '没写完的经历草稿' },
  { kind: 'certification', label: '证书' },
  { kind: 'skill', label: '技能' },
  { kind: 'session', label: 'AI 对话' },
];

export type ItemStatus = 'new' | 'same' | 'changed';

export interface BackupItem {
  kind: ItemKind;
  id: string;
  label: string;
  sub: string;
  /** 只在导入预览里有意义 */
  status: ItemStatus;
}

export interface BackupManifest {
  exportedAt: string;
  version: number;
  items: BackupItem[];
  profile: { present: boolean; label: string; status: ItemStatus };
  hasPhotos: boolean;
  settings: { present: boolean; hasKey: boolean };
}

/* ------------------------------ 工具函数 ------------------------------ */

const CATEGORY_LABELS: Record<string, string> = {
  work: '工作经历',
  project: '项目经历',
  education: '教育经历',
};
const categoryLabel = (category: unknown) => CATEGORY_LABELS[String(category)] || String(category || '经历');

const shortDate = (value: unknown): string => {
  const text = typeof value === 'string' ? value : '';
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
};

const monthText = (value: unknown): string => {
  const text = typeof value === 'string' ? value : '';
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7).replace('-', '.') : '';
};

const clip = (text: unknown, length = 40): string => {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return value.length > length ? `${value.slice(0, length)}…` : value;
};

/** 键排序后的 JSON，用来判断两条数据内容是否相同。 */
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return Object.keys(item).sort().reduce<Row>((acc, key) => { acc[key] = item[key]; return acc; }, {});
  }
  return item;
});

/** 把对象里所有等于旧编号的字符串（包括对象的键）换成新编号。 */
const remapDeep = <T,>(value: T, map: Map<string, string>): T => {
  if (!map.size) return value;
  const walk = (item: any): any => {
    if (typeof item === 'string') return map.get(item) ?? item;
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const next: Row = {};
      for (const [key, child] of Object.entries(item)) next[map.get(key) ?? key] = walk(child);
      return next;
    }
    return item;
  };
  return walk(value);
};

/** 收集对象里出现的所有字符串（用来找简历引用了哪些条目）。 */
const collectStrings = (value: unknown, into: Set<string>) => {
  if (typeof value === 'string') { into.add(value); return; }
  if (Array.isArray(value)) { value.forEach((item) => collectStrings(item, into)); return; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { into.add(key); collectStrings(child, into); }
  }
};

/* -------------------------------- 照片 -------------------------------- */

const profilePhoto = (row: Row | undefined): string => row?.extra_json?.avatar_data_url || '';
const resumePhoto = (row: Row | undefined): string => row?.config?.profile?.avatarDataUrl || '';

const withProfilePhoto = (row: Row, photo: string): Row => {
  const extra = { ...(row.extra_json && typeof row.extra_json === 'object' ? row.extra_json : {}) };
  if (photo) extra.avatar_data_url = photo; else delete extra.avatar_data_url;
  return { ...row, extra_json: extra };
};

const withResumePhoto = (row: Row, photo: string): Row => {
  if (!row.config?.profile || typeof row.config.profile !== 'object') return row;
  const profile = { ...row.config.profile };
  if (photo) profile.avatarDataUrl = photo; else delete profile.avatarDataUrl;
  return { ...row, config: { ...row.config, profile } };
};

/* ------------------------------ 数据快照 ------------------------------ */

type Data = Record<CollectionName, Row[]>;

const COLLECTIONS_IN_BACKUP: CollectionName[] = [
  'profile', 'masters', 'versions', 'userSkills', 'certifications', 'drafts',
  'resumes', 'links', 'assistantSessions', 'assistantMessages', 'optimizationRuns',
];

const localData = (): Data => {
  const data = {} as Data;
  for (const name of COLLECTIONS_IN_BACKUP) data[name] = table(name);
  return data;
};

const backupData = (payload: Row): Data => {
  const data = {} as Data;
  for (const name of COLLECTIONS_IN_BACKUP) {
    data[name] = Array.isArray(payload.data?.[name]) ? payload.data[name] : [];
  }
  return data;
};

const latestVersion = (data: Data, master: Row): Row | undefined => {
  const versions = data.versions.filter((item) => item.master_experience_id === master.id);
  return versions.find((item) => item.id === master.latest_version_id)
    ?? versions.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0))[0];
};

/** 每类条目：读出列表，以及比较内容时要连带比较的数据。 */
const rowsOf = (data: Data, kind: ItemKind): Row[] => {
  switch (kind) {
    case 'resume': return data.resumes;
    case 'experience': return data.masters;
    case 'draft': return data.drafts;
    case 'skill': return data.userSkills;
    case 'certification': return data.certifications;
    case 'session': return data.assistantSessions;
    default: return [];
  }
};

const describe = (data: Data, kind: ItemKind, row: Row): { label: string; sub: string } => {
  switch (kind) {
    case 'resume': {
      const parts = [row.target_role ? `目标岗位：${clip(row.target_role, 24)}` : '', shortDate(row.updated_at) && `更新于 ${shortDate(row.updated_at)}`];
      return { label: row.title || '未命名简历', sub: parts.filter(Boolean).join(' · ') };
    }
    case 'experience': {
      const version = latestVersion(data, row) || {};
      const title = [version.title, version.org].filter(Boolean).join(' @ ') || '（未填写标题）';
      const range = [monthText(version.start_date), version.is_current ? '至今' : monthText(version.end_date)].filter(Boolean).join(' – ');
      const count = data.versions.filter((item) => item.master_experience_id === row.id).length;
      return {
        label: `${categoryLabel(row.category)} · ${title}`,
        sub: [range, count > 1 ? `${count} 个版本` : '', row.is_archived ? '已归档' : ''].filter(Boolean).join(' · '),
      };
    }
    case 'draft': {
      const text = clip(row.card_data?.title || row.simple_text, 30) || '（空草稿）';
      return { label: `${categoryLabel(row.category)}草稿 · ${text}`, sub: shortDate(row.updated_at) && `更新于 ${shortDate(row.updated_at)}` };
    }
    case 'skill':
      return { label: row.name || '（未命名技能）', sub: row.category || '' };
    case 'certification':
      return { label: row.name || '（未命名证书）', sub: [row.issuer, shortDate(row.issue_date)].filter(Boolean).join(' · ') };
    case 'session': {
      const count = data.assistantMessages.filter((item) => item.session_id === row.id).length;
      return { label: row.title || 'AI 对话', sub: [`${count} 条消息`, shortDate(row.updated_at)].filter(Boolean).join(' · ') };
    }
    default:
      return { label: String(row.id), sub: '' };
  }
};

/** 用来比较「是否相同」的内容（照片不参与比较）。 */
const fingerprint = (data: Data, kind: ItemKind, row: Row): string => {
  switch (kind) {
    case 'resume':
      return stable({
        resume: withResumePhoto(row, ''),
        links: data.links.filter((item) => item.resume_id === row.id).map((item) => ({ ...item, id: undefined }))
          .sort((a, b) => stable(a).localeCompare(stable(b))),
      });
    case 'experience':
      return stable({
        master: row,
        versions: data.versions.filter((item) => item.master_experience_id === row.id)
          .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      });
    case 'session':
      return stable({
        session: row,
        messages: data.assistantMessages.filter((item) => item.session_id === row.id).length,
      });
    case 'skill':
      return stable({ name: row.name, category: row.category ?? null, proficiency: row.proficiency ?? null });
    default:
      return stable(row);
  }
};

const sameSkill = (left: Row, right: Row) => left.name === right.name && (left.category ?? null) === (right.category ?? null);

/** 判断备份里的一个条目在本机的情况。 */
const statusOf = (backup: Data, local: Data, kind: ItemKind, row: Row): ItemStatus => {
  if (kind === 'skill') {
    const match = local.userSkills.find((item) => sameSkill(item, row));
    if (!match) return 'new';
    return (match.proficiency ?? null) === (row.proficiency ?? null) ? 'same' : 'changed';
  }
  const existing = rowsOf(local, kind).find((item) => item.id === row.id);
  if (!existing) return 'new';
  return fingerprint(backup, kind, row) === fingerprint(local, kind, existing) ? 'same' : 'changed';
};

const listItems = (data: Data, compareWith?: Data): BackupItem[] => {
  const items: BackupItem[] = [];
  for (const { kind } of ITEM_KINDS) {
    const rows = [...rowsOf(data, kind)];
    rows.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    for (const row of rows) {
      if (!row?.id) continue;
      items.push({
        kind,
        id: String(row.id),
        ...describe(data, kind, row),
        status: compareWith ? statusOf(data, compareWith, kind, row) : 'new',
      });
    }
  }
  return items;
};

const profileLabel = (row: Row | undefined): string => {
  if (!row) return '';
  return [row.full_name, row.title].filter(Boolean).join(' · ') || '未填写姓名';
};

/* --------------------------- 简历用到的条目 --------------------------- */

export interface Dependencies { experience: Set<string>; certification: Set<string>; skill: Set<string>; versions: Set<string> }

/** 找出一组简历引用的经历、证书、技能（引用全部用编号表示）。 */
const dependenciesOf = (data: Data, resumeIds: Iterable<string>): Dependencies => {
  const refs = new Set<string>();
  const wanted = new Set(resumeIds);
  for (const resume of data.resumes) {
    if (wanted.has(resume.id)) collectStrings(resume.config, refs);
  }
  for (const link of data.links) {
    if (wanted.has(link.resume_id)) refs.add(String(link.experience_version_id));
  }
  const deps: Dependencies = { experience: new Set(), certification: new Set(), skill: new Set(), versions: new Set() };
  for (const version of data.versions) {
    if (refs.has(version.id)) {
      deps.versions.add(version.id);
      deps.experience.add(version.master_experience_id);
    }
  }
  for (const master of data.masters) if (refs.has(master.id)) deps.experience.add(master.id);
  for (const cert of data.certifications) if (refs.has(cert.id)) deps.certification.add(cert.id);
  for (const skill of data.userSkills) if (refs.has(skill.id) || refs.has(skill.skill_id)) deps.skill.add(skill.id);
  return deps;
};

/* -------------------------------- 导出 -------------------------------- */

/** 本机现有的全部条目（导出时供勾选）。 */
export const listLocalItems = async (): Promise<{
  items: BackupItem[];
  profile: { present: boolean; label: string };
  hasPhotos: boolean;
}> => {
  await ready();
  const data = localData();
  const profile = data.profile[0];
  return {
    items: listItems(data),
    profile: { present: !!profile, label: profileLabel(profile) },
    hasPhotos: !!profilePhoto(profile) || data.resumes.some((row) => !!resumePhoto(row)),
  };
};

/** 选中的简历会自动带上哪些条目（用于导出界面提示）。 */
export const localDependencies = (resumeIds: string[]): Dependencies => dependenciesOf(localData(), resumeIds);

export interface ExportSelection {
  ids: Partial<Record<ItemKind, string[]>>;
  profile: boolean;
  photos: boolean;
  settings: boolean;
  includeApiKey: boolean;
}

export const exportBackup = async (selection: ExportSelection) => {
  await ready();
  const local = localData();
  const pick = (kind: ItemKind) => new Set(selection.ids[kind] ?? []);
  const resumes = pick('resume');
  const experiences = pick('experience');
  const certs = pick('certification');
  const skills = pick('skill');
  const deps = dependenciesOf(local, resumes);
  deps.experience.forEach((id) => experiences.add(id));
  deps.certification.forEach((id) => certs.add(id));
  deps.skill.forEach((id) => skills.add(id));
  const drafts = pick('draft');
  const sessions = pick('session');

  const data: Partial<Data> = {
    resumes: local.resumes.filter((row) => resumes.has(row.id)),
    links: local.links.filter((row) => resumes.has(row.resume_id)),
    optimizationRuns: local.optimizationRuns.filter((row) => resumes.has(row.resume_id)),
    masters: local.masters.filter((row) => experiences.has(row.id)),
    versions: local.versions.filter((row) => experiences.has(row.master_experience_id)),
    drafts: local.drafts.filter((row) => drafts.has(row.id)),
    certifications: local.certifications.filter((row) => certs.has(row.id)),
    userSkills: local.userSkills.filter((row) => skills.has(row.id)),
    assistantSessions: local.assistantSessions.filter((row) => sessions.has(row.id)),
    assistantMessages: local.assistantMessages.filter((row) => sessions.has(row.session_id)),
    profile: selection.profile ? local.profile.slice(0, 1) : [],
  };
  const cloned = deepClone(data) as Data;
  if (!selection.photos) {
    cloned.profile = cloned.profile.map((row) => withProfilePhoto(row, ''));
    cloned.resumes = cloned.resumes.map((row) => withResumePhoto(row, ''));
  }
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(cloned)) counts[name] = rows.length;

  const payload: Row = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: APP_NAME,
    exportedAt: new Date().toISOString(),
    photos: selection.photos,
    counts,
    data: cloned,
  };
  if (selection.settings) {
    const settings = deepClone(getSettings());
    if (!selection.includeApiKey && settings.ai && typeof settings.ai === 'object') {
      settings.ai = { ...settings.ai, apiKey: '' };
    }
    payload.settings = settings;
  }
  return payload;
};

/* -------------------------------- 导入 -------------------------------- */

const checkFormat = (payload: unknown): Row => {
  if (!payload || typeof payload !== 'object') throw new Error('备份文件格式不正确。');
  const record = payload as Row;
  if (record.format !== BACKUP_FORMAT || !record.data || typeof record.data !== 'object') {
    throw new Error('这不是榫卯简历（ResumeFLOW 本地版）的备份文件。');
  }
  return record;
};

/** 读出备份里有哪些条目，以及它们和本机数据的关系。 */
export const inspectBackup = async (payload: unknown): Promise<BackupManifest> => {
  await ready();
  const record = checkFormat(payload);
  const backup = backupData(record);
  const local = localData();
  const backupProfile = backup.profile[0];
  const localProfile = local.profile[0];
  let profileStatus: ItemStatus = 'new';
  if (backupProfile && localProfile) {
    const strip = (row: Row) => { const { updated_at: _u, ...rest } = withProfilePhoto(row, ''); return rest; };
    profileStatus = stable(strip(backupProfile)) === stable(strip(localProfile)) ? 'same' : 'changed';
  }
  return {
    exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
    version: Number(record.version) || 1,
    items: listItems(backup, local),
    profile: { present: !!backupProfile, label: profileLabel(backupProfile), status: profileStatus },
    hasPhotos: !!profilePhoto(backupProfile) || backup.resumes.some((row) => !!resumePhoto(row)),
    settings: {
      present: !!record.settings && typeof record.settings === 'object',
      hasKey: !!record.settings?.ai?.apiKey,
    },
  };
};

/** 本机已有的条目怎么处理：另存一份 / 覆盖。新条目直接加入。 */
export type ConflictChoice = 'copy' | 'overwrite';

export interface ImportPlan {
  /** 要导入的条目，键为 `${kind}:${id}` */
  selected: Set<string>;
  /** 本机已有的条目的处理方式，键同上；未写时按「另存一份」 */
  choices: Record<string, ConflictChoice>;
  profile: boolean;
  photos: boolean;
  settings: boolean;
}

export const itemKey = (kind: ItemKind, id: string) => `${kind}:${id}`;

export interface ImportResult {
  added: number;
  copied: number;
  overwritten: number;
  autoAdded: number;
}

/** 生成不重复的副本名称：「标题（导入）」「标题（导入 2）」… */
const copyTitle = (title: string, existing: Row[], field = 'title'): string => {
  const base = title || '未命名';
  const taken = new Set(existing.map((row) => row[field]));
  let candidate = `${base}（导入）`;
  for (let index = 2; taken.has(candidate); index += 1) candidate = `${base}（导入 ${index}）`;
  return candidate;
};

export const importBackup = async (payload: unknown, plan: ImportPlan): Promise<ImportResult> => {
  await ready();
  const record = checkFormat(payload);
  const backup = deepClone(backupData(record)) as Data;
  const local = localData();
  const result: ImportResult = { added: 0, copied: 0, overwritten: 0, autoAdded: 0 };
  const idMap = new Map<string, string>();
  const touched = new Set<CollectionName>();
  const isSelected = (kind: ItemKind, id: string) => plan.selected.has(itemKey(kind, id));
  const choiceOf = (kind: ItemKind, id: string): ConflictChoice => plan.choices[itemKey(kind, id)] ?? 'copy';

  // 选中的简历用到、但本机没有的经历 / 证书 / 技能，自动一起导入，保证简历完整。
  const selectedResumes = backup.resumes.filter((row) => isSelected('resume', row.id)).map((row) => row.id);
  const deps = dependenciesOf(backup, selectedResumes);

  /* 技能：同名同分类视为同一个技能 */
  for (const skill of backup.userSkills) {
    const match = local.userSkills.find((item) => sameSkill(item, skill));
    const wanted = isSelected('skill', skill.id);
    const needed = deps.skill.has(skill.id);
    if (match) {
      if (match.id !== skill.id) idMap.set(skill.id, match.id);
      if (match.skill_id && skill.skill_id && match.skill_id !== skill.skill_id) idMap.set(skill.skill_id, match.skill_id);
      if (wanted && (match.proficiency ?? null) !== (skill.proficiency ?? null) && choiceOf('skill', skill.id) === 'overwrite') {
        match.proficiency = skill.proficiency ?? null;
        touched.add('userSkills');
        result.overwritten += 1;
      }
      continue;
    }
    if (!wanted && !needed) continue;
    const row = { ...skill };
    if (local.userSkills.some((item) => item.id === row.id)) {
      row.id = uuid();
      idMap.set(skill.id, row.id);
    }
    local.userSkills.push(row);
    touched.add('userSkills');
    if (wanted) result.added += 1; else result.autoAdded += 1;
  }

  /* 证书 */
  for (const cert of backup.certifications) {
    const wanted = isSelected('certification', cert.id);
    const existingIndex = local.certifications.findIndex((item) => item.id === cert.id);
    const needed = deps.certification.has(cert.id) && existingIndex < 0;
    if (!wanted && !needed) continue;
    if (existingIndex < 0) {
      local.certifications.push(cert);
      if (wanted) result.added += 1; else result.autoAdded += 1;
    } else if (statusOf(backup, localData(), 'certification', cert) === 'same') {
      continue;
    } else if (choiceOf('certification', cert.id) === 'overwrite') {
      local.certifications[existingIndex] = cert;
      result.overwritten += 1;
    } else {
      const now = nowIso();
      const row = { ...cert, id: uuid(), created_at: now, updated_at: now };
      idMap.set(cert.id, row.id);
      local.certifications.push(row);
      result.copied += 1;
    }
    touched.add('certifications');
  }

  /* 经历（主条目 + 全部版本） */
  for (const master of backup.masters) {
    const wanted = isSelected('experience', master.id);
    const versions = backup.versions.filter((item) => item.master_experience_id === master.id);
    const existingIndex = local.masters.findIndex((item) => item.id === master.id);
    if (!wanted) {
      if (!deps.experience.has(master.id)) continue;
      if (existingIndex < 0) {
        // 本机没有：整条加入
        local.masters.push(master);
        local.versions.push(...versions);
        result.autoAdded += 1;
      } else {
        // 本机有：只补上简历用到、本机缺少的历史版本，不改动本机的当前内容
        const missing = versions.filter((item) => deps.versions.has(item.id) && !local.versions.some((row) => row.id === item.id));
        if (!missing.length) continue;
        local.versions.push(...missing);
      }
      touched.add('masters').add('versions');
      continue;
    }
    if (existingIndex < 0) {
      local.masters.push(master);
      local.versions.push(...versions);
      result.added += 1;
    } else if (statusOf(backup, localData(), 'experience', master) === 'same') {
      continue;
    } else if (choiceOf('experience', master.id) === 'overwrite') {
      // 覆盖：主条目换成备份的；版本按编号更新，本机独有的旧版本保留（别的简历可能还在用）
      local.masters[existingIndex] = master;
      for (const version of versions) {
        const index = local.versions.findIndex((item) => item.id === version.id);
        if (index >= 0) local.versions[index] = version; else local.versions.push(version);
      }
      result.overwritten += 1;
    } else {
      const newMasterId = uuid();
      idMap.set(master.id, newMasterId);
      const now = nowIso();
      for (const version of versions) {
        const newId = uuid();
        idMap.set(version.id, newId);
        local.versions.push({ ...version, id: newId, master_experience_id: newMasterId });
      }
      local.masters.push({
        ...master,
        id: newMasterId,
        latest_version_id: idMap.get(master.latest_version_id) ?? master.latest_version_id ?? null,
        created_at: now,
        updated_at: now,
      });
      result.copied += 1;
    }
    touched.add('masters').add('versions');
  }

  /* 经历草稿 */
  for (const draft of backup.drafts) {
    if (!isSelected('draft', draft.id)) continue;
    const row = { ...draft, target_master_id: draft.target_master_id ? (idMap.get(draft.target_master_id) ?? draft.target_master_id) : null };
    const existingIndex = local.drafts.findIndex((item) => item.id === draft.id);
    const keyClash = local.drafts.findIndex((item) => item.category === draft.category && item.client_draft_key === draft.client_draft_key);
    if (existingIndex < 0 && keyClash < 0) {
      local.drafts.push(row);
      result.added += 1;
    } else if (existingIndex >= 0 && stable(local.drafts[existingIndex]) === stable(draft)) {
      continue;
    } else if (choiceOf('draft', draft.id) === 'overwrite') {
      local.drafts.splice(existingIndex >= 0 ? existingIndex : keyClash, 1, row);
      result.overwritten += 1;
    } else {
      local.drafts.push({ ...row, id: uuid(), client_draft_key: `${draft.client_draft_key || 'draft'}-import-${uuid().slice(0, 8)}` });
      result.copied += 1;
    }
    touched.add('drafts');
  }

  /* 简历 */
  const remapResume = (row: Row): Row => ({ ...row, config: remapDeep(row.config ?? {}, idMap) });
  const remapLink = (link: Row, resumeId: string, newIds: boolean): Row => ({
    ...link,
    id: newIds ? uuid() : link.id,
    resume_id: resumeId,
    experience_version_id: idMap.get(link.experience_version_id) ?? link.experience_version_id,
  });
  for (const resume of backup.resumes) {
    if (!isSelected('resume', resume.id)) continue;
    const links = backup.links.filter((item) => item.resume_id === resume.id);
    const runs = backup.optimizationRuns.filter((item) => item.resume_id === resume.id);
    const existingIndex = local.resumes.findIndex((item) => item.id === resume.id);
    let row = remapResume(resume);
    if (!plan.photos) row = withResumePhoto(row, '');
    if (existingIndex < 0) {
      local.resumes.push(row);
      local.links.push(...links.map((link) => remapLink(link, resume.id, false)));
      local.optimizationRuns.push(...runs);
      result.added += 1;
    } else if (statusOf(backup, localData(), 'resume', resume) === 'same') {
      continue;
    } else if (choiceOf('resume', resume.id) === 'overwrite') {
      if (!plan.photos || !resumePhoto(resume)) row = withResumePhoto(row, resumePhoto(local.resumes[existingIndex]));
      local.resumes[existingIndex] = row;
      const keptLinks = local.links.filter((item) => item.resume_id !== resume.id);
      keptLinks.push(...links.map((link) => remapLink(link, resume.id, false)));
      local.links.splice(0, local.links.length, ...keptLinks);
      const keptRuns = local.optimizationRuns.filter((item) => item.resume_id !== resume.id);
      keptRuns.push(...runs);
      local.optimizationRuns.splice(0, local.optimizationRuns.length, ...keptRuns);
      result.overwritten += 1;
    } else {
      const newId = uuid();
      const now = nowIso();
      local.resumes.push({ ...row, id: newId, title: copyTitle(resume.title, local.resumes), created_at: now, updated_at: now });
      local.links.push(...links.map((link) => remapLink(link, newId, true)));
      local.optimizationRuns.push(...runs.map((run) => ({ ...run, id: uuid(), resume_id: newId })));
      idMap.set(resume.id, newId);
      result.copied += 1;
    }
    touched.add('resumes').add('links').add('optimizationRuns');
  }

  /* AI 对话（连同全部消息） */
  for (const session of backup.assistantSessions) {
    if (!isSelected('session', session.id)) continue;
    const messages = backup.assistantMessages.filter((item) => item.session_id === session.id);
    const existingIndex = local.assistantSessions.findIndex((item) => item.id === session.id);
    const row = { ...session, context_json: remapDeep(session.context_json ?? {}, idMap) };
    if (existingIndex < 0) {
      local.assistantSessions.push(row);
      local.assistantMessages.push(...messages);
      result.added += 1;
    } else if (statusOf(backup, localData(), 'session', session) === 'same') {
      continue;
    } else if (choiceOf('session', session.id) === 'overwrite') {
      local.assistantSessions[existingIndex] = row;
      const kept = local.assistantMessages.filter((item) => item.session_id !== session.id);
      kept.push(...messages);
      local.assistantMessages.splice(0, local.assistantMessages.length, ...kept);
      result.overwritten += 1;
    } else {
      const newId = uuid();
      local.assistantSessions.push({ ...row, id: newId, title: copyTitle(session.title, local.assistantSessions) });
      local.assistantMessages.push(...messages.map((message) => ({ ...message, id: uuid(), session_id: newId })));
      result.copied += 1;
    }
    touched.add('assistantSessions').add('assistantMessages');
  }

  /* 个人资料：只有一份，勾选了才覆盖 */
  const backupProfile = backup.profile[0];
  if (plan.profile && backupProfile) {
    const current = local.profile[0];
    let row: Row = { ...backupProfile, updated_at: nowIso() };
    if (!plan.photos || !profilePhoto(backupProfile)) row = withProfilePhoto(row, profilePhoto(current));
    local.profile.splice(0, local.profile.length, row);
    touched.add('profile');
    result.overwritten += current ? 1 : 0;
    result.added += current ? 0 : 1;
  }

  if (touched.size) await save(...touched);

  /* 本程序的设置：API Key 为空时保留本机的 */
  if (plan.settings && record.settings && typeof record.settings === 'object') {
    const current = getSettings();
    const imported = deepClone(record.settings);
    if (imported.ai && !imported.ai.apiKey && current?.ai?.apiKey) imported.ai.apiKey = current.ai.apiKey;
    if (!imported.ai && current.ai) imported.ai = current.ai;
    await saveSettings({ ...current, ...imported });
  }
  return result;
};
