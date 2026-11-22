import { cpSync, createReadStream, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri injects these at build/dev time.
const host = process.env.TAURI_DEV_HOST;
const debug = !!process.env.TAURI_ENV_DEBUG;

/**
 * The files PDF.js fetches by URL while it reads a document (ARCHITECTURE §10.5): the
 * character maps and standard fonts of PDFs that embed none, the WebAssembly decoders
 * with their JavaScript fallbacks, the color profiles, and the annotation icons. They
 * are served under `/pdfjs/` from the package in development and copied to
 * `dist/pdfjs/` by a build, with the licenses they come under. `src/lib/pdf/engine.ts`
 * names the same folders.
 */
function pdfAssets(): Plugin {
  const pkg = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  /** Published folder → its folder in the package, and the files of it that are served. */
  const folders: Record<string, { from: string; keep: (name: string) => boolean }> = {
    cmaps: { from: "cmaps", keep: () => true },
    standard_fonts: { from: "standard_fonts", keep: () => true },
    // The scripting sandbox (quickjs) runs a PDF's own JavaScript, which the viewer never does.
    wasm: { from: "wasm", keep: (name) => !name.toLowerCase().includes("quickjs") },
    iccs: { from: "iccs", keep: () => true },
    images: { from: join("web", "images"), keep: (name) => name.startsWith("annotation-") },
  };
  const types: Record<string, string> = { wasm: "application/wasm", js: "text/javascript", svg: "image/svg+xml" };
  let outDir = "";
  let building = false;
  return {
    name: "mininote-pdf-assets",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      building = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        let path: string;
        try {
          path = decodeURIComponent((req.url ?? "").split("?")[0]);
        } catch {
          return next();
        }
        const [folder, name, ...rest] = path.split("/").filter(Boolean);
        const entry = folder === undefined ? undefined : folders[folder];
        if (!entry || name === undefined || rest.length > 0 || name.includes("..") || name.includes(sep) || !entry.keep(name)) {
          return next();
        }
        const file = join(pkg, entry.from, name);
        try {
          if (!statSync(file).isFile()) return next();
        } catch {
          return next();
        }
        res.setHeader("Content-Type", types[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!building) return;
      const out = join(outDir, "pdfjs");
      for (const [folder, entry] of Object.entries(folders)) {
        const from = join(pkg, entry.from);
        cpSync(from, join(out, folder), { recursive: true, filter: (src) => src === from || entry.keep(basename(src)) });
      }
      cpSync(join(pkg, "LICENSE"), join(out, "LICENSE"));
    },
  };
}

export default defineConfig({
  plugins: [svelte(), pdfAssets()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WebView2 (Windows) is evergreen Chromium; WKWebView / WebKitGTK lag behind.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome110" : "safari15",
    minify: !debug,
    sourcemap: debug,
    // The app is one bundle, read from local disk by the webview: splitting it would buy nothing.
    // Only the code view's language modes are chunks of their own, fetched when a file of that
    // language is first opened (src/lib/editor/code/languages.ts), and so is PDF.js, fetched
    // when the first PDF is opened (src/lib/pdf/engine.ts).
    chunkSizeWarningLimit: 2048,
  },
});
