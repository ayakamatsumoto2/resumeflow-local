/**
 * ResumeFLOW Local Edition — 备份的挑选窗口。
 * 导出：勾选要备份的简历、经历、证书……
 * 导入：列出备份里的条目，勾选要导入的；本机已有的条目选择「另存一份」或「覆盖」。
 */
import React from 'react';
import { X } from 'lucide-react';
import {
  ITEM_KINDS, exportBackup, importBackup, itemKey, listLocalItems, localDependencies,
  type BackupItem, type BackupManifest, type ConflictChoice, type ImportResult, type ItemKind,
} from './backup';

const secondaryButton = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';
const primaryButton = 'inline-flex items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60';
const checkboxClass = 'mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600 disabled:opacity-50';
const linkButton = 'text-xs font-medium text-teal-700 hover:underline disabled:opacity-50 dark:text-teal-300';

type ExportProps = {
  mode: 'export';
  onClose: () => void;
  onExport: (payload: Record<string, unknown>) => Promise<void>;
};

type ImportProps = {
  mode: 'import';
  onClose: () => void;
  payload: unknown;
  manifest: BackupManifest;
  fileName: string;
  onImported: (result: ImportResult) => void;
};

type Props = ExportProps | ImportProps;

const STATUS_TEXT: Record<BackupItem['status'], string> = {
  new: '本机没有',
  same: '本机已有，内容相同',
  changed: '本机已有，内容不同',
};

const STATUS_CLASS: Record<BackupItem['status'], string> = {
  new: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  same: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  changed: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
};

const choiceLabels = (kind: ItemKind): Record<ConflictChoice, string> => (
  kind === 'skill'
    ? { copy: '保留本机的', overwrite: '用备份的熟练度' }
    : kind === 'experience'
      ? { copy: '另存一份', overwrite: '覆盖本机的' }
      : { copy: '改名另存一份', overwrite: '覆盖本机的' }
);

