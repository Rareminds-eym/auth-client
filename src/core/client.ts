import { MemoryStore } from "../storage/memoryStore.js";
import { fetcher, normalizeHeaders } from "../utils/fetcher.js";
import { SyncChannel } from "../sync/channel.js";
import type {
  LoginPayload,
  SignupPayload,
  AuthResponse,
  AuthClientConfig,
  SessionResult,
  ValidateSessionResult,
  AuthStateChangeCallback,
} from "../types/auth.js";

const DEFAULT_CHANNEL_NAME = "rareminds_auth_channel";

export class AuthClient {
  readonly #baseURL: string;
  readonly #onSessionExpired?: () => void;
  readonly #debug: boolean;
  readonly #store: MemoryStore;
  readonly #channel: SyncChannel;

  #unsubscribe: (() => void) | null = null;
  #initialized = false;
  #refreshing: Promise<AuthResponse> | null = null;
  #listeners = new Set<AuthStateChangeCallback>();
  #destroyed = false;

  /**
   * Counter for nested cross-tab rehydrations.
   * Incremented when a cross-tab event triggers initSession(),
   * decremented when it completes. Broadcasts are suppressed while > 0.
   * A counter (not boolean) prevents rapid cross-tab events from
   * prematurely re-enabling broadcasts.
   */
  #suppressBroadcastDepth = 0;

  constructor(config: AuthClientConfig) {
    this.#baseURL = config.baseURL.replace(/\/+$/, "");
    this.#onSessionExpired = config.onSessionExpired;
    this.#debug = config.debug ?? false;

    // Instance-scoped store and channel — safe for multi-client usage
    this.#store = new MemoryStore();
    this.#channel = new SyncChannel(DEFAULT_CHANNEL_NAME);

    this.#setupCrossTabSync();
    this.#log("AuthClient initialized", { baseURL: this.#baseURL });
  }

  // ─── Public API ────────────────────────────────────────────

