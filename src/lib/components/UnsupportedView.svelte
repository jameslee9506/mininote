<script lang="ts">
  // What the main area shows for a file that is not a note, an image or a code file
  // (TREE-16): the tree lists every file, but only those open. Nothing is read from the
  // file; the inline title above still shows its full name and renames it.
  import Icon from "./Icon.svelte";
  import { t } from "../i18n";
  import type { VaultPath } from "../types";
  import { basename, nfc } from "../utils/path";

  let { path }: { path: VaultPath } = $props();

  /** The extension as the name spells it ("" for a name without one, such as "Makefile"). */
  const ext = $derived.by(() => {
    const name = nfc(basename(path));
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1) : "";
  });
</script>

<div class="unsupported">
  <span class="glyph"><Icon name="file" /></span>
  <p>{ext === "" ? t("unsupportedFile") : t("unsupportedExt", { ext })}</p>
</div>

<style>
  .unsupported {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding-top: 12vh;
    color: var(--c-text-muted);
    font-size: var(--fs-ui);
    line-height: var(--lh-ui);
    text-align: center;
    overflow-wrap: anywhere;
  }

  .glyph {
    color: var(--c-text-faint);
  }

  p {
    margin: 0;
  }
</style>
