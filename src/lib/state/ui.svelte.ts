/** Transient UI state: panels, modals, menus, confirmations, toasts, focus requests. */
import { t } from "../i18n";
import { settings } from "./settings.svelte";

export type ModalKind = "switcher" | "palette" | "settings" | null;

export type MenuEntry =
  | { label: string; run: () => void | Promise<void>; disabled?: boolean }
  | { separator: true };

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
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
  /** The sidebar's search field. While it holds a query, the results stand in for the file tree. */
  searchQuery = $state("");

  /** Focus requests: components watch these counters and focus themselves when they change. */
  searchFocusTick = $state(0);
  titleFocusTick = $state(0);
  /** How the latest title request wants the text: all selected (F2) or the caret at the end (↑ from the body). */
  titleFocusSelect = $state(true);
  treeFocusTick = $state(0);

  /** The sidebar shows search results instead of the tree. */
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

  showMenu = (x: number, y: number, items: MenuEntry[]): void => {
    this.menu = { x, y, items };
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

  /** Shows the file tree: the search field is cleared, so the results give way to it. */
  showFiles = (): void => {
    this.searchQuery = "";
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
}

export const ui = new UiStore();
