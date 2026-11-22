/**
 * User settings + per-vault sessions, persisted as one JSON document in the
 * app-config folder (atomic write in Rust; never inside the vault). Every window
 * keeps a copy: it writes only what it changed (a patch), and takes over what the
 * other windows change (ARCHITECTURE §7), except their window layout.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { settingsLoad, settingsUpdate } from "../ipc/commands";
import { onSettingsChanged } from "../ipc/events";
import type { Settings, SettingsChangedPayload, SettingsPatch, VaultSession } from "../types";
import {
  headingFontValue,
  monoFontValue,
  sanitizeFontFamily,
  sanitizeHeadingFont,
  sanitizeTextFont,
  textFontValue,
} from "../utils/fonts";
import { sanitizeShortcuts } from "../utils/keys";
import { SyncLedger } from "./settingsSync";

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 15,
  textFont: "",
  headingFont: "",
  codeFont: "",
  lineWidth: 720,
  theme: "system",
  iconTheme: "filled",
  editorMode: "live",
  spellcheck: false,
  inlineTitle: true,
  newNoteLocation: "current",
  attachmentLocation: "folder",
  attachmentFolder: "attachments",
  confirmDelete: false,
  sidebarVisible: true,
  sidebarWidth: 248,
  shortcuts: {},
  recentVaults: [],
  lastVault: null,
};

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 24;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;

const EMPTY_SESSION: VaultSession = { expanded: [], lastFile: null, recent: [] };
const SAVE_DELAY_MS = 300;
/**
 * Each window's own layout: written like any setting (new windows and the next launch start
 * from the last one changed), never taken over from another window.
 */
const WINDOW_KEYS: ReadonlySet<string> = new Set<keyof Settings>(["sidebarVisible", "sidebarWidth"]);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Coerces persisted (possibly stale or hand-edited) values into a valid Settings object.
 * Defaults fill in missing keys, and every field is listed, so unknown keys are dropped (SET-01).
 */
