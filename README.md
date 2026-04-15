# @rareminds-eym/auth-client

Browser authentication SDK for the RareMinds SSO platform. Handles login, signup, silent refresh, session restore, org switching, invite management, email verification, password reset, multi-tab sync, and authenticated API calls.

## Features

- Cookie-based refresh tokens (HttpOnly, Secure, SameSite — never accessible to JS)
- In-memory JWT access tokens (never persisted to storage)
- Silent refresh on 401 with automatic request retry
- Session restore on page reload via `initSession()`
- Multi-tab sync — logout, login, refresh propagate across all tabs
- De-duplicated refresh — concurrent calls share a single in-flight request
- Full multi-tenant support — org switching, org listing, invite flows
- Email verification flow
- Password reset flow (forgot + reset)
- Invite management — create, accept, cancel, resend
- Framework-agnostic — React, Vue, Svelte, Angular, vanilla JS
- Zero runtime dependencies
- Full TypeScript with strict response types matching the SSO worker

## Install

```bash
npm install @rareminds-eym/auth-client
```

`.npmrc` for GitHub Packages:
```
@rareminds-eym:registry=https://npm.pkg.github.com
```

## Quick Start

```ts
import { AuthClient } from "@rareminds-eym/auth-client";

const auth = new AuthClient({
  baseURL: "https://sso-api.your-domain.workers.dev",
  onSessionExpired: () => (window.location.href = "/login"),
});

// Restore session on page load
const { authenticated } = await auth.initSession();

// Login
const { access_token, user, active_org_id, organizations } = await auth.login({
  email: "user@example.com",
  password: "secret",
});

// Authenticated API calls (auto-refresh on 401)
const res = await auth.fetch("https://api.example.com/data");

// Logout (clears all tabs)
await auth.logout();
```

## API Reference

### Authentication

#### `login(payload): Promise<LoginResponse>`

```ts
const { access_token, user, active_org_id, organizations } = await auth.login({
  email: "user@example.com",
  password: "secret",
});
// user: { id, email }
// organizations: [{ org_id }]
```

#### `signup(payload): Promise<SignupResponse>`

```ts
const { access_token, user, org } = await auth.signup({
  email: "new@example.com",
  password: "secret",
  org_name: "Acme Corp",
});
// org: { id, name, slug }
```

#### `logout(): Promise<void>`

Best-effort server call — local state is always cleared.

#### `refresh(): Promise<RefreshResponse>`

Silent refresh via HttpOnly cookie. De-duplicated across concurrent callers.

```ts
const { access_token } = await auth.refresh();
```

#### `initSession(): Promise<SessionResult>`

Call once at app startup before rendering protected routes.

```ts
const { authenticated } = await auth.initSession();
```

### Identity

#### `getMe(): Promise<MeResponse>`

```ts
const me = await auth.getMe();
// { sub, email, org_id, roles, products, membership_status, is_email_verified }
```

### Organizations

#### `listOrgs(): Promise<ListOrgsResponse>`

```ts
const { organizations } = await auth.listOrgs();
// [{ org_id, roles, name, slug, is_active }]
```

#### `switchOrg(payload): Promise<SwitchOrgResponse>`

Switches active org, rotates session.

```ts
const { access_token, org_id, roles } = await auth.switchOrg({ org_id: "target-uuid" });
```

### Invites

#### `createInvite(payload): Promise<CreateInviteResponse>`

Requires owner or admin role.

```ts
const { invite_id, token, email, expires_at } = await auth.createInvite({
  email: "new@example.com",
  org_id: "your-org-uuid",
  role: ["member"],
});
```

#### `acceptInvite(payload): Promise<AcceptInviteResponse>`

Creates user if needed (password required for new users). Logs in automatically.

```ts
const { access_token, user, org_id } = await auth.acceptInvite({
  token: "invite-uuid",
  password: "required-for-new-users",
});
```

#### `cancelInvite(payload): Promise<CancelInviteResponse>`

Cancel a pending invite. Requires owner/admin role or being the original inviter.

