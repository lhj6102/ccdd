export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(url: string, options: { signal?: AbortSignal; body?: unknown; csrfToken?: string } = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', signal: options.signal,
    headers: options.body === undefined ? { Accept: 'application/json' } : {
      Accept: 'application/json', 'Content-Type': 'application/json', 'X-CCDD-CSRF': options.csrfToken ?? '',
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value !== null && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
      ? value.error : '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
    throw new ApiError(message, response.status);
  }
  if (value === null) throw new ApiError('서버 응답을 읽지 못했습니다.', response.status);
  return value as T;
}

export const requestRoute = (projectId: string, requestId: string): string => `/api/requests/${encodeURIComponent(projectId)}/${encodeURIComponent(requestId)}`;
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
