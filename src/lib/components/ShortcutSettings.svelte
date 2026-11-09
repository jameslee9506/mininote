<script lang="ts">
  // Settings → Shortcuts (SET-06): one row per command, its keys on the right. "+" records a
  // key, a key's × removes it, and ↺ brings the defaults back. While "+" listens, the global
  // handler stands aside (commands.paused) and the recorder cancels every key it gets, so
  // nothing runs, reloads or closes the modal. A key belongs to one command at most.
  import Icon from "./Icon.svelte";
  import { EDITOR_SHORTCUTS } from "../editor/commands";
  import { t } from "../i18n";
  import { commands } from "../state/commands.svelte";
  import { settings } from "../state/settings.svelte";
  import { ui } from "../state/ui.svelte";
  import { canBind, chordOf, formatChord, formatShortcut, isReserved, normalizeSpec, sameKeySet, specOf } from "../utils/keys";
  import { isComposing } from "../utils/platform";

  interface Entry {
    id: string;
    label: string;
    defaults: readonly string[];
  }

  // Commands are registered once at startup, so the rows never change while the modal is open.
  const groups: Entry[][] = [
    commands.list.filter((c) => !c.fixed).map((c) => ({ id: c.id, label: t(c.label), defaults: c.keys ?? [] })),
    EDITOR_SHORTCUTS.map((s) => ({ id: s.id, label: t(s.label, s.labelParams), defaults: s.keys })),
  ];
  const entries = groups.flat();

  const uid = $props.id();
  /** The row whose "+" is listening for a key. */
  let recording = $state<string | null>(null);
  /** The modifiers held meanwhile ("⌘⇧"). */
  let held = $state("");

  const keysOf = (entry: Entry): readonly string[] => settings.values.shortcuts[entry.id] ?? entry.defaults;
  const isCustom = (entry: Entry): boolean => settings.values.shortcuts[entry.id] !== undefined;
  const uses = (entry: Entry, spec: string): boolean => keysOf(entry).some((k) => normalizeSpec(k) === spec);

  /** Stores the keys of `entry`; the defaults again drop its override. */
  function store(entry: Entry, keys: readonly string[]): void {
    const shortcuts = { ...settings.values.shortcuts };
    delete shortcuts[entry.id];
    if (!sameKeySet(keys, entry.defaults)) shortcuts[entry.id] = [...keys];
    settings.update({ shortcuts });
  }

  function startRecording(entry: Entry, button: HTMLButtonElement): void {
    if (recording === entry.id) return;
    // WebKit leaves a clicked button unfocused. Focusing first also ends another row's recording (blur).
    button.focus();
    recording = entry.id;
    held = "";
    commands.paused = true;
  }

  function stopRecording(): void {
    recording = null;
    held = "";
    commands.paused = false;
  }

  // Closing the modal mid-recording must not leave the global shortcuts off.
  $effect(() => () => {
    commands.paused = false;
  });

  function record(entry: Entry, e: KeyboardEvent): void {
    if (recording !== entry.id || isComposing(e)) return;
    // Tab still moves focus, and the blur ends recording.
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      stopRecording();
      return;
    }
    const chord = chordOf(e);
    if (chord === null || e.repeat) return;
    if (chord.key === "") {
      held = formatChord(chord);
      return;
    }
    if (!canBind(chord)) {
      ui.notify(t("errShortcutInvalid"));
      return;
    }
    const spec = specOf(chord);
    if (isReserved(spec)) {
      ui.notify(t("errShortcutReserved", { key: formatShortcut(spec) }));
      return;
    }
    if (!uses(entry, spec)) {
      const owner = entries.find((other) => other.id !== entry.id && uses(other, spec));
      if (owner) {
        ui.notify(t("errShortcutTaken", { key: formatShortcut(spec), name: owner.label }));
        return;
      }
      store(entry, [...keysOf(entry), spec]);
    }
    stopRecording();
  }

  function release(entry: Entry, e: KeyboardEvent): void {
    if (recording !== entry.id) return;
    const chord = chordOf(e);
    held = chord ? formatChord({ ...chord, key: "" }) : "";
  }
</script>

<div class="shortcuts">
  {#each groups as group, i (i)}
    <div class="group">
      {#each group as entry (entry.id)}
        {@const listening = recording === entry.id}
        <div class="row" role="group" aria-labelledby="{uid}-{entry.id}">
          <span class="label" id="{uid}-{entry.id}">{entry.label}</span>
          {#each keysOf(entry) as key (key)}
            <span class="key">
              <kbd>{formatShortcut(key)}</kbd>
              <button
                type="button"
                class="remove"
                aria-label={t("ariaRemoveShortcut", { key: formatShortcut(key) })}
                onclick={() => store(entry, keysOf(entry).filter((k) => k !== key))}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          {/each}
          <button
            type="button"
            class="icon-btn add"
            class:listening
            aria-label={listening ? t("ariaRecordShortcut") : t("ariaAddShortcut")}
            onclick={(e) => startRecording(entry, e.currentTarget)}
            onkeydown={(e) => record(entry, e)}
            onkeyup={(e) => release(entry, e)}
            onblur={() => {
              if (recording === entry.id) stopRecording();
            }}
          >
            {#if listening}{held}{:else}<Icon name="plus" size={14} />{/if}
          </button>
          <!-- Disabled while hidden, so the modal's Tab trap never counts it as the last stop. -->
          <button
            type="button"
            class="icon-btn reset"
            class:hidden={!isCustom(entry)}
            disabled={!isCustom(entry)}
            aria-label={t("ariaResetShortcut")}
            onclick={() => store(entry, entry.defaults)}
          >
            <Icon name="reset" size={14} />
          </button>
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .shortcuts {
    min-height: 0;
    overflow-y: auto;
    padding: 4px 20px 8px;
  }

  .group + .group {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--c-border);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 40px;
  }

  .label {
    flex: 1 1 auto;
    min-width: 0;
    padding-right: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--c-text);
    font-size: var(--fs-ui);
  }

  .key {
    display: inline-flex;
    flex: none;
    align-items: center;
    height: 24px;
    padding: 0 2px 0 8px;
    border: 1px solid var(--c-border-strong);
    border-radius: var(--radius-s);
  }

  kbd {
    color: var(--c-text);
    font-family: inherit;
    font-size: var(--fs-ui-small);
    white-space: nowrap;
  }

  .remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: 2px;
    border-radius: var(--radius-s);
    color: var(--c-text-faint);
    transition:
      background-color var(--dur-fast),
      color var(--dur-fast);
  }

  .remove:hover,
  .remove:focus-visible {
    background: var(--c-bg-hover);
    color: var(--c-text);
  }

  .icon-btn {
    width: 24px;
    height: 24px;
    flex: none;
  }

  /* Listening: an empty key slot that shows the modifiers held so far. */
  .add.listening {
    width: auto;
    min-width: 44px;
    padding: 0 8px;
    border: 1px dashed var(--c-border-strong);
    background: none;
    color: var(--c-text);
    font-size: var(--fs-ui-small);
    white-space: nowrap;
  }

  /* Keeps its place, so the "+" buttons line up whether a row is customized or not. */
  .reset.hidden {
    visibility: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    .remove {
      transition: none;
    }
  }
</style>
