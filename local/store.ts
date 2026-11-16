/**
 * ResumeFLOW Local Edition — 本地数据层。
 * 所有数据保存在本机浏览器/WebView 的 IndexedDB 中，不经过任何服务器。
 * 数据量很小（单用户），启动时整体读入内存，写入时按集合落盘。
 */

export type Row = Record<string, any>;

export const COLLECTIONS = [
  'profile',
  'masters',
  'versions',
  'userSkills',
  'certifications',
  'drafts',
  'resumes',
  'links',
  'assistantSessions',
  'assistantMessages',
  'optimizationRuns',
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

const DB_NAME = 'resumeflow-local';
const STORE_NAME = 'kv';
const SETTINGS_KEY = '__settings__';

let dbPromise: Promise<IDBDatabase> | null = null;
let loadPromise: Promise<void> | null = null;
const cache: Record<string, Row[]> = {};
let settingsCache: Row = {};
let writeChain: Promise<void> = Promise.resolve();

const openDb = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'));
    });
  }
  return dbPromise;
};

const idbGet = async (key: string): Promise<any> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const idbPutMany = async (entries: Array<[string, any]>): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const [key, value] of entries) {
      store.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('本地数据写入被中止'));
  });
};

export const ready = (): Promise<void> => {
  if (!loadPromise) {
    loadPromise = (async () => {
      for (const name of COLLECTIONS) {
        const value = await idbGet(name);
        cache[name] = Array.isArray(value) ? value : [];
      }
      const settings = await idbGet(SETTINGS_KEY);
      settingsCache = settings && typeof settings === 'object' ? settings : {};
    })();
  }
  return loadPromise;
};

/** 读取集合（返回内存中的活动数组，修改后须调用 save）。 */
export const table = (name: CollectionName): Row[] => {
  if (!cache[name]) {
    cache[name] = [];
  }
  return cache[name];
};

export const setTable = (name: CollectionName, rows: Row[]) => {
  cache[name] = rows;
};

const clone = <T,>(value: T): T => (
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
);

/** 把指定集合写回 IndexedDB（串行，保证顺序）。 */
export const save = (...names: CollectionName[]): Promise<void> => {
  const entries = names.map((name) => [name, clone(table(name))] as [string, any]);
  writeChain = writeChain.catch(() => undefined).then(() => idbPutMany(entries));
  return writeChain;
};

export const getSettings = (): Row => settingsCache;

export const saveSettings = (next: Row): Promise<void> => {
  settingsCache = { ...next };
  const snapshot = clone(settingsCache);
  writeChain = writeChain.catch(() => undefined).then(() => idbPutMany([[SETTINGS_KEY, snapshot]]));
  return writeChain;
};

export const uuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
};

let lastTimestamp = 0;
/** 单调递增的 ISO 时间戳（毫秒级），保证乐观锁比较不会撞值。 */
export const nowIso = (): string => {
  const now = Math.max(Date.now(), lastTimestamp + 1);
  lastTimestamp = now;
  return new Date(now).toISOString();
};

export const sameInstant = (left: unknown, right: unknown): boolean => {
  const a = new Date(String(left)).getTime();
  const b = new Date(String(right)).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
};

export const deepClone = clone;

/* ------------------------- 备份导出 / 导入 ------------------------- */

export const BACKUP_FORMAT = 'resumeflow-local-backup';
export const BACKUP_VERSION = 2;

/** 备份可以按「部分」选择导出 / 导入。 */
export type BackupPart = 'profile' | 'experiences' | 'resumes' | 'skills' | 'assistant' | 'photos' | 'settings';

export const BACKUP_PARTS: Array<{ id: BackupPart; label: string; hint: string }> = [
  { id: 'profile', label: '个人资料', hint: '姓名、联系方式、个人简介' },
  { id: 'experiences', label: '经历库', hint: '工作 / 项目 / 教育经历，含历史版本和未写完的草稿' },
  { id: 'resumes', label: '简历', hint: '每份简历的内容、排版设置、JD 分析结果' },
  { id: 'skills', label: '技能和证书', hint: '' },
  { id: 'assistant', label: 'AI 对话记录', hint: 'AI 助手的全部会话' },
  { id: 'photos', label: '照片', hint: '个人资料和简历里的头像；不选则备份更小' },
  { id: 'settings', label: '本程序的设置', hint: 'AI 接口等（API Key 另外选择）' },
];

/** 每个部分对应的数据集合（照片、设置不是独立集合）。 */
const PART_COLLECTIONS: Record<BackupPart, CollectionName[]> = {
  profile: ['profile'],
  experiences: ['masters', 'versions', 'drafts'],
  resumes: ['resumes', 'links', 'optimizationRuns'],
  skills: ['userSkills', 'certifications'],
  assistant: ['assistantSessions', 'assistantMessages'],
  photos: [],
  settings: [],
};

const ALL_PARTS = BACKUP_PARTS.map((part) => part.id);

/* 照片：个人资料 extra_json.avatar_data_url，以及单份简历自己的 config.profile.avatarDataUrl */

