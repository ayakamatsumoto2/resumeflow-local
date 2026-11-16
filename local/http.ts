/**
 * ResumeFLOW Local Edition — 本地「后端」的请求/响应基础类型。
 */

export class HttpError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const badRequest = (message: string) => new HttpError(400, message);

export type StreamEvent = Record<string, any> & { type: string };
export type Emit = (event: StreamEvent) => void;

export interface LocalRequest {
  method: string;
  /** 已去掉 /api 挂载前缀的路径，例如 /resumes/xxx 或 /api/assistant/sessions */
  path: string;
  query: URLSearchParams;
  /** JSON 请求体（已解析）；multipart 时为 null */
  body: any;
  form: FormData | null;
  signal?: AbortSignal;
  /** 路由匹配得到的路径参数 */
  params: Record<string, string>;
}

export type LocalResult =
  | { status?: number; json: unknown }
  | { status: 204 }
  | { stream: (emit: Emit, signal: AbortSignal) => Promise<void> };

export type Handler = (request: LocalRequest) => Promise<LocalResult> | LocalResult;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const routes: Route[] = [];

export const route = (method: string, pattern: string, handler: Handler) => {
  routes.push({
    method: method.toUpperCase(),
    segments: pattern.split('/').filter(Boolean),
    handler,
  });
};

export const matchRoute = (method: string, path: string) => {
  const segments = path.split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  for (const candidate of routes) {
    if (candidate.method !== method.toUpperCase()) continue;
    if (candidate.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < segments.length; index += 1) {
      const expected = candidate.segments[index];
      if (expected.startsWith(':')) {
        params[expected.slice(1)] = segments[index];
      } else if (expected !== segments[index]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { handler: candidate.handler, params };
    }
  }
  return null;
};
