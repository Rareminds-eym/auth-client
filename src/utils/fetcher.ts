/**
 * Thin fetch wrapper that:
 *  - always sends cookies (credentials: "include")
 *  - sets Content-Type to JSON only when a body is present
 *  - throws on non-2xx responses with the response body
 */
export async function fetcher<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const { headers: optHeaders, body, method, ...rest } = options;

  // Only set Content-Type: application/json when there's a body.
  // Some servers reject bodyless requests (GET, HEAD) that carry Content-Type.
  const baseHeaders: Record<string, string> = body
    ? { "Content-Type": "application/json" }
    : {};

  const res = await fetch(url, {
    ...rest,
    method,
    body,
    credentials: "include",
    headers: {
      ...baseHeaders,
      ...normalizeHeaders(optHeaders),
    },
  });

  if (!res.ok) {
    // Read body as text first — avoids double-consumption if json() fails
    const raw = await res.text();
    let message: string;
    try {
      const body = JSON.parse(raw);
      message = body?.message ?? body?.error ?? raw;
    } catch {
      message = raw;
    }
    throw new AuthFetchError(res.status, message);
  }

  // Handle empty responses (e.g. 204 No Content or empty 200)
  const text = await res.text();
  if (!text) return undefined as unknown as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AuthFetchError(
      res.status,
      `Expected JSON response from ${url} but received: ${text.slice(0, 200)}`,
    );
  }
}

export class AuthFetchError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthFetchError";
  }
}

/**
 * Normalize HeadersInit (plain object | Headers | string[][]) into a plain Record.
 * This prevents silent failures when spreading a Headers instance.
 * Coerces all values to strings for safety.
 */
export function normalizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};

  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) {
      out[key] = String(value);
    }
    return out;
  }

  // Plain object — coerce values to strings
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = String(value);
  }
  return out;
}
