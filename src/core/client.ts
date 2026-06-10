import { MemoryStore } from "../storage/memoryStore.js";
import { SyncChannel } from "../sync/channel.js";
import type {
  AcceptInvitePayload,
  AcceptInviteResponse,
  AuthClientConfig,
  AuthStateChangeCallback,
  CancelInvitePayload,
  CancelInviteResponse,
  CreateInvitePayload,
  CreateInviteResponse,
  ForgotPasswordPayload,
  ForgotPasswordResponse,
  ListOrgsResponse,
  LoginPayload,
  LoginResponse,
  MeResponse,
  RefreshResponse,
  RequestVerificationPayload,
  RequestVerificationResponse,
  ResendInvitePayload,
  ResendInviteResponse,
  ResetPasswordPayload,
  ResetPasswordResponse,
  SessionResult,
  SignupMemberPayload,
  SignupMemberResponse,
  SignupPayload,
  SignupResponse,
  SwitchOrgPayload,
  SwitchOrgResponse,
  VerifyEmailPayload,
  VerifyEmailResponse,
} from "../types/auth.js";
import { fetcher, normalizeHeaders } from "../utils/fetcher.js";

const DEFAULT_CHANNEL_NAME = "rareminds_auth_channel";
const MAX_REFRESH_RETRIES = 2;
const REFRESH_BASE_BACKOFF_MS = 300;
const REFRESH_JITTER_MS = 100;

export class AuthClient {
  readonly #baseURL: string;
  readonly #onSessionExpired?: () => void;
  readonly #debug: boolean;
  readonly #store: MemoryStore;
  readonly #channel: SyncChannel;

  #unsubscribe: (() => void) | null = null;
  #initialized = false;
  #refreshing: Promise<RefreshResponse> | null = null;
  #listeners = new Set<AuthStateChangeCallback>();
  #destroyed = false;

  /**
   * Counter for nested cross-tab rehydrations.
   * Incremented when a cross-tab event triggers initSession(),
   * decremented when it completes. Broadcasts are suppressed while > 0.
   */
  #suppressBroadcastDepth = 0;

