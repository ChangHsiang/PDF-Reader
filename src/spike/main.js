/**
 * 第 1 步验证页：用 PDFium 渲染论文，测速度 / 内存 / 字形坐标。不是正式功能，验证完就删。
 * 打开方式：chrome-extension://<id>/spike.html?url=https://arxiv.org/pdf/xxxx
 * 测试脚本从 window.__spike 读数据。
 */
import { createPdfium } from "../lib/pdfium/client.js";

const url = new URLSearchParams(location.search).get("url");
const $ = (id) => document.getElementById(id);
const pdf = createPdfium();
const PT2PX = 96 / 72;                 // 1 PDF 点 = 96/72 CSS 像素（和 pdf.js 的 100% 一致）
let zoom = 1, pages = [], docId = "d1";
const stat = { renders: [], openMs: 0, fetchMs: 0 };
window.__spike = { stat, get pages() { return pages; }, pdf, docId };

function layout() {
  const box = $("pages");
  box.replaceChildren();
  for (const p of pages) {
    const el = document.createElement("div");
    el.className = "pg";
    el.dataset.index = p.index;
    el.style.width = `${p.size.width * PT2PX * zoom}px`;
    el.style.height = `${p.size.height * PT2PX * zoom}px`;
    box.appendChild(el);
    p.el = el;
    p.renderedAt = 0;
  }
  observe();
  $("z").textContent = `${Math.round(zoom * 100)}%`;
}

let io = null;
function observe() {
  io?.disconnect();
  io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) renderPage(pages[+e.target.dataset.index]);
  }, { root: $("scroller"), rootMargin: "600px 0px" });
  pages.forEach(p => io.observe(p.el));
}

async function renderPage(p) {
  const z = zoom;
  if (p.renderedAt === z) return;
  p.renderedAt = z;
  const dpr = devicePixelRatio || 1;
  const t0 = performance.now();
  const { bitmap, width, height } = await pdf.render(docId, p.index, PT2PX * z * dpr);
  const ms = performance.now() - t0;
  if (zoom !== z) { bitmap.close(); return; }
  let cv = p.el.querySelector("canvas");
  if (!cv) { cv = document.createElement("canvas"); p.el.prepend(cv); }
  cv.width = width; cv.height = height;
  const ctx = cv.getContext("bitmaprenderer");
  ctx.transferFromImageBitmap(bitmap);
  stat.renders.push({ page: p.index, zoom: z, ms: Math.round(ms), px: `${width}x${height}` });
  if ($("showGlyphs").checked) drawGlyphs(p);
}

async function drawGlyphs(p) {
  const geo = await pdf.geometry(docId, p.index);
  let layer = p.el.querySelector(".glyphs");
  if (!layer) { layer = document.createElement("div"); layer.className = "glyphs"; p.el.appendChild(layer); }
  const W = p.size.width, H = p.size.height;
  const kids = [];
  for (const run of geo.runs) for (const g of run.glyphs) {
    const x = g.tightX ?? g.x, y = g.tightY ?? g.y, w = g.tightWidth ?? g.width, h = g.tightHeight ?? g.height;
    if (!w || !h) continue;
    const d = document.createElement("div");
    d.style.cssText = `left:${x / W * 100}%;top:${y / H * 100}%;width:${w / W * 100}%;height:${h / H * 100}%`;
    kids.push(d);
  }
  layer.replaceChildren(...kids);
}

$("zin").onclick = () => { zoom = Math.min(4, +(zoom + 0.25).toFixed(2)); layout(); };
$("zout").onclick = () => { zoom = Math.max(0.5, +(zoom - 0.25).toFixed(2)); layout(); };
$("showGlyphs").onchange = () => pages.forEach(p => p.renderedAt && (p.renderedAt = 0, renderPage(p)));
window.__spike.setZoom = (z) => { zoom = z; layout(); };

(async () => {
  const t0 = performance.now();
  const buf = await (await fetch(url)).arrayBuffer();
  stat.fetchMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const info = await pdf.open(docId, buf);
  stat.openMs = Math.round(performance.now() - t1);
  pages = info.pages;
  $("info").textContent = `${pages.length} 页 · 下载 ${stat.fetchMs}ms · PDFium 打开 ${stat.openMs}ms`;
  layout();
  window.__spike.ready = true;
})().catch(e => { $("info").textContent = `出错：${e.message}`; window.__spike.error = String(e.message); });

/* 对比测速：同一个 PDF、同样的缩放，用 pdf.js 和 PDFium 各把每一页渲染一遍（只量渲染本身，不含排版） */
window.__spike.bench = async (scale) => {
  const buf = await (await fetch(url)).arrayBuffer();
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
  const t0 = performance.now();
  const doc = await pdfjs.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;
  const openJs = performance.now() - t0;
  const js = [], fi = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: scale * PT2PX });
    const cv = document.createElement("canvas"); cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    const t = performance.now();
    await page.render({ canvasContext: cv.getContext("2d", { alpha: false }), viewport: vp }).promise;
    js.push(performance.now() - t);
  }
  for (let i = 0; i < pages.length; i++) {
    const t = performance.now();
    const r = await pdf.render(docId, i, scale * PT2PX);
    fi.push(performance.now() - t);
    r.bitmap.close();
  }
  const sum = (a) => Math.round(a.reduce((x, y) => x + y, 0)), med = (a) => Math.round([...a].sort((x, y) => x - y)[a.length >> 1]);
  return { scale, pages: pages.length, pdfjs: { open: Math.round(openJs), total: sum(js), median: med(js), max: Math.round(Math.max(...js)) },
           pdfium: { open: stat.openMs, total: sum(fi), median: med(fi), max: Math.round(Math.max(...fi)) },
           jsHeapMB: Math.round(performance.memory?.usedJSHeapSize / 1048576), pdfiumMem: await pdf.mem() };
};
