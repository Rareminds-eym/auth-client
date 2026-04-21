import { MemoryStore } from "../storage/memoryStore.js";
import { fetcher, normalizeHeaders } from "../utils/fetcher.js";
import { SyncChannel } from "../sync/channel.js";
import type {
  LoginPayload,
  SignupPayload,
  SwitchOrgPayload,
  CreateInvitePayload,
  AcceptInvitePayload,
  VerifyEmailPayload,
  RequestVerificationPayload,
  ForgotPasswordPayload,
  ResetPasswordPayload,
  CancelInvitePayload,
  ResendInvitePayload,
  LoginResponse,
  SignupResponse,
  RefreshResponse,
  SwitchOrgResponse,
  ListOrgsResponse,
  CreateInviteResponse,
  AcceptInviteResponse,
  RequestVerificationResponse,
  VerifyEmailResponse,
  ForgotPasswordResponse,
  ResetPasswordResponse,
  CancelInviteResponse,
  ResendInviteResponse,
  MeResponse,
  AuthClientConfig,
  SessionResult,
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
    this.#emit("LOGIN");
    this.#broadcastIfAllowed({ type: "LOGIN" });
    this.#log("signup: success");

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
   */
  async refresh(): Promise<RefreshResponse> {
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

  async #executeRefresh(): Promise<RefreshResponse> {
    const data = await fetcher<RefreshResponse>(
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
    this.#emit("REFRESH");
    this.#broadcastIfAllowed({ type: "REFRESH" });
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

    if (res.status === 401) {
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
