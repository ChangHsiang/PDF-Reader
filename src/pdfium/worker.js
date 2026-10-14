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
  /**
   * 一页的全部字符：Unicode、外框、标记。文字层（选字）和搜索都用它。
   * 不用 embedpdf 现成的 getPageGlyphs：它每个字 malloc / free 九次，而且把坐标取整到「点」
   * （FPDF_PageToDevice 出来是整数）—— 1 点 = 1.33px，放大到 500% 就差 6~7px。
   * 这里把设备坐标放大 64 倍再除回来，保留小数；一页只申请一次内存。
   * 返回：codes（Uint32，每个字符的 Unicode）、boxes（Float32 x,y,w,h，单位点、原点左上、按显示方向；
   * 没框的字符全是 0）、flags（1 = PDFium 补出来的空格 / 换行，2 = 行尾连字符）
   */
  async text({ docId, pageIndex }) {
    const doc = docs.get(docId);
    const page = doc.pages[pageIndex];
    const M = native.pdfiumModule, P = M.pdfium, mm = native.memoryManager;
    const pc = native.cache.getContext(doc.id).acquirePage(pageIndex);
    try {
      const tp = pc.getTextPage();
      const n = M.FPDFText_CountChars(tp);
      const codes = new Uint32Array(n), boxes = new Float32Array(n * 4), flags = new Uint8Array(n);
      const rect = mm.malloc(16), dev = mm.malloc(16);
      const S = 64, W = Math.round(page.size.width * S), H = Math.round(page.size.height * S);
      try {
        for (let i = 0; i < n; i++) {
          codes[i] = M.FPDFText_GetUnicode(tp, i);
          if (M.FPDFText_IsGenerated(tp, i)) flags[i] |= 1;
          if (M.FPDFText_IsHyphen(tp, i)) flags[i] |= 2;
          if (!M.FPDFText_GetLooseCharBox(tp, i, rect)) continue;
          const l = P.getValue(rect, "float"), t = P.getValue(rect + 4, "float");
          const r = P.getValue(rect + 8, "float"), b = P.getValue(rect + 12, "float");
          if (l === r || t === b) continue;
          M.FPDF_PageToDevice(pc.pagePtr, 0, 0, W, H, 0, l, t, dev, dev + 4);
          M.FPDF_PageToDevice(pc.pagePtr, 0, 0, W, H, 0, r, b, dev + 8, dev + 12);
          const x1 = P.getValue(dev, "i32") / S, y1 = P.getValue(dev + 4, "i32") / S;
          const x2 = P.getValue(dev + 8, "i32") / S, y2 = P.getValue(dev + 12, "i32") / S;
          boxes[i * 4] = Math.min(x1, x2); boxes[i * 4 + 1] = Math.min(y1, y2);
          boxes[i * 4 + 2] = Math.abs(x2 - x1); boxes[i * 4 + 3] = Math.abs(y2 - y1);
        }
      } finally { mm.free(rect); mm.free(dev); }
      return { codes, boxes, flags, transfer: [codes.buffer, boxes.buffer, flags.buffer] };
    } finally { pc.release(); }
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