```ts
const { cancelled } = await auth.cancelInvite({ invite_id: "uuid" });
```

#### `resendInvite(payload): Promise<ResendInviteResponse>`

Resend an invite with a new token and extended expiry. Requires owner/admin.

```ts
const { invite_id, token, email, expires_at } = await auth.resendInvite({ invite_id: "uuid" });
```

### Password Reset

#### `forgotPassword(payload): Promise<ForgotPasswordResponse>`

Request a password reset token. Always succeeds to prevent email enumeration.

```ts
const result = await auth.forgotPassword({ email: "user@example.com" });
// { reset_token, expires_at } or { message: "If an account exists..." }
```

#### `resetPassword(payload): Promise<ResetPasswordResponse>`

Reset password using a valid token. Revokes all sessions.

```ts
const { reset } = await auth.resetPassword({
  token: "reset-uuid",
  password: "newpassword",
});
```

### Email Verification

#### `requestVerification(): Promise<RequestVerificationResponse>`

Authenticated. Returns a token to deliver via email.

```ts
const { verification_token, expires_at } = await auth.requestVerification();
// or { already_verified: true }
```

#### `verifyEmail(payload): Promise<VerifyEmailResponse>`

No authentication required.

```ts
const { verified } = await auth.verifyEmail({ token: "verification-uuid" });
```

### Authenticated Fetch

#### `fetch(input, init?): Promise<Response>`

Drop-in replacement for `window.fetch`. Attaches Bearer token, retries on 401 with silent refresh, triggers logout on failure.

```ts
const res = await auth.fetch("https://api.example.com/users", {
  method: "GET",
  signal: controller.signal,
});
```

### Events

#### `onAuthStateChange(callback, options?): () => void`

```ts
const unsub = auth.onAuthStateChange(
  (event) => {
    // "LOGIN" | "LOGOUT" | "REFRESH"
    if (event === "LOGOUT") router.push("/login");
  },
  { fireImmediately: true },
);
```

### Accessors

| Method | Returns |
|--------|---------|
| `getAccessToken()` | Current JWT or `null` |
| `isAuthenticated()` | `true` if token exists in memory |
| `isInitialized()` | `true` after first successful `initSession()` |
| `destroy()` | Tear down listeners, clear state |

## Error Handling

```ts
import { AuthFetchError } from "@rareminds-eym/auth-client";

try {
  await auth.login({ email: "user@example.com", password: "wrong" });
} catch (err) {
  if (err instanceof AuthFetchError) {
    console.error(err.status);   // 401
    console.error(err.message);  // "Invalid credentials"
  }
}
```

`auth.fetch()` does NOT throw on non-2xx — it returns the raw `Response`. It only throws when the session is fully expired.

## Multi-Tab Sync

| Event in Tab A | Effect in Tab B |
|---|---|
| `login()` / `signup()` / `acceptInvite()` | Rehydrates via `initSession()` |
| `logout()` | Clears token, fires `onSessionExpired` |
| `refresh()` / `switchOrg()` | Rehydrates via `initSession()` |

Uses `BroadcastChannel` with `localStorage` fallback. SSR-safe (degrades to no-op).

## Types

```ts
import type {
  // Request payloads
  LoginPayload, SignupPayload, SwitchOrgPayload,
  CreateInvitePayload, AcceptInvitePayload, CancelInvitePayload,
  ResendInvitePayload, VerifyEmailPayload,
  ForgotPasswordPayload, ResetPasswordPayload,

  // Response types (match SSO worker exactly)
  LoginResponse, SignupResponse, RefreshResponse,
  SwitchOrgResponse, ListOrgsResponse, OrgListItem,
  CreateInviteResponse, AcceptInviteResponse,
  CancelInviteResponse, ResendInviteResponse,
  RequestVerificationResponse, VerifyEmailResponse,
  ForgotPasswordResponse, ResetPasswordResponse,
  MeResponse, MembershipStatus,

  // Client
  AuthClientConfig, SessionResult,
  AuthEvent, AuthEventType, AuthStateChangeCallback,

  // Deprecated (backward compat)
  AuthResponse, ValidateSessionResult,
} from "@rareminds-eym/auth-client";
```

