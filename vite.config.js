import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync } from "node:fs";
import { resolve } from "node:path";

/* pdf.js 的字体 / CMap / wasm 解码器要跟着扩展一起发：扩展页不该去 CDN 取东西
   （CSP + 离线可用），缺了它们部分论文的字会退化成系统字体、JPX 图解不出来 */
const copyPdfjsAssets = () => ({
  name: "copy-pdfjs-assets",
  closeBundle() {
    const from = resolve("node_modules/pdfjs-dist");
    for (const d of ["cmaps", "standard_fonts", "wasm"]) {
      cpSync(resolve(from, d), resolve("dist/pdfjs", d), { recursive: true });
    }
    // PDFium 的 wasm（src/pdfium/worker.js 从扩展自己取，不去 CDN）
    cpSync(resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm"), resolve("dist/pdfium/pdfium.wasm"));
  },
});

export default defineConfig(({ mode }) => ({
  root: "src",
  publicDir: resolve("public"),
  envDir: resolve("."),
  base: "./",
  plugins: [react(), copyPdfjsAssets()],
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
        spike: resolve("src/spike.html"),          // PDFium 第 1 步验证页（验证完删）
      },
      output: {
        // service worker 的文件名要和 manifest 里写的一致，不能带 hash
        entryFileNames: (c) => (c.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
}));
