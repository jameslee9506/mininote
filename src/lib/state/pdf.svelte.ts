/**
 * The PDF view (TREE-20, ARCHITECTURE §10.5): what its toolbar and panels show, and the
 * PDF.js objects behind them. `PdfView.svelte` hands over its scroll container when it
 * mounts and takes it back when it goes; everything in between is asked of this store,
 * by the toolbar in the main strip as by the keys.
 *
 * PDF.js objects never live in `$state`: a session holds them, and the reactive fields
 * only mirror what its events report.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { untrack } from "svelte";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { t } from "../i18n";
import { binaryRead, currentEpoch, isIpcError } from "../ipc/commands";
import { loadPdfEngine, pdfAssetUrl, type PdfEngine } from "../pdf/engine";
import { clampZoom, stepZoom } from "../pdf/zoom";
import type { VaultPath } from "../types";
import { basename, nfc } from "../utils/path";
import { ui } from "./ui.svelte";

/** `loading` covers the read and the parse; `password` waits for one; `failed` shows nothing but said why. */
export type PdfPhase = "idle" | "loading" | "password" | "ready" | "failed";
/** A zoom that follows the pane: PDF.js's default, the page's width, the whole page. */
export type PdfFit = "auto" | "page-width" | "page-fit";
export type PdfPanel = "thumbnails" | "outline";

/** An entry of the document's outline (its bookmarks). */
export interface PdfOutlineItem {
  title: string;
  /** Where it leads inside the document: a named or an explicit destination. */
  dest: string | unknown[] | null;
  /** Where it leads outside of it. */
  url: string | null;
  items: PdfOutlineItem[];
}

/** Where a PDF was left: reopened in this session, it shows the same place again. */
interface PdfPlace {
  page: number;
  /** The view's top-left corner on that page, in PDF points. */
  left: number;
  top: number;
  /** A zoom factor as text, or a fit. */
  zoom: string;
  rotation: number;
}

interface Session {
  path: VaultPath;
  /** The vault epoch and the path: what `#places` is keyed by. */
  key: string;
  container: HTMLDivElement;
  /** Ends every listener and observer of the session, PDF.js's own included. */
  abort: AbortController;
  /** The place to show first, read before PDF.js reports any of its own. */
  restore: PdfPlace | null;
  engine: PdfEngine | null;
  task: PDFDocumentLoadingTask | null;
  doc: PDFDocumentProxy | null;
  viewer: PDFViewer | null;
  eventBus: EventBus | null;
  links: PDFLinkService | null;
  /** Answers PDF.js's request for a password. */
  password: ((password: string) => void) | null;
  /** What a pinch asked for beyond the zoom it got: zooms move in steps of 1 %. */
  pinch: number;
}

/** The outline as PDF.js gives it. */
interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineNode[];
}

const FITS: readonly string[] = ["auto", "page-width", "page-fit"] satisfies PdfFit[];
const fitOf = (value: string | null | undefined): PdfFit | null => (value != null && FITS.includes(value) ? (value as PdfFit) : null);

/** The schemes that leave the app, as for a note's links (LINK-01). */
const EXTERNAL_HREF = /^(https?:|mailto:|tel:)/i;
/** PDFs whose place is remembered. */
const MAX_PLACES = 100;
/** While a pinch or a wheel zooms, pages are stretched and drawn anew only after this pause (ms). */
const ZOOM_REDRAW_MS = 400;
/** One notch of a wheel held with Ctrl. */
const WHEEL_STEP = 1.1;
/** A thumbnail's backing store is at most this many device pixels per CSS pixel. */
const THUMBNAIL_MAX_RATIO = 2;

const toOutline = (nodes: readonly OutlineNode[]): PdfOutlineItem[] =>
  nodes.map((n) => ({
    title: n.title,
    dest: n.dest ?? null,
    url: n.url ?? null,
    items: toOutline(n.items ?? []),
  }));

