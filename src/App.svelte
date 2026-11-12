<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import Welcome from "./lib/components/Welcome.svelte";
  import Main from "./lib/components/Main.svelte";
  import Sidebar, { checkNarrowStartup } from "./lib/components/Sidebar.svelte";
  import Resizer from "./lib/components/Resizer.svelte";
  import QuickSwitcher from "./lib/components/QuickSwitcher.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import ContextMenu from "./lib/components/ContextMenu.svelte";
  import ConfirmDialog from "./lib/components/ConfirmDialog.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import { discardNewNote, flushBeforeExit, openVault, quitApp, registerAppCommands } from "./lib/appCommands";
  import { uiLanguage } from "./lib/i18n";
  import { onFlushRequest } from "./lib/ipc/events";
  import { commands } from "./lib/state/commands.svelte";
  import { editor } from "./lib/state/editor.svelte";
  import { settings } from "./lib/state/settings.svelte";
  import { ui } from "./lib/state/ui.svelte";
  import { updater } from "./lib/state/updater.svelte";
  import { vault } from "./lib/state/vault.svelte";
  import { matchShortcut } from "./lib/utils/keys";
  import { fileKindOf, titleOf } from "./lib/utils/names";
  import { basename, nfc } from "./lib/utils/path";
  import { isComposing } from "./lib/utils/platform";
  import { nextFrame } from "./lib/utils/timing";

  /** Shows the window even if startup stalls (a slow network vault, a stuck IPC call). */
  const SHOW_FALLBACK_MS = 1000;
  /** WebKit may pause animation frames in a hidden window, so the frame wait is capped. */
  const FRAME_WAIT_MS = 100;

  // The UI language from i18n.ts (READ-02, SET-04).
  document.documentElement.lang = uiLanguage;

  /**
   * Below 700 px the sidebar floats over the content (PLAT-12). Sidebar.svelte owns that
   * layout and the hide-by-default bookkeeping; keep this query in sync with its own.
   */
  const narrowQuery = new MediaQuery("max-width: 699px");
  const narrow = $derived(narrowQuery.current);

  /** Startup finished (or the fallback fired): only then may the Welcome screen appear. */
  let booted = $state(false);
  let shown = false;

  // ── Window title (PLAT-02) ───────────────────────────────────────────────

  const windowTitle = $derived.by(() => {
    const p = editor.path;
    if (p !== null) return titleOf(nfc(basename(p)), fileKindOf(p));
    return vault.info ? nfc(vault.info.name) : "mininote";
  });

  $effect(() => {
    const title = windowTitle;
    getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  });

  // ── Narrow windows (PLAT-12) ─────────────────────────────────────────────

  // The overlay sidebar steps aside once a file opens from it.
  $effect(() => {
    void editor.path;
    untrack(() => {
      if (narrow && settings.loaded && settings.values.sidebarVisible) settings.update({ sidebarVisible: false });
    });
  });

  function closeOverlaySidebar(): void {
    settings.update({ sidebarVisible: false });
  }

  // ── Startup ──────────────────────────────────────────────────────────────

  async function reveal(): Promise<void> {
    booted = true;
    if (shown) return;
    shown = true;
    await tick();
    await Promise.race([nextFrame(), new Promise<void>((r) => setTimeout(r, FRAME_WAIT_MS))]);
    await getCurrentWindow()
      .show()
      .catch((e) => console.error("show window failed", e));
  }

  /**
   * settings → reopen the last vault → show (PLAT-03). An unreachable last vault fails
   * silently inside vault.open and stays on the recent list, dimmed (VAULT-02).
   */
  async function boot(): Promise<void> {
    const fallback = setTimeout(() => void reveal(), SHOW_FALLBACK_MS);
    try {
      await settings.load();
      // PLAT-12: a narrow window starts with the sidebar hidden; checked here, not when it mounts.
      checkNarrowStartup();
      const last = settings.values.lastVault;
      if (last) await openVault(last);
    } catch (e) {
      console.error("startup failed", e);
    } finally {
      clearTimeout(fallback);
      await reveal();
    }
  }

  onMount(() => {
    const win = getCurrentWindow();
    const unlisten: Promise<UnlistenFn>[] = [
      // The window must always close: flushBeforeExit never rejects and is time-bounded (§8.4).
      win.onCloseRequested(async () => {
        try {
          await flushBeforeExit();
        } catch (e) {
          console.error("close flush failed", e);
        }
      }),
      onFlushRequest(() => void quitApp()),
    ];
    // Commands carry no settings dependency; registering first keeps reload keys blocked from the start.
    registerAppCommands();
    // The update check (ARCHITECTURE §6.7) runs beside startup; an install flushes like a quit.
    const stopUpdater = updater.start(flushBeforeExit);
    void boot();
    return () => {
      stopUpdater();
      for (const p of unlisten) p.then((off) => off()).catch(() => {});
    };
  });

  // ── Keyboard (ARCHITECTURE §9.1, PLAT-13) ────────────────────────────────

  /** Every global shortcut is a modifier chord, a function key or a browser key; plain typing skips the scan. */
  const mayBeShortcut = (e: KeyboardEvent): boolean =>
    e.ctrlKey || e.metaKey || e.altKey || /^F\d{1,2}$/.test(e.key) || e.key.startsWith("Browser");

  /** Keys bound to a command, plus every browser key (Refresh, Home, Stop…): the webview acts on none of them (PLAT-13). */
  const ownsKey = (e: KeyboardEvent): boolean =>
    e.key.startsWith("Browser") || (mayBeShortcut(e) && commands.list.some((c) => commands.matches(c, e)));

  /** Capture phase: global shortcuts beat CodeMirror's defaults and the engine's accelerators. */
  function onKeydown(e: KeyboardEvent): void {
    // While Settings records a shortcut, every key goes to the recorder, which cancels it (SET-06).
    if (isComposing(e) || commands.paused) return;
    // A confirmation is modal: shortcuts wait until it is answered.
    if (ui.confirmDialog === null && commands.handleKeydown(e)) return;
    // Keys the app owns never fall through, even while their command is unavailable or the key
    // auto-repeats (the registry ignores repeats): a held F5 must not reload the webview, and an
    // unavailable history key must not indent or move the caret in CodeMirror.
    if (ownsKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Engine find-in-page keys (WebView2's find bar) when nothing in the page handled them. */
  const FIND_KEYS = ["Mod-f", "Mod-g", "Mod-Shift-g", "F3", "Shift-F3"];

  const isTextField = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

  /** Bubble phase: CodeMirror's panels and completions handle Escape before new-note cancellation. */
  function onKeydownLate(e: KeyboardEvent): void {
    if (e.defaultPrevented || isComposing(e)) return;
    if (matchShortcut(e, "Escape")) {
      if (!e.repeat && e.target instanceof HTMLElement && e.target.closest(".cm-content") && discardNewNote()) {
        e.preventDefault();
      }
      return;
    }
    if (!FIND_KEYS.some((k) => matchShortcut(e, k))) return;
    e.preventDefault();
    // EDIT-09: Mod+F anywhere else (reading view, the tree, the blank page) opens the note's
    // find panel, switching to editing first. Text fields and dialogs keep the key inert.
    if (e.repeat || !matchShortcut(e, "Mod-f") || isTextField(e.target)) return;
    if (ui.modal === null && ui.confirmDialog === null) void editor.openFind();
  }

  // ── Mouse back/forward buttons (NAV-03) ──────────────────────────────────

  function onNavButton(e: MouseEvent): void {
    if (e.button !== 3 && e.button !== 4) return;
    // Cancelled on every phase so the engine never navigates the webview itself.
    e.preventDefault();
    if (e.type === "mouseup" && ui.confirmDialog === null) void commands.run(e.button === 3 ? "back" : "forward");
  }

  // ── Links: the webview never navigates (ARCHITECTURE §9.2) ───────────────

  const EXTERNAL_HREF = /^(https?:|mailto:|tel:)/i;

  /** Bubble phase, so components that handle their own links (reading view) go first. */
  function onLinkClick(e: MouseEvent): void {
    if (e.defaultPrevented || !(e.target instanceof Element)) return;
    const anchor = e.target.closest("a, area");
    if (!anchor) return;
    e.preventDefault();
    if (e.type !== "click") return;
    const href = (anchor.getAttribute("href") ?? "").trim();
    if (EXTERNAL_HREF.test(href)) openUrl(href).catch((err) => console.error("open url failed", err));
  }

  // ── Native context menu (PLAT-13) ────────────────────────────────────────

  /**
   * Text that can be edited. An editor that cannot be (a read-only note, a code file) is
   * `contenteditable="false"`, so it is none: its menu appears over selected text only,
   * and nothing drops into it.
   */
  const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

  function inSelection(x: number, y: number): boolean {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return false;
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const r of sel.getRangeAt(i).getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
    }
    return false;
  }

  /** The engine's menu (Reload, Back, Print…) only appears over editable or selected text. */
  function onContextMenu(e: MouseEvent): void {
    if (e.defaultPrevented) return; // a component showed its own menu
    if (e.target instanceof Element && e.target.closest(EDITABLE)) return;
    if (inSelection(e.clientX, e.clientY)) return;
    e.preventDefault();
  }

  // ── Drops outside handled zones never navigate (PLAT-13) ─────────────────

  const isEditable = (target: EventTarget | null): boolean => target instanceof Element && target.closest(EDITABLE) !== null;

  function onDragOver(e: DragEvent): void {
    // Accepted by a zone (tree, editor paste handler), or a native text drop target.
    if (e.defaultPrevented || isEditable(e.target)) return;
    // Cancelling keeps the engine from opening the dragged item; "none" shows that nothing drops here.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  }

  function onDrop(e: DragEvent): void {
    if (e.defaultPrevented) return;
    const files = e.dataTransfer?.types.includes("Files") ?? false;
    if (!files && isEditable(e.target)) return; // text moved inside an input or the editor
    e.preventDefault();
  }
</script>

<svelte:window
  onkeydowncapture={onKeydown}
  onkeydown={onKeydownLate}
  onmousedowncapture={onNavButton}
  onmouseupcapture={onNavButton}
  onauxclickcapture={onNavButton}
  onclick={onLinkClick}
  onauxclick={onLinkClick}
  oncontextmenu={onContextMenu}
  ondragover={onDragOver}
  ondrop={onDrop}
/>

{#if vault.info}
  <div class="shell">
    {#if settings.values.sidebarVisible}
      <!-- Both size and place themselves, including the narrow overlay (PLAT-12). -->
      <Sidebar />
      <Resizer />
      {#if narrow}
        <!-- Under the overlay sidebar: a click beside it closes it. -->
        <div class="scrim" role="presentation" onmousedown={closeOverlaySidebar}></div>
      {/if}
    {/if}
    <div class="main">
      <Main />
    </div>
  </div>
{:else if booted && !vault.switching}
  <Welcome />
{/if}

{#if ui.modal === "switcher"}
  <QuickSwitcher />
{:else if ui.modal === "palette"}
  <CommandPalette />
{:else if ui.modal === "settings"}
  <SettingsModal />
{/if}
{#if ui.menu}
  <ContextMenu />
{/if}
{#if ui.confirmDialog}
  <ConfirmDialog />
{/if}
<Toasts />

<style>
  .shell {
    position: relative;
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  .scrim {
    position: absolute;
    inset: 0;
    z-index: calc(var(--z-sidebar) - 1);
  }

  .main {
    flex: 1;
    min-width: 0;
    height: 100%;
  }
</style>
