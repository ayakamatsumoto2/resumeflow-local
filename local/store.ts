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
export const BACKUP_VERSION = 1;

export const exportBackup = async (options: { includeApiKey?: boolean } = {}) => {
  await ready();
  const data: Record<string, Row[]> = {};
  for (const name of COLLECTIONS) {
    data[name] = clone(table(name));
  }
  const settings = clone(settingsCache);
  if (!options.includeApiKey && settings.ai && typeof settings.ai === 'object') {
    settings.ai = { ...settings.ai, apiKey: '' };
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data,
    settings,
  };
};

export const importBackup = async (payload: unknown): Promise<void> => {
  await ready();
  if (!payload || typeof payload !== 'object') {
    throw new Error('备份文件格式不正确。');
  }
  const record = payload as Row;
  if (record.format !== BACKUP_FORMAT || !record.data || typeof record.data !== 'object') {
    throw new Error('这不是 ResumeFLOW 本地版的备份文件。');
  }
  for (const name of COLLECTIONS) {
    const rows = record.data[name];
    cache[name] = Array.isArray(rows) ? clone(rows) : [];
  }
  const previousKey = settingsCache?.ai?.apiKey;
  const importedSettings = record.settings && typeof record.settings === 'object'
    ? clone(record.settings)
    : {};
  if (importedSettings.ai && !importedSettings.ai.apiKey && previousKey) {
    importedSettings.ai.apiKey = previousKey;
  }
  if (!importedSettings.ai && settingsCache.ai) {
    importedSettings.ai = settingsCache.ai;
  }
  settingsCache = importedSettings;
  const entries: Array<[string, any]> = COLLECTIONS.map((name) => [name, clone(cache[name])]);
  entries.push([SETTINGS_KEY, clone(settingsCache)]);
  writeChain = writeChain.catch(() => undefined).then(() => idbPutMany(entries));
  await writeChain;
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
