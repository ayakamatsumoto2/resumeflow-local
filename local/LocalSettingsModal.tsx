/**
 * ResumeFLOW Local Edition — 本地设置：AI 接口、数据备份、关于。
 * 取代原版的「额度 / 充值」窗口。
 */
import React from 'react';
import { Download, Eye, EyeOff, Upload, X } from 'lucide-react';
import { chat } from './ai/llm';
import {
  AI_PROVIDER_PRESETS, DEFAULT_AI_SETTINGS, readAiSettings, writeAiSettings, type AiSettings,
} from './ai/settings';
import { clearAllData, exportBackup, importBackup, ready } from './store';

export const LOCAL_EDITION_SOURCE_URL = 'https://github.com/CMFHF-404/ResumeFLOW';

interface LocalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  returnFocusElement?: HTMLElement | null;
  [legacyProp: string]: unknown;
}

type Notice = { tone: 'ok' | 'error' | 'info'; text: string } | null;

const inputClass = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100';
const labelClass = 'block text-sm font-medium text-slate-700 dark:text-slate-200';
const secondaryButton = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';
const primaryButton = 'inline-flex items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60';

const downloadJson = (fileName: string, payload: unknown) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

const LocalSettingsModal: React.FC<LocalSettingsModalProps> = ({ isOpen, onClose, returnFocusElement }) => {
  const [form, setForm] = React.useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const [loaded, setLoaded] = React.useState(false);
  const [showKey, setShowKey] = React.useState(false);
  const [busy, setBusy] = React.useState<'' | 'save' | 'test' | 'export' | 'import' | 'clear'>('');
  const [notice, setNotice] = React.useState<Notice>(null);
  const [includeKey, setIncludeKey] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    void ready().then(() => {
      if (cancelled) return;
      setForm(readAiSettings());
      setLoaded(true);
    });
    const focusTarget = returnFocusElement
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', handleKeyDown);
      if (focusTarget?.isConnected) focusTarget.focus();
    };
  }, [isOpen, onClose, returnFocusElement]);

  if (!isOpen) return null;

  const update = (patch: Partial<AiSettings>) => {
    setForm((current) => ({ ...current, ...patch }));
    setNotice(null);
  };

  const presetId = AI_PROVIDER_PRESETS.find(
    (preset) => preset.settings.baseUrl && preset.settings.baseUrl === form.baseUrl.trim().replace(/\/+$/, ''),
  )?.id ?? 'custom';

  const handleSave = async () => {
    setBusy('save');
    try {
      setForm(await writeAiSettings(form));
      setNotice({ tone: 'ok', text: '已保存到本机。' });
    } catch {
      setNotice({ tone: 'error', text: '保存失败，请重试。' });
    } finally {
      setBusy('');
    }
  };

  const handleTest = async () => {
    setBusy('test');
    setNotice({ tone: 'info', text: '正在测试连接…' });
    try {
      await writeAiSettings(form);
      const { content } = await chat(
        [{ role: 'user', content: '请只回复两个字：正常' }],
        { jsonMode: false },
      );
      setNotice({ tone: 'ok', text: `连接成功，模型回复：${content.trim().slice(0, 40)}` });
    } catch (error) {
      const detail = (error as { detail?: unknown })?.detail;
      setNotice({
        tone: 'error',
        text: typeof detail === 'string' ? detail : error instanceof Error ? error.message : '连接失败。',
      });
    } finally {
      setBusy('');
    }
  };

  const handleExport = async () => {
    setBusy('export');
    try {
      const backup = await exportBackup({ includeApiKey: includeKey });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`resumeflow-backup-${stamp}.json`, backup);
      setNotice({ tone: 'ok', text: '备份文件已导出。' });
    } catch {
      setNotice({ tone: 'error', text: '导出失败，请重试。' });
    } finally {
      setBusy('');
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!window.confirm('导入备份会覆盖当前本机的全部简历、经历库和对话记录，确定继续吗？')) return;
    setBusy('import');
    try {
      await importBackup(JSON.parse(await file.text()));
      setNotice({ tone: 'ok', text: '导入成功，正在刷新…' });
      window.setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof SyntaxError ? '备份文件不是有效的 JSON。' : error instanceof Error ? error.message : '导入失败。',
      });
      setBusy('');
    }
  };

  const handleClear = async () => {
    if (!window.confirm('确定清空本机的全部简历、经历库和对话记录吗？此操作无法撤销，建议先导出备份。')) return;
    setBusy('clear');
    try {
      await clearAllData();
      setNotice({ tone: 'ok', text: '已清空，正在刷新…' });
      window.setTimeout(() => window.location.reload(), 600);
    } catch {
      setNotice({ tone: 'error', text: '清空失败，请重试。' });
      setBusy('');
    }
  };

  const noticeClass = notice?.tone === 'ok'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200'
    : notice?.tone === 'error'
      ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200'
      : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 px-4 py-6 backdrop-blur-sm"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="local-settings-title"
    >
      <div
        className="relative flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-surface-dark"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-700">
          <div>
            <h2 id="local-settings-title" className="text-lg font-semibold text-slate-900 dark:text-slate-50">本地设置</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">所有数据只保存在这台电脑上。</p>
          </div>
          <button
            ref={closeButtonRef}
            className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={onClose}
            type="button"
            aria-label="关闭本地设置"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-7 overflow-y-auto px-6 py-5">
          <section aria-labelledby="local-settings-ai">
            <h3 id="local-settings-ai" className="text-sm font-semibold text-slate-900 dark:text-slate-100">AI 接口</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              AI 功能会把相关的简历内容直接发给你在这里填写的模型服务，费用由该服务按你的账户计费。
            </p>
            <div className="mt-4 space-y-4">
              <label className={labelClass}>
                服务商
                <select
                  className={inputClass}
                  value={presetId}
                  disabled={!loaded}
                  onChange={(event) => {
                    const preset = AI_PROVIDER_PRESETS.find((item) => item.id === event.target.value);
                    if (preset) update(preset.settings);
                  }}
                >
                  {AI_PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.label}</option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                API Key
                <div className="relative">
                  <input
                    className={`${inputClass} pr-10 font-mono`}
                    type={showKey ? 'text' : 'password'}
                    value={form.apiKey}
                    disabled={!loaded}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-..."
                    onChange={(event) => update({ apiKey: event.target.value })}
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 mt-0.5 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    onClick={() => setShowKey((value) => !value)}
                    aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </label>
              <label className={labelClass}>
                接口地址
                <input
                  className={`${inputClass} font-mono`}
                  value={form.baseUrl}
                  disabled={!loaded}
                  spellCheck={false}
                  placeholder="https://api.deepseek.com"
                  onChange={(event) => update({ baseUrl: event.target.value })}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className={labelClass}>
                  模型
                  <input
                    className={`${inputClass} font-mono`}
                    value={form.model}
                    disabled={!loaded}
                    spellCheck={false}
                    onChange={(event) => update({ model: event.target.value })}
                  />
                </label>
                <label className={labelClass}>
                  深度思考模型（可留空）
                  <input
                    className={`${inputClass} font-mono`}
                    value={form.reasoningModel}
                    disabled={!loaded}
                    spellCheck={false}
                    onChange={(event) => update({ reasoningModel: event.target.value })}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={primaryButton} disabled={!loaded || !!busy} onClick={handleSave}>
                  {busy === 'save' ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={!loaded || !!busy || !form.apiKey.trim()}
                  onClick={handleTest}
                >
                  {busy === 'test' ? '测试中…' : '保存并测试连接'}
                </button>
              </div>
            </div>
          </section>

          <section aria-labelledby="local-settings-data">
            <h3 id="local-settings-data" className="text-sm font-semibold text-slate-900 dark:text-slate-100">数据备份</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              导出的备份包含个人资料、经历库、简历、技能证书和 AI 对话记录，可在另一台电脑上导入。
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                checked={includeKey}
                onChange={(event) => setIncludeKey(event.target.checked)}
              />
              备份里包含 API Key（文件请自行妥善保管）
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={secondaryButton} disabled={!!busy} onClick={handleExport}>
                <Download className="h-4 w-4" />导出备份
              </button>
              <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" />导入备份
              </button>
              <button
                type="button"
                className={`${secondaryButton} border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40`}
                disabled={!!busy}
                onClick={handleClear}
              >
                清空本机数据
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportFile}
              />
            </div>
          </section>

          <section aria-labelledby="local-settings-about">
            <h3 id="local-settings-about" className="text-sm font-semibold text-slate-900 dark:text-slate-100">关于</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              ResumeFLOW 本地版，基于 CMFHF 的开源项目 ResumeFLOW 修改，按 AGPL-3.0-or-later 许可发布。
              你有权获取本程序的完整源代码：
              {' '}
              <a
                className="font-medium text-teal-700 underline underline-offset-2 dark:text-teal-300"
                href={LOCAL_EDITION_SOURCE_URL}
                target="_blank"
                rel="noreferrer"
              >
                {LOCAL_EDITION_SOURCE_URL}
              </a>
            </p>
          </section>
        </div>

        {notice ? (
          <div className={`mx-6 mb-5 rounded-lg border px-3 py-2 text-sm ${noticeClass}`} role="status">
            {notice.text}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default LocalSettingsModal;
