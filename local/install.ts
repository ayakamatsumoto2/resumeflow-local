/**
 * ResumeFLOW Local Edition — 把发往 /api 的请求拦截到本地处理器。
 * 原版前端通过 axios / fetch 访问同源 /api；本地版没有服务器，
 * 这里接管 window.fetch，把这些请求交给浏览器内的本地「后端」处理。
 * 其他请求（例如直连 DeepSeek 等模型接口）不受影响。
 */
import { HttpError, matchRoute, type LocalResult, type StreamEvent } from './http';
import { ready as storeReady } from './store';
import { refreshBanshoSettings } from './ai/settings';
import './handlers';

const API_MOUNT = '/api';

let readyPromise: Promise<void> | null = null;
/** 本地数据就绪，并读过一次万象之匣的全局设置（桌面版）。 */
const ready = (): Promise<void> => {
  if (!readyPromise) {
    readyPromise = (async () => {
      await storeReady();
      await refreshBanshoSettings();
    })();
  }
  return readyPromise;
};

const jsonResponse = (status: number, payload: unknown) => new Response(
  JSON.stringify(payload),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
);

const describeError = (error: unknown) => {
  if (error instanceof HttpError) {
    return { status: error.status, detail: error.detail };
  }
  const message = error instanceof Error && error.message ? error.message : '本地处理失败';
  return { status: 500, detail: message };
};

const streamResponse = (
  run: Extract<LocalResult, { stream: unknown }>['stream'],
  outerSignal?: AbortSignal,
) => {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) abort();
    else outerSignal.addEventListener('abort', abort, { once: true });
  }
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      const emit = (event: StreamEvent) => {
        if (closed) return;
        try {
          streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      void (async () => {
        try {
          await run(emit, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) {
            const { status, detail } = describeError(error);
            emit({
              type: 'error',
              message: typeof detail === 'string' ? detail : '本地处理失败',
              code: error instanceof HttpError ? 'http_error' : 'local_error',
              statusCode: status,
              retryable: false,
            });
          }
        } finally {
          if (!closed) {
            closed = true;
            try {
              streamController.close();
            } catch {
              // 流已被取消
            }
          }
        }
      })();
    },
    cancel() {
      closed = true;
      abort();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
};

const readBody = async (request: Request) => {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return { body: null, form: null };
  }
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    return { body: null, form: await request.formData() };
  }
  const text = await request.text();
  if (!text.trim()) {
    return { body: null, form: null };
  }
  try {
    return { body: JSON.parse(text), form: null };
  } catch {
    throw new HttpError(400, '请求体不是有效的 JSON。');
  }
};

export const handleLocalRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.slice(API_MOUNT.length) || '/';
  try {
    await ready();
    const matched = matchRoute(request.method, path);
    if (!matched) {
      return jsonResponse(404, { detail: `本地版暂不支持该功能（${request.method} ${path}）。` });
    }
    const { body, form } = await readBody(request);
    const result = await matched.handler({
      method: request.method.toUpperCase(),
      path,
      query: url.searchParams,
      body,
      form,
      signal: request.signal,
      params: matched.params,
    });
    if ('stream' in result) {
      return streamResponse(result.stream, request.signal);
    }
    if (result.status === 204 || !('json' in result)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(result.status ?? 200, result.json);
  } catch (error) {
    const { status, detail } = describeError(error);
    if (status >= 500) {
      console.error('[local-backend]', request.method, path, error);
    }
    return jsonResponse(status, { detail });
  }
};

const isLocalApiUrl = (url: URL) => (
  url.origin === window.location.origin
  && (url.pathname === API_MOUNT || url.pathname.startsWith(`${API_MOUNT}/`))
);

let installed = false;

export const installLocalBackend = () => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: URL;
    try {
      const raw = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      url = new URL(raw, window.location.href);
    } catch {
      return originalFetch(input, init);
    }
    if (!isLocalApiUrl(url)) {
      return originalFetch(input, init);
    }
    const request = input instanceof Request && !init
      ? input
      : new Request(url.href, {
        ...(input instanceof Request ? {
          method: input.method,
          headers: input.headers,
          body: input.method === 'GET' || input.method === 'HEAD' ? undefined : await input.clone().blob(),
          signal: input.signal,
        } : {}),
        ...init,
      });
    return handleLocalRequest(request);
  };
};