## Framework Examples

### React

```tsx
import { useEffect, useState } from "react";
import { AuthClient } from "@rareminds-eym/auth-client";

const auth = new AuthClient({
  baseURL: "https://sso-api.your-domain.workers.dev",
  onSessionExpired: () => (window.location.href = "/login"),
});

export function useAuth() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    auth.initSession().then((res) => {
      setAuthenticated(res.authenticated);
      setLoading(false);
    });
    const unsub = auth.onAuthStateChange((event) => {
      setAuthenticated(event !== "LOGOUT");
    });
    return unsub;
  }, []);

  return { loading, authenticated, auth };
}
```

### Vue 3

```ts
import { ref, onMounted, onUnmounted } from "vue";
import { AuthClient } from "@rareminds-eym/auth-client";

const auth = new AuthClient({
  baseURL: "https://sso-api.your-domain.workers.dev",
  onSessionExpired: () => (window.location.href = "/login"),
});

export function useAuth() {
  const loading = ref(true);
  const authenticated = ref(false);
  let unsub: (() => void) | null = null;

  onMounted(async () => {
    const res = await auth.initSession();
    authenticated.value = res.authenticated;
    loading.value = false;
    unsub = auth.onAuthStateChange((event) => {
      authenticated.value = event !== "LOGOUT";
    });
  });

  onUnmounted(() => unsub?.());
  return { loading, authenticated, auth };
}
```

## Build

```bash
npm run build       # Compile TypeScript → dist/
npm run clean       # Remove dist/
```

## Security Model

| Concern | How it's handled |
|---|---|
| Refresh token storage | HttpOnly cookie — never accessible to JavaScript |
| Access token storage | In-memory only — lost on page refresh by design |
| Session restore | `initSession()` exchanges the HttpOnly cookie for a fresh JWT |
| Cookie transport | All requests use `credentials: "include"` |
| Cross-tab logout | Instant via BroadcastChannel / localStorage fallback |
| Token validation | JWT structure check on receipt (three base64url segments) |
| Cross-tab message integrity | Strict schema validation on incoming messages |
| Post-destroy safety | All public methods throw after `destroy()` |

## SSR / Non-Browser

Safe to import in SSR (Next.js, Nuxt, etc.). All browser APIs are guarded behind `typeof` checks and degrade to no-ops. Auth operations require a browser with cookie support.

## Debug Mode

```ts
const auth = new AuthClient({ baseURL: "...", debug: true });
```

Logs prefixed with `[AuthClient]`: `login: starting`, `refresh: joining existing in-flight request`, `cross-tab: LOGOUT received`, `fetch: 401 received, attempting silent refresh`, etc.

## Advanced Exports

```ts
import {
  AuthClient,        // Main client class
  AuthFetchError,    // Error class with .status and .message
  normalizeHeaders,  // HeadersInit → Record<string, string>
  MemoryStore,       // Instance-scoped in-memory token store
  SyncChannel,       // Instance-scoped BroadcastChannel + localStorage sync
} from "@rareminds-eym/auth-client";
```

## Deprecated Methods

- `validateSession()` → use `getMe()` instead (same behavior, better name)
- `AuthResponse` type → use `LoginResponse` or `SignupResponse` instead
- `ValidateSessionResult` type → use `MeResponse` instead

## Project Structure

```
src/
├── core/client.ts         # AuthClient class
├── storage/memoryStore.ts # In-memory JWT store with structure validation
├── sync/channel.ts        # BroadcastChannel + localStorage cross-tab sync
├── types/auth.ts          # All TypeScript interfaces
├── utils/fetcher.ts       # fetcher(), AuthFetchError, normalizeHeaders()
└── index.ts               # Barrel exports
```

## License

UNLICENSED — private package for Rareminds.
