/**
 * Typed listeners for backend events. CONTRACT with src-tauri (event names + payloads).
 * Each listens for this window only: a global listen() would also hear the events the
 * backend sends to other windows, such as their vaults' changes (ARCHITECTURE §5).
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SettingsChangedPayload, VaultChangedPayload } from "../types";

export const EVENT_VAULT_CHANGED = "vault:changed";
export const EVENT_VAULT_FORGOTTEN = "vault:forgotten";
export const EVENT_FLUSH_REQUEST = "app:flush-request";
export const EVENT_SETTINGS_CHANGED = "settings:changed";
export const EVENT_WINDOW_OPEN = "window:open";

/** Batched filesystem changes inside this window's vault (hidden paths excluded). */
export const onVaultChanged = (cb: (p: VaultChangedPayload) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<VaultChangedPayload>(EVENT_VAULT_CHANGED, (e) => cb(e.payload));

/**
 * This window's vault left the recent vaults (`vaultForget`, VAULT-05). The payload is the root
 * that was removed: the window may show another vault by the time it hears this.
 */
export const onVaultForgotten = (cb: (root: string) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<string>(EVENT_VAULT_FORGOTTEN, (e) => cb(e.payload));

/** Emitted to every window when the app is about to quit; reply with `appExitReady()` after flushing. */
export const onFlushRequest = (cb: () => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<null>(EVENT_FLUSH_REQUEST, () => cb());

/**
 * The command line asked this window for a folder, and maybe a file in it (PLAT-14). The event
 * carries nothing: the plan waits in the backend, for `windowStartup()`.
 */
export const onWindowOpen = (cb: () => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<null>(EVENT_WINDOW_OPEN, () => cb());

/** A settings patch some window wrote (this one included), in the order the backend applied them. */
export const onSettingsChanged = (cb: (p: SettingsChangedPayload) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<SettingsChangedPayload>(EVENT_SETTINGS_CHANGED, (e) => cb(e.payload));
