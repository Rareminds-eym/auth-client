export { AuthClient } from "./core/client.js";
export { AuthFetchError, normalizeHeaders } from "./utils/fetcher.js";
export { MemoryStore } from "./storage/memoryStore.js";
export { SyncChannel } from "./sync/channel.js";
export type {
  LoginPayload,
  SignupPayload,
  AuthResponse,
  AuthClientConfig,
  SessionResult,
  ValidateSessionResult,
  AuthEvent,
  AuthEventType,
  AuthStateChangeCallback,
} from "./types/auth.js";
