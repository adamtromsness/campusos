/**
 * ApiClient — fetch wrapper for the CampusOS API.
 *
 * - Attaches `Authorization: Bearer <accessToken>` and `X-Tenant-Subdomain`.
 * - On 401, calls /auth/refresh once (HttpOnly cookie) and retries the request.
 * - Single-flights concurrent refreshes so N parallel 401s trigger one refresh.
 * - On terminal 401, invokes the registered onUnauthenticated handler.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const TENANT_SUBDOMAIN = process.env.NEXT_PUBLIC_TENANT_SUBDOMAIN || 'demo';

let _accessToken: string | null = null;
let _onUnauthenticated: (() => void) | null = null;
let _refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  _accessToken = token;
}

export function getAccessToken(): string | null {
  return _accessToken;
}

export function setOnUnauthenticated(handler: () => void) {
  _onUnauthenticated = handler;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function buildHeaders(init: RequestInit, token: string | null): Headers {
  const headers = new Headers(init.headers || {});
  headers.set('X-Tenant-Subdomain', TENANT_SUBDOMAIN);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

async function rawFetch(path: string, init: RequestInit, token: string | null): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders(init, token),
    credentials: 'include',
  });
}

async function refreshOnce(): Promise<string | null> {
  if (!_refreshPromise) {
    _refreshPromise = (async () => {
      try {
        const res = await rawFetch('/api/v1/auth/refresh', { method: 'POST' }, null);
        if (!res.ok) return null;
        const data = (await res.json()) as { accessToken: string };
        return data.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      _refreshPromise = null;
    });
  }
  return _refreshPromise;
}

export async function attemptSilentLogin(): Promise<string | null> {
  return refreshOnce();
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await rawFetch(path, init, _accessToken);

  if (res.status === 401 && !path.startsWith('/api/v1/auth/refresh')) {
    const newToken = await refreshOnce();
    if (newToken) {
      _accessToken = newToken;
      res = await rawFetch(path, init, newToken);
    }
  }

  if (res.status === 401) {
    _onUnauthenticated?.();
    throw new ApiError(401, 'Unauthenticated');
  }

  if (!res.ok) {
    let body: unknown = null;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    const message = (body as { message?: string })?.message || text || res.statusText;
    throw new ApiError(res.status, message, body);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return undefined as T;
  return (await res.json()) as T;
}
