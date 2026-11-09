/**
 * Command registry: the single source for global shortcuts and the command palette.
 * Concrete commands are registered once at startup (src/lib/appCommands.ts).
 */
import type { MessageKey } from "../i18n";
import { matchShortcut } from "../utils/keys";
import { isComposing } from "../utils/platform";
import { settings } from "./settings.svelte";

export interface Command {
  id: string;
  label: MessageKey;
  /**
   * Default shortcut specs such as "Mod-Shift-f"; the user's own replace them (SET-06).
   * The first key in effect shows in the palette.
   */
  keys?: string[];
  /** Keys that always apply and show nowhere (hardware browser keys). */
  fixedKeys?: string[];
  /** Left out of the shortcut settings, so its keys never change (key guards, macOS's menu-only Quit). */
  fixed?: boolean;
  run: () => void | Promise<void>;
  /** Availability check (e.g. "a note is open"); unavailable commands are hidden and inert. */
  when?: () => boolean;
  /** Hide from the palette (still reachable by shortcut). */
  hidden?: boolean;
  /** Fire even while focus is inside a text input/textarea (default true for Mod-combos). */
  inInputs?: boolean;
}

function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return false; // the CodeMirror editor: global shortcuts still apply
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

class CommandRegistry {
  list = $state.raw<Command[]>([]);
  /**
   * True while the shortcut settings record a key: the window-level handler then leaves
   * every key to the recorder, which cancels each one itself.
   */
  paused = false;

  /** The keys `cmd` answers to besides its fixed ones: the user's (SET-06), else its defaults. */
  keysOf = (cmd: Command): readonly string[] => (cmd.fixed ? undefined : settings.values.shortcuts[cmd.id]) ?? cmd.keys ?? [];

  matches = (cmd: Command, e: KeyboardEvent): boolean =>
    this.keysOf(cmd).some((k) => matchShortcut(e, k)) || (cmd.fixedKeys?.some((k) => matchShortcut(e, k)) ?? false);

  register = (cmds: Command[]): void => {
    const ids = new Set(cmds.map((c) => c.id));
    this.list = [...this.list.filter((c) => !ids.has(c.id)), ...cmds];
  };

  available = (): Command[] => this.list.filter((c) => !c.hidden && (!c.when || c.when()));

  run = async (id: string): Promise<void> => {
    const cmd = this.list.find((c) => c.id === id);
    if (!cmd || (cmd.when && !cmd.when())) return;
    await cmd.run();
  };

  /** Window-level capturing keydown handler. Returns true when a command handled the event. */
  handleKeydown = (e: KeyboardEvent): boolean => {
    if (isComposing(e) || e.repeat) return false;
    const inInput = isTextInput(e.target);
    for (const cmd of this.list) {
      if (!this.matches(cmd, e)) continue;
      if (inInput && cmd.inInputs === false) continue;
      if (cmd.when && !cmd.when()) continue;
      e.preventDefault();
      e.stopPropagation();
      void cmd.run();
      return true;
    }
    return false;
  };
}

export const commands = new CommandRegistry();
