/**
 * PDFium（WebAssembly）跑在这个 Worker 里：解析、渲染、取字形都不占主线程。
 * 主线程通过 lib/pdfium/client.js 发消息：{ id, op, args } → { id, ok, result | error }。
 *
 * wasm 从扩展自己的 dist/pdfium/pdfium.wasm 取（vite 构建时拷过去），不去 CDN：
 * 扩展页不该依赖外网才能打开 PDF，也省得多申请一个网站的权限。
 */
import { init } from "@embedpdf/pdfium";
import { PdfiumNative, createCdnFontConfig } from "@embedpdf/engines/pdfium";

/* 没嵌入字体的中日韩文字：wasm 里的 PDFium 读不到电脑上装的字体，会画成空白（实测）。
   交给 embedpdf 的后备字体：PDFium 真用到某种文字时才从 jsDelivr 下对应的 Noto 字体（一个约 8MB），
   版本钉死，不跟 @latest 漂。arXiv 的论文 pdfTeX 都会嵌字体，绝大多数时候一个字节都不会下 */
const FONT_VERSION = "1";
const fontLog = [];
/** 同步下载字体（PDFium 渲染时同步要字体；Worker 里允许同步 XHR）。记一笔日志，测试时从 mem() 读 */
function loadFontSync(url) {
  const t = performance.now();
  try {
    const x = new XMLHttpRequest();
    x.open("GET", url, false);
    x.responseType = "arraybuffer";
    x.send();
    fontLog.push({ url, status: x.status, bytes: x.response?.byteLength || 0, ms: Math.round(performance.now() - t) });
    return x.status === 200 ? new Uint8Array(x.response) : null;
  } catch (e) {
    fontLog.push({ url, error: String(e.message || e) });
    return null;
  }
}

let native = null;
const docs = new Map();             // docId → PdfDocumentObject

async function boot() {
  if (native) return native;
  const wasmBinary = await (await fetch(new URL("../pdfium/pdfium.wasm", self.location.href))).arrayBuffer();
  const mod = await init({ wasmBinary });
  const cfg = createCdnFontConfig(FONT_VERSION);
  native = new PdfiumNative(mod, { fontFallback: { ...cfg, fontLoader: (p) => loadFontSync(/^https?:/.test(p) ? p : (cfg.baseUrl || "") + p) } });
  return native;
}

const run = (task) => (task?.toPromise ? task.toPromise() : task);

/** 链接 / 目录的目标 → { dest: { pageIndex, x, y } } 或 { url }。XYZ 以外的跳转方式只给页码 */
function targetOf(t) {
  if (!t) return { dest: null };
  const d = t.type === "destination" ? t.destination
    : t.type === "action" && (t.action.type === 1 || t.action.type === 2) ? t.action.destination : null;
  if (d) {
    const p = d.zoom?.mode === 1 ? d.zoom.params : null;
    return { dest: { pageIndex: d.pageIndex, x: p ? p.x : null, y: p ? p.y : null } };
  }
  if (t.type === "action" && t.action.type === 3) return { url: t.action.uri };
  return { dest: null };
}

const ops = {
  async open({ docId, buffer }) {
    const n = await boot();
    const doc = await run(n.openDocumentBuffer({ id: docId, content: buffer }));
    docs.set(docId, doc);
    return { pageCount: doc.pageCount, pages: doc.pages.map(p => ({ index: p.index, size: p.size, rotation: p.rotation, crop: p.boxes?.crop || null })) };
  },
  /** 渲染整页（或其中一块 rect，单位 PDF 点、原点左上），返回 ImageBitmap（零拷贝转给主线程） */
  async render({ docId, pageIndex, scale, rect }) {
    const doc = docs.get(docId);
    const page = doc.pages[pageIndex];
    const opts = { scaleFactor: scale, dpr: 1, withAnnotations: true };
    const img = await run(rect ? native.renderPageRect(doc, page, rect, opts) : native.renderPageRaw(doc, page, opts));
    const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer || img.data);
    const bmp = await createImageBitmap(new ImageData(data, img.width, img.height));
    return { bitmap: bmp, width: img.width, height: img.height, transfer: [bmp] };
  },
  /** 渲染一块（放大后只画看得见的那块）：rect 是页面坐标（PDF 点，原点左上，按显示方向） */
  async renderRect({ docId, pageIndex, scale, rect }) {
    const doc = docs.get(docId);
    const r = { origin: { x: rect.x, y: rect.y }, size: { width: rect.w, height: rect.h } };
    const img = await run(native.renderPageRect(doc, doc.pages[pageIndex], r, { scaleFactor: scale, dpr: 1, withAnnotations: true }));
    const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer || img.data);
    const bmp = await createImageBitmap(new ImageData(data, img.width, img.height));
    return { bitmap: bmp, width: img.width, height: img.height, transfer: [bmp] };
  },
  /** 目录：[{ title, dest: { pageIndex, x, y } | null, url, items: [...] }] */
  async outline({ docId }) {
    const doc = docs.get(docId);
    const res = await run(native.getBookmarks(doc));
    const conv = (b) => ({ title: b.title, ...targetOf(b.target), items: (b.children || []).map(conv) });
    return (res?.bookmarks || []).map(conv);
  },
  /** 一页上的链接：[{ x, y, w, h（页面坐标，点）, dest | url }] */
  async links({ docId, pageIndex }) {
    const doc = docs.get(docId);
    const annots = await run(native.getPageAnnotations(doc, doc.pages[pageIndex]));
    return (annots || []).filter(a => a.type === 2 && a.target).map(a => ({
      x: a.rect.origin.x, y: a.rect.origin.y, w: a.rect.size.width, h: a.rect.size.height, ...targetOf(a.target),
    })).filter(l => l.dest || l.url);
  },
  async geometry({ docId, pageIndex }) {
    const doc = docs.get(docId);
    return run(native.getPageGeometry(doc, doc.pages[pageIndex]));
  },
  async glyphs({ docId, pageIndex }) {
    const doc = docs.get(docId);
    return run(native.getPageGlyphs(doc, doc.pages[pageIndex]));
  },
  /** 调试用：wasm 堆的大小（PDFium 自己的内存都在这里面） */
  async mem() { return { fontLog, wasmHeapMB: native ? Math.round(native.pdfiumModule?.pdfium?.HEAPU8?.length / 1048576 || native.pdfium?.HEAPU8?.length / 1048576 || 0) : 0, keys: native ? Object.keys(native).slice(0, 12) : [] }; },
  async close({ docId }) {
    const doc = docs.get(docId);
    if (doc) { await run(native.closeDocument(doc)); docs.delete(docId); }
    return true;
  },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const res = await ops[op](args || {});
    const transfer = res?.transfer || [];
    if (res && res.transfer) delete res.transfer;
    self.postMessage({ id, ok: true, result: res }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err?.reason?.message || JSON.stringify(err)) });
  }
};