  constructor(config: AuthClientConfig) {
    this.#baseURL = config.baseURL.replace(/\/+$/, "");
    this.#onSessionExpired = config.onSessionExpired;
    this.#debug = config.debug ?? false;

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
  async login(payload: LoginPayload): Promise<LoginResponse> {
    this.#assertNotDestroyed();
    this.#log("login: starting");

    const data = await fetcher<LoginResponse>(
      `${this.#baseURL}/auth/login`,
      { method: "POST", body: JSON.stringify(payload) },
    );

    this.#store.set(data.access_token);
    this.#initialized = true;
    this.#emit("LOGIN");
    this.#broadcastIfAllowed({ type: "LOGIN" });
    this.#log("login: success");

    return data;
  }

  /**
   * Register a new user + organization.
   * Behaves identically to login on success.
   */
  async signup(payload: SignupPayload): Promise<SignupResponse> {
    this.#assertNotDestroyed();
    this.#log("signup: starting");

    const data = await fetcher<SignupResponse>(
      `${this.#baseURL}/auth/signup`,
      { method: "POST", body: JSON.stringify(payload) },
    );

    this.#store.set(data.access_token);
    this.#initialized = true;
    this.#emit("LOGIN");
    this.#broadcastIfAllowed({ type: "LOGIN" });
    this.#log("signup: success");

    return data;
  }

  /**
   * Register a new member user (no org creation).
   * Creates a user and optionally joins a specified org with the given role.
   * Behaves identically to login on success.
   */
  async signupMember(payload: SignupMemberPayload): Promise<SignupMemberResponse> {
    this.#assertNotDestroyed();
    this.#log("signupMember: starting");

    const data = await fetcher<SignupMemberResponse>(
      `${this.#baseURL}/auth/signup-member`,
      { method: "POST", body: JSON.stringify(payload) },
    );

    this.#store.set(data.access_token);
    this.#initialized = true;
    this.#emit("LOGIN");
    this.#broadcastIfAllowed({ type: "LOGIN" });
    this.#log("signupMember: success");

    return data;
  }

  /**
   * End the session.
   * Server revokes the session and clears the refresh cookie.
   */
  async logout(): Promise<void> {
    this.#log("logout: starting");

    try {
      await fetcher(`${this.#baseURL}/auth/logout`, { method: "POST" });
    } catch {
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
   * Cross-tab single-flight using Web Locks API (with localStorage fallback).
   */
  async refresh(): Promise<RefreshResponse> {
    this.#assertNotDestroyed();

    if (this.#refreshing) {
      this.#log("refresh: joining existing in-flight request");
      return this.#refreshing;
    }

    this.#log("refresh: starting");
    this.#refreshing = this.#refreshSingleFlight();

    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }

  async #refreshSingleFlight(): Promise<RefreshResponse> {
    // Cross-tab single-flight using Web Locks API
    if (typeof navigator !== "undefined" && "locks" in navigator) {
      this.#log("refresh: using Web Locks API for cross-tab coordination");
      return navigator.locks.request(
        "rareminds_auth_refresh",
        { mode: "exclusive" },
        async () => {
          // Check if another tab already refreshed while we were waiting
          const currentToken = this.#store.get();
          if (currentToken && this.#refreshing) {
            this.#log("refresh: token already refreshed by another tab");
            return { access_token: currentToken, refresh_token: "" } as RefreshResponse;
          }
          return this.#executeRefresh();
        }
      );
    }

    // Fallback: localStorage mutex for older browsers
    this.#log("refresh: using localStorage mutex for cross-tab coordination");
    return this.#executeRefreshWithLocalStorageMutex();
  }

  async #executeRefreshWithLocalStorageMutex(): Promise<RefreshResponse> {
    const LOCK_KEY = "rareminds_auth_refresh_lock";
    const LOCK_TIMEOUT_MS = 10000; // 10 seconds stale lock timeout
    const POLL_INTERVAL_MS = 50;

    // Try to acquire lock
    const acquireLock = (): boolean => {
      const now = Date.now();
      const existingLock = localStorage.getItem(LOCK_KEY);

      if (existingLock) {
        try {
          const { timestamp } = JSON.parse(existingLock);
          // Check if lock is stale
          if (now - timestamp > LOCK_TIMEOUT_MS) {
            this.#log("refresh: removing stale lock");
            localStorage.removeItem(LOCK_KEY);
          } else {
            return false; // Lock is held by another tab
          }
        } catch {
          // Invalid lock format, remove it
          localStorage.removeItem(LOCK_KEY);
        }
      }

      // Acquire lock
      const lockId = `${now}_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(LOCK_KEY, JSON.stringify({ timestamp: now, id: lockId }));
      return true;
    };

    const releaseLock = () => {
      try {
        localStorage.removeItem(LOCK_KEY);
      } catch {
        // Ignore errors during cleanup
      }
    };

    // Wait for lock with timeout
    const maxWaitTime = 5000; // 5 seconds max wait
    const startWait = Date.now();

    while (!acquireLock()) {
      if (Date.now() - startWait > maxWaitTime) {
        this.#log("refresh: lock acquisition timeout, proceeding anyway");
        break;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      // Check if another tab already refreshed
      const currentToken = this.#store.get();
      if (currentToken) {
        this.#log("refresh: token already refreshed by another tab (detected via BroadcastChannel)");
        return { access_token: currentToken, refresh_token: "" } as RefreshResponse;
      }
    }

    try {
      return await this.#executeRefresh();
    } finally {
      releaseLock();
    }
  }

  async #executeRefresh(): Promise<RefreshResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter
        const backoffMs = REFRESH_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        const jitter = Math.random() * REFRESH_JITTER_MS;
        const delayMs = backoffMs + jitter;

        this.#log(`refresh: retry attempt ${attempt}/${MAX_REFRESH_RETRIES} after ${delayMs.toFixed(0)}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      try {
        const data = await fetcher<RefreshResponse>(
          `${this.#baseURL}/auth/refresh`,
          {
            method: "POST",
            timeoutMs: 8000, // 8 second timeout
          },
        );

        this.#store.set(data.access_token);
        this.#emit("REFRESH");
        this.#broadcastIfAllowed({ type: "REFRESH", token: data.access_token });
        this.#log("refresh: success");

        return data;
      } catch (error) {
        lastError = error as Error;

        // Check if this is a definitive auth error (401/403) - don't retry
        if (error instanceof Error && 'status' in error) {
          const status = (error as any).status;
          if (status === 401 || status === 403) {
            this.#log(`refresh: definitive auth error (${status}), not retrying`);
            break;
          }
        }

        // Check for transient errors (network, timeout, 5xx, 429)
        const isTransient =
          error instanceof Error && (
            error.name === "AbortError" ||
            error.message.includes("timeout") ||
            error.message.includes("network") ||
            ('status' in error && ((error as any).status >= 500 || (error as any).status === 429))
          );

        if (!isTransient || attempt === MAX_REFRESH_RETRIES) {
          this.#log(`refresh: ${isTransient ? 'exhausted retries' : 'non-transient error'}`);
          break;
        }

        this.#log(`refresh: transient error, will retry: ${error.message}`);
      }
    }

    // All retries exhausted or definitive failure
    this.#log("refresh: failed, triggering logout");
    await this.logout();
    this.#notifySessionExpired();

    throw lastError || new Error("Refresh failed after retries");
  }

  /**
   * Switch the active organization.
   * Revokes the current session and creates a new one scoped to the target org.
   * The server sets rotated cookies automatically.
   */
  async switchOrg(payload: SwitchOrgPayload): Promise<SwitchOrgResponse> {
    this.#assertNotDestroyed();
    this.#log("switchOrg: starting", { org_id: payload.org_id });

    const token = this.#store.get();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    const data = await fetcher<SwitchOrgResponse>(
      `${this.#baseURL}/auth/switch-org`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );

    this.#store.set(data.access_token);
    this.#initialized = true;
    this.#emit("REFRESH");
    this.#broadcastIfAllowed({ type: "REFRESH", token: data.access_token });
    this.#log("switchOrg: success", { org_id: data.org_id });

    return data;
  }