class PdfStore {
  phase = $state<PdfPhase>("idle");
  pages = $state(0);
  /** The page the view is on, from 1. */
  page = $state(1);
  /** The zoom as a factor: 1 is 100 %. */
  zoom = $state(1);
  /** The fit the zoom follows as the pane changes its size; null for a zoom of its own. */
  fit = $state<PdfFit | null>(null);
  /** By how many degrees the pages are turned: 0, 90, 180 or 270. */
  rotation = $state(0);
  /** Width over height of the first page, turned as the pages are: a thumbnail's shape until its own page is read. */
  aspect = $state(0.707);
  outline = $state.raw<readonly PdfOutlineItem[]>([]);
  /** The side panel, kept from one PDF to the next. */
  panelOpen = $state(false);
  panel = $state<PdfPanel>("thumbnails");
  /** The password given last was refused. */
  wrongPassword = $state(false);

  findOpen = $state(false);
  findQuery = $state("");
  /** The match shown, from 1, and how many there are; 0 while there is none. */
  findCurrent = $state(0);
  findTotal = $state(0);
  /** The query is nowhere in the document. */
  findMissed = $state(false);
  /** Grows whenever the find field should take the keyboard and select its text. */
  findFocus = $state(0);

  #session: Session | null = null;
  #places = new Map<string, PdfPlace>();

  // ── Opening and closing ──────────────────────────────────────────────────

  /** Shows the PDF at `path` in `container`, whose first child is the element PDF.js fills with pages. */
  open = (path: VaultPath, container: HTMLDivElement): void =>
    untrack(() => {
      void this.#open(path, container);
    });

  /**
   * Lets the open PDF go; its place stays remembered for this session. With `container`, only
   * the PDF shown in that element is let go: a view that leaves after its successor arrived
   * must not close the successor's document.
   */
  close = (container?: HTMLDivElement): void =>
    untrack(() => {
      const session = this.#session;
      if (container !== undefined && session?.container !== container) return;
      this.#session = null;
      if (session) this.#dispose(session);
      this.phase = "idle";
      this.pages = 0;
      this.page = 1;
      this.zoom = 1;
      this.fit = null;
      this.rotation = 0;
      this.outline = [];
      this.wrongPassword = false;
      this.findOpen = false;
      this.findQuery = "";
      this.findCurrent = this.findTotal = 0;
      this.findMissed = false;
    });

