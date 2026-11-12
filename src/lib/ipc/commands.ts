/**
 * Typed wrappers around the Rust commands. CONTRACT with src-tauri/src/*.rs:
 * command names, argument names (camelCase here = snake_case in Rust), header
 * names and result shapes must match exactly (see docs/ARCHITECTURE.md §5).
 * All paths are vault-relative ("/"-separated). Every vault-scoped command
 * carries the current vault epoch automatically, or the epoch an operation captured
 * with currentEpoch() when it started (optional last argument), so a continuation
 * that outlives a vault switch fails with "no_vault" instead of reaching the new vault.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Baseline,
  FileContent,
  IpcErrorKind,
  IpcErrorPayload,
  ListResult,
  RecoveryCopy,
  SearchResponse,
  VaultInfo,
  VaultPath,
  WriteResult,
} from "../types";

export class IpcError extends Error {
  readonly kind: IpcErrorKind;
  constructor(payload: IpcErrorPayload) {
    super(payload.message);
    this.name = "IpcError";
    this.kind = payload.kind;
  }
}

export function isIpcError(e: unknown, kind?: IpcErrorKind): e is IpcError {
  return e instanceof IpcError && (kind === undefined || e.kind === kind);
}

function isPayload(e: unknown): e is IpcErrorPayload {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

function toIpcError(e: unknown): IpcError {
  return isPayload(e) ? new IpcError(e) : new IpcError({ kind: "io", message: String(e) });
}

/** Epoch of the vault the frontend currently works on (set by vaultOpen). */
let epoch = 0;

/** The current vault epoch. Long-lived work captures it and passes it to its later calls (PLAT-08). */
export const currentEpoch = (): number => epoch;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toIpcError(e);
  }
}

/** Vault-scoped command: adds the vault epoch (`at`, else the current one). */
const scoped = <T>(cmd: string, args: Record<string, unknown> = {}, at: number = epoch) =>
  call<T>(cmd, { ...args, epoch: at });

async function callRaw<T>(cmd: string, body: Uint8Array, headers: Record<string, string>, at: number = epoch): Promise<T> {
  try {
    return await invoke<T>(cmd, body, { headers: { ...headers, "x-epoch": String(at) } });
  } catch (e) {
    throw toIpcError(e);
  }
}

const utf8 = new TextEncoder();
/** ignoreBOM: a leading U+FEFF is note text here (a BOM to recreate) and must survive. */
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const BOM = "\uFEFF";
/** A high surrogate without its low half, or a low one without its high half (no lookbehind: Safari 15). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Text sent as a JSON string argument: serde rejects lone surrogates, and the
 * rejection would surface as a generic "io" error, so they become U+FFFD exactly
 * as TextEncoder does for raw-body writes.
 */
const wellFormed = (text: string): string => (LONE_SURROGATE.test(text) ? utf8Decoder.decode(utf8.encode(text)) : text);

/**
 * Only the three baseline fields cross IPC. A FileContent is assignable to Baseline,
 * and passing one would put the note text into the x-expected header (non-ASCII text
 * then fails the request, so every save would fail).
 */
const plainBaseline = (b: Baseline): Baseline => ({ mtime: b.mtime, size: b.size, hash: b.hash });

/** Opens (and starts watching) a folder as the active vault; adopts its epoch. */
export async function vaultOpen(path: string): Promise<VaultInfo> {
  const info = await call<VaultInfo>("vault_open", { path });
  epoch = info.epoch;
  return info;
}

/** Breadth-first listing of the visible folders, notes (.md/.markdown) and images, one column per field. */
export const vaultList = () => scoped<ListResult>("vault_list");

export const noteRead = (path: VaultPath, at?: number) => scoped<FileContent>("note_read", { path }, at);

/**
 * Atomically writes `text` (already in the file's own line-ending style) as UTF-8,
 * prefixed with a BOM when `bom`. Sent as raw bytes so lone surrogates can never
 * break serialization (TextEncoder replaces them).
 *
 * `expected` is the baseline we last saw: if the file changed since, Rust refuses
 * with kind "conflict"; if it vanished, "not_found". Pass `null` to write
 * without a baseline (missing parent folders inside the vault are recreated);
 * even then the target is re-checked right before it is replaced, so a file that
 * appears or changes during the write gives "conflict", and one that vanishes
 * "not_found". Also rejects with "read_only" for non-writable targets. `epoch`
 * defaults to the current one.
 */