function sanitize(raw: Partial<Settings> | undefined): Settings {
  const d = DEFAULT_SETTINGS;
  const s = { ...d, ...(raw ?? {}) };
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  return {
    fontSize: clamp(Number(s.fontSize) || d.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX),
    textFont: sanitizeTextFont(s.textFont),
    headingFont: sanitizeHeadingFont(s.headingFont),
    codeFont: sanitizeFontFamily(s.codeFont),
    lineWidth: Math.max(0, Number(s.lineWidth) || 0),
    theme: pick(s.theme, ["system", "light", "dark"] as const, "system"),
    iconTheme: pick(s.iconTheme, ["outline", "filled", "color"] as const, d.iconTheme),
    editorMode: pick(s.editorMode, ["live", "source"] as const, "live"),
    spellcheck: bool(s.spellcheck, d.spellcheck),
    inlineTitle: bool(s.inlineTitle, d.inlineTitle),
    newNoteLocation: pick(s.newNoteLocation, ["current", "root"] as const, "current"),
    attachmentLocation: pick(s.attachmentLocation, ["same", "root", "folder"] as const, "folder"),
    attachmentFolder: typeof s.attachmentFolder === "string" ? s.attachmentFolder : "attachments",
    confirmDelete: bool(s.confirmDelete, d.confirmDelete),
    sidebarVisible: bool(s.sidebarVisible, d.sidebarVisible),
    sidebarWidth: clamp(Number(s.sidebarWidth) || d.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
    shortcuts: sanitizeShortcuts(s.shortcuts),
    recentVaults: Array.isArray(s.recentVaults) ? s.recentVaults.filter((v) => typeof v === "string").slice(0, 10) : [],
    lastVault: typeof s.lastVault === "string" ? s.lastVault : null,
  };
}

class SettingsStore {
  values = $state<Settings>({ ...DEFAULT_SETTINGS });
  loaded = $state(false);

  #sessions: Record<string, VaultSession> = {};
  /** Settings keys and session roots changed here and not yet seen applied (settingsSync.ts). */
  #keys = new SyncLedger();
  #roots = new SyncLedger();
  /** This window's label: the origin of its own writes when they come back. */
  #label = "";
  /** Other windows' changes that arrived while the file was being read; null once loaded. */
  #early: SettingsChangedPayload[] | null = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #saving: Promise<void> = Promise.resolve();
  /** Theme last sent to the window; undefined until the first apply. */
  #windowTheme: Settings["theme"] | undefined;

  /**
   * Loads persisted settings (defaults on first run; Rust sets an unparsable file
   * aside) and applies them. Nothing is written before loading finishes. Listens to
   * the other windows' changes first, so one written while the file is read still lands.
   */
  load = async (): Promise<void> => {
    this.#label = getCurrentWindow().label;
    try {
      await onSettingsChanged(this.#onChanged);
    } catch (e) {
      console.error("settings: other windows' changes will not show here", e);
    }
    try {
      const raw = await settingsLoad();
      if (raw) {
        const doc = JSON.parse(raw) as { settings?: Partial<Settings>; sessions?: Record<string, VaultSession> };
        this.values = sanitize(doc.settings);
        this.#sessions = doc.sessions && typeof doc.sessions === "object" ? doc.sessions : {};
      }
    } catch (e) {
      console.error("settings: load failed, using defaults", e);
    }
    this.loaded = true;
    const early = this.#early ?? [];
    this.#early = null;
    for (const p of early) this.#onChanged(p);
    this.apply();
  };

  update = (patch: Partial<Settings>): void => {
    this.values = sanitize({ ...this.values, ...patch });
    for (const k of Object.keys(patch)) this.#keys.touch(k);
    this.apply();
    this.#schedule();
  };

  /** Records a vault as most recently used. Vaults pushed off the list lose their session (VAULT-04). */
  rememberVault = (root: string): void => {
    const recentVaults = [root, ...this.values.recentVaults.filter((v) => v !== root)].slice(0, 10);
    for (const key of Object.keys(this.#sessions)) if (!recentVaults.includes(key)) this.#dropSession(key);
    this.update({ recentVaults, lastVault: root });
  };

  /** Removes a vault from the recent list together with its session (VAULT-04, VAULT-05); never touches files. */
  forgetVault = (root: string): void => {
    this.#dropSession(root);
    this.update({
      recentVaults: this.values.recentVaults.filter((v) => v !== root),
      lastVault: this.values.lastVault === root ? null : this.values.lastVault,
    });
  };

  session = (root: string): VaultSession => ({ ...EMPTY_SESSION, ...(this.#sessions[root] ?? {}) });

  updateSession = (root: string, patch: Partial<VaultSession>): void => {
    this.#sessions[root] = { ...this.session(root), ...patch };
    this.#roots.touch(root);
    this.#schedule();
  };

  /** Writes pending changes now (called on quit/close), with any a failed write left behind. */
  flush = async (): Promise<void> => {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.loaded) this.#persist();
    await this.#saving;
  };

  /** Pushes settings into CSS variables and the theme, icon-set and sidebar attributes on <html>. */
  apply = (): void => {
    const v = this.values;
    const root = document.documentElement;
    root.style.setProperty("--fs-content", `${v.fontSize}px`);
    // A chosen family comes first, with a stack of system fonts behind it as the fallback;
    // the default leaves the variable to tokens.css.
    const font = (name: string, value: string | null): void => {
      if (value === null) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    };
    font("--font-content", textFontValue(v.textFont));
    font("--font-heading", headingFontValue(v.headingFont));
    font("--font-mono", monoFontValue(v.codeFont));
    root.style.setProperty("--content-max", v.lineWidth > 0 ? `${v.lineWidth}px` : "none");
    root.style.setProperty("--sidebar-width", `${v.sidebarWidth}px`);
    // The room left for the document is CSS only: base.css takes a shown sidebar's width from it.
    root.toggleAttribute("data-sidebar", v.sidebarVisible);
    if (v.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", v.theme);
    // The icon set is CSS only: tokens.css maps the attribute to the tree's folder color and fill.
    root.setAttribute("data-icons", v.iconTheme);
    // One IPC call per actual change: Resizer drags call update() every frame.
    if (v.theme === this.#windowTheme) return;
    this.#windowTheme = v.theme;
    getCurrentWindow()
      .setTheme(v.theme === "system" ? null : v.theme)
      .catch(() => {});
  };

  #dropSession(root: string): void {
    delete this.#sessions[root];
    this.#roots.touch(root);
  }

  /**
   * A patch some window wrote, as the backend applied it. This window's own marks its keys
   * written; another's replaces what this window has not changed itself, except the layout.
   */
  #onChanged = (p: SettingsChangedPayload): void => {
    if (this.#early !== null) {
      this.#early.push(p);
      return;
    }
    const settings: Record<string, unknown> = p.settings ?? {};
    const sessions = p.sessions ?? {};
    if (p.origin === this.#label) {
      this.#keys.landed(Object.keys(settings));
      this.#roots.landed(Object.keys(sessions));
      return;
    }
    const adopted: Record<string, unknown> = {};
    let changed = false;
    for (const [k, v] of Object.entries(settings)) {
      if (WINDOW_KEYS.has(k) || !this.#keys.adopts(k)) continue;
      adopted[k] = v;
      changed = true;
    }
    if (changed) {
      this.values = sanitize({ ...this.values, ...(adopted as Partial<Settings>) });
      this.apply();
    }
    for (const [root, session] of Object.entries(sessions)) {
      if (!this.#roots.adopts(root)) continue;
      if (session && typeof session === "object") this.#sessions[root] = session;
      else delete this.#sessions[root];
    }
  };

  #schedule(): void {
    if (!this.loaded) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#persist();
    }, SAVE_DELAY_MS);
  }

  /** Writes what changed since the last write as one patch; writes never overlap. */
  #persist(): void {
    const keys = this.#keys.send();
    const roots = this.#roots.send();
    if (keys.length === 0 && roots.length === 0) return;
    const values = $state.snapshot(this.values) as Record<string, unknown>;
    const settings: Record<string, unknown> = {};
    for (const k of keys) if (k in values) settings[k] = values[k];
    const sessions: Record<string, VaultSession | null> = {};
    for (const root of roots) sessions[root] = this.#sessions[root] ?? null;
    const patch: SettingsPatch = { settings: settings as Partial<Settings>, sessions };
    this.#saving = this.#saving
      .then(() => settingsUpdate(patch))
      .catch((e) => {
        console.error("settings: save failed", e);
        // Written again with the next change or flush; until then no other window's change replaces them.
        this.#keys.failed(keys);
        this.#roots.failed(roots);
      });
  }
}

export const settings = new SettingsStore();
