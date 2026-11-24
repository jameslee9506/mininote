<script lang="ts" module>
  import type { Snippet } from "svelte";
  import type { CliStatus } from "../types";

  /** Declared here, where the snippets below see it too: in the instance script alone, they read `Option` as the DOM's. */
  interface Option {
    value: string | number;
    label: string;
  }

  type Tab = "general" | "appearance" | "shortcuts";

  /**
   * The terminal command's status when last asked (PLAT-14), kept between openings so that its
   * row is there at once; null hides the row.
   */
  let knownCommand: CliStatus = null;
  /** The tab shown last: the settings open on it again until the window closes. */
  let lastTab: Tab = "general";
</script>

<script lang="ts">
  // Settings (SET-02), in three tabs: General (editing, where new notes and attachments
  // go, deleting, the terminal command), Appearance (theme, icons, fonts, line width,
  // title) and Shortcuts (SET-06). In the first two, one row per setting, label left and
  // control right, no descriptions; every change applies at once through settings.update.
  // An icon set is chosen by its own folder and note, drawn instead of named (SET-08). A
  // font is a family installed here, listed or typed by hand: any family for the text and
  // the headings (SET-09), a monospaced one for code (SET-07). What belongs to a row hangs
  // under it in sub-rows, joined to it by a line: a folder or family typed by hand, and the
  // heading levels the heading font is given, a checkbox each (SET-09). The terminal
  // command's switch is no setting: it shows whether the command is installed, and
  // installs or removes it (PLAT-14). A quiet last row in General shows the app version.
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import ShortcutSettings from "./ShortcutSettings.svelte";
  import { cliInstall, cliStatus, cliUninstall, isIpcError } from "../ipc/commands";
  import { FONT_SIZE_MAX, FONT_SIZE_MIN, settings } from "../state/settings.svelte";
  import { ui } from "../state/ui.svelte";
  import { updater } from "../state/updater.svelte";
  import { t } from "../i18n";
  import type { HeadingFontLevel, IconTheme, Settings, ThemeMode } from "../types";
  import {
    fontProbe,
    HEADING_FONT_LEVELS,
    installedMonoFonts,
    installedTextFonts,
    monoFontProbe,
    SANS_SERIF,
    sanitizeFontFamily,
    SERIF,
  } from "../utils/fonts";
  import { validateName } from "../utils/names";
  import { nfc } from "../utils/path";
  import { isComposing } from "../utils/platform";

  const TABS: { id: Tab; label: string }[] = [
    { id: "general", label: t("settingsGeneral") },
    { id: "appearance", label: t("settingsAppearance") },
    { id: "shortcuts", label: t("shortcuts") },
  ];
  const LINE_WIDTHS = [640, 720, 800, 960];
  const THEMES: Option[] = [
    { value: "system", label: t("themeSystem") },
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
  ];
  /** The icon sets (SET-08). A segment shows its set; the label is only its accessible name. */
  const ICON_THEMES: Option[] = [
    { value: "outline", label: t("iconsOutline") },
    { value: "filled", label: t("iconsFilled") },
    { value: "color", label: t("iconsColor") },
  ];
  const NEW_NOTE_LOCATIONS: Option[] = [
    { value: "current", label: t("locationCurrent") },
    { value: "root", label: t("locationRoot") },
  ];
  const ATTACHMENT_LOCATIONS: Option[] = [
    { value: "folder", label: t("attachmentFolder") },
    { value: "same", label: t("attachmentSame") },
    { value: "root", label: t("attachmentRoot") },
  ];
  /** The select's value for a family typed by hand. No family is named so: a stored name has no quotes. */
  const CUSTOM_FONT = '"custom"';

  type FontKey = "textFont" | "headingFont" | "codeFont";

  /**
   * One font setting: its select, and the name field of a family typed by hand. A listed
   * choice applies at once; "Custom" opens the field on the current name, which applies once
   * committed unless `refuse` names what is wrong with it.
   */
  class FontField {
    key: FontKey;
    options: Option[];
    /** The family is typed by hand: chosen so in the select, or stored and not listed there. */
    custom = $state(false);
    draft = $state("");
    invalid = $state(false);
    /** The error toast for a typed name the setting cannot take, or null. */
    #refuse: (name: string) => string | null;

    constructor(key: FontKey, choices: Option[], families: string[], refuse: (name: string) => string | null) {
      this.key = key;
      this.#refuse = refuse;
      this.options = [
        ...choices,
        ...families.map((name) => ({ value: name, label: name })),
        { value: CUSTOM_FONT, label: t("fontCustom") },
      ];
      const stored = settings.values[key];
      this.custom = !this.options.some((o) => o.value === stored);
      this.draft = stored;
    }

    get selected(): string {
      return this.custom ? CUSTOM_FONT : settings.values[this.key];
    }

    /** A name was typed and not committed. */
    get pending(): boolean {
      return this.custom && sanitizeFontFamily(this.draft) !== settings.values[this.key];
    }

    choose = (value: string): void => {
      this.invalid = false;
      if (value === CUSTOM_FONT) {
        this.custom = true;
        this.draft = settings.values[this.key];
        return;
      }
      this.custom = false;
      this.#store(value);
    };

    /** Commits the typed name; an empty one is the default. A refused one toasts, and reverts when `revert` is set. */
    commit = (revert: boolean): void => {
      const stored = settings.values[this.key];
      const name = sanitizeFontFamily(this.draft);
      const error = name !== "" && name !== stored ? this.#refuse(name) : null;
      if (error !== null) {
        ui.notify(error);
        this.invalid = !revert;
        if (revert) this.draft = stored;
        return;
      }
      this.invalid = false;
      this.draft = name;
      if (name !== stored) this.#store(name);
    };

    #store(name: string): void {
      const patch: Partial<Settings> = {};
      patch[this.key] = name;
      settings.update(patch);
    }
  }

  const DEFAULT_FONT: Option = { value: "", label: t("fontDefault") };
  const SERIF_FONT: Option = { value: SERIF, label: t("fontSerif") };
  /** The families installed here, probed as the modal opens (SET-07, SET-09). */
  const textFamilies = installedTextFonts();
  /** A typed family must be installed (SET-09), and a code font monospaced as well (SET-07). */
  const notInstalled = (name: string): string | null =>
    fontProbe()?.(name) === false ? t("errFontNotInstalled", { name }) : null;
  const notMono = (name: string): string | null => (monoFontProbe()?.(name) === false ? t("errFontNotMono", { name }) : null);
  const textFont = new FontField("textFont", [DEFAULT_FONT, SERIF_FONT], textFamilies, notInstalled);
  const headingFont = new FontField(
    "headingFont",
    [DEFAULT_FONT, SERIF_FONT, { value: SANS_SERIF, label: t("fontSansSerif") }],
    textFamilies,
    notInstalled,
  );
  const codeFont = new FontField("codeFont", [DEFAULT_FONT], installedMonoFonts(), notMono);
  const FONT_FIELDS = [textFont, headingFont, codeFont];

  const uid = $props.id();
  const v = $derived(settings.values);
  /** The fixed widths (plus a hand-edited one, so the select can show it), then Full (0). */
  const widthOptions: Option[] = $derived(
    [...new Set([...LINE_WIDTHS, v.lineWidth])]
      .filter((w) => w > 0)
      .sort((a, b) => a - b)
      .concat(0)
      .map((w) => ({ value: w, label: w === 0 ? t("fullWidth") : String(w) })),
  );

  let tab = $state<Tab>(lastTab);
  let folderDraft = $state(settings.values.attachmentFolder);
  let folderInvalid = $state(false);
  /** Whether the `mininote` terminal command is installed; null where the app cannot install it (PLAT-14). */
  let command = $state<CliStatus>(knownCommand);
  let commandBusy = false;

  function setCommand(status: CliStatus): void {
    command = knownCommand = status;
  }

  onMount(() => {
    cliStatus()
      .then(setCommand)
      .catch((e) => console.error("terminal command status failed", e));
  });

  /**
   * Installs or removes the terminal command. The switch follows what the backend reports
   * afterwards: where the system asks for an administrator's password, declining leaves it as it was.
   */
  async function toggleCommand(install: boolean): Promise<void> {
    if (commandBusy) return;
    commandBusy = true;
    try {
      setCommand(await (install ? cliInstall(t("terminalCommandInstall")) : cliUninstall(t("terminalCommandRemove"))));
    } catch (e) {
      console.error("terminal command failed", e);
      ui.notify(t(!install ? "errCommandRemove" : isIpcError(e, "exists") ? "errCommandTaken" : "errCommandInstall"));
    } finally {
      commandBusy = false;
    }
  }

  function show(next: Tab): void {
    tab = lastTab = next;
  }

  function stepFontSize(delta: number): void {
    const size = v.fontSize + delta;
    if (size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX) settings.update({ fontSize: size });
  }

  /** Gives a heading level the heading font, or the text font back (SET-09). */
  function setHeadingLevel(level: HeadingFontLevel, on: boolean): void {
    const others = v.headingFontLevels.filter((l) => l !== level);
    settings.update({ headingFontLevels: on ? [...others, level] : others });
  }

  /** Radio-group keys, on the segment at `at`: arrows move the choice and the focus together. */
  function onSegmentKeydown(
    e: KeyboardEvent & { currentTarget: HTMLElement },
    options: Option[],
    at: number,
    set: (value: string) => void,
  ): void {
    if (isComposing(e)) return;
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = (at + delta + options.length) % options.length;
    set(String(options[next].value));
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  }

  /** Tab keys, on the tab at `at`: Left and Right open the next tab around the ends, Home and End the first and last. */
  function onTabKeydown(e: KeyboardEvent & { currentTarget: HTMLElement }, at: number): void {
    if (isComposing(e)) return;
    const last = TABS.length - 1;
    const targets: Partial<Record<string, number>> = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    const next = targets[e.key];
    if (next === undefined) return;
    e.preventDefault();
    show(TABS[next].id);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  }

  /** "a\b/ c /" → "a/b/c" (NFC); null when empty or when a segment is not a valid folder name. */
  function parseFolder(raw: string): string | null {
    const segments = raw
      .split(/[\\/]/)
      .map((s) => nfc(s.trim()))
      .filter((s) => s !== "");
    if (segments.length === 0 || segments.some((s) => validateName(s, { note: false }) !== null)) return null;
    return segments.join("/");
  }

  /** Commits the attachment-folder draft. An invalid one toasts, and reverts when `revert` is set. */
  function commitFolder(revert: boolean): void {
    const stored = settings.values.attachmentFolder;
    if (folderDraft === stored) {
      folderInvalid = false;
      return;
    }
    const folder = parseFolder(folderDraft);
    if (folder === null) {
      ui.notify(t("errNameInvalid"));
      folderInvalid = !revert;
      if (revert) folderDraft = stored;
      return;
    }
    folderInvalid = false;
    folderDraft = folder;
    if (folder !== stored) settings.update({ attachmentFolder: folder });
  }

  /** Enter commits a name field. */
  function onNameKeydown(e: KeyboardEvent, commit: (revert: boolean) => void): void {
    if (isComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit(false);
    }
  }

  // Escape or a click outside closes the modal without blurring the field first:
  // keep a valid folder or font name that was typed but not yet committed.
  $effect(() => () => {
    if (settings.values.attachmentLocation === "folder" && folderDraft !== settings.values.attachmentFolder) commitFolder(false);
    for (const field of FONT_FIELDS) if (field.pending) field.commit(false);
  });
