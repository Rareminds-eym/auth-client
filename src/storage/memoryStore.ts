/**
 * In-memory token store — instance-scoped.
 *
 * Access tokens are NEVER persisted to localStorage/sessionStorage.
 * They live only in JS memory — lost on page refresh by design.
 * initSession() restores them via the refresh-token cookie.
 *
 * Each AuthClient gets its own MemoryStore, so multiple clients
 * (e.g. different SSO providers) don't share token state.
 */

/** Minimal JWT structure check: three base64url segments separated by dots. */
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class MemoryStore {
  #accessToken: string | null = null;

  set(token: string): void {
    if (!token || typeof token !== "string") {
      throw new Error(
        "AuthClient: received invalid access_token from server. " +
        "Expected a non-empty string.",
      );
    }

    if (!JWT_PATTERN.test(token)) {
      throw new Error(
        "AuthClient: received malformed access_token from server. " +
        "Expected a valid JWT (header.payload.signature).",
      );
    }

    this.#accessToken = token;
  }

  get(): string | null {
    return this.#accessToken;
  }

  clear(): void {
    this.#accessToken = null;
  }
}
