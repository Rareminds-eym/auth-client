export interface LoginPayload {
  email: string;
  password: string;
}

export interface SignupPayload {
  email: string;
  password: string;
  name?: string;
  organization_name?: string;
}

export interface AuthResponse {
  access_token: string;
  user?: Record<string, unknown>;
}

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

export interface SessionResult {
  authenticated: boolean;
}

export interface ValidateSessionResult {
  valid: boolean;
  user?: Record<string, unknown>;
}

export type AuthEventType = "LOGIN" | "LOGOUT" | "REFRESH";

export interface AuthEvent {
  type: AuthEventType;
}

/**
 * Callback for auth state changes.
 * Fired on login, logout, refresh — both local and cross-tab.
 */
export type AuthStateChangeCallback = (event: AuthEventType) => void;
