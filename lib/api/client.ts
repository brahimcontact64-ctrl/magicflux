export type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export function extractApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const p = payload as ApiErrorPayload;
  return p.error ?? p.message ?? fallback;
}

export async function apiRequest<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallbackError: string
): Promise<T> {
  const res = await fetch(input, init);
  const payload = (await res.json().catch(() => null)) as T | ApiErrorPayload | null;

  if (!res.ok) {
    throw new Error(extractApiError(payload, fallbackError));
  }

  return payload as T;
}