</script>

<!-- A radio group of segments. With `icons`, the options are icon sets: each segment draws its own. -->
{#snippet segmented(id: string, label: string, value: string, options: Option[], set: (value: string) => void, icons = false)}
  <div class="row">
    <span class="label" id="{uid}-{id}">{label}</span>
    <div class="segmented" role="radiogroup" aria-labelledby="{uid}-{id}">
      {#each options as o, i (o.value)}
        <button
          type="button"
          class:icons
          role="radio"
          aria-checked={o.value === value}
          aria-label={icons ? o.label : undefined}
          tabindex={o.value === value ? 0 : -1}
          data-icons={icons ? o.value : undefined}
          onclick={() => set(String(o.value))}
          onkeydown={(e) => onSegmentKeydown(e, options, i, set)}
        >
          {#if icons}
            <span class="sample folder"><Icon name="folder" /></span>
            <span class="sample"><Icon name="note" /></span>
          {:else}
            {o.label}
          {/if}
        </button>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet toggle(id: string, label: string, checked: boolean, set: (on: boolean) => void)}
  <div class="row">
    <span class="label" id="{uid}-{id}">{label}</span>
    <button type="button" class="switch" role="switch" aria-checked={checked} aria-labelledby="{uid}-{id}" onclick={() => set(!checked)}
    ></button>
  </div>
{/snippet}

{#snippet choice(label: string, value: string | number, options: Option[], set: (value: string) => void)}
  <label class="row">
    <span class="label">{label}</span>
    <span class="select">
      <select class="field" {value} onchange={(e) => set(e.currentTarget.value)}>
        {#each options as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
      </select>
    </span>
  </label>
{/snippet}

<!--
  A sub-row with a name field: the attachment folder, a font typed by hand. Enter commits the
  name; leaving the field commits it too, or puts the stored one back if it is refused.
-->
{#snippet nameField(
  label: string,
  invalid: boolean,
  commit: (revert: boolean) => void,
  get: () => string,
  set: (value: string) => void,
)}
  <label class="row">
    <span class="label">{label}</span>
    <input
      class="field name"
      class:invalid
      type="text"
      aria-invalid={invalid}
      bind:value={get, set}
      onkeydown={(e) => onNameKeydown(e, commit)}
      onblur={() => commit(true)}
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      writingsuggestions="false"
    />
  </label>
{/snippet}

<!-- A font's select, and the sub-rows under it: the name field of a family typed by hand, then `more`. -->
{#snippet font(label: string, field: FontField, more?: Snippet)}
  {@render choice(label, field.selected, field.options, field.choose)}
  {#if field.custom || more}
    <div class="subs" role="group" aria-label={label}>
      {#if field.custom}
        {@render nameField(
          t("fontName"),
          field.invalid,
          field.commit,
          () => field.draft,
          (name) => {
            field.draft = name;
            field.invalid = false;
          },
        )}
      {/if}
      {@render more?.()}
    </div>
  {/if}
{/snippet}

<!--
  The heading levels the heading font is given (SET-09): a sub-row each, its checkbox before
  its name. The whole row toggles it.
-->
{#snippet headingLevels()}
  {#each HEADING_FONT_LEVELS as level (level)}
    {@const on = v.headingFontLevels.includes(level)}
    <label class="row check">
      <button
        type="button"
        class="checkbox"
        role="checkbox"
        aria-checked={on}
        aria-labelledby="{uid}-h{level}"
        onclick={() => setHeadingLevel(level, !on)}
      >
        {#if on}<Icon name="check" size={12} />{/if}
      </button>
      <span class="label" id="{uid}-h{level}">{t("headingLevel", { level })}</span>
    </label>
  {/each}
{/snippet}

<Modal width={520} label={t("settings")} onclose={ui.closeModal}>
  <div class="tabs" role="tablist">
    {#each TABS as item, i (item.id)}
      <button
        type="button"
        role="tab"
        id="{uid}-tab-{item.id}"
        aria-selected={item.id === tab}
        aria-controls="{uid}-panel"
        tabindex={item.id === tab ? 0 : -1}
        onclick={() => show(item.id)}
        onkeydown={(e) => onTabKeydown(e, i)}
      >
        {item.label}
      </button>
    {/each}
  </div>

  <div class="body" role="tabpanel" id="{uid}-panel" aria-labelledby="{uid}-tab-{tab}">
    {#if tab === "general"}
      <div class="settings">
        {@render toggle("live", t("livePreview"), v.editorMode === "live", (on) => settings.update({ editorMode: on ? "live" : "source" }))}
        {@render toggle("spellcheck", t("spellcheck"), v.spellcheck, (on) => settings.update({ spellcheck: on }))}
        {@render choice(t("newNoteLocation"), v.newNoteLocation, NEW_NOTE_LOCATIONS, (loc) =>
          settings.update({ newNoteLocation: loc as Settings["newNoteLocation"] }),
        )}
        {@render choice(t("attachmentLocation"), v.attachmentLocation, ATTACHMENT_LOCATIONS, (loc) =>
          settings.update({ attachmentLocation: loc as Settings["attachmentLocation"] }),
        )}

        {#if v.attachmentLocation === "folder"}
          <div class="subs" role="group" aria-label={t("attachmentLocation")}>
            {@render nameField(
              t("attachmentFolder"),
              folderInvalid,
              commitFolder,
              () => folderDraft,
              (folder) => {
                folderDraft = folder;
                folderInvalid = false;
              },
            )}
          </div>
        {/if}

        {@render toggle("confirm", t("confirmDeleteSetting"), v.confirmDelete, (on) => settings.update({ confirmDelete: on }))}

        {#if command !== null}
          {@render toggle("command", t("terminalCommand"), command, (on) => void toggleCommand(on))}
        {/if}

        {#if updater.current !== ""}
          <div class="row version">
            <span class="label">{t("version")}</span>
            <span class="version-value">{updater.current}</span>
          </div>
        {/if}
      </div>
    {:else if tab === "appearance"}
      <div class="settings">
        {@render segmented("theme", t("theme"), v.theme, THEMES, (theme) => settings.update({ theme: theme as ThemeMode }))}
        {@render segmented(
          "icons",
          t("iconTheme"),
          v.iconTheme,
          ICON_THEMES,
          (icons) => settings.update({ iconTheme: icons as IconTheme }),
          true,
        )}

        <div class="row">
          <span class="label" id="{uid}-font">{t("fontSize")}</span>
          <div class="stepper" role="group" aria-labelledby="{uid}-font">
            <button
              type="button"
              aria-label={t("ariaDecrease")}
              aria-disabled={v.fontSize <= FONT_SIZE_MIN}
              onclick={() => stepFontSize(-1)}><span aria-hidden="true">−</span></button
            >
            <span class="value" aria-live="polite">{v.fontSize}</span>
            <button
              type="button"
              aria-label={t("ariaIncrease")}
              aria-disabled={v.fontSize >= FONT_SIZE_MAX}
              onclick={() => stepFontSize(1)}><span aria-hidden="true">+</span></button
            >
          </div>
        </div>

        {@render font(t("textFont"), textFont)}
        <!-- The levels show while a heading font is chosen: with "Default", every heading is in the text font. -->
        {@render font(t("headingFont"), headingFont, headingFont.selected === "" ? undefined : headingLevels)}
        {@render font(t("codeFont"), codeFont)}
        {@render choice(t("lineWidth"), v.lineWidth, widthOptions, (w) => settings.update({ lineWidth: Number(w) }))}
        {@render toggle("title", t("inlineTitle"), v.inlineTitle, (on) => settings.update({ inlineTitle: on }))}
      </div>
    {:else}
      <ShortcutSettings />
    {/if}
  </div>
</Modal>

<style>
  /* The tabs: names, as on the rows below them, the first one's on the labels' line. */
  .tabs {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    height: 44px;
    padding: 0 10px;
    border-bottom: 1px solid var(--c-border);
  }

  .tabs button {
    height: var(--row-h);
    padding: 0 10px;
    border-radius: var(--radius-s);
    color: var(--c-text-muted);
    font-size: var(--fs-ui);
    white-space: nowrap;
    transition:
      background-color var(--dur-fast),
      color var(--dur-fast);
  }

  .tabs button:hover {
    color: var(--c-text);
  }

  .tabs button[aria-selected="true"] {
    background: var(--c-bg-active);
    color: var(--c-text-strong);
  }

  /* The open tab's page: it scrolls under the tabs when the window is short. */
  .body {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .settings {
    min-height: 0;
    overflow-y: auto;
    padding: 8px 20px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 40px;
  }

  .label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--c-text);
    font-size: var(--fs-ui);
  }

  /*
   * Sub-rows: what belongs to the row above them, hung from it like a folder's children in the
   * tree (DESIGN §4). A straight 1px line drops from under that row's label, and each sub-row
   * gets an arm at its middle, ├ or └ for the last, that stops 4px before what the row holds.
   */
  .subs > .row {
    position: relative;
    padding-left: 22px;
  }

  .subs > .row::before,
  .subs > .row:not(:last-child)::after {
    content: "";
    position: absolute;
    left: 5px;
    border-left: 1px solid var(--c-border-strong);
  }

  /* └: down to the middle of the row, then across. */
  .subs > .row::before {
    top: 0;
    bottom: calc(50% - 0.5px);
    width: 13px;
    border-bottom: 1px solid var(--c-border-strong);
  }

  /* The first one's line starts right under the label of the row above: at the foot of its
   * line (--fs-ui × --lh-ui, centered in the 40px row), 11px above that row's bottom. */
  .subs > .row:first-child::before {
    top: -11px;
  }

  /* ├: the line goes on to the next sub-row. */
  .subs > .row:not(:last-child)::after {
    top: 50%;
    bottom: 0;
  }

  .subs .label {
    color: var(--c-text-muted);
  }

  /* A heading level's sub-row: its checkbox, then its name, packed at the left. */
  .check {
    justify-content: flex-start;
    gap: 8px;
    min-height: 32px;
  }

  /* The version row: information, not a control, so it stays quiet. */
  .version .label,
  .version-value {
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
  }

  .version-value {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  /* Segmented control (theme, icon set). */
  .segmented {
    display: inline-flex;
    flex: none;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--c-border-strong);
    border-radius: var(--radius-m);
  }

  .segmented button {
    height: 22px;
    padding: 0 10px;
    border-radius: var(--radius-s);
    color: var(--c-text-muted);
    font-size: var(--fs-ui);
    transition:
      background-color var(--dur-fast),
      color var(--dur-fast);
  }

  .segmented button:hover {
    color: var(--c-text);
  }

  .segmented button[aria-checked="true"] {
    background: var(--c-bg-active);
    color: var(--c-text-strong);
  }

  /* An icon set's segment: its folder and its note, colored as in the tree (TreeRow.svelte). */
  .segmented .icons {
    display: inline-flex;
    align-items: center;
    gap: var(--tree-icon-gap);
  }

  .segmented .icons:not([aria-checked="true"]):hover {
    background: var(--c-bg-hover);
  }

  .sample {
    color: var(--c-icon-tree);
  }

  .sample.folder {
    color: var(--tree-folder);
    --icon-fill: var(--tree-folder-fill);
  }

  /* Stepper (font size). */
  .stepper {
    display: inline-flex;
    flex: none;
    align-items: center;
    height: 28px;
    border: 1px solid var(--c-border-strong);
    border-radius: var(--radius-s);
  }

  .stepper button {
    width: 28px;
    height: 100%;
    color: var(--c-text-muted);
    font-size: var(--fs-ui);
    transition:
      background-color var(--dur-fast),
      color var(--dur-fast);
  }

  .stepper button:hover {
    background: var(--c-bg-hover);
    color: var(--c-text);
  }

  .stepper button[aria-disabled="true"] {
    color: var(--c-text-faint);
    background: none;
  }

  .stepper .value {
    min-width: 28px;
    text-align: center;
    color: var(--c-text);
    font-size: var(--fs-ui);
    font-variant-numeric: tabular-nums;
  }

  /* Native select, restyled; the chevron is drawn with two borders. */
  .select {
    position: relative;
    display: inline-flex;
    flex: none;
  }

  .select select {
    width: auto;
    min-width: 150px;
    padding-right: 26px;
    appearance: none;
    -webkit-appearance: none;
    font-size: var(--fs-ui);
  }

  .select::after {
    content: "";
    position: absolute;
    top: 50%;
    right: 11px;
    width: 5px;
    height: 5px;
    border-right: 1.5px solid var(--c-text-muted);
    border-bottom: 1.5px solid var(--c-text-muted);
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
  }

  /* Switch (toggles). */
  .switch {
    position: relative;
    flex: none;
    width: 28px;
    height: 16px;
    border-radius: var(--radius-l);
    background: var(--c-border-strong);
    transition: background-color var(--dur-fast);
  }

  .switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: var(--radius-m);
    background: var(--c-bg);
    transition: transform var(--dur-fast);
  }

  .switch[aria-checked="true"] {
    background: var(--c-text-strong);
  }

  .switch[aria-checked="true"]::after {
    transform: translateX(12px);
  }

  .switch:focus-visible {
    outline-offset: 2px;
  }

  /* Checkbox (the heading levels): a task's square (markdown.css), filled when checked as a switch is when on. */
  .checkbox {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: 1px solid var(--c-border-strong);
    border-radius: calc(var(--radius-s) - 1px);
    color: var(--c-bg);
    transition:
      background-color var(--dur-fast),
      border-color var(--dur-fast);
  }

  .check:hover .checkbox:not([aria-checked="true"]) {
    border-color: var(--c-text-muted);
  }

  .checkbox[aria-checked="true"] {
    border-color: var(--c-text-strong);
    background: var(--c-text-strong);
  }

  .checkbox:focus-visible {
    outline-offset: 2px;
  }

  /* Name fields: the attachment folder, a font typed by hand. */
  .name {
    flex: none;
    width: 150px;
    font-size: var(--fs-ui);
  }

  .name.invalid {
    border-style: dashed;
    border-color: var(--c-text-muted);
  }

  @media (prefers-reduced-motion: reduce) {
    .tabs button,
    .segmented button,
    .stepper button,
    .switch,
    .switch::after,
    .checkbox {
      transition: none;
    }
  }
</style>