  async #open(path: VaultPath, container: HTMLDivElement): Promise<void> {
    this.close();
    const epoch = currentEpoch();
    const key = `${epoch}\n${path}`;
    const session: Session = {
      path,
      key,
      container,
      abort: new AbortController(),
      restore: this.#places.get(key) ?? null,
      engine: null,
      task: null,
      doc: null,
      viewer: null,
      eventBus: null,
      links: null,
      password: null,
      pinch: 1,
    };
    this.#session = session;
    this.phase = "loading";
    try {
      const [engine, data] = await Promise.all([loadPdfEngine(), binaryRead(path, epoch)]);
      if (this.#session !== session) return;
      session.engine = engine;
      // PDF.js takes the bytes over: they move to its worker and are not kept here.
      const task = engine.lib.getDocument({
        data,
        cMapUrl: pdfAssetUrl("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: pdfAssetUrl("standard_fonts"),
        wasmUrl: pdfAssetUrl("wasm"),
        iccUrl: pdfAssetUrl("iccs"),
      });
      session.task = task;
      task.onPassword = (answer: (password: string) => void, reason: number) => {
        if (this.#session !== session) return;
        session.password = answer;
        this.wrongPassword = reason === engine.lib.PasswordResponses.INCORRECT_PASSWORD;
        this.phase = "password";
      };
      const doc = await task.promise;
      if (this.#session !== session) return; // closed meanwhile: `#dispose` destroyed the task
      session.doc = doc;
      session.password = null;
      this.#show(session, engine, doc);
    } catch (e) {
      if (this.#session === session) this.#failed(session, e);
    }
  }

  /** One toast says why; the view then shows only that there is nothing to see. */
  #failed(session: Session, e: unknown): void {
    this.#dispose(session);
    this.phase = "failed";
    if (isIpcError(e, "no_vault")) return; // the vault was switched under the read
    console.error("pdf: open failed", e);
    const name = nfc(basename(session.path));
    ui.notify(isIpcError(e, "too_large") ? t("errTooLarge", { name }) : t("errOpen", { name }));
  }

  /**
   * Ends a session. The pages go first: PDF.js keeps one set of selection listeners for all
   * text layers, and only a text layer that is cancelled lets go of them.
   */
  #dispose(session: Session): void {
    try {
      session.viewer?.setDocument(null);
    } catch (e) {
      console.error("pdf: closing the view failed", e);
    }
    session.abort.abort();
    session.password = null;
    const task = session.task;
    session.task = null;
    session.doc = null;
    session.viewer = null;
    session.eventBus = null;
    session.links = null;
    void task?.destroy().catch(() => {});
  }

  /** Builds PDF.js's viewer over the loaded document. */
  #show(session: Session, engine: PdfEngine, doc: PDFDocumentProxy): void {
    const { lib, viewer: web } = engine;
    const { container } = session;
    const { signal } = session.abort;
    const live = (): boolean => this.#session === session;

    const eventBus = new web.EventBus();
    const links = new web.PDFLinkService({ eventBus, externalLinkTarget: web.LinkTarget.BLANK });
    const findController = new web.PDFFindController({ eventBus, linkService: links });
    // `abortSignal` is read by the viewer and missing from its declared options.
    const options = {
      container,
      eventBus,
      linkService: links,
      findController,
      // Form fields are drawn as the document has them, and nothing is edited or scripted.
      annotationMode: lib.AnnotationMode.ENABLE,
      annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      // The engine's own selection: the text layer's `::selection` (pdf.css).
      enableSelectionRendering: false,
      imageResourcesPath: pdfAssetUrl("images"),
      abortSignal: signal,
    };
    const viewer = new web.PDFViewer(options);
    links.setViewer(viewer);
    session.viewer = viewer;
    session.eventBus = eventBus;
    session.links = links;

    eventBus.on("pagesinit", () => {
      if (live()) this.#restore(session, viewer);
    });
    eventBus.on("pagechanging", (e: { pageNumber: number }) => {
      if (live()) this.page = e.pageNumber;
    });
    eventBus.on("scalechanging", (e: { scale: number }) => {
      if (!live()) return;
      this.zoom = e.scale;
      this.fit = fitOf(viewer.currentScaleValue);
    });
    eventBus.on("rotationchanging", (e: { pagesRotation: number }) => {
      if (!live()) return;
      this.rotation = e.pagesRotation;
      void this.#measure(session, doc);
    });
    eventBus.on("updateviewarea", (e: { location?: { pageNumber: number; left: number; top: number; rotation: number } | null }) => {
      const at = e.location;
      if (!live() || !at) return;
      this.#remember(session.key, {
        page: at.pageNumber,
        left: at.left,
        top: at.top,
        zoom: viewer.currentScaleValue ?? "auto",
        rotation: at.rotation,
      });
    });
    const onMatches = (count: { current: number; total: number } | undefined): void => {
      this.findCurrent = count?.current ?? 0;
      this.findTotal = count?.total ?? 0;
    };
    eventBus.on("updatefindmatchescount", (e: { matchesCount?: { current: number; total: number } }) => {
      if (live()) onMatches(e.matchesCount);
    });
    eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount?: { current: number; total: number } }) => {
      if (!live()) return;
      onMatches(e.matchesCount);
      if (e.state !== web.FindState.PENDING) this.findMissed = e.state === web.FindState.NOT_FOUND && this.findQuery !== "";
    });

    viewer.setDocument(doc);
    links.setDocument(doc, null);
    this.pages = doc.numPages;
    this.page = 1;
    this.phase = "ready";
    void this.#measure(session, doc);
    doc.getOutline().then(
      (nodes: OutlineNode[] | null) => {
        if (live()) this.outline = toOutline(nodes ?? []);
      },
      () => {},
    );

    // A fit follows the pane (the window, the sidebar, the panel); PDF.js itself only watches its height.
    const resized = new ResizeObserver(() => {
      // Nothing to lay out before the pages exist, or while the pane is not shown.
      if (!live() || viewer.pagesCount === 0 || container.clientWidth === 0 || container.clientHeight === 0) return;
      const fit = fitOf(viewer.currentScaleValue);
      if (fit !== null) viewer.currentScaleValue = fit;
      viewer.update();
    });
    resized.observe(container);
    signal.addEventListener("abort", () => resized.disconnect(), { once: true });

    this.#listenForZoom(session, viewer);
    // The keys of the view work at once, unless the keyboard is somewhere it should stay (the tree, a field).
    const active = document.activeElement;
    if (active === null || active === document.body) container.focus({ preventScroll: true });
  }

  /** The first page's shape, as the pages are turned now. */
  async #measure(session: Session, doc: PDFDocumentProxy): Promise<void> {
    try {
      const first = await doc.getPage(1);
      if (this.#session !== session || !session.viewer) return;
      const box = first.getViewport({ scale: 1, rotation: (first.rotate + session.viewer.pagesRotation) % 360 });
      if (box.width > 0 && box.height > 0) this.aspect = box.width / box.height;
    } catch {
      // The viewer reports a page it cannot read; the thumbnails keep the default shape.
    }
  }

  /** The first view of a document: where it was left in this session, else its first page at the default zoom. */
  #restore(session: Session, viewer: PDFViewer): void {
    const place = session.restore;
    session.restore = null;
    if (!place) {
      viewer.currentScaleValue = "auto";
      return;
    }
    if (place.rotation !== 0) viewer.pagesRotation = place.rotation;
    viewer.currentScaleValue = place.zoom;
    viewer.scrollPageIntoView({
      pageNumber: Math.min(Math.max(1, place.page), viewer.pagesCount),
      destArray: [null, { name: "XYZ" }, place.left, place.top, null],
      allowNegativeOffset: true,
    });
  }

  #remember(key: string, place: PdfPlace): void {
    this.#places.delete(key);
    this.#places.set(key, place);
    if (this.#places.size > MAX_PLACES) {
      const oldest = this.#places.keys().next();
      if (!oldest.done) this.#places.delete(oldest.value);
    }
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  #viewer(): PDFViewer | null {
    return this.phase === "ready" ? (this.#session?.viewer ?? null) : null;
  }

  goToPage = (page: number): void => {
    const viewer = this.#viewer();
    if (!viewer || !Number.isFinite(page)) return;
    viewer.currentPageNumber = Math.min(viewer.pagesCount, Math.max(1, Math.trunc(page)));
  };

  nextPage = (): void => void this.#viewer()?.nextPage();

  previousPage = (): void => void this.#viewer()?.previousPage();

  /** Turns every page a quarter counter-clockwise, as Chrome's button does. Nothing is written to the file. */
  rotate = (): void => {
    const viewer = this.#viewer();
    if (viewer) viewer.pagesRotation = (viewer.pagesRotation + 270) % 360;
  };

  // ── Zoom ─────────────────────────────────────────────────────────────────

  zoomIn = (): void => {
    const viewer = this.#viewer();
    if (viewer) this.#zoomTo(viewer, stepZoom(viewer.currentScale, 1));
  };

  zoomOut = (): void => {
    const viewer = this.#viewer();
    if (viewer) this.#zoomTo(viewer, stepZoom(viewer.currentScale, -1));
  };

  /** A zoom of its own, as typed into the toolbar: a factor. */
  setZoom = (zoom: number): void => {
    const viewer = this.#viewer();
    if (viewer && Number.isFinite(zoom)) this.#zoomTo(viewer, zoom);
  };

  setFit = (fit: PdfFit): void => {
    const viewer = this.#viewer();
    if (viewer) viewer.currentScaleValue = fit;
  };

  /** Chrome's one fit button: the whole page, then its width, and back. */
  toggleFit = (): void => this.setFit(this.fit === "page-fit" ? "page-width" : "page-fit");

  /** Zooms around the middle of the pane, so the text being read stays there. */
  #zoomTo(viewer: PDFViewer, zoom: number): void {
    const session = this.#session;
    if (!session) return;
    const { container } = session;
    const middle: [number, number] = [container.offsetLeft + container.clientWidth / 2, container.offsetTop + container.clientHeight / 2];
    this.#scaleTo(viewer, zoom, middle, -1);
  }

  /**
   * Sets the zoom to `zoom` with the point `origin` held in place. `origin` is measured like
   * the container's own `offsetLeft` and `offsetTop`, which is what PDF.js subtracts from it.
   */
  #scaleTo(viewer: PDFViewer, zoom: number, origin: [number, number], drawingDelay: number): void {
    const from = viewer.currentScale;
    const to = clampZoom(zoom);
    if (Math.round(to * 100) === Math.round(from * 100)) {
      // The same zoom, but no longer a fit that follows the pane. PDF.js reports no change of scale for it.
      if (fitOf(viewer.currentScaleValue) !== null) {
        viewer.currentScaleValue = String(from);
        this.fit = null;
      }
      return;
    }
    viewer.updateScale({ scaleFactor: to / from, origin, drawingDelay });
  }

  /**
   * Ctrl+wheel, and the pinch of a trackpad: Chromium sends a pinch as Ctrl+wheel with small
   * deltas, WebKit as its own gesture events. Both zoom around the pointer.
   */
  #listenForZoom(session: Session, viewer: PDFViewer): void {
    const { container } = session;
    const { signal } = session.abort;
    const at = (clientX: number, clientY: number): [number, number] => {
      const box = container.getBoundingClientRect();
      return [clientX - box.left + container.offsetLeft, clientY - box.top + container.offsetTop];
    };
    /** Zooms by `factor`, carrying over what is too little to show yet: the zoom moves in whole percents. */
    const zoomBy = (factor: number, origin: [number, number]): void => {
      if (this.#session !== session || !(factor > 0)) return;
      const from = viewer.currentScale;
      session.pinch *= factor;
      const wanted = from * session.pinch;
      const to = clampZoom(Math.round(wanted * 100) / 100);
      if (Math.round(to * 100) === Math.round(from * 100)) {
        // At a limit nothing is owed: the next move the other way zooms at once.
        if (wanted !== clampZoom(wanted)) session.pinch = 1;
        return;
      }
      session.pinch = wanted / to;
      this.#scaleTo(viewer, to, origin, ZOOM_REDRAW_MS);
    };

    container.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey || e.deltaY === 0) return;
        e.preventDefault();
        const smooth = Math.exp(-e.deltaY / 100);
        const pinch = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && e.deltaX === 0 && Math.abs(smooth - 1) < 0.05;
        zoomBy(pinch ? smooth : e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, at(e.clientX, e.clientY));
      },
      { signal, passive: false },
    );

    // WebKit (WKWebView, WebKitGTK): `scale` is the whole gesture's, so each event zooms by its change.
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    let seen = 1;
    container.addEventListener(
      "gesturestart",
      (e) => {
        e.preventDefault();
        seen = 1;
      },
      { signal },
    );
    container.addEventListener(
      "gesturechange",
      (e) => {
        e.preventDefault();
        const g = e as Gesture;
        if (!(g.scale > 0)) return;
        zoomBy(g.scale / seen, at(g.clientX, g.clientY));
        seen = g.scale;
      },
      { signal },
    );
    container.addEventListener("gestureend", (e) => e.preventDefault(), { signal });
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  togglePanel = (): void => {
    this.panelOpen = !this.panelOpen;
  };

  /** Follows an outline entry. */
  goToOutline = (item: PdfOutlineItem): void => {
    const links = this.#session?.links;
    if (this.phase !== "ready" || !links) return;
    if (item.dest !== null) void links.goToDestination(item.dest).catch((e: unknown) => console.error("pdf: outline entry failed", e));
    else if (item.url !== null && EXTERNAL_HREF.test(item.url)) openUrl(item.url).catch((e) => console.error("open url failed", e));
  };

  /**
   * Draws page `page` into `canvas`, `width` CSS pixels wide, and resolves with the page's
   * width over its height; null when it could not be drawn, or the document is no longer shown.
   */
  drawThumbnail = async (page: number, canvas: HTMLCanvasElement, width: number): Promise<number | null> => {
    const session = this.#session;
    const doc = session?.doc;
    const viewer = session?.viewer;
    if (!session || !doc || !viewer) return null;
    try {
      const pdfPage = await doc.getPage(page);
      if (this.#session !== session) return null;
      const rotation = (pdfPage.rotate + viewer.pagesRotation) % 360;
      const box = pdfPage.getViewport({ scale: 1, rotation });
      if (!(box.width > 0 && box.height > 0)) return null;
      const ratio = Math.min(window.devicePixelRatio || 1, THUMBNAIL_MAX_RATIO);
      const viewport = pdfPage.getViewport({ scale: (width * ratio) / box.width, rotation });
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      await pdfPage.render({ canvas, viewport }).promise;
      if (this.#session !== session) return null;
      // The viewer frees what a page keeps for drawing, unless one of its own views still uses it.
      session.eventBus?.dispatch("thumbnailrendered", { source: this, pageNumber: page, pdfPage });
      return box.width / box.height;
    } catch (e) {
      if (this.#session === session) console.error("pdf: thumbnail failed", e);
      return null;
    }
  };

  // ── Password ─────────────────────────────────────────────────────────────

  submitPassword = (password: string): void => {
    const session = this.#session;
    const answer = session?.password;
    if (this.phase !== "password" || !session || !answer) return;
    session.password = null;
    this.phase = "loading";
    answer(password);
  };

  // ── Find ─────────────────────────────────────────────────────────────────

  /** Shows the find bar and gives it the keyboard; a query left in it finds again. */
  openFind = (): void => {
    if (this.phase !== "ready") return;
    const reopened = !this.findOpen;
    this.findOpen = true;
    this.findFocus++;
    if (reopened && this.findQuery !== "") this.#find("");
  };

  closeFind = (): void => {
    if (!this.findOpen) return;
    this.findOpen = false;
    const session = this.#session;
    session?.eventBus?.dispatch("findbarclose", { source: this });
    session?.container.focus({ preventScroll: true });
  };

  setFindQuery = (query: string): void => {
    this.findQuery = query;
    if (query === "") {
      this.findCurrent = this.findTotal = 0;
      this.findMissed = false;
    }
    this.#find("");
  };

  findNext = (): void => this.#findAgain(false);

  findPrevious = (): void => this.#findAgain(true);

  /** The next or the previous match of the query; with the bar closed, the key that asks opens it first. */
  #findAgain(previous: boolean): void {
    if (!this.findOpen) this.openFind();
    else if (this.findQuery !== "") this.#find("again", previous);
  }

  /** `type` "" is a changed query, which PDF.js debounces; "again" moves to the next or the previous match. */
  #find(type: "" | "again", previous = false): void {
    const eventBus = this.#session?.eventBus;
    if (this.phase !== "ready" || !eventBus) return;
    eventBus.dispatch("find", {
      source: this,
      type,
      query: this.findQuery,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }

  /** Gives the keyboard to the pages, where the arrow, Page and Home/End keys scroll. */
  focus = (): void => this.#session?.container.focus({ preventScroll: true });

  /** Whether the pages can scroll sideways: then ← and → scroll, and do not turn the page. */
  scrollsSideways = (): boolean => {
    const container = this.#session?.container;
    return container !== undefined && container.scrollWidth > container.clientWidth + 1;
  };
}

export const pdf = new PdfStore();
