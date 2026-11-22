/**
 * PDF.js, fetched when the first PDF is opened and kept for the session (ARCHITECTURE §10.5).
 *
 * The `legacy` builds carry the polyfills the modern ones leave out; WKWebView and WebKitGTK
 * lag behind the engines those are written for. The viewer bundle reads the library from
 * `globalThis.pdfjsLib` while it is evaluated, so the library is imported first.
 */
import type * as PdfLib from "pdfjs-dist";
import type * as PdfViewerLib from "pdfjs-dist/web/pdf_viewer.mjs";
// The worker is published as it is, a file of its own: PDF.js starts it as a module worker.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export interface PdfEngine {
  lib: typeof PdfLib;
  viewer: typeof PdfViewerLib;
}

let engine: Promise<PdfEngine> | null = null;

/** Never loads twice; a failed load is tried again by the next call. */
export function loadPdfEngine(): Promise<PdfEngine> {
  if (engine) return engine;
  const loading = (async (): Promise<PdfEngine> => {
    const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    const viewer = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
    return { lib, viewer };
  })();
  engine = loading;
  loading.catch(() => {
    if (engine === loading) engine = null;
  });
  return loading;
}

/**
 * The folder `name` of the files PDF.js fetches while it reads a document, with the
 * trailing slash it asks for. `vite.config.ts › pdfAssets` serves and publishes them.
 */
export const pdfAssetUrl = (name: "cmaps" | "standard_fonts" | "wasm" | "iccs" | "images"): string =>
  new URL(`pdfjs/${name}/`, document.baseURI).href;
