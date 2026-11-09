<script lang="ts">
  // Command palette (NAV-06): every available command, ranked with the switcher's
  // fuzzy scorer; Enter closes the palette, then runs the command.
  import { tick } from "svelte";
  import Modal, { highlight } from "./Modal.svelte";
  import { commands, type Command } from "../state/commands.svelte";
  import { ui } from "../state/ui.svelte";
  import { t } from "../i18n";
  import { fuzzyRank } from "../utils/fuzzy";
  import { formatShortcut } from "../utils/keys";
  import { isComposing } from "../utils/platform";

  /** Result row height (DESIGN §4), used to size PageUp/PageDown. */
  const ROW_H = 32;

  const uid = $props.id();
  let query = $state("");
  let selected = $state(0);
  let list: HTMLElement | undefined = $state();
  let lastPointer = "";

  const available = $derived(commands.available());
  const results = $derived(fuzzyRank(query, available, (c) => t(c.label), available.length));
  const active = $derived(results.length === 0 ? -1 : Math.min(selected, results.length - 1));

  function reset(): void {
    selected = 0;
    if (list) list.scrollTop = 0;
  }

  function select(i: number): void {
    selected = i;
    void tick().then(() => list?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  /**
   * Follows real pointer moves only: not rows scrolling or appearing under a
   * resting pointer, and not the first report after opening.
   */
  function hover(e: MouseEvent, i: number): void {
    const at = `${e.clientX},${e.clientY}`;
    if (at === lastPointer) return;
    const first = lastPointer === "";
    lastPointer = at;
    if (!first) selected = i;
  }

  const keepFocus = (e: MouseEvent): void => e.preventDefault();

  /** Closes first, so the command runs with focus back where it was before the palette. */
  async function run(cmd: Command): Promise<void> {
    ui.closeModal();
    await tick();
    try {
      await commands.run(cmd.id);
    } catch (err) {
      console.error(err);
      ui.notify(t("errGeneric"));
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const count = results.length;
    const page = Math.max(1, Math.floor((list?.clientHeight ?? 0) / ROW_H) - 1);
    let next: number;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        if (active >= 0) void run(results[active].item);
        return;
      case "ArrowDown":
        next = active + 1 >= count ? 0 : active + 1;
        break;
      case "ArrowUp":
        next = active <= 0 ? count - 1 : active - 1;
        break;
      case "PageDown":
        next = Math.min(count - 1, active + page);
        break;
      case "PageUp":
        next = Math.max(0, active - page);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (count > 0) select(next);
  }
</script>

{#snippet marked(text: string, hits: readonly number[])}
  {#each highlight(text, hits) as s}{#if s.hit}<span class="ml-hit">{s.text}</span>{:else}{s.text}{/if}{/each}
{/snippet}

<Modal label={t("cmdCommandPalette")} onclose={ui.closeModal}>
  <input
    class="ml-input"
    type="text"
    data-autofocus
    bind:value={query}
    oninput={reset}
    onkeydown={onKeydown}
    role="combobox"
    aria-label={t("ariaSearch")}
    aria-expanded={results.length > 0}
    aria-controls={results.length > 0 ? `${uid}-list` : undefined}
    aria-autocomplete="list"
    aria-activedescendant={active >= 0 ? `${uid}-${active}` : undefined}
    spellcheck="false"
    autocomplete="off"
    autocorrect="off"
    autocapitalize="off"
    writingsuggestions="false"
  />
  {#if results.length > 0}
    <div bind:this={list} id="{uid}-list" class="ml-list" role="listbox" aria-label={t("cmdCommandPalette")}>
      {#each results as r, i (r.item.id)}
        {@const keys = commands.keysOf(r.item)}
        <button
          type="button"
          id="{uid}-{i}"
          data-index={i}
          class="ml-row"
          class:selected={i === active}
          role="option"
          tabindex="-1"
          aria-selected={i === active}
          onmousedown={keepFocus}
          onmousemove={(e) => hover(e, i)}
          onclick={() => void run(r.item)}
        >
          <span class="ml-main">{@render marked(t(r.item.label), r.positions)}</span>
          {#if keys.length > 0}
            <span class="ml-aside">{formatShortcut(keys[0])}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</Modal>