  /**
   * List all organizations the current user belongs to.
   */
  async listOrgs(): Promise<ListOrgsResponse> {
    this.#assertNotDestroyed();
    this.#log("listOrgs: fetching");

    const token = this.#store.get();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    return fetcher<ListOrgsResponse>(
      `${this.#baseURL}/auth/orgs`,
      { method: "GET", headers },
    );
  }

  /**
   * Create an invite for a user to join the caller's active organization.
   * Requires owner or admin role. The server sends the invitation email directly.
   */
  async createInvite(payload: CreateInvitePayload): Promise<CreateInviteResponse> {
    this.#assertNotDestroyed();
    this.#log("createInvite: starting", { email: payload.email });

    const token = this.#store.get();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    return fetcher<CreateInviteResponse>(
      `${this.#baseURL}/auth/invite`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );
  }

  /**
   * Accept an invite token. Creates the user if they don't exist (password required).
   * Logs the user in to the invited organization.
   */
  async acceptInvite(payload: AcceptInvitePayload): Promise<AcceptInviteResponse> {
    this.#assertNotDestroyed();
    this.#log("acceptInvite: starting");

    const data = await fetcher<AcceptInviteResponse>(
      `${this.#baseURL}/auth/invite/accept`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    this.#store.set(data.access_token);
    this.#initialized = true;
    this.#emit("LOGIN");
    this.#broadcastIfAllowed({ type: "LOGIN" });
    this.#log("acceptInvite: success");

    return data;
  }

  /**
   * Request a verification email for the current user.
   * Requires authentication. The server sends the email directly.
   * Returns a confirmation message, or { already_verified: true } if already verified.
   */
  async requestVerification(payload?: RequestVerificationPayload): Promise<RequestVerificationResponse> {
    this.#assertNotDestroyed();
    this.#log("requestVerification: starting");

    const token = this.#store.get();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    return fetcher<RequestVerificationResponse>(
      `${this.#baseURL}/auth/request-verification`,
      { method: "POST", headers, body: JSON.stringify(payload ?? {}) },
    );
  }

  /**
   * Verify an email address using a verification token.
   * No authentication required — the user clicks a link from their email.
   */
  async verifyEmail(payload: VerifyEmailPayload): Promise<VerifyEmailResponse> {
    this.#assertNotDestroyed();
    this.#log("verifyEmail: starting");

    return fetcher<VerifyEmailResponse>(
      `${this.#baseURL}/auth/verify-email`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  /**
   * Request a password reset email. Always returns the same message
   * to prevent email enumeration. If the account exists, the server
   * sends a reset email with a time-limited link.
   */
  async forgotPassword(payload: ForgotPasswordPayload): Promise<ForgotPasswordResponse> {
    this.#assertNotDestroyed();
    this.#log("forgotPassword: starting");

    return fetcher<ForgotPasswordResponse>(
      `${this.#baseURL}/auth/forgot-password`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  /**
   * Reset password using a valid reset token.
   * Revokes all existing sessions (forces re-login everywhere).
   */
  async resetPassword(payload: ResetPasswordPayload): Promise<ResetPasswordResponse> {
    this.#assertNotDestroyed();
    this.#log("resetPassword: starting");

    return fetcher<ResetPasswordResponse>(
      `${this.#baseURL}/auth/reset-password`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  /**
   * Cancel a pending invite. Requires owner/admin role or being the original inviter.
   */
  async cancelInvite(payload: CancelInvitePayload): Promise<CancelInviteResponse> {
    this.#assertNotDestroyed();
    this.#log("cancelInvite: starting");

    const token = this.#store.get();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    return fetcher<CancelInviteResponse>(
      `${this.#baseURL}/auth/invite/cancel`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );
  }

  /**
   * Resend an invite email with a new token and extended expiry.
   * Requires owner or admin role. The server sends the invitation email directly.
   */
  async resendInvite(payload: ResendInvitePayload): Promise<ResendInviteResponse> {
    this.#assertNotDestroyed();
    this.#log("resendInvite: starting");

    const token = this.#store.get();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    return fetcher<ResendInviteResponse>(
      `${this.#baseURL}/auth/invite/resend`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );
  }

  /**
   * Restore session on page load / reload.
   * Call this once at app startup (before rendering protected routes).
   *
   * Uses the refresh-token cookie to obtain a fresh access token.
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
      this.#initialized = false; // Unconditional reset on failure
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
   * 4. Syncs X-Access-Token header from server-side refresh responses.
   *
   * Respects the caller's AbortSignal.
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

    // Sync X-Access-Token from response if present (server-side refresh)
    const serverRefreshedToken = res.headers.get("X-Access-Token");
    if (serverRefreshedToken) {
      this.#log("fetch: syncing X-Access-Token from server-side refresh");
      this.#store.set(serverRefreshedToken);
    }

    if (res.status === 401) {
      if (signal?.aborted) {
        this.#log("fetch: 401 received but signal already aborted, skipping retry");
        return res;
      }

      this.#log("fetch: 401 received, attempting silent refresh");

      try {
        const refreshed = await this.refresh();
        res = await makeRequest(refreshed.access_token);

        // Sync X-Access-Token from retry response if present
        const retryToken = res.headers.get("X-Access-Token");
        if (retryToken) {
          this.#log("fetch: syncing X-Access-Token from retry response");
          this.#store.set(retryToken);
        }
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
   * Get the current user's identity from the SSO server.
   * Calls GET /auth/me with the current access token.
   */
  async getMe(): Promise<MeResponse> {
    this.#assertNotDestroyed();

    const token = this.#store.get();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    return fetcher<MeResponse>(
      `${this.#baseURL}/auth/me`,
      { method: "GET", headers },
    );
  }

  /**
   * @deprecated Use getMe() instead.
   */
  async validateSession(): Promise<MeResponse> {
    return this.getMe();
  }

  // ─── Event System ──────────────────────────────────────────

  /**
   * Subscribe to auth state changes (login, logout, refresh).
   * Returns an unsubscribe function.
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
          if (event.token) {
            this.#log(`cross-tab: ${event.type} received with token, syncing state directly`);
            this.#store.set(event.token);
            this.#initialized = true;
            this.#emit(event.type);
          } else {
            this.#log(`cross-tab: ${event.type} received without token, rehydrating via network`);
            this.#suppressBroadcastDepth++;
            this.initSession().finally(() => {
              this.#suppressBroadcastDepth--;
            });
          }
          break;
      }
    });
  }

  // ─── Internal helpers ──────────────────────────────────────

  #broadcastIfAllowed(event: { type: "LOGIN" | "LOGOUT" | "REFRESH", token?: string }): void {
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
      console.debug("[AuthClient]", ...args);
    }
  }

  /**
   * Tear down event listeners and release resources.
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
