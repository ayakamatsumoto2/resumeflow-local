/**
 * ResumeFLOW Local Edition — 直连模型服务的最小客户端（OpenAI Chat Completions 兼容）。
 * 取代原版后端的 llm_transport.py：请求从本机直接发往用户自己配置的模型服务。
 */
import { HttpError } from '../http';
import { readAiSettings, type AiSettings } from './settings';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

export interface ChatOptions {
  signal?: AbortSignal;
  /** 使用「深度思考」模型（如 deepseek-reasoner） */
  thinking?: boolean;
  /** 模型思考过程的增量文本 */
  onReasoning?: (delta: string) => void;
  /** 正文的增量文本 */
  onContent?: (delta: string, full: string) => void;
  temperature?: number;
  jsonMode?: boolean;
}

export const AI_NOT_CONFIGURED_MESSAGE = '还没有配置 AI 接口。请点击左上角头像，在「本地设置」里填写 API Key。';

const describeHttpFailure = async (response: Response): Promise<string> => {
  let detail = '';
  try {
    const payload = await response.clone().json();
    detail = payload?.error?.message || payload?.message || '';
  } catch {
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      detail = '';
    }
  }
  const prefix = (() => {
    switch (response.status) {
      case 401: return 'API Key 无效或已失效，请在「本地设置」里检查。';
      case 402: return '模型服务账户余额不足，请到服务商后台充值。';
      case 404: return '接口地址或模型名称不正确，请在「本地设置」里检查。';
      case 429: return '请求太频繁或额度受限，请稍后再试。';
      default: return response.status >= 500
        ? '模型服务暂时不可用，请稍后再试。'
        : `模型服务返回错误（${response.status}）。`;
    }
  })();
  return detail ? `${prefix}（${detail}）` : prefix;
};

const usesJsonKeyword = (messages: ChatMessage[]) => messages.some((message) => (
  typeof message.content === 'string'
    ? /json/i.test(message.content)
    : message.content.some((part) => typeof part.text === 'string' && /json/i.test(part.text))
));

const buildRequestBody = (
  settings: AiSettings,
  messages: ChatMessage[],
  options: ChatOptions,
) => {
  const useReasoner = !!options.thinking && !!settings.reasoningModel;
  const model = useReasoner ? settings.reasoningModel : settings.model;
  const jsonMode = options.jsonMode !== false;
  const finalMessages = jsonMode && !usesJsonKeyword(messages)
    ? [...messages, { role: 'user' as const, content: 'Return a single valid JSON object only.' }]
    : messages;
  const body: Record<string, unknown> = {
    model,
    messages: finalMessages,
    stream: true,
    max_tokens: settings.maxTokens,
  };
  // 推理模型通常不接受 temperature / response_format，保持最小参数集。
  if (!useReasoner) {
    body.temperature = options.temperature ?? settings.temperature;
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }
  }
  return body;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 桌面版（榫卯简历.exe）里用 Tauri 的 HTTP 插件从本机发请求，不受浏览器跨域限制；
 * 浏览器里直接用 fetch（需要模型服务允许跨域）。
 */
const modelFetch = (): FetchLike => {
  const tauriHttp = (globalThis as { __TAURI__?: { http?: { fetch?: FetchLike } } }).__TAURI__?.http;
  return typeof tauriHttp?.fetch === 'function' ? tauriHttp.fetch : (input, init) => fetch(input, init);
};

