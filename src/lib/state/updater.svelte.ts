/**
 * App updates (ARCHITECTURE §6.7). Release builds carry an updater endpoint and the
 * public signing key; one background check at startup (and again when an offline
 * machine comes back online) learns whether a newer release exists. Only the user's
 * click downloads it; the install and the restart follow at once. Check failures stay
 * silent: offline, nothing published yet, or a local build without an endpoint.
 */
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { t } from "../i18n";
import { ui } from "./ui.svelte";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "installing" | "restart" | "restarting";

/** The check gives up after this long; coming back online checks again. */
const CHECK_TIMEOUT_MS = 10_000;
/** The whole download, independent of the check. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

class UpdaterStore {
  phase = $state<UpdatePhase>("idle");
  /** The version the server offers; "" until one is known. */
  version = $state("");
  /** Whole-percent download progress; null while the length is unknown or nothing downloads. */
  progress = $state<number | null>(null);
  /** The running app's version, for the settings panel; "" until read. */
  current = $state("");

  /** A Tauri resource with a backend handle: kept out of reactive state. */
  #update: Update | null = null;
  /** Writes unsaved notes and settings before the install and the restart (`flushBeforeExit`). */
  #beforeExit: () => Promise<void> = () => Promise.resolve();
  #started = false;
  /** Bumped by every check and by stop, so a late answer is dropped. */
  #seq = 0;
  /** The machine came back online during a check: check once more after it. */
  #again = false;

  /** The button shows: a newer release is known, or an install is under way or waits for its restart. */
  get visible(): boolean {
    return this.phase !== "idle" && this.phase !== "checking";
  }

  /** A click would duplicate work in progress. */
  get busy(): boolean {
    return this.phase === "downloading" || this.phase === "installing" || this.phase === "restarting";
  }

  /**
   * Reads the running version and starts the background check; returns the stop function.
   * `beforeExit` runs before the install (Windows exits inside it) and before the restart
   * (which Tauri never holds back for the flush protocol, §6.6). Browser previews do
   * nothing, and development builds only read the version: they carry no endpoint.
   */
  start = (beforeExit: () => Promise<void>): (() => void) => {
    if (this.#started || !isTauri()) return () => {};
    this.#started = true;
    this.#beforeExit = beforeExit;
    getVersion().then(
      (v) => {
        if (this.#started) this.current = v;
      },
      () => {},
    );
    if (import.meta.env.DEV) return this.#stop;
    window.addEventListener("online", this.#online);
    void this.#check();
    return this.#stop;
  };

  #stop = (): void => {
    window.removeEventListener("online", this.#online);
    this.#started = false;
    this.#seq++;
    this.#again = false;
    // An install under way owns the resource until it settles (install's finally block).
    if (!this.busy) {
      void this.#release();
      if (this.phase !== "restart") this.phase = "idle";
    }
  };

  #online = (): void => {
    // A connection can come back before the offline request has timed out.
    if (this.phase === "checking") this.#again = true;
    else void this.#check();
  };

  #check = async (): Promise<void> => {
    if (!this.#started || this.phase !== "idle") return;
    const seq = ++this.#seq;
    this.phase = "checking";
    try {
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (!this.#started || seq !== this.#seq) {
        await update?.close().catch(() => {});
        return;
      }
      this.#update = update;
      this.version = update?.version ?? "";
      this.phase = update ? "available" : "idle";
    } catch {
      // Offline, no release yet, or no endpoint: an optional check never interrupts the user.
      if (seq === this.#seq) this.phase = "idle";
    } finally {
      if (this.#started && seq === this.#seq) {
        const again = this.#again;
        this.#again = false;
        if (again && this.phase === "idle") void this.#check();
      }
    }
  };

  /**
   * The click: download → flush → install → flush → restart. A failure keeps the button
   * for a retry and reports once. After a successful install only the restart is
   * retried, never the install.
   */
  install = async (): Promise<void> => {
    if (!this.#started || this.busy) return;
    if (this.phase === "restart") {
      await this.#restart();
      return;
    }
    const update = this.#update;
    if (this.phase !== "available" || !update) return;

    this.phase = "downloading";
    this.progress = null;
    let downloaded = 0;
    let total: number | undefined;
    let live = true;
    try {
      await update.download(
        (event) => {
          if (!live) return;
          if (event.event === "Started") {
            downloaded = 0;
            total = event.data.contentLength;
            this.progress = total ? 0 : null;
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            // Whole percentages only: not a render per chunk.
            this.progress = total ? Math.min(100, Math.floor((downloaded / total) * 100)) : null;
          }
        },
        { timeout: DOWNLOAD_TIMEOUT_MS },
      );
      live = false;
      this.phase = "installing";
      this.progress = null;
      // Windows exits inside install(): whatever is unsaved must be on disk first.
      await this.#beforeExit();
      await update.install();
      await this.#release();
      this.phase = "restart";
      if (this.#started) await this.#restart();
    } catch (e) {
      live = false;
      console.error("update failed", e);
      this.phase = "available";
      this.progress = null;
      if (this.#started) ui.notify(t("errUpdate", { version: this.version, message: messageOf(e) }));
    } finally {
      if (!this.#started) {
        await this.#release();
        if (this.phase !== "restart") this.phase = "idle";
      }
    }
  };

  #restart = async (): Promise<void> => {
    this.phase = "restarting";
    try {
      // Edits made while the new version was installing.
      await this.#beforeExit();
      await relaunch();
    } catch (e) {
      // The new version is installed; only the restart failed, so the next click retries just that.
      console.error("restart failed", e);
      this.phase = "restart";
      if (this.#started) ui.notify(t("errRestart"));
    }
  };

  #release = async (): Promise<void> => {
    const update = this.#update;
    this.#update = null;
    await update?.close().catch(() => {});
  };
}

export const updater = new UpdaterStore();
