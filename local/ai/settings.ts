/**
 * ResumeFLOW Local Edition — AI 接口设置（保存在本机 IndexedDB，不上传）。
 * 默认面向 DeepSeek；任何兼容 OpenAI Chat Completions 的服务都可以用。
 *
 * 桌面版如果检测到「万象之匣」的全局设置文件（%APPDATA%\lab.banshou.hako\settings.json），
 * 默认使用其中的 AI 接口；用户也可以在「本地设置」里改为单独设置。
 * 两个程序之间只通过这个 JSON 文件交换配置。
 */
import { getSettings, saveSettings } from '../store';

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  /** 常规任务使用的模型 */
  model: string;
  /** 开启「深度思考」时使用的模型；留空则沿用常规模型 */
  reasoningModel: string;
  temperature: number;
  /** 单次回复的最大 token 数 */
  maxTokens: number;
}

/** AI 设置的来源：万象之匣的全局设置，或本程序自己的设置。 */
export type AiSettingsSource = 'bansho' | 'local';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  reasoningModel: 'deepseek-reasoner',
  temperature: 0.3,
  maxTokens: 8192,
};

export const AI_PROVIDER_PRESETS: Array<{ id: string; label: string; settings: Partial<AiSettings> }> = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    settings: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', reasoningModel: 'deepseek-reasoner' },
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    settings: {},
  },
];

/* ------------------------- 万象之匣的全局设置 ------------------------- */

export interface BanshoAiProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningModel: string;
}

let banshoProfile: BanshoAiProfile | null = null;
let banshoChecked = false;

type TauriGlobal = { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } };

const tauriInvoke = (): ((cmd: string, args?: unknown) => Promise<unknown>) | null => {
  const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function' ? tauri.core.invoke : null;
};

export const isDesktopShell = (): boolean => !!tauriInvoke();

/** 解析万象之匣 settings.json 里的默认 AI 配置；格式不对时返回 null。 */
export const parseBanshoAiProfile = (text: string | null | undefined): BanshoAiProfile | null => {
  if (!text) return null;
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const ai = data && typeof data === 'object' ? data.ai : null;
  const profiles: any[] = Array.isArray(ai?.profiles) ? ai.profiles : [];
  if (!profiles.length) return null;
  const chosen = profiles.find((item) => item && item.id === ai.defaultProfileId) ?? profiles[0];
  if (!chosen || typeof chosen !== 'object') return null;
  const text_ = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const profile: BanshoAiProfile = {
    id: text_(chosen.id),
    name: text_(chosen.name) || '默认',
    baseUrl: text_(chosen.baseUrl).replace(/\/+$/, ''),
    apiKey: text_(chosen.apiKey),
    model: text_(chosen.model),
    reasoningModel: text_(chosen.reasoningModel),
  };
  return profile.apiKey && profile.baseUrl && profile.model ? profile : null;
};

/** 重新读取万象之匣的全局设置（启动时调用一次，打开本地设置时再刷新）。 */
export const refreshBanshoSettings = async (): Promise<BanshoAiProfile | null> => {
  const invoke = tauriInvoke();
  banshoChecked = true;
  if (!invoke) {
    banshoProfile = null;
    return null;
  }
  try {
    banshoProfile = parseBanshoAiProfile((await invoke('read_bansho_settings')) as string | null);
  } catch {
    banshoProfile = null;
  }
  return banshoProfile;
};

export const getBanshoAiProfile = (): BanshoAiProfile | null => banshoProfile;
export const hasCheckedBanshoSettings = (): boolean => banshoChecked;

export const readAiSource = (): AiSettingsSource => (
  getSettings().aiSource === 'local' ? 'local' : 'bansho'
);

export const writeAiSource = async (source: AiSettingsSource): Promise<void> => {
  await saveSettings({ ...getSettings(), aiSource: source });
};

/* ------------------------------ 读写 ------------------------------ */

const normalize = (raw: Partial<AiSettings>): AiSettings => {
  const merged = { ...DEFAULT_AI_SETTINGS, ...raw };
  return {
    baseUrl: String(merged.baseUrl || DEFAULT_AI_SETTINGS.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: String(merged.apiKey || '').trim(),
    model: String(merged.model || DEFAULT_AI_SETTINGS.model).trim(),
    reasoningModel: String(merged.reasoningModel || '').trim(),
    temperature: Number.isFinite(Number(merged.temperature)) ? Number(merged.temperature) : DEFAULT_AI_SETTINGS.temperature,
    maxTokens: Number.isFinite(Number(merged.maxTokens)) && Number(merged.maxTokens) > 0
      ? Math.floor(Number(merged.maxTokens))
      : DEFAULT_AI_SETTINGS.maxTokens,
  };
};

/** 本程序自己保存的 AI 设置（不考虑万象之匣）。 */
export const readLocalAiSettings = (): AiSettings => {
  const stored = getSettings().ai;
  return normalize(stored && typeof stored === 'object' ? stored : {});
};

/** 实际生效的 AI 设置：优先万象之匣的全局设置（除非用户选了单独设置）。 */
export const readAiSettings = (): AiSettings => {
  const local = readLocalAiSettings();
  if (banshoProfile && readAiSource() === 'bansho') {
    return normalize({
      baseUrl: banshoProfile.baseUrl,
      apiKey: banshoProfile.apiKey,
      model: banshoProfile.model,
      reasoningModel: banshoProfile.reasoningModel,
      temperature: local.temperature,
      maxTokens: local.maxTokens,
    });
  }
  return local;
};

/** 是否正在使用万象之匣的设置。 */
export const isUsingBanshoSettings = (): boolean => !!banshoProfile && readAiSource() === 'bansho';

export const writeAiSettings = async (next: Partial<AiSettings>): Promise<AiSettings> => {
  const merged = { ...readLocalAiSettings(), ...next };
  await saveSettings({ ...getSettings(), ai: merged });
  return readLocalAiSettings();
};

export const isAiConfigured = (): boolean => !!readAiSettings().apiKey;
