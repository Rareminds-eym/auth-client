import type { AuthEvent, AuthEventType } from "../types/auth.js";

const VALID_EVENT_TYPES = new Set<AuthEventType>(["LOGIN", "LOGOUT", "REFRESH"]);

/**
 * Validate that an unknown value is a well-formed AuthEvent.
 * Guards against malicious or malformed messages from other contexts.
 */
function isAuthEvent(data: unknown): data is AuthEvent {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    typeof (data as AuthEvent).type === "string" &&
    VALID_EVENT_TYPES.has((data as AuthEvent).type)
  );
}

/**
 * Instance-scoped cross-tab sync channel.
 *
 * Each AuthClient gets its own SyncChannel so multiple clients
 * (e.g. different SSO providers) use isolated broadcast channels.
 */
export class SyncChannel {
  readonly #channelName: string;
  #channel: BroadcastChannel | null = null;
  #channelUnavailable = false;

  constructor(channelName: string) {
    this.#channelName = channelName;
  }

  #getChannel(): BroadcastChannel | null {
    if (this.#channelUnavailable) return null;

    if (typeof BroadcastChannel !== "undefined") {
      if (!this.#channel) {
        try {
          this.#channel = new BroadcastChannel(this.#channelName);
        } catch {
          // BroadcastChannel can throw in restricted contexts
          // (opaque origins, sandboxed iframes, etc.)
          this.#channelUnavailable = true;
          return null;
        }
      }
      return this.#channel;
    }

    return null;
  }

  /**
   * Broadcast an auth event to all other tabs.
   *
   * Uses BroadcastChannel where available,
   * falls back to localStorage events for older browsers.
   */
  broadcast(event: AuthEvent): void {
    const ch = this.#getChannel();

    if (ch) {
      ch.postMessage(event);
    } else if (typeof localStorage !== "undefined") {
      // localStorage "storage" event fires in OTHER tabs only
      localStorage.setItem(
        this.#channelName,
        JSON.stringify({ ...event, _ts: Date.now() }),
      );
      // Clean up immediately — we only need the event to fire, not persist
      try {
        localStorage.removeItem(this.#channelName);
      } catch {
        // best-effort cleanup
      }
    }
  }

  /**
   * Subscribe to auth events from other tabs.
   * Returns an unsubscribe function for cleanup.
   *
   * Validates incoming messages to guard against malformed/malicious data.
   */
  subscribe(callback: (event: AuthEvent) => void): () => void {
    const ch = this.#getChannel();

    if (ch) {
      const handler = (e: MessageEvent) => {
        if (isAuthEvent(e.data)) {
          callback(e.data);
        }
      };
      ch.addEventListener("message", handler);
      return () => ch.removeEventListener("message", handler);
    }

    if (typeof window !== "undefined") {
      const handler = (e: StorageEvent) => {
        if (e.key === this.#channelName && e.newValue) {
          try {
            const parsed: unknown = JSON.parse(e.newValue);
            if (isAuthEvent(parsed)) {
              callback(parsed);
            }
          } catch {
            // ignore malformed events
          }
        }
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    }

    // SSR / non-browser — no-op
    return () => {};
  }

  /**
   * Close the BroadcastChannel and release the reference.
   * Call this on full teardown (e.g. AuthClient.destroy()) so the
   * event-loop isn't kept alive by an open channel.
   */
  close(): void {
    if (this.#channel) {
      this.#channel.close();
      this.#channel = null;
    }
  }
}