const stripPhotos = (name: CollectionName, rows: Row[]): Row[] => rows.map((row) => {
  if (name === 'profile' && row.extra_json && typeof row.extra_json === 'object' && 'avatar_data_url' in row.extra_json) {
    const extra = { ...row.extra_json };
    delete extra.avatar_data_url;
    return { ...row, extra_json: extra };
  }
  if (name === 'resumes' && row.config?.profile && typeof row.config.profile === 'object' && 'avatarDataUrl' in row.config.profile) {
    const profile = { ...row.config.profile };
    delete profile.avatarDataUrl;
    return { ...row, config: { ...row.config, profile } };
  }
  return row;
});

/** 导入不含照片的备份时，保留本机已有的照片。 */
const keepExistingPhotos = (name: CollectionName, imported: Row[], existing: Row[]): Row[] => {
  if (name === 'profile') {
    const photo = existing[0]?.extra_json?.avatar_data_url;
    if (!photo) return imported;
    return imported.map((row) => ({ ...row, extra_json: { ...(row.extra_json || {}), avatar_data_url: photo } }));
  }
  if (name === 'resumes') {
    const photos = new Map(existing
      .filter((row) => row.config?.profile?.avatarDataUrl)
      .map((row) => [row.id, row.config.profile.avatarDataUrl]));
    return imported.map((row) => {
      const photo = photos.get(row.id);
      if (!photo || !row.config?.profile || typeof row.config.profile !== 'object') return row;
      return { ...row, config: { ...row.config, profile: { ...row.config.profile, avatarDataUrl: photo } } };
    });
  }
  return imported;
};

export const exportBackup = async (options: { includeApiKey?: boolean; parts?: BackupPart[] } = {}) => {
  await ready();
  const parts = new Set<BackupPart>(options.parts?.length ? options.parts : ALL_PARTS);
  const data: Record<string, Row[]> = {};
  const counts: Record<string, number> = {};
  for (const part of parts) {
    for (const name of PART_COLLECTIONS[part]) {
      const rows = clone(table(name));
      data[name] = parts.has('photos') ? rows : stripPhotos(name, rows);
      counts[name] = rows.length;
    }
  }
  const payload: Row = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: '榫卯简历（ResumeFLOW 本地版）',
    exportedAt: new Date().toISOString(),
    parts: [...parts],
    counts,
    data,
  };
  if (parts.has('settings')) {
    const settings = clone(settingsCache);
    if (!options.includeApiKey && settings.ai && typeof settings.ai === 'object') {
      settings.ai = { ...settings.ai, apiKey: '' };
    }
    payload.settings = settings;
  }
  return payload;
};

/** 读出备份里包含哪些部分（兼容第 1 版：那时总是全部导出）。 */
export const describeBackup = (payload: unknown): { parts: BackupPart[]; exportedAt: string } => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('备份文件格式不正确。');
  }
  const record = payload as Row;
  if (record.format !== BACKUP_FORMAT || !record.data || typeof record.data !== 'object') {
    throw new Error('这不是榫卯简历（ResumeFLOW 本地版）的备份文件。');
  }
  const parts = Array.isArray(record.parts)
    ? record.parts.filter((part: unknown): part is BackupPart => ALL_PARTS.includes(part as BackupPart))
    : ALL_PARTS;
  return { parts, exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '' };
};

/**
 * 导入备份：只替换备份里包含的部分，其他数据保持不变。
 * 备份里没有照片时，保留本机已有的照片。
 */
export const importBackup = async (payload: unknown): Promise<BackupPart[]> => {
  await ready();
  const { parts } = describeBackup(payload);
  const record = payload as Row;
  const partSet = new Set(parts);
  const touched: CollectionName[] = [];
  for (const part of parts) {
    for (const name of PART_COLLECTIONS[part]) {
      const rows = Array.isArray(record.data[name]) ? clone(record.data[name]) : [];
      cache[name] = partSet.has('photos') ? rows : keepExistingPhotos(name, rows, table(name));
      touched.push(name);
    }
  }
  const entries: Array<[string, any]> = touched.map((name) => [name, clone(cache[name])]);
  if (partSet.has('settings') && record.settings && typeof record.settings === 'object') {
    const previousKey = settingsCache?.ai?.apiKey;
    const importedSettings = clone(record.settings);
    if (importedSettings.ai && !importedSettings.ai.apiKey && previousKey) {
      importedSettings.ai.apiKey = previousKey;
    }
    if (!importedSettings.ai && settingsCache.ai) {
      importedSettings.ai = settingsCache.ai;
    }
    settingsCache = importedSettings;
    entries.push([SETTINGS_KEY, clone(settingsCache)]);
  }
  writeChain = writeChain.catch(() => undefined).then(() => idbPutMany(entries));
  await writeChain;
  return parts;
};

export const clearAllData = async (): Promise<void> => {
  await ready();
  for (const name of COLLECTIONS) {
    cache[name] = [];
  }
  const entries: Array<[string, any]> = COLLECTIONS.map((name) => [name, []]);
  writeChain = writeChain.catch(() => undefined).then(() => idbPutMany(entries));
  await writeChain;
};
