/**
 * The zoom levels of the PDF view (TREE-20): the steps of Chrome's viewer, whose toolbar
 * this one follows. A zoom is a factor: 1 is 100 %, one PDF point drawn as 96/72 px.
 */

/** What the zoom buttons step through. */
export const ZOOM_STEPS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Two zooms closer than this show the same percentage. */
const EPSILON = 0.005;

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/**
 * The next step above (`dir` 1) or below (`dir` -1) `zoom`, which need not be a step
 * itself: a fitted page at 87 % zooms in to 90 % and out to 80 %. The ends stay where they are.
 */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_STEPS.find((step) => step > zoom + EPSILON) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < zoom - EPSILON) return ZOOM_STEPS[i];
  }
  return MIN_ZOOM;
}

/** "125%" for a zoom of 1.25. */
export const formatZoom = (zoom: number): string => `${Math.round(zoom * 100)}%`;

/**
 * The zoom typed into the toolbar's field: a percentage with or without its sign
 * ("150", "150 %", "62.5%"), within the limits. Null for anything else.
 */
export function parseZoom(text: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(text);
  if (!m) return null;
  const percent = Number(m[1].replace(",", "."));
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return clampZoom(percent / 100);
}

/** The page number typed into the toolbar's field, within the document. Null for anything else. */
export function parsePage(text: string, pages: number): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const page = Number(text);
  if (!Number.isSafeInteger(page) || pages < 1) return null;
  return Math.min(pages, Math.max(1, page));
}