/** 发起一次流式对话，返回完整正文与思考文本。 */
export const chat = async (
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<{ content: string; reasoning: string }> => {
  const settings = readAiSettings();
  if (!settings.apiKey) {
    throw new HttpError(400, AI_NOT_CONFIGURED_MESSAGE);
  }
  let response: Response;
  try {
    response = await modelFetch()(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(settings, messages, options)),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new HttpError(
      503,
      '无法连接模型服务，请检查网络和「本地设置」里的接口地址。',
    );
  }
  if (!response.ok) {
    throw new HttpError(response.status === 401 ? 400 : 502, await describeHttpFailure(response));
  }
  if (!response.body) {
    throw new HttpError(502, '模型服务没有返回内容。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';

  const consumeLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk?.error?.message) {
      throw new HttpError(502, `模型服务返回错误：${chunk.error.message}`);
    }
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoningDelta === 'string' && reasoningDelta) {
      reasoning += reasoningDelta;
      options.onReasoning?.(reasoningDelta);
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      options.onContent?.(delta.content, content);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
  }
  if (buffer.trim()) consumeLine(buffer);

  if (!content.trim()) {
    throw new HttpError(502, '模型没有返回有效内容，请重试。');
  }
  return { content, reasoning };
};

/* ----------------------------- JSON 解析 ----------------------------- */
// 移植自 backend/app/domain/ai/response_normalizers.py

const stripJsonWrappers = (text: string): string => {
  const cleaned = text.trim();
  if (!cleaned.includes('```')) return cleaned;
  const start = cleaned.indexOf('```');
  const end = cleaned.lastIndexOf('```');
  if (end <= start) return cleaned;
  let inner = cleaned.slice(start + 3, end).trim();
  if (inner.toLowerCase().startsWith('json')) inner = inner.slice(4).trim();
  return inner;
};

const extractJsonPayload = (text: string): string => {
  const cleaned = stripJsonWrappers(text);
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) return cleaned;
  const braceIndex = cleaned.indexOf('{');
  const bracketIndex = cleaned.indexOf('[');
  const candidates = [braceIndex, bracketIndex].filter((index) => index >= 0);
  if (!candidates.length) return cleaned;
  const start = Math.min(...candidates);
  const end = cleaned.lastIndexOf(start === braceIndex ? '}' : ']');
  if (end <= start) return cleaned;
  return cleaned.slice(start, end + 1);
};

/** 找到第一个完整 JSON 值的结束位置（容忍模型在末尾多写的括号或重复对象）。 */
const firstJsonValueEnd = (payload: string): number => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
};

export const parseJsonObject = (text: string): Record<string, any> => {
  const payload = extractJsonPayload(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    const end = firstJsonValueEnd(payload);
    if (end <= 0) {
      throw new HttpError(502, '模型返回的内容不是有效的 JSON，请重试。');
    }
    try {
      parsed = JSON.parse(payload.slice(0, end));
    } catch {
      throw new HttpError(502, '模型返回的内容不是有效的 JSON，请重试。');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(502, '模型返回的内容格式不正确，请重试。');
  }
  return parsed as Record<string, any>;
};

/* --------------------------- 思考过程转事件 --------------------------- */

/**
 * 把模型的思考增量整理成前端能展示的 thought 事件（按段落节流发送）。
 */
export const createThoughtForwarder = (
  emit: ((event: { type: string; summary?: string }) => void) | undefined,
) => {
  let pending = '';
  const flush = (force: boolean) => {
    if (!emit) return;
    const breakIndex = pending.lastIndexOf('\n');
    if (breakIndex < 0 && !force) return;
    const ready = force ? pending : pending.slice(0, breakIndex);
    pending = force ? '' : pending.slice(breakIndex + 1);
    for (const line of ready.split('\n')) {
      const summary = line.trim();
      if (summary) emit({ type: 'thought', summary });
    }
  };
  return {
    push(delta: string) {
      pending += delta;
      flush(false);
    },
    end() {
      flush(true);
    },
  };
};

/** 一次性拿到 JSON 结果的便捷封装。 */
export const chatJson = async (
  messages: ChatMessage[],
  options: ChatOptions & { emitThought?: (event: { type: string; summary?: string }) => void } = {},
): Promise<Record<string, any>> => {
  const forwarder = createThoughtForwarder(options.emitThought);
  const { content } = await chat(messages, {
    ...options,
    onReasoning: (delta) => {
      forwarder.push(delta);
      options.onReasoning?.(delta);
    },
  });
  forwarder.end();
  return parseJsonObject(content);
};
