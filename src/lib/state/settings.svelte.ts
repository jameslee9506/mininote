/**
 * User settings + per-vault sessions, persisted as one JSON document in the
 * app-config folder (atomic write in Rust; never inside the vault).
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { settingsLoad, settingsSave } from "../ipc/commands";
import type { Settings, VaultSession } from "../types";
import { monoFontValue, sanitizeFontFamily } from "../utils/fonts";
import { sanitizeShortcuts } from "../utils/keys";

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 15,
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
  #timer: ReturnType<typeof setTimeout> | null = null;
  #saving: Promise<void> = Promise.resolve();
  /** Theme last sent to the window; undefined until the first apply. */
  #windowTheme: Settings["theme"] | undefined;

  /**
   * Loads persisted settings (defaults on first run; Rust sets an unparsable file
   * aside) and applies them. Nothing is written before loading finishes.
   */
  load = async (): Promise<void> => {
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
    this.apply();
  };

  update = (patch: Partial<Settings>): void => {
    this.values = sanitize({ ...this.values, ...patch });
    this.apply();
    this.#schedule();
  };

  /** Records a vault as most recently used. Vaults pushed off the list lose their session (VAULT-04). */
  rememberVault = (root: string): void => {
    const recentVaults = [root, ...this.values.recentVaults.filter((v) => v !== root)].slice(0, 10);
    for (const key of Object.keys(this.#sessions)) if (!recentVaults.includes(key)) delete this.#sessions[key];
    this.update({ recentVaults, lastVault: root });
  };

  /** Removes a vault from the recent list together with its session (VAULT-04, VAULT-05); never touches files. */
  forgetVault = (root: string): void => {
    delete this.#sessions[root];
    this.update({
      recentVaults: this.values.recentVaults.filter((v) => v !== root),
      lastVault: this.values.lastVault === root ? null : this.values.lastVault,
    });
  };

  session = (root: string): VaultSession => ({ ...EMPTY_SESSION, ...(this.#sessions[root] ?? {}) });

  updateSession = (root: string, patch: Partial<VaultSession>): void => {
    this.#sessions[root] = { ...this.session(root), ...patch };
    this.#schedule();
  };

  /** Writes pending changes now (called on quit/close). */
  flush = async (): Promise<void> => {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#persist();
    }
    await this.#saving;
  };

  /** Pushes settings into CSS variables and the theme and icon-set attributes on <html>. */
  apply = (): void => {
    const v = this.values;
    const root = document.documentElement;
    root.style.setProperty("--fs-content", `${v.fontSize}px`);
    // The chosen family comes first; the default stack stays behind it as the fallback.
    const mono = monoFontValue(v.codeFont);
    if (mono === null) root.style.removeProperty("--font-mono");
    else root.style.setProperty("--font-mono", mono);
    root.style.setProperty("--content-max", v.lineWidth > 0 ? `${v.lineWidth}px` : "none");
    root.style.setProperty("--sidebar-width", `${v.sidebarWidth}px`);
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

  #schedule(): void {
    if (!this.loaded) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#persist();
    }, SAVE_DELAY_MS);
  }

  #persist(): void {
    const json = JSON.stringify({ settings: $state.snapshot(this.values), sessions: this.#sessions });
    this.#saving = this.#saving
      .then(() => settingsSave(json))
      .catch((e) => console.error("settings: save failed", e));
  }
}

export const settings = new SettingsStore();
