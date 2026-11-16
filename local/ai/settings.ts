/**
 * ResumeFLOW Local Edition — AI 接口设置（保存在本机 IndexedDB，不上传）。
 * 默认面向 DeepSeek；任何兼容 OpenAI Chat Completions 的服务都可以用。
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

export const readAiSettings = (): AiSettings => {
  const stored = getSettings().ai;
  const merged = { ...DEFAULT_AI_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
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

export const writeAiSettings = async (next: Partial<AiSettings>): Promise<AiSettings> => {
  const merged = { ...readAiSettings(), ...next };
  await saveSettings({ ...getSettings(), ai: merged });
  return readAiSettings();
};

export const isAiConfigured = (): boolean => !!readAiSettings().apiKey;
