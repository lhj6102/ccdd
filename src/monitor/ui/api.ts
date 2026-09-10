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
      ? value.error : 'Unable to process the request. Please try again.';
    throw new ApiError(message, response.status);
  }
  if (value === null) throw new ApiError('Unable to read the server response.', response.status);
  return value as T;
}

export const requestRoute = (projectId: string, requestId: string): string => `/api/requests/${encodeURIComponent(projectId)}/${encodeURIComponent(requestId)}`;
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unable to process the request.';
