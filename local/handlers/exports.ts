/**
 * PDF 导出 —— 本地版不再用服务器端的 Playwright/Chromium 生成 PDF，
 * 而是把排版快照交给原有的打印页（/print/...），再调用系统打印对话框「另存为 PDF」。
 * 快照只保存在内存里，不落盘。
 */
import { badRequest, notFound, route } from '../http';
import { uuid, type Row } from '../store';
import { isPlainObject } from './shared';

type SnapshotStore = Map<string, { kind: 'resume' | 'experience-bank'; snapshot: Row }>;

const STORE_KEY = '__rfLocalExportSnapshots';

const ownStore = (): SnapshotStore => {
  const host = window as unknown as Record<string, SnapshotStore | undefined>;
  if (!host[STORE_KEY]) host[STORE_KEY] = new Map();
  return host[STORE_KEY]!;
};

/** 打印页运行在同源 iframe 里，需要到发起导出的父窗口取快照。 */
const findSnapshot = (exportId: string) => {
  const local = ownStore().get(exportId);
  if (local) return local;
  try {
    if (window.parent && window.parent !== window) {
      const parentStore = (window.parent as unknown as Record<string, SnapshotStore | undefined>)[STORE_KEY];
      return parentStore?.get(exportId) ?? null;
    }
  } catch {
    // 跨源父窗口：忽略
  }
  return null;
};

const createLink = (kind: 'resume' | 'experience-bank', printPath: string) => ({ body }: { body: unknown }) => {
  if (!isPlainObject(body) || !isPlainObject(body.snapshot)) {
    throw badRequest('导出内容不完整，请重新发起导出。');
  }
  const exportId = uuid();
  const store = ownStore();
  store.set(exportId, { kind, snapshot: body.snapshot });
  // 只保留最近几次导出，避免内存堆积
  while (store.size > 5) store.delete(store.keys().next().value as string);
  const fileName = typeof body.fileName === 'string' && body.fileName.trim()
    ? body.fileName.trim()
    : kind === 'resume' ? '简历' : '经历库';
  return {
    json: {
      downloadUrl: `${printPath}?exportId=${encodeURIComponent(exportId)}`,
      fileName: /\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`,
    },
  };
};

const readSnapshot = (kind: 'resume' | 'experience-bank') => ({ params }: { params: Record<string, string> }) => {
  const entry = findSnapshot(params.exportId);
  if (!entry || entry.kind !== kind) {
    throw notFound('导出快照已失效，请回到编辑页重新导出。');
  }
  return { json: { snapshot: entry.snapshot } };
};

route('POST', '/exports/resume-pdf-link', createLink('resume', '/print/resume-export'));
route('GET', '/exports/render-snapshots/:exportId', readSnapshot('resume'));
route('POST', '/exports/experience-bank-pdf-link', createLink('experience-bank', '/print/experience-bank-export'));
route('GET', '/exports/experience-bank-render-snapshots/:exportId', readSnapshot('experience-bank'));
