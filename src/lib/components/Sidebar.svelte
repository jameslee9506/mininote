<script module lang="ts">
  import { settings } from "../state/settings.svelte";

  /**
   * Narrow windows (PLAT-12): below 700 px the sidebar overlays the content and is
   * hidden by default. Keep in sync with the media queries in this file and Resizer.
   */
  const NARROW_QUERY = "(max-width: 699px)";
  const narrow = typeof window !== "undefined" ? window.matchMedia(NARROW_QUERY) : null;
  /** The sidebar was hidden by narrowing the window, so widening brings it back. */
  let autoHidden = false;
  let startupChecked = false;

  function hideForNarrow(): void {
    if (!settings.values.sidebarVisible) return;
    autoHidden = true;
    settings.update({ sidebarVisible: false });
  }

  /**
   * Starting in a narrow window hides the sidebar. Called once at startup, right after the
   * settings load, never when the sidebar mounts: a mount the user asked for must not be undone.
   */
  export function checkNarrowStartup(): void {
    if (startupChecked) return;
    startupChecked = true;
    if (narrow?.matches) hideForNarrow();
  }

  // Registered once at import: it must also see the window widen while the sidebar is unmounted.
  narrow?.addEventListener("change", (e) => {
    if (!settings.loaded) return;
    if (e.matches) {
      hideForNarrow();
    } else if (autoHidden) {
      autoHidden = false;
      if (!settings.values.sidebarVisible) settings.update({ sidebarVisible: true });
    }
  });
</script>

<script lang="ts">
  // The sidebar (DESIGN §4, NAV-04): a header that doubles as the macOS window drag
  // region (new note, new folder, collapse all), the search field over the file tree
  // (the results take the tree's place while a query is typed), and a footer with
  // the vault menu (VAULT-05) and the settings gear.
  import Icon from "./Icon.svelte";
  import FileTree from "./FileTree.svelte";
  import SearchPanel from "./SearchPanel.svelte";
  import { newFolder, newNote, openFolderDialog, openVault } from "../appCommands";
  import { vault } from "../state/vault.svelte";
  import { ui, type MenuEntry } from "../state/ui.svelte";
  import { t } from "../i18n";
  import { isMac } from "../utils/platform";
  import { key, nfc } from "../utils/path";

  const vaultName = $derived(vault.info ? vault.info.name || vault.info.root : "");

  function safely(p: Promise<unknown>): void {
    p.catch((err) => {
      console.error(err);
      ui.notify(t("errGeneric"));
    });
  }

  /** Last component of an absolute OS path ("C:\" stays "C:"). */
  function baseName(root: string): string {
    const parts = root.split(/[\\/]/).filter((s) => s !== "");
    return nfc(parts.length > 0 ? parts[parts.length - 1] : root);
  }

  /**
   * Recent vaults (the open one skipped; same-named ones by full path), then "Open
   * another folder". Opening goes through appCommands, like the Welcome screen.
   */
  function openVaultMenu(e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    const roots = settings.values.recentVaults.filter((r) => r !== vault.info?.root);
    const names = roots.map(baseName);
    const items: MenuEntry[] = roots.map((root, i) => ({
      label: names.filter((n) => key(n) === key(names[i])).length > 1 ? nfc(root) : names[i],
      run: () => safely(openVault(root)),
    }));
    if (items.length > 0) items.push({ separator: true });
    items.push({ label: t("openAnotherFolder"), run: () => safely(openFolderDialog()) });

    // Anchored at the button's top edge: near the window bottom, the menu opens upward.
    const rect = e.currentTarget.getBoundingClientRect();
    ui.showMenu(rect.left, rect.top, items);
  }
</script>

<aside class="sidebar">
  <!-- Buttons are direct children: Tauri drags only on the region element itself. -->
  <header class="header" class:mac={isMac} data-tauri-drag-region={isMac ? "" : undefined}>
    <button type="button" class="icon-btn first" aria-label={t("ariaNewNote")} onclick={() => safely(newNote())}>
      <Icon name="note-plus" />
    </button>
    <button
      type="button"
      class="icon-btn"
      aria-label={t("ariaNewFolder")}
      onclick={() => safely(newFolder(vault.activeDir()))}
    >
      <Icon name="folder-plus" />
    </button>
    <button type="button" class="icon-btn" aria-label={t("collapseAll")} onclick={() => vault.collapseAll()}>
      <Icon name="collapse" />
    </button>
  </header>

  <div class="body">
    <SearchPanel />
    {#if !ui.searching}
      <FileTree />
    {/if}
  </div>

  <footer class="footer">
    <button type="button" class="vault" aria-haspopup="menu" onclick={openVaultMenu}>{vaultName}</button>
    <button type="button" class="icon-btn" aria-label={t("ariaSettings")} onclick={() => ui.openModal("settings")}>
      <Icon name="settings" />
    </button>
  </footer>
</aside>

<style>
  .sidebar {
    display: flex;
    flex: none;
    flex-direction: column;
    width: var(--sidebar-width);
    height: 100%;
    min-width: 0;
    overflow: hidden;
    border-right: 1px solid var(--c-border);
    background: var(--c-bg-alt);
  }

  .header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    height: var(--header-h);
    padding: 0 8px;
  }

  /* Room for the traffic lights, which sit inside this header on macOS. */
  .header.mac {
    padding-left: 76px;
  }

  .first {
    margin-left: auto;
  }

  /* At the narrowest width (and 76 px reserved on macOS) the buttons may shrink a little. */
  .header .icon-btn {
    flex: 0 1 28px;
    width: auto;
    min-width: 22px;
  }

  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .footer {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: var(--header-h);
    padding: 0 8px;
  }

  .vault {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 6px;
    overflow: hidden;
    border-radius: var(--radius-s);
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition:
      background-color var(--dur-fast),
      color var(--dur-fast);
  }

  .vault:hover,
  .vault:focus-visible {
    background: var(--c-bg-hover);
    color: var(--c-text);
  }

  .vault:active {
    background: var(--c-bg-active);
  }

  /* PLAT-12: over the content instead of beside it; never wider than the window allows. */
  @media (max-width: 699px) {
    .sidebar {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: var(--z-sidebar);
      width: min(var(--sidebar-width), calc(100vw - var(--header-h)));
      height: auto;
      box-shadow: var(--shadow-elev);
    }
  }
</style>
