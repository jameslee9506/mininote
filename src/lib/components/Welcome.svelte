<script lang="ts">
  // No vault open (VAULT-01/02/05): one open-folder icon button and the names of the
  // recent vaults below it. A full path shows only to tell same-named vaults apart.
  // The update button, when there is one, sits in the top-right corner (§6.7).
  import Icon from "./Icon.svelte";
  import UpdateButton from "./UpdateButton.svelte";
  import { openFolderDialog, openVault, unavailableVaults } from "../appCommands";
  import { t } from "../i18n";
  import { settings } from "../state/settings.svelte";
  import { ui } from "../state/ui.svelte";
  import { key, nfc } from "../utils/path";
  import { isMac } from "../utils/platform";

  /** Last component of an absolute OS path: "/a/b" → "b", "C:\\x\\y\\" → "y". */
  function folderName(root: string): string {
    const parts = root.split(/[\\/]+/).filter((part) => part !== "");
    return nfc(parts.length > 0 ? parts[parts.length - 1] : root);
  }

  const recent = $derived.by(() => {
    const roots = settings.values.recentVaults;
    const names = roots.map(folderName);
    return roots.map((root, i) => ({
      root,
      name: names[i],
      ambiguous: names.filter((n) => key(n) === key(names[i])).length > 1,
    }));
  });

  let busy = false;

  /** One open at a time (a double click must not start two). */
  async function once(action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
    }
  }

  function showVaultMenu(e: MouseEvent, root: string): void {
    e.preventDefault();
    ui.showMenu(e.clientX, e.clientY, [{ label: t("removeFromRecent"), run: () => settings.forgetVault(root) }]);
  }
</script>

<div class="welcome">
  {#if isMac}
    <div class="drag" data-tauri-drag-region></div>
  {/if}
  <!-- Where the main strip keeps it once a vault opens; a sibling of the drag region, so clicks never drag. -->
  <div class="corner">
    <UpdateButton />
  </div>
  <div class="content">
    <button type="button" class="icon-btn" aria-label={t("openFolder")} onclick={() => once(openFolderDialog)}>
      <Icon name="folder" />
    </button>
    {#if recent.length > 0}
      <ul class="recent">
        {#each recent as { root, name, ambiguous } (root)}
          <li>
            <button
              type="button"
              class="vault"
              class:unavailable={unavailableVaults.has(root)}
              onclick={() => once(() => openVault(root))}
              oncontextmenu={(e) => showVaultMenu(e, root)}
            >
              <span class="name">{name}</span>
              {#if ambiguous}<span class="path">{nfc(root)}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .welcome {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: var(--header-h) 16px;
    background: var(--c-bg);
  }

  /* macOS: the overlay title bar has no native drag area; the traffic lights sit here. */
  .drag {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--header-h);
  }

  /* Centered in the strip's height like the main strip's icon buttons (28px). */
  .corner {
    position: absolute;
    top: calc((var(--header-h) - 28px) / 2);
    right: 8px;
  }

  .content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    width: 100%;
    max-width: 360px;
    max-height: 100%;
  }

  .recent {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  .vault {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    padding: 6px 10px;
    border-radius: var(--radius-s);
    text-align: left;
    transition: background-color var(--dur-fast);
  }

  .vault:hover {
    background: var(--c-bg-hover);
  }

  .vault:active {
    background: var(--c-bg-active);
  }

  .name,
  .path {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name {
    font-size: var(--fs-ui);
    color: var(--c-text);
  }

  .path {
    font-size: var(--fs-ui-small);
    color: var(--c-text-muted);
  }

  /* Missing or unreadable this session (VAULT-02): still clickable to retry. */
  .unavailable .name,
  .unavailable .path {
    color: var(--c-text-faint);
  }
</style>