const BackupDialog: React.FC<Props> = (props) => {
  const isImport = props.mode === 'import';
  const [items, setItems] = React.useState<BackupItem[]>(isImport ? props.manifest.items : []);
  const [loaded, setLoaded] = React.useState(isImport);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(
    isImport ? props.manifest.items.filter((item) => item.status !== 'same').map((item) => itemKey(item.kind, item.id)) : [],
  ));
  const [choices, setChoices] = React.useState<Record<string, ConflictChoice>>({});
  const [profile, setProfile] = React.useState(isImport ? props.manifest.profile.present && props.manifest.profile.status === 'new' : true);
  const [profileInfo, setProfileInfo] = React.useState<{ present: boolean; label: string }>(
    isImport ? props.manifest.profile : { present: false, label: '' },
  );
  const [hasPhotos, setHasPhotos] = React.useState(isImport ? props.manifest.hasPhotos : false);
  const [photos, setPhotos] = React.useState(true);
  const [settings, setSettings] = React.useState(!isImport);
  const [includeKey, setIncludeKey] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (isImport) return;
    void listLocalItems().then((local) => {
      setItems(local.items);
      setSelected(new Set(local.items.map((item) => itemKey(item.kind, item.id))));
      setProfileInfo(local.profile);
      setProfile(local.profile.present);
      setHasPhotos(local.hasPhotos);
      setLoaded(true);
    });
  }, [isImport]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.stopImmediatePropagation(); props.onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [busy, props]);

  /** 导出时：选中的简历会自动带上的经历 / 证书 / 技能 */
  const autoIncluded = React.useMemo(() => {
    if (isImport) return new Set<string>();
    const resumeIds = items.filter((item) => item.kind === 'resume' && selected.has(itemKey('resume', item.id))).map((item) => item.id);
    const deps = localDependencies(resumeIds);
    const keys = new Set<string>();
    deps.experience.forEach((id) => keys.add(itemKey('experience', id)));
    deps.certification.forEach((id) => keys.add(itemKey('certification', id)));
    deps.skill.forEach((id) => keys.add(itemKey('skill', id)));
    return keys;
  }, [isImport, items, selected]);

  const toggle = (key: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(key); else next.delete(key);
    setSelected(next);
  };

  const setGroup = (kind: ItemKind, checked: boolean) => {
    const next = new Set(selected);
    for (const item of items) {
      if (item.kind !== kind) continue;
      if (isImport && item.status === 'same') continue;
      const key = itemKey(item.kind, item.id);
      if (checked) next.add(key); else next.delete(key);
    }
    setSelected(next);
  };

  const conflictKeys = items.filter((item) => item.status === 'changed').map((item) => itemKey(item.kind, item.id));
  const setAllChoices = (choice: ConflictChoice) => {
    const next: Record<string, ConflictChoice> = {};
    conflictKeys.forEach((key) => { next[key] = choice; });
    setChoices(next);
  };

  const selectedCount = items.filter((item) => selected.has(itemKey(item.kind, item.id)) || autoIncluded.has(itemKey(item.kind, item.id))).length;
  const nothingChosen = !selectedCount && !profile && !settings;

  const handleConfirm = async () => {
    if (nothingChosen) { setError('请至少勾选一项。'); return; }
    setBusy(true);
    setError('');
    try {
      if (props.mode === 'export') {
        const ids: Partial<Record<ItemKind, string[]>> = {};
        for (const item of items) {
          if (!selected.has(itemKey(item.kind, item.id))) continue;
          (ids[item.kind] ??= []).push(item.id);
        }
        const payload = await exportBackup({ ids, profile, photos: photos && hasPhotos, settings, includeApiKey: settings && includeKey });
        await props.onExport(payload);
      } else {
        const overwrite = conflictKeys.filter((key) => selected.has(key) && choices[key] === 'overwrite').length;
        if (overwrite || (profile && props.manifest.profile.status === 'changed')) {
          const lines = [overwrite ? `${overwrite} 个条目会被备份里的内容覆盖` : '', profile && props.manifest.profile.status === 'changed' ? '个人资料会被替换' : ''].filter(Boolean);
          if (!window.confirm(`${lines.join('，')}。确定继续吗？`)) { setBusy(false); return; }
        }
        const result = await importBackup(props.payload, { selected, choices, profile, photos: photos && hasPhotos, settings });
        props.onImported(result);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const title = isImport ? '导入备份' : '导出备份';
  const date = isImport && props.manifest.exportedAt ? props.manifest.exportedAt.slice(0, 10) : '';

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/60 px-4 py-6 backdrop-blur-sm"
      onMouseDown={() => { if (!busy) props.onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="backup-dialog-title"
    >
      <div
        className="relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-surface-dark"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-700">
          <div>
            <h2 id="backup-dialog-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {isImport
                ? `${props.fileName}${date ? `（${date} 导出）` : ''}。勾选要导入的条目；本机原有的数据都会保留，不会被整体覆盖。`
                : '勾选要备份的内容，不必全部导出。'}
            </p>
          </div>
          <button type="button" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={props.onClose} disabled={busy} aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {!loaded ? <p className="text-sm text-slate-500">正在读取…</p> : null}

          {isImport && conflictKeys.length ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
              <span>有 {conflictKeys.length} 个条目本机也有、但内容不同，默认另存一份。</span>
              <button type="button" className={linkButton} onClick={() => setAllChoices('copy')}>全部另存一份</button>
              <button type="button" className={linkButton} onClick={() => setAllChoices('overwrite')}>全部用备份的覆盖</button>
            </div>
          ) : null}

          {ITEM_KINDS.map(({ kind, label, hint }) => {
            const group = items.filter((item) => item.kind === kind);
            if (!group.length) return null;
            const checkedCount = group.filter((item) => selected.has(itemKey(kind, item.id))).length;
            return (
              <section key={kind} aria-label={label}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {label}
                    <span className="ml-2 text-xs font-normal text-slate-500">已选 {checkedCount} / {group.length}</span>
                  </h3>
                  <span className="flex gap-3">
                    <button type="button" className={linkButton} onClick={() => setGroup(kind, true)}>全选</button>
                    <button type="button" className={linkButton} onClick={() => setGroup(kind, false)}>全不选</button>
                  </span>
                </div>
                {hint ? <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
                <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                  {group.map((item) => {
                    const key = itemKey(kind, item.id);
                    const checked = selected.has(key);
                    const auto = !checked && autoIncluded.has(key);
                    const labels = choiceLabels(kind);
                    return (
                      <li key={key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                        <label className="flex min-w-0 flex-1 items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                          <input
                            type="checkbox"
                            className={checkboxClass}
                            checked={checked || auto}
                            onChange={(event) => toggle(key, event.target.checked)}
                            disabled={auto}
                          />
                          <span className="min-w-0">
                            <span className="block truncate">{item.label}</span>
                            {item.sub ? <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{item.sub}</span> : null}
                            {auto ? <span className="block text-xs text-teal-700 dark:text-teal-300">选中的简历用到了它，会自动一起导出</span> : null}
                          </span>
                        </label>
                        {isImport ? (
                          <span className="flex shrink-0 flex-col items-end gap-1">
                            <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_CLASS[item.status]}`}>{STATUS_TEXT[item.status]}</span>
                            {item.status === 'changed' && checked ? (
                              <select
                                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
                                value={choices[key] ?? 'copy'}
                                onChange={(event) => setChoices({ ...choices, [key]: event.target.value as ConflictChoice })}
                                aria-label={`${item.label} 的处理方式`}
                              >
                                <option value="copy">{labels.copy}</option>
                                <option value="overwrite">{labels.overwrite}</option>
                              </select>
                            ) : null}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          {loaded && !items.length && !isImport ? (
            <p className="text-sm text-slate-500">本机还没有简历或经历，只能导出个人资料和设置。</p>
          ) : null}

          <section aria-label="其他内容" className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">其他内容</h3>
            {profileInfo.present ? (
              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" className={checkboxClass} checked={profile} onChange={(event) => setProfile(event.target.checked)} />
                <span>
                  个人资料（{profileInfo.label}）
                  {isImport ? (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {props.manifest.profile.status === 'new' ? '本机还没有个人资料' : props.manifest.profile.status === 'same' ? '和本机的相同' : '和本机的不同；个人资料只有一份，勾选会替换本机的'}
                    </span>
                  ) : null}
                </span>
              </label>
            ) : null}
            {hasPhotos ? (
              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" className={checkboxClass} checked={photos} onChange={(event) => setPhotos(event.target.checked)} />
                <span>
                  照片
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {isImport ? '不勾选则导入的内容不带照片，本机已有的照片保留' : '个人资料和简历里的头像；不勾选备份文件更小'}
                  </span>
                </span>
              </label>
            ) : null}
            {!isImport || props.manifest.settings.present ? (
              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" className={checkboxClass} checked={settings} onChange={(event) => setSettings(event.target.checked)} />
                <span>
                  本程序的设置（AI 接口等）
                  {isImport ? (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {props.manifest.settings.hasKey ? '备份里带有 API Key' : '备份里没有 API Key，导入后保留本机的 Key'}
                    </span>
                  ) : null}
                </span>
              </label>
            ) : null}
            {!isImport && settings ? (
              <label className="ml-6 flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                <input type="checkbox" className={checkboxClass} checked={includeKey} onChange={(event) => setIncludeKey(event.target.checked)} />
                连同 API Key 一起导出（文件请自行妥善保管）
              </label>
            ) : null}
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-4 dark:border-slate-700">
          <span className="text-xs text-slate-500 dark:text-slate-400" role={error ? 'alert' : undefined}>
            {error ? <span className="text-red-600 dark:text-red-300">{error}</span> : `共选中 ${selectedCount} 个条目`}
          </span>
          <span className="flex gap-2">
            <button type="button" className={secondaryButton} onClick={props.onClose} disabled={busy}>取消</button>
            <button type="button" className={primaryButton} onClick={handleConfirm} disabled={busy || !loaded || nothingChosen}>
              {busy ? '处理中…' : isImport ? '导入选中的内容' : '导出选中的内容'}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
};

export default BackupDialog;