  /**
   * Authenticate with email + password.
   * Sets the access token in memory; refresh token is set via HttpOnly cookie by the server.
   */
  async login(payload: LoginPayload): Promise<AuthResponse> {
    this.#assertNotDestroyed();
    this.#log("login: starting");

    const data = await fetcher<AuthResponse>(
      `${this.#baseURL}/auth/login`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    this.#store.set(data.access_token);
    this.#emit("LOGIN");
    this.#broadcastIfAllowed({ type: "LOGIN" });
    this.#log("login: success");

    return data;
  }

  /**
   * Register a new user (+ optional organization).
   * Behaves identically to login on success.
   */
  async signup(payload: SignupPayload): Promise<AuthResponse> {
    this.#assertNotDestroyed();
    this.#log("signup: starting");

    const data = await fetcher<AuthResponse>(
      `${this.#baseURL}/auth/signup`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    this.#store.set(data.access_token);
    this.#emit("LOGIN");
    this.#broadcastIfAllowed({ type: "LOGIN" });
    this.#log("signup: success");

    return data;
  }

  /**
   * End the session.
   * Server deletes the session row and clears the refresh cookie.
   */
  async logout(): Promise<void> {
    this.#log("logout: starting");

    try {
      await fetcher(`${this.#baseURL}/auth/logout`, {
        method: "POST",
      });
    } catch {
      // best-effort — clear local state regardless
      this.#log("logout: server call failed, clearing local state anyway");
    }

    this.#store.clear();
    this.#emit("LOGOUT");
    this.#broadcastIfAllowed({ type: "LOGOUT" });
    this.#log("logout: complete");
  }

  /**
   * Silent token refresh using the HttpOnly refresh-token cookie.
   * De-duplicated: concurrent calls share a single in-flight request.
   */
  async refresh(): Promise<AuthResponse> {
    this.#assertNotDestroyed();

    if (this.#refreshing) {
      this.#log("refresh: joining existing in-flight request");
      return this.#refreshing;
    }

    this.#log("refresh: starting");
    this.#refreshing = this.#executeRefresh();

    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }

  async #executeRefresh(): Promise<AuthResponse> {
    const data = await fetcher<AuthResponse>(
      `${this.#baseURL}/auth/refresh`,
      { method: "POST" },
    );

    this.#store.set(data.access_token);
    this.#emit("REFRESH");
    this.#broadcastIfAllowed({ type: "REFRESH" });
    this.#log("refresh: success");

    return data;
  }

  /**
   * Restore session on page load / reload.
   * Call this once at app startup (before rendering protected routes).
   *
   * Uses the refresh-token cookie to obtain a fresh access token.
   * On failure, clears the token but preserves `#initialized` if it was
   * previously true (avoids breaking consumers during cross-tab rehydration).
   */
  async initSession(): Promise<SessionResult> {
    this.#log("initSession: starting");

    try {
      await this.refresh();
      this.#initialized = true;
      this.#log("initSession: authenticated");
      return { authenticated: true };
    } catch {
      this.#store.clear();
      // Only set initialized=false if this is the first call.
      // If we were already initialized (e.g. cross-tab rehydration failed),
      // keep the flag true — the token is gone but the app knows it was
      // initialized and can react to isAuthenticated() being false.
      if (!this.#initialized) {
        this.#initialized = false;
      }
      this.#log("initSession: not authenticated");
      return { authenticated: false };
    }
  }

  /**
   * Authenticated fetch — drop-in replacement for `window.fetch`.
   *
   * 1. Attaches the current access token as Bearer header.
   * 2. On 401, silently refreshes and retries once.
   * 3. On second failure, triggers logout + onSessionExpired callback.
   *
   * Respects the caller's AbortSignal — if aborted, the retry is skipped.
   */
  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    this.#assertNotDestroyed();

    const { headers: initHeaders, signal, ...rest } = init;

    const makeRequest = (token: string | null): Promise<Response> =>
      fetch(input, {
        ...rest,
        signal,
        credentials: "include",
        headers: {
          ...normalizeHeaders(initHeaders),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

    let res = await makeRequest(this.#store.get());

    if (res.status === 401) {
      // If the caller already aborted, don't bother retrying
      if (signal?.aborted) {
        this.#log("fetch: 401 received but signal already aborted, skipping retry");
        return res;
      }

      this.#log("fetch: 401 received, attempting silent refresh");

      try {
        const refreshed = await this.refresh();
        res = await makeRequest(refreshed.access_token);
      } catch {
        this.#log("fetch: refresh failed, logging out");
        await this.logout();
        this.#notifySessionExpired();
        throw new Error("Session expired. User has been logged out.");
      }
    }

    return res;
  }

  /**
   * Validate the current session against the SSO server.
   * Returns user info if the session is still valid.
   *
   * Uses the access token (Bearer) + cookie for validation.
   * This is an optional check — most flows rely on initSession() + refresh instead.
   */
  async validateSession(): Promise<ValidateSessionResult> {
    this.#assertNotDestroyed();

    const token = this.#store.get();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    const data = await fetcher<ValidateSessionResult>(
      `${this.#baseURL}/auth/validate-session`,
      { method: "POST", headers },
    );
    return data;
  }

  // ─── Event System ──────────────────────────────────────────

  /**
   * Subscribe to auth state changes (login, logout, refresh).
   * Returns an unsubscribe function.
   *
   * Optionally fires immediately with the current state if `fireImmediately` is true.
   *
   * @example
   * const unsub = auth.onAuthStateChange((event) => {
   *   if (event === "LOGOUT") router.push("/login");
   * });
   */
  onAuthStateChange(
    callback: AuthStateChangeCallback,
    options?: { fireImmediately?: boolean },
  ): () => void {
    this.#listeners.add(callback);

    if (options?.fireImmediately) {
      const currentEvent = this.isAuthenticated() ? "LOGIN" : "LOGOUT";
      try {
        callback(currentEvent);
      } catch {
        // don't let a bad listener break the subscription
      }
    }

    return () => {
      this.#listeners.delete(callback);
    };
  }

  #emit(event: "LOGIN" | "LOGOUT" | "REFRESH"): void {
    if (this.#destroyed) return;
    for (const cb of this.#listeners) {
      try {
        cb(event);
      } catch {
        // don't let a bad listener break the auth flow
      }
    }
  }

  #notifySessionExpired(): void {
    try {
      this.#onSessionExpired?.();
    } catch {
      // don't let a bad callback break the auth flow
    }
  }

  // ─── Accessors ─────────────────────────────────────────────

  /** Current in-memory access token (may be null). */
  getAccessToken(): string | null {
    return this.#store.get();
  }

  /** Whether initSession() has completed successfully at least once. */
  isInitialized(): boolean {
    return this.#initialized;
  }

  /** Whether the client currently holds an access token. */
  isAuthenticated(): boolean {
    return !!this.#store.get();
  }

  // ─── Cross-tab sync ────────────────────────────────────────

  #setupCrossTabSync(): void {
    this.#unsubscribe = this.#channel.subscribe((event) => {
      if (this.#destroyed) return;

      switch (event.type) {
        case "LOGOUT":
          this.#log("cross-tab: LOGOUT received");
          this.#store.clear();
          this.#initialized = false;
          this.#emit("LOGOUT");
          this.#notifySessionExpired();
          break;

        case "LOGIN":
        case "REFRESH":
          // Another tab logged in or refreshed — rehydrate this tab.
          // Suppress broadcast to prevent infinite ping-pong between tabs.
          this.#log(`cross-tab: ${event.type} received, rehydrating`);
          this.#suppressBroadcastDepth++;
          this.initSession().finally(() => {
            this.#suppressBroadcastDepth--;
          });
          break;
      }
    });
  }

  // ─── Internal helpers ──────────────────────────────────────

  /**
   * Broadcast only when not suppressed (cross-tab rehydration)
   * and not destroyed. Consistent for all event types.
   */
  #broadcastIfAllowed(event: { type: "LOGIN" | "LOGOUT" | "REFRESH" }): void {
    if (this.#suppressBroadcastDepth === 0 && !this.#destroyed) {
      this.#channel.broadcast(event);
    }
  }

  #assertNotDestroyed(): void {
    if (this.#destroyed) {
      throw new Error(
        "AuthClient: this instance has been destroyed. Create a new AuthClient.",
      );
    }
  }

  #log(...args: unknown[]): void {
    if (this.#debug) {
      // eslint-disable-next-line no-console
      console.debug("[AuthClient]", ...args);
    }
  }

  /**
   * Tear down event listeners and release resources.
   * Call this if you ever need to dispose of the client instance.
   *
   * After calling destroy(), all public methods will throw.
   */
  destroy(): void {
    if (this.#destroyed) return;

    this.#log("destroy: tearing down");
    this.#destroyed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listeners.clear();
    this.#store.clear();
    this.#channel.close();
  }
}
