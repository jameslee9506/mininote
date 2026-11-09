import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Tauri injects these at build/dev time.
const host = process.env.TAURI_DEV_HOST;
const debug = !!process.env.TAURI_ENV_DEBUG;

export default defineConfig({
  plugins: [svelte()],
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
    // One bundle read from local disk by the webview: code splitting would buy nothing.
    chunkSizeWarningLimit: 2048,
  },
});
