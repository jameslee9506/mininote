/** Transient UI state: panels, modals, menus, confirmations, toasts, focus requests. */
import type { IconName } from "../components/Icon.svelte";
import { t } from "../i18n";
import { settings } from "./settings.svelte";

export type ModalKind = "switcher" | "palette" | "settings" | null;

/** A menu item that acts when it is chosen. */
export interface MenuAction {
  label: string;
  run: () => void | Promise<void>;
  disabled?: boolean;
}

/**
 * A second action on what an item names: a small icon button at the item's far edge, there while
 * the item is highlighted (the × of a recent vault, VAULT-05). The menu stays open under it:
 * `run` shows the menu again as it now is, or hides it.
 */
export interface MenuSideAction {
  icon: IconName;
  /** The button's `aria-label`: it shows no text. */
  label: string;
  run: () => void | Promise<void>;
}

/** An action, an item that opens a second panel of actions beside it (one level deep), or a separator. */
export type MenuEntry =
  | (MenuAction & { icon?: IconName; side?: MenuSideAction })
  | { label: string; submenu: MenuAction[] }
  | { separator: true };

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
  /** The element whose click opened the menu, which another click on it closes (ContextMenu leaves it alone). */
  anchor?: HTMLElement;
}

export interface ConfirmState {
  message: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

export interface Toast {
  id: number;
  message: string;
}

const TOAST_MS = 4000;
let toastSeq = 0;

class UiStore {
  modal = $state<ModalKind>(null);
  menu = $state<MenuState | null>(null);
  confirmDialog = $state<ConfirmState | null>(null);
  toasts = $state<Toast[]>([]);
  /** The sidebar's search field. While it holds a query, the results stand in for the list under it. */
  searchQuery = $state("");
  /**
   * The sidebar lists the notes changed last where the file tree stands (NAV-10): the header's
   * toggle. It lasts while the window does, and is not kept between runs.
   */
  recentShown = $state(false);

  /** Focus requests: components watch these counters and focus themselves when they change. */
  searchFocusTick = $state(0);
  titleFocusTick = $state(0);
  /** How the latest title request wants the text: all selected (F2) or the caret at the end (↑ from the body). */
  titleFocusSelect = $state(true);
  treeFocusTick = $state(0);
  /** A softer request than `treeFocusTick`: only a tree that is on screen takes the keyboard, and not from a field of the sidebar or an overlay. */
  treeRestTick = $state(0);
  recentFocusTick = $state(0);

  /** The sidebar shows search results instead of the file tree or the recent list. */
  get searching(): boolean {
    return this.searchQuery.trim() !== "";
  }

  openModal = (m: Exclude<ModalKind, null>): void => {
    this.menu = null;
    this.modal = m;
  };

  closeModal = (): void => {
    this.modal = null;
  };

  showMenu = (x: number, y: number, items: MenuEntry[], anchor?: HTMLElement): void => {
    this.menu = { x, y, items, anchor };
  };

  hideMenu = (): void => {
    this.menu = null;
  };

  /** Resolves true when the user confirms. Only one dialog at a time; a new one cancels the old. */
  confirm = (message: string, confirmLabel: string = t("delete")): Promise<boolean> => {
    this.confirmDialog?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.confirmDialog = {
        message,
        confirmLabel,
        resolve: (ok) => {
          this.confirmDialog = null;
          resolve(ok);
        },
      };
    });
  };

  /** Error notices only — the UI never announces success. */
  notify = (message: string): void => {
    const id = ++toastSeq;
    this.toasts = [...this.toasts, { id, message }];
    setTimeout(() => this.dismiss(id), TOAST_MS);
  };

  dismiss = (id: number): void => {
    this.toasts = this.toasts.filter((x) => x.id !== id);
  };

  /** Focuses the sidebar's search field, with `query` in it when given (SRCH-01). */
  showSearch = (query?: string): void => {
    if (!settings.values.sidebarVisible) settings.update({ sidebarVisible: true });
    if (query !== undefined && query !== "") this.searchQuery = query;
    this.searchFocusTick++;
  };

  /** Shows the file tree: the search field is cleared and the recent list closed, so both give way to it. */
  showFiles = (): void => {
    this.searchQuery = "";
    this.recentShown = false;
  };

  /**
   * The header's toggle (NAV-10): the notes changed last take the file tree's place, or give it
   * back. The list that shows takes the keyboard, and a search in progress gives way to it.
   */
  toggleRecent = (): void => {
    this.recentShown = !this.recentShown;
    this.focusList();
  };

  toggleSidebar = (): void => {
    settings.update({ sidebarVisible: !settings.values.sidebarVisible });
  };

  /**
   * Focuses the inline title. `select: false` puts the caret at the end instead of
   * selecting everything, so the next keystroke cannot replace (and rename) the title.
   */
  focusTitle = (opts?: { select?: boolean }): void => {
    this.titleFocusSelect = opts?.select ?? true;
    this.titleFocusTick++;
  };

  focusTree = (): void => {
    if (!settings.values.sidebarVisible) settings.update({ sidebarVisible: true });
    this.showFiles();
    this.treeFocusTick++;
  };

  /**
   * Gives the keyboard to the list under the search field, the file tree or the recent list
   * (NAV-10), whichever the sidebar has there. The search field is cleared, so its results
   * give way to that list.
   */
  focusList = (): void => {
    if (!this.recentShown) {
      this.focusTree();
      return;
    }
    if (!settings.values.sidebarVisible) settings.update({ sidebarVisible: true });
    this.searchQuery = "";
    this.recentFocusTick++;
  };

  /**
   * The main area lost what had the keyboard (its file is gone): the tree takes it, where the
   * arrows go on and the undo key takes the removal back (TREE-21). Nothing changes when the
   * tree is not on screen, or while a field of the sidebar or an overlay has the keyboard.
   */
  restInTree = (): void => {
    this.treeRestTick++;
  };
}

export const ui = new UiStore();
