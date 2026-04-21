// ─── Request Payloads ──────────────────────────────────────────

export interface LoginPayload {
  email: string;
  password: string;
}

export interface SignupPayload {
  email: string;
  password: string;
  org_name: string;
  /** Base URL for email links. Must be in the server's ALLOWED_APP_URLS allowlist. */
  redirect_url?: string;
}

export interface SwitchOrgPayload {
  org_id: string;
}

export interface CreateInvitePayload {
  email: string;
  org_id: string;
  role: string[];
  /** Base URL for email links. Must be in the server's ALLOWED_APP_URLS allowlist. */
  redirect_url?: string;
}

export interface AcceptInvitePayload {
  token: string;
  password?: string;
}

// ─── Response Types (aligned with SSO worker) ─────────────────

export type MembershipStatus = "active" | "inactive" | "suspended" | "expired";

export interface LoginResponse {
  access_token: string;
  user: { id: string; email: string };
  active_org_id: string;
  organizations: Array<{ org_id: string }>;
}

export interface SignupResponse {
  access_token: string;
  user: { id: string; email: string };
  org: { id: string; name: string; slug: string };
}

export interface RefreshResponse {
  access_token: string;
}

export interface SwitchOrgResponse {
  access_token: string;
  org_id: string;
  roles: string[];
}

export interface OrgListItem {
  org_id: string;
  roles: string[];
  name: string | null;
  slug: string | null;
  is_active: boolean;
}

export interface ListOrgsResponse {
  organizations: OrgListItem[];
}

export interface CreateInviteResponse {
  invite_id: string;
  email: string;
  expires_at: string;
}

export interface AcceptInviteResponse {
  access_token: string;
  user: { id: string; email: string };
  org_id: string;
}

export interface RequestVerificationResponse {
  message?: string;
  already_verified?: boolean;
}

export interface VerifyEmailResponse {
  verified: boolean;
}

export interface VerifyEmailPayload {
  token: string;
}

export interface RequestVerificationPayload {
  /** Base URL for email links. Must be in the server's ALLOWED_APP_URLS allowlist. */
  redirect_url?: string;
}

export interface ForgotPasswordPayload {
  email: string;
  /** Base URL for email links. Must be in the server's ALLOWED_APP_URLS allowlist. */
  redirect_url?: string;
}

export interface ResetPasswordPayload {
  token: string;
  password: string;
}

export interface ForgotPasswordResponse {
  message: string;
}

export interface ResetPasswordResponse {
  reset: boolean;
}

export interface CancelInvitePayload {
  invite_id: string;
}

export interface CancelInviteResponse {
  cancelled: boolean;
}

export interface ResendInvitePayload {
  invite_id: string;
  /** Base URL for email links. Must be in the server's ALLOWED_APP_URLS allowlist. */
  redirect_url?: string;
}

export interface ResendInviteResponse {
  invite_id: string;
  email: string;
  expires_at: string;
}

export interface MeResponse {
  sub: string;
  email: string;
  org_id: string;
  roles: string[];
  products: string[];
  membership_status: MembershipStatus;
  is_email_verified: boolean;
}

/**
 * @deprecated Use LoginResponse or SignupResponse instead.
 * Kept for backward compatibility.
 */
export interface AuthResponse {
  access_token: string;
  user?: { id: string; email: string };
}

// ─── Client Config ─────────────────────────────────────────────

export interface AuthClientConfig {
  /** SSO base URL, e.g. https://auth.rareminds.com */
  baseURL: string;

  /**
   * Called when the user is forcefully logged out
   * (e.g. session expired and refresh failed).
   * Use this to redirect to login page.
   */
  onSessionExpired?: () => void;

  /**
   * Enable debug logging for troubleshooting auth flows.
   * Logs to console.debug — safe to leave on in dev, off in prod.
   */
  debug?: boolean;
}

// ─── Session ───────────────────────────────────────────────────

export interface SessionResult {
  authenticated: boolean;
}

/**
 * @deprecated Use MeResponse instead.
 */
export type ValidateSessionResult = MeResponse;

// ─── Events ────────────────────────────────────────────────────

export type AuthEventType = "LOGIN" | "LOGOUT" | "REFRESH";

export interface AuthEvent {
  type: AuthEventType;
}

/**
 * Callback for auth state changes.
 * Fired on login, logout, refresh — both local and cross-tab.
 */
export type AuthStateChangeCallback = (event: AuthEventType) => void;
