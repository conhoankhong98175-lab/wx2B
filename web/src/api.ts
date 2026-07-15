interface ErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    requestId?: string;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'diangao_access_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function localLogin(displayName = '我的店铺'): Promise<string> {
  const response = await fetch('/api/auth/local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  const body = (await response.json().catch(() => ({}))) as ErrorPayload & { token?: string };
  if (!response.ok || !body.token) {
    throw new ApiError(
      response.status,
      body.error?.code ?? 'LOGIN_FAILED',
      body.error?.message ?? '无法进入本地工具',
      body.error?.details,
    );
  }
  localStorage.setItem(TOKEN_KEY, body.token);
  return body.token;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorPayload;
    if (response.status === 401) clearToken();
    throw new ApiError(
      response.status,
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.message ?? '请求失败，请稍后重试',
      body.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function publicApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`/api/public${path}`, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorPayload;
    throw new ApiError(
      response.status,
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.message ?? '请求失败，请稍后重试',
      body.error?.details,
    );
  }
  return (await response.json()) as T;
}

export function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
