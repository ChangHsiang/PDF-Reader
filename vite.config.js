import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => ({
  root: "src",
  publicDir: resolve("public"),
  envDir: resolve("."),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve("dist"),
    emptyOutDir: true,
    target: "chrome120",
    sourcemap: mode === "development",
    minify: mode !== "development",
    chunkSizeWarningLimit: 2000,
    worker: { format: "es" },
    rollupOptions: {
      input: {
        viewer: resolve("src/viewer.html"),
        popup: resolve("src/popup.html"),
        background: resolve("src/background.js"),
      },
      output: {
        // service worker 的文件名要和 manifest 里写的一致，不能带 hash
        entryFileNames: (c) => (c.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
}));