export const noteWrite = (path: VaultPath, text: string, opts: { bom: boolean; expected: Baseline | null; epoch?: number }) =>
  callRaw<WriteResult>(
    "note_write",
    utf8.encode(opts.bom ? BOM + text : text),
    {
      "x-path": encodeURIComponent(path),
      "x-expected": opts.expected ? JSON.stringify(plainBaseline(opts.expected)) : "",
    },
    opts.epoch,
  );

/**
 * Creates a NEW file (exclusive create; missing parent folders inside the vault
 * are created). `content` is written verbatim, so a leading U+FEFF becomes a BOM.
 * Rejects with kind "exists" if the path is taken.
 */
export const noteCreate = (path: VaultPath, content: string, at?: number) =>
  scoped<WriteResult>("note_create", { path, content: wellFormed(content) }, at);

/** Creates a folder (and parents); rejects with kind "exists" if the path is taken. */
export const dirCreate = (path: VaultPath) => scoped<void>("dir_create", { path });

/**
 * Renames or moves a file/folder (creating `to`'s parent if needed). Rejects with
 * "exists" when `to` is taken, except for a case/normalization-only rename of the
 * same entry (handled safely by Rust). The vault root can never be renamed.
 */
export const pathRename = (from: VaultPath, to: VaultPath, at?: number) => scoped<void>("path_rename", { from, to }, at);

/** Moves a file/folder to the OS trash; rejects with "trash_failed" if unsupported. */
export const pathTrash = (path: VaultPath, at?: number) => scoped<void>("path_trash", { path }, at);

/** Permanently deletes a file/folder (only after explicit user confirmation). */
export const pathDelete = (path: VaultPath, at?: number) => scoped<void>("path_delete", { path }, at);

export const pathExists = (path: VaultPath) => scoped<boolean>("path_exists", { path });

/** Shows the file/folder in Finder / Explorer / the Linux file manager. */
export const pathReveal = (path: VaultPath) => scoped<void>("path_reveal", { path });

/** Writes binary data to a NEW file (missing parents created); rejects with "exists". */
export const binaryWrite = (path: VaultPath, data: Uint8Array, at?: number) =>
  callRaw<void>("binary_write", data, { "x-path": encodeURIComponent(path) }, at);

/**
 * Full-text search over notes. Whitespace-separated terms (or "quoted phrases")
 * must all occur in a file (content or name); case-insensitive unless
 * `caseSensitive`; NFC on both sides. A newer call cancels older ones.
 */
export const searchText = (query: string, caseSensitive: boolean, limit: number) =>
  scoped<SearchResponse>("search_text", { query, caseSensitive, limit });

/** Stores unsaved text for `path` in the app-data folder (one copy per note, newest wins). */
export const recoveryWrite = (path: VaultPath, content: string, baseline: Baseline | null, at?: number) =>
  scoped<void>(
    "recovery_write",
    {
      path,
      content: wellFormed(content),
      baseline: baseline ? plainBaseline(baseline) : null,
    },
    at,
  );

/** Returns the recovery copy for `path` in the active vault, if any (does not delete it). */
export const recoveryGet = (path: VaultPath, at?: number) => scoped<RecoveryCopy | null>("recovery_get", { path }, at);

/** Deletes the recovery copy for `path` (after a successful save or restore). */
export const recoveryClear = (path: VaultPath, at?: number) => scoped<void>("recovery_clear", { path }, at);

/** Raw settings JSON from the app-config folder, or null (first run / unparsable file set aside). */
export const settingsLoad = () => call<string | null>("settings_load");

/** Atomically writes the settings JSON document. */
export const settingsSave = (json: string) => call<void>("settings_save", { json });

/** Tells Rust that pending saves are flushed and the app may exit now. */
export const appExitReady = () => call<void>("app_exit_ready");
