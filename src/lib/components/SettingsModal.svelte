<script lang="ts">
  // Settings (SET-02): one row per setting, label left and control right, no
  // descriptions. Every change applies at once through settings.update. An icon set
  // is chosen by its own folder and note, drawn instead of named (SET-08). The code
  // font is a monospaced family installed here, listed or typed by hand (SET-07).
  // The shortcuts row opens the shortcut list in the same panel (SET-06); a quiet
  // last row shows the app version.
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import ShortcutSettings from "./ShortcutSettings.svelte";
  import { FONT_SIZE_MAX, FONT_SIZE_MIN, settings } from "../state/settings.svelte";
  import { ui } from "../state/ui.svelte";
  import { updater } from "../state/updater.svelte";
  import { t } from "../i18n";
  import type { IconTheme, Settings, ThemeMode } from "../types";
  import { installedMonoFonts, monoFontProbe, sanitizeFontFamily } from "../utils/fonts";
  import { validateName } from "../utils/names";
  import { nfc } from "../utils/path";
  import { isComposing } from "../utils/platform";

  interface Option {
    value: string | number;
    label: string;
  }

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
  /** The monospaced families installed here, probed as the modal opens (SET-07). */
  const monoFonts = installedMonoFonts();
  const FONTS: Option[] = [
    { value: "", label: t("fontDefault") },
    ...monoFonts.map((name) => ({ value: name, label: name })),
    { value: CUSTOM_FONT, label: t("fontCustom") },
  ];

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

  let page = $state<"general" | "shortcuts">("general");
  let shortcutsRow: HTMLButtonElement | undefined = $state();
  let backButton: HTMLButtonElement | undefined = $state();
  let folderDraft = $state(settings.values.attachmentFolder);
  let folderInvalid = $state(false);
  /** The code font is typed by hand: chosen so in the select, or stored and not among the listed families. */
  let customFont = $state(settings.values.codeFont !== "" && !monoFonts.includes(settings.values.codeFont));
  let fontDraft = $state(settings.values.codeFont);
  let fontInvalid = $state(false);

  function stepFontSize(delta: number): void {
    const size = v.fontSize + delta;
    if (size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX) settings.update({ fontSize: size });
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

  function onFolderKeydown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitFolder(false);
    }
  }

  /** The code font select: a listed family applies at once; "Custom" opens the name field on the current one. */
  function chooseFont(value: string): void {
    fontInvalid = false;
    if (value === CUSTOM_FONT) {
      customFont = true;
      fontDraft = settings.values.codeFont;
      return;
    }
    customFont = false;
    settings.update({ codeFont: value });
  }

  /**
   * Commits the typed family, which must be installed and monospaced (SET-07); an empty
   * name is the default. A refused one toasts, and reverts when `revert` is set.
   */
  function commitFont(revert: boolean): void {
    const stored = settings.values.codeFont;
    const name = sanitizeFontFamily(fontDraft);
    if (name !== "" && name !== stored && monoFontProbe()?.(name) === false) {
      ui.notify(t("errFontNotMono", { name }));
      fontInvalid = !revert;
      if (revert) fontDraft = stored;
      return;
    }
    fontInvalid = false;
    fontDraft = name;
    if (name !== stored) settings.update({ codeFont: name });
  }

  function onFontKeydown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitFont(false);
    }
  }

  /** Switches pages; focus lands where the user can go back the same way. */
  async function show(next: typeof page): Promise<void> {
    page = next;
    await tick();
    (next === "shortcuts" ? backButton : shortcutsRow)?.focus();
  }

  // Escape or a click outside closes the modal without blurring the field first:
  // keep a valid folder or font name that was typed but not yet committed.
  $effect(() => () => {
    if (settings.values.attachmentLocation === "folder" && folderDraft !== settings.values.attachmentFolder) commitFolder(false);
    if (customFont && sanitizeFontFamily(fontDraft) !== settings.values.codeFont) commitFont(false);
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
  <label class="row">
    <span class="label" id="{uid}-{id}">{label}</span>
    <button type="button" class="switch" role="switch" aria-checked={checked} aria-labelledby="{uid}-{id}" onclick={() => set(!checked)}
    ></button>
  </label>
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

<Modal width={520} label={t("settings")} onclose={ui.closeModal}>
  {#if page === "shortcuts"}
    <div class="header">
      <button type="button" class="icon-btn" bind:this={backButton} aria-label={t("ariaBack")} onclick={() => show("general")}>
        <Icon name="chevron-left" />
      </button>
      <span class="title">{t("shortcuts")}</span>
    </div>
    <ShortcutSettings />
  {:else}
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

      {@render choice(t("codeFont"), customFont ? CUSTOM_FONT : v.codeFont, FONTS, chooseFont)}

      {#if customFont}
        <label class="row sub">
          <span class="label">{t("fontName")}</span>
          <input
            class="field name"
            class:invalid={fontInvalid}
            type="text"
            aria-invalid={fontInvalid}
            bind:value={fontDraft}
            oninput={() => (fontInvalid = false)}
            onkeydown={onFontKeydown}
            onblur={() => commitFont(true)}
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            writingsuggestions="false"
          />
        </label>
      {/if}

      {@render choice(t("lineWidth"), v.lineWidth, widthOptions, (w) => settings.update({ lineWidth: Number(w) }))}
      {@render toggle("live", t("livePreview"), v.editorMode === "live", (on) => settings.update({ editorMode: on ? "live" : "source" }))}
      {@render toggle("spellcheck", t("spellcheck"), v.spellcheck, (on) => settings.update({ spellcheck: on }))}
      {@render toggle("title", t("inlineTitle"), v.inlineTitle, (on) => settings.update({ inlineTitle: on }))}
      {@render choice(t("newNoteLocation"), v.newNoteLocation, NEW_NOTE_LOCATIONS, (loc) =>
        settings.update({ newNoteLocation: loc as Settings["newNoteLocation"] }),
      )}
      {@render choice(t("attachmentLocation"), v.attachmentLocation, ATTACHMENT_LOCATIONS, (loc) =>
        settings.update({ attachmentLocation: loc as Settings["attachmentLocation"] }),
      )}

      {#if v.attachmentLocation === "folder"}
        <label class="row sub">
          <span class="label">{t("attachmentFolder")}</span>
          <input
            class="field name"
            class:invalid={folderInvalid}
            type="text"
            aria-invalid={folderInvalid}
            bind:value={folderDraft}
            oninput={() => (folderInvalid = false)}
            onkeydown={onFolderKeydown}
            onblur={() => commitFolder(true)}
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            writingsuggestions="false"
          />
        </label>
      {/if}

      {@render toggle("confirm", t("confirmDeleteSetting"), v.confirmDelete, (on) => settings.update({ confirmDelete: on }))}

      <button type="button" class="row page" bind:this={shortcutsRow} onclick={() => show("shortcuts")}>
        <span class="label">{t("shortcuts")}</span>
        <span class="chevron"><Icon name="chevron-right" /></span>
      </button>

      {#if updater.current !== ""}
        <div class="row version">
          <span class="label">{t("version")}</span>
          <span class="version-value">{updater.current}</span>
        </div>
      {/if}
    </div>
  {/if}
</Modal>

<style>
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

  .sub .label {
    padding-left: 12px;
    color: var(--c-text-muted);
  }

  /* A row that opens a page (shortcuts): the chevron darkens like an icon button. */
  .page {
    width: 100%;
    text-align: left;
  }

  .chevron {
    flex: none;
    color: var(--c-text-faint);
    transition: color var(--dur-fast);
  }

  .page:hover .chevron,
  .page:focus-visible .chevron {
    color: var(--c-text);
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

  /* Shortcuts page header: back, then the page name. */
  .header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 44px;
    padding: 0 12px;
    border-bottom: 1px solid var(--c-border);
  }

  .title {
    color: var(--c-text-strong);
    font-size: var(--fs-ui);
    font-weight: var(--fw-strong);
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

  /* Name fields: the attachment folder, a custom code font. */
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
    .segmented button,
    .stepper button,
    .switch,
    .switch::after,
    .chevron {
      transition: none;
    }
  }
</style>
