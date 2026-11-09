/** Typed listeners for backend events. CONTRACT with src-tauri (event names + payloads). */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VaultChangedPayload } from "../types";

export const EVENT_VAULT_CHANGED = "vault:changed";
export const EVENT_FLUSH_REQUEST = "app:flush-request";

/** Batched filesystem changes inside the active vault (hidden paths excluded). */
export const onVaultChanged = (cb: (p: VaultChangedPayload) => void): Promise<UnlistenFn> =>
  listen<VaultChangedPayload>(EVENT_VAULT_CHANGED, (e) => cb(e.payload));

/** Emitted when the app is about to quit; reply with `appExitReady()` after flushing. */
export const onFlushRequest = (cb: () => void): Promise<UnlistenFn> =>
  listen<null>(EVENT_FLUSH_REQUEST, () => cb());
