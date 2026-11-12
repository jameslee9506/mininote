<script module lang="ts">
  export type IconName =
    | "chevron-right"
    | "chevron-left"
    | "note-plus"
    | "folder-plus"
    | "folder"
    | "folder-open"
    | "note"
    | "image"
    | "file"
    | "search"
    | "settings"
    | "sidebar"
    | "arrow-left"
    | "arrow-right"
    | "book"
    | "pencil"
    | "close"
    | "more"
    | "check"
    | "lock"
    | "collapse"
    | "plus"
    | "reset"
    | "download"
    | "restart";
</script>

<script lang="ts">
  // Minimal 16×16 stroke icon set (1.5px, currentColor). Purely decorative:
  // the interactive parent carries the aria-label.
  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === "chevron-right"}
    <path d="M6.5 4.5 10 8l-3.5 3.5" />
  {:else if name === "chevron-left"}
    <path d="M9.5 4.5 6 8l3.5 3.5" />
  {:else if name === "note-plus"}
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6Z" />
    <path d="M9 2v4h4" />
    <path d="M8 8.25v3.5M6.25 10h3.5" />
  {:else if name === "folder-plus"}
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" />
    <path d="M8 7v3.5M6.25 8.75h3.5" />
  {:else if name === "folder"}
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" />
  {:else if name === "folder-open"}
    <path d="M2 13V4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v1" />
    <path d="M4 7h10.5l-2 6H2Z" />
  {:else if name === "note"}
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6Z" />
    <path d="M9 2v4h4" />
    <path d="M6 8.75h4M6 11.25h4" />
  {:else if name === "image"}
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <circle cx="6" cy="6" r="1.25" />
    <path d="m13.5 10-2.5-2.5-6 6" />
  {:else if name === "file"}
    <!-- The note's page without its lines: any other file (TREE-16). -->
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6Z" />
    <path d="M9 2v4h4" />
  {:else if name === "search"}
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  {:else if name === "settings"}
    <path d="M2.5 4.5h6.5M12 4.5h1.5M2.5 11.5h1.5M7 11.5h6.5" />
    <circle cx="10.5" cy="4.5" r="1.5" />
    <circle cx="5.5" cy="11.5" r="1.5" />
  {:else if name === "sidebar"}
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6.25 3v10" />
  {:else if name === "arrow-left"}
    <path d="M13 8H3M7 4 3 8l4 4" />
  {:else if name === "arrow-right"}
    <path d="M3 8h10M9 4l4 4-4 4" />
  {:else if name === "book"}
    <path d="M2 3.5h4A2 2 0 0 1 8 5.5V13a1.5 1.5 0 0 0-1.5-1.5H2Z" />
    <path d="M14 3.5h-4A2 2 0 0 0 8 5.5V13a1.5 1.5 0 0 1 1.5-1.5H14Z" />
  {:else if name === "pencil"}
    <path d="m10.5 2.5 3 3L6 13H3v-3Z" />
    <path d="m9 4 3 3" />
  {:else if name === "close"}
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  {:else if name === "more"}
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  {:else if name === "check"}
    <path d="m3.5 8.5 3 3 6-7" />
  {:else if name === "lock"}
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  {:else if name === "collapse"}
    <!-- Two chevrons pointing at each other: fold everything up. -->
    <path d="m5 2.75 3 3 3-3M5 13.25l3-3 3 3" />
  {:else if name === "plus"}
    <path d="M8 3.5v9M3.5 8h9" />
  {:else if name === "reset"}
    <!-- A counter-clockwise arrow: back to the default. -->
    <path d="M2.5 8a5.5 5.5 0 1 0 5.5-5.5 6 6 0 0 0-4.12 1.68L2.5 5.5" />
    <path d="M2.5 2.5v3h3" />
  {:else if name === "download"}
    <!-- An arrow into a tray: an update to fetch. -->
    <path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7" />
    <path d="M3 11v1.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V11" />
  {:else if name === "restart"}
    <!-- A clockwise arrow, the mirror of reset: quit and come back. -->
    <path d="M13.5 8a5.5 5.5 0 1 1-5.5-5.5 6 6 0 0 1 4.12 1.68L13.5 5.5" />
    <path d="M13.5 2.5v3h-3" />
  {/if}
</svg>

<style>
  .icon {
    display: block;
    flex: none;
  }
</style>
