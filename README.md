# @rareminds-eym/auth-client

Production-grade browser authentication SDK for the RareMinds SSO platform.

Handles the full auth lifecycle — login, signup, silent token refresh, session restore, multi-tab sync, and authenticated API calls — so your frontend doesn't have to.

## Features

- Cookie-based refresh tokens (HttpOnly, Secure, SameSite — never accessible to JS)
- In-memory JWT access tokens (never persisted to localStorage/sessionStorage)
- Silent refresh on 401 with automatic request retry
- Session restore on page reload via `initSession()`
- Multi-tab sync — logout, login, and refresh propagate instantly across all tabs
- De-duplicated refresh — concurrent calls share a single in-flight request
- Instance-scoped stores — safe to run multiple clients (different SSO providers)
- AbortSignal support on authenticated fetch
- Debug logging mode for troubleshooting
- Framework-agnostic — works with React, Vue, Svelte, Angular, vanilla JS
- Zero runtime dependencies — only `typescript` as a dev dependency
- ESM-only, tree-shakeable (`sideEffects: false`)
- Full TypeScript types with declaration maps and source maps

## Requirements

- Node.js >= 18 (for build tooling)
- A browser environment with `fetch`, `BroadcastChannel` (optional, falls back to `localStorage`)
- A RareMinds SSO-compatible backend (see [Server Contract](#server-contract))

## Install

```bash
npm install @rareminds-eym/auth-client
```

## Quick Start

```ts
import { AuthClient } from "@rareminds-eym/auth-client";

const auth = new AuthClient({
  baseURL: "https://auth.rareminds.com",
  onSessionExpired: () => (window.location.href = "/login"),
  debug: false, // set true for console.debug logs
});

// 1. Restore session on page load (call before rendering protected routes)
const { authenticated } = await auth.initSession();

// 2. Login
const { access_token, user } = await auth.login({
  email: "user@example.com",
  password: "secret",
});

// 3. Make authenticated API calls (auto-refresh on 401)
const res = await auth.fetch("https://api.rareminds.com/v1/data");
const data = await res.json();

// 4. Logout (clears all tabs)
await auth.logout();
```

---

## Configuration

```ts
interface AuthClientConfig {
  /** SSO base URL, e.g. "https://auth.rareminds.com" */
  baseURL: string;

  /** Called when the session is fully expired and refresh failed. */
  onSessionExpired?: () => void;

  /** Enable [AuthClient] prefixed console.debug logs. Default: false */
  debug?: boolean;
}
```

| Option | Required | Default | Description |
|---|---|---|---|
| `baseURL` | Yes | — | Your SSO server origin. Trailing slashes are stripped automatically. |
| `onSessionExpired` | No | — | Callback fired when a 401 retry fails or a cross-tab LOGOUT is received. Use this to redirect to your login page. |
| `debug` | No | `false` | Enables `console.debug` logging for every auth operation (login, refresh, cross-tab sync, retry, destroy). Safe to leave on in dev. |

---

## API Reference

### `login(payload): Promise<AuthResponse>`

Authenticate with email and password.

```ts
const { access_token, user } = await auth.login({
  email: "user@example.com",
  password: "secret",
});
```

- POSTs to `{baseURL}/auth/login`
- Stores the returned JWT in memory
- Server sets the HttpOnly refresh cookie
- Broadcasts `LOGIN` to all other tabs
- Throws `AuthFetchError` on non-2xx response

### `signup(payload): Promise<AuthResponse>`

Register a new user with optional organization.

```ts
const { access_token, user } = await auth.signup({
  email: "new@example.com",
  password: "secret",
  name: "Gokul",                    // optional
  organization_name: "RareMinds",   // optional
});
```

- POSTs to `{baseURL}/auth/signup`
- Behaves identically to `login()` on success (stores token, broadcasts `LOGIN`)

### `logout(): Promise<void>`

End the session.

```ts
await auth.logout();
```

- POSTs to `{baseURL}/auth/logout` (best-effort — local state is cleared even if the server call fails)
- Clears the in-memory token
- Broadcasts `LOGOUT` to all other tabs
- Server deletes the session row and clears the refresh cookie

### `refresh(): Promise<AuthResponse>`

Silent token refresh using the HttpOnly refresh cookie.

```ts
const { access_token } = await auth.refresh();
```

- POSTs to `{baseURL}/auth/refresh`
- De-duplicated: if 5 components call `refresh()` simultaneously, only one HTTP request fires — all callers share the same promise
- Broadcasts `REFRESH` to other tabs
- You rarely call this directly — `initSession()` and `fetch()` call it for you

### `initSession(): Promise<SessionResult>`

Restore the session on page load or reload.

```ts
const { authenticated } = await auth.initSession();
if (!authenticated) router.push("/login");
```

- Calls `refresh()` internally to exchange the HttpOnly cookie for a fresh JWT
- Returns `{ authenticated: true }` on success, `{ authenticated: false }` on failure
- On failure, clears the token but preserves `isInitialized()` if it was previously `true` (prevents breaking consumers during cross-tab rehydration)
- Call this once at app startup, before rendering protected routes

### `fetch(input, init?): Promise<Response>`

Authenticated fetch — drop-in replacement for `window.fetch`.

```ts
const res = await auth.fetch("https://api.rareminds.com/v1/users", {
  method: "GET",
  signal: controller.signal,
});
```

- Attaches `Authorization: Bearer <token>` from the in-memory store
- Sends cookies with `credentials: "include"`
- On 401: silently calls `refresh()`, then retries the original request once
- On retry failure: calls `logout()`, fires `onSessionExpired`, throws `Error("Session expired. User has been logged out.")`
- Respects `AbortSignal` — if the caller aborts before the retry, the retry is skipped
- Does NOT throw on non-2xx responses (returns the raw `Response`, like `window.fetch`) — it only throws when the session is fully dead

### `validateSession(): Promise<ValidateSessionResult>`

Server-side session validation.

```ts
const { valid, user } = await auth.validateSession();
```

- POSTs to `{baseURL}/auth/validate-session` with both the Bearer token and the cookie
- Returns `{ valid: boolean, user?: Record<string, unknown> }`
- Use for sensitive operations where you want server confirmation, not just a local token check

### `onAuthStateChange(callback, options?): () => void`

Subscribe to auth state transitions.

```ts
const unsub = auth.onAuthStateChange(
  (event) => {
    // event: "LOGIN" | "LOGOUT" | "REFRESH"
    if (event === "LOGOUT") router.push("/login");
  },
  { fireImmediately: true },
);

// Unsubscribe when done
unsub();
```

- Fires on local events AND cross-tab events
- `fireImmediately: true` fires the callback once immediately with the current state (`"LOGIN"` if authenticated, `"LOGOUT"` if not)
- Returns an unsubscribe function

### `getAccessToken(): string | null`

Returns the current in-memory JWT, or `null` if not authenticated.

### `isAuthenticated(): boolean`

Returns `true` if the client currently holds an access token in memory.

### `isInitialized(): boolean`

Returns `true` if `initSession()` has completed successfully at least once. Stays `true` even if a subsequent cross-tab rehydration fails.

### `destroy(): void`

Tear down the client instance.

```ts
auth.destroy();
```

- Closes the BroadcastChannel
- Removes all event listeners
- Clears the in-memory token
- Marks the instance as destroyed — all subsequent public method calls throw `"AuthClient: this instance has been destroyed. Create a new AuthClient."`
- Safe to call multiple times (idempotent)

---

## Error Handling

All SSO server calls (login, signup, logout, refresh, validateSession) throw `AuthFetchError` on non-2xx responses:

```ts
import { AuthFetchError } from "@rareminds-eym/auth-client";

try {
  await auth.login({ email: "user@example.com", password: "wrong" });
} catch (err) {
  if (err instanceof AuthFetchError) {
    console.error(err.status);   // 401
    console.error(err.message);  // "Invalid credentials"
    console.error(err.name);     // "AuthFetchError"
  }
}
```

`AuthFetchError` parses the server response body automatically — it looks for `body.message`, then `body.error`, then falls back to the raw text.

`auth.fetch()` does NOT throw `AuthFetchError` on non-2xx (it returns the raw `Response`). It only throws a plain `Error` when the session is fully expired.

---

## Multi-Tab Sync

Auth state is synchronized across all browser tabs automatically:

| Event in Tab A | What happens in Tab B |
|---|---|
| `login()` or `signup()` | Calls `initSession()` to rehydrate with a fresh token |
| `logout()` | Clears token, fires `onSessionExpired` callback |
| `refresh()` | Calls `initSession()` to rehydrate with a fresh token |

The sync mechanism uses `BroadcastChannel` where available, with a `localStorage` `StorageEvent` fallback for older browsers. In SSR or non-browser environments, sync degrades to a no-op.

All incoming cross-tab messages are validated against a strict schema — only `{ type: "LOGIN" | "LOGOUT" | "REFRESH" }` is accepted. Malformed or malicious messages are silently dropped.

Cross-tab rehydration uses a broadcast suppression counter to prevent infinite ping-pong between tabs.

---

## Security Model

| Concern | How it's handled |
|---|---|
| Refresh token storage | HttpOnly cookie — never accessible to JavaScript |
| Access token storage | In-memory only — lost on page refresh by design |
| Session restore | `initSession()` exchanges the HttpOnly cookie for a fresh JWT |
| Cookie transport | All requests use `credentials: "include"` |
| Cross-tab logout | Instant via BroadcastChannel / localStorage fallback |
| Token validation | JWT structure check on receipt (three base64url segments) |
| Cross-tab message integrity | Strict schema validation on all incoming BroadcastChannel/localStorage messages |
| Content-Type header | Only sent when a request body is present (prevents server rejections on bodyless requests) |
| Post-destroy safety | All public methods throw after `destroy()` is called |
| Listener isolation | Bad listener callbacks are caught — they never break the auth flow |

---

## Debug Mode

```ts
const auth = new AuthClient({
  baseURL: "https://auth.rareminds.com",
  debug: true,
});
```

Logs are prefixed with `[AuthClient]` and cover:

- `login: starting` / `login: success`
- `signup: starting` / `signup: success`
- `logout: starting` / `logout: complete` / `logout: server call failed, clearing local state anyway`
- `refresh: starting` / `refresh: success` / `refresh: joining existing in-flight request`
- `initSession: starting` / `initSession: authenticated` / `initSession: not authenticated`
- `fetch: 401 received, attempting silent refresh` / `fetch: refresh failed, logging out` / `fetch: 401 received but signal already aborted, skipping retry`
- `cross-tab: LOGOUT received` / `cross-tab: LOGIN received, rehydrating` / `cross-tab: REFRESH received, rehydrating`
- `destroy: tearing down`
- `AuthClient initialized { baseURL: "..." }`

---

## SSR / Non-Browser Environments

The package is safe to import in SSR environments (Next.js, Nuxt, etc.). All browser APIs (`BroadcastChannel`, `localStorage`, `window`) are guarded behind `typeof` checks and degrade to no-ops.

However, auth operations (`login`, `refresh`, `fetch`, etc.) require a browser with cookie support. They will fail in pure Node.js environments because there's no cookie jar.

---

## Server Contract

The client expects your SSO backend to expose these endpoints:

| Endpoint | Method | Request Body | Response Body | Cookie Behavior |
|---|---|---|---|---|
| `{baseURL}/auth/login` | POST | `{ email, password }` | `{ access_token, user? }` | Sets HttpOnly refresh cookie |
| `{baseURL}/auth/signup` | POST | `{ email, password, name?, organization_name? }` | `{ access_token, user? }` | Sets HttpOnly refresh cookie |
| `{baseURL}/auth/logout` | POST | — | — | Clears refresh cookie |
| `{baseURL}/auth/refresh` | POST | — (reads cookie) | `{ access_token, user? }` | May rotate refresh cookie |
| `{baseURL}/auth/validate-session` | POST | — (reads cookie + Bearer) | `{ valid, user? }` | — |

All endpoints must:
- Accept `credentials: "include"` (CORS with `Access-Control-Allow-Credentials: true`)
- Return JSON with `Content-Type: application/json`
- Return a valid JWT (three dot-separated base64url segments) as `access_token`
- Return error details as `{ message: "..." }` or `{ error: "..." }` for proper error parsing

---

## Framework Examples

### React

```tsx
import { useEffect, useState } from "react";
import { AuthClient } from "@rareminds-eym/auth-client";

const auth = new AuthClient({
  baseURL: "https://auth.rareminds.com",
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

### Vue 3 (Composition API)

```ts
import { ref, onMounted, onUnmounted } from "vue";
import { AuthClient } from "@rareminds-eym/auth-client";

const auth = new AuthClient({
  baseURL: "https://auth.rareminds.com",
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

### Svelte

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { AuthClient } from "@rareminds-eym/auth-client";

  const auth = new AuthClient({
    baseURL: "https://auth.rareminds.com",
    onSessionExpired: () => (window.location.href = "/login"),
  });

  let loading = true;
  let authenticated = false;
  let unsub: (() => void) | undefined;

  onMount(async () => {
    const res = await auth.initSession();
    authenticated = res.authenticated;
    loading = false;

    unsub = auth.onAuthStateChange((event) => {
      authenticated = event !== "LOGOUT";
    });
  });

  onDestroy(() => unsub?.());
</script>
```

### Vanilla JS

```html
<script type="module">
  import { AuthClient } from "@rareminds-eym/auth-client";

  const auth = new AuthClient({
    baseURL: "https://auth.rareminds.com",
    onSessionExpired: () => (window.location.href = "/login"),
  });

  const { authenticated } = await auth.initSession();

  if (!authenticated) {
    window.location.href = "/login";
  }

  // Use auth.fetch() for all API calls
  const res = await auth.fetch("/api/profile");
  const profile = await res.json();
</script>
```

---

## Advanced Exports

The package also exports lower-level primitives for custom usage or testing:

```ts
import {
  AuthClient,        // Main client class
  AuthFetchError,    // Error class with .status and .message
  normalizeHeaders,  // HeadersInit → Record<string, string>
  MemoryStore,       // Instance-scoped in-memory token store
  SyncChannel,       // Instance-scoped BroadcastChannel + localStorage sync
} from "@rareminds-eym/auth-client";
```

---

## TypeScript Types

All types are exported for consumers:

```ts
import type {
  LoginPayload,            // { email: string; password: string }
  SignupPayload,           // { email, password, name?, organization_name? }
  AuthResponse,            // { access_token: string; user?: Record<string, unknown> }
  AuthClientConfig,        // { baseURL, onSessionExpired?, debug? }
  SessionResult,           // { authenticated: boolean }
  ValidateSessionResult,   // { valid: boolean; user?: Record<string, unknown> }
  AuthEvent,               // { type: AuthEventType }
  AuthEventType,           // "LOGIN" | "LOGOUT" | "REFRESH"
  AuthStateChangeCallback, // (event: AuthEventType) => void
} from "@rareminds-eym/auth-client";
```

---

## Project Structure

```
src/
├── core/
│   └── client.ts          # AuthClient class — public API, 401 retry, cross-tab sync
├── storage/
│   └── memoryStore.ts     # MemoryStore class — in-memory JWT with structure validation
├── sync/
│   └── channel.ts         # SyncChannel class — BroadcastChannel + localStorage fallback
├── types/
│   └── auth.ts            # All TypeScript interfaces and type aliases
├── utils/
│   └── fetcher.ts         # fetcher(), AuthFetchError, normalizeHeaders()
└── index.ts               # Public barrel exports
```

## Build

```bash
npm run build       # Compile TypeScript → dist/
npm run clean       # Remove dist/
```

The `prepublishOnly` script runs `clean && build` automatically before `npm publish`.

Output includes `.js`, `.d.ts`, `.d.ts.map`, and `.js.map` files for full IDE support.

## License

MIT — see [LICENSE](./LICENSE).
