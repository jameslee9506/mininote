<script lang="ts">
  // The update control (DESIGN §4): nothing until a newer release is known, then one
  // icon button that downloads, installs and restarts. While it downloads, the icon
  // gives way to the whole percentage; an install whose restart failed shows a
  // restart arrow instead, and the click then only restarts.
  import Icon from "./Icon.svelte";
  import { t } from "../i18n";
  import { updater } from "../state/updater.svelte";

  const label = $derived.by(() => {
    const version = updater.version;
    switch (updater.phase) {
      case "downloading":
        return t("ariaUpdateDownloading", { version }) + (updater.progress === null ? "" : ` ${updater.progress}%`);
      case "installing":
        return t("ariaUpdateInstalling", { version });
      case "restarting":
        return t("ariaUpdateRestarting");
      case "restart":
        return t("ariaUpdateRestart", { version });
      default:
        return t("ariaUpdate", { version });
    }
  });
</script>

{#if updater.visible}
  <button
    type="button"
    class="icon-btn update"
    aria-label={label}
    aria-busy={updater.busy}
    disabled={updater.busy}
    onclick={() => void updater.install()}
  >
    {#if updater.phase === "downloading" && updater.progress !== null}
      <span class="percent">{updater.progress}</span>
    {:else}
      <Icon name={updater.phase === "restart" ? "restart" : "download"} />
    {/if}
  </button>
{/if}

<style>
  /* A step past the faint chrome: an available update should be noticed, in gray. */
  .update {
    color: var(--c-text-muted);
  }

  /* Locked while it works, but its progress stays readable. */
  .update:disabled {
    opacity: 1;
    pointer-events: auto;
    background: none;
    color: var(--c-text-faint);
  }

  .percent {
    font-size: var(--fs-ui-small);
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
</style>
