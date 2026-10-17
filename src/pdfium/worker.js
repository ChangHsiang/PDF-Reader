/**
 * PDFium（WebAssembly）跑在这个 Worker 里：解析、渲染、取字形都不占主线程。
 * 主线程通过 lib/pdfium/client.js 发消息：{ id, op, args } → { id, ok, result | error }。
 *
 * wasm 打包在扩展里（vite 当资源文件发出来，?url 拿到它的地址），不去 CDN：
 * 扩展页不该依赖外网才能打开 PDF，也省得多申请一个网站的权限。
 */
import { init } from "@embedpdf/pdfium";
import { PdfiumNative, createCdnFontConfig } from "@embedpdf/engines/pdfium";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";

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
  const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
  const mod = await init({ wasmBinary });
  const cfg = createCdnFontConfig(FONT_VERSION);
  native = new PdfiumNative(mod, { fontFallback: { ...cfg, fontLoader: (p) => loadFontSync(/^https?:/.test(p) ? p : (cfg.baseUrl || "") + p) } });
  return native;
}

/** PDFium 的导出函数：embedpdf 包装过的就用包装的，没包装的直接调 wasm 导出（参数全是数字 / 指针） */
const fn = (name) => native.pdfiumModule[name] || native.pdfiumModule.pdfium["_" + name];

/**
 * 把名字（/NM）在 names 里的注释从内存里的这份文档删掉（倒着删，下标不乱）。不动文件，也不重新生成页面内容。
 * 用在「我们自己导出的文件」：那几条注释的名字就是笔记 id，本插件里已经有对应的笔记在画，文件里那份不再画，免得叠两层。
 * 别人 / 别的软件加的标注名字对不上，照旧由 PDF 自己画
 */
function stripNamed(doc, names) {
  const M = native.pdfiumModule;
  let removed = 0;
  for (const page of doc.pages) {
    const pc = native.cache.getContext(doc.id).acquirePage(page.index);
    try {
      for (let i = M.FPDFPage_GetAnnotCount(pc.pagePtr) - 1; i >= 0; i--) {
        const a = M.FPDFPage_GetAnnot(pc.pagePtr, i);
        if (!a) continue;
        const nm = native.getAnnotString(a, "NM");
        M.FPDFPage_CloseAnnot(a);
        if (nm && names.has(nm) && M.FPDFPage_RemoveAnnot(pc.pagePtr, i)) removed++;
      }
    } finally { pc.release(); }
  }
  return removed;
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
  /* annots：要不要画 PDF 文件里自带的注释（设置里「显示标注」关掉时不画） */
  async render({ docId, pageIndex, scale, rect, annots = true }) {
    const doc = docs.get(docId);
    const page = doc.pages[pageIndex];
    const opts = { scaleFactor: scale, dpr: 1, withAnnotations: annots };
    const img = await run(rect ? native.renderPageRect(doc, page, rect, opts) : native.renderPageRaw(doc, page, opts));
    const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer || img.data);
    const bmp = await createImageBitmap(new ImageData(data, img.width, img.height));
    return { bitmap: bmp, width: img.width, height: img.height, transfer: [bmp] };
  },
  /** 渲染一块（放大后只画看得见的那块）：rect 是页面坐标（PDF 点，原点左上，按显示方向） */
  async renderRect({ docId, pageIndex, scale, rect, annots = true }) {
    const doc = docs.get(docId);
    const r = { origin: { x: rect.x, y: rect.y }, size: { width: rect.w, height: rect.h } };
    const img = await run(native.renderPageRect(doc, doc.pages[pageIndex], r, { scaleFactor: scale, dpr: 1, withAnnotations: annots }));
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
      const codes = new Uint32Array(n), boxes = new Float32Array(n * 4), flags = new Uint8Array(n), base = new Float32Array(n);
      const rect = mm.malloc(16), dev = mm.malloc(16), org = mm.malloc(16);
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
          // 基线（字的原点）：参考文献表按行切条要用，字框的下沿比基线低一截，分不清相邻两行
          if (fn("FPDFText_GetCharOrigin")(tp, i, org, org + 8)) {
            M.FPDF_PageToDevice(pc.pagePtr, 0, 0, W, H, 0, P.getValue(org, "double"), P.getValue(org + 8, "double"), dev, dev + 4);
            base[i] = P.getValue(dev + 4, "i32") / S;
          }
          M.FPDF_PageToDevice(pc.pagePtr, 0, 0, W, H, 0, l, t, dev, dev + 4);
          M.FPDF_PageToDevice(pc.pagePtr, 0, 0, W, H, 0, r, b, dev + 8, dev + 12);
          const x1 = P.getValue(dev, "i32") / S, y1 = P.getValue(dev + 4, "i32") / S;
          const x2 = P.getValue(dev + 8, "i32") / S, y2 = P.getValue(dev + 12, "i32") / S;
          boxes[i * 4] = Math.min(x1, x2); boxes[i * 4 + 1] = Math.min(y1, y2);
          boxes[i * 4 + 2] = Math.abs(x2 - x1); boxes[i * 4 + 3] = Math.abs(y2 - y1);
        }
      } finally { mm.free(rect); mm.free(dev); mm.free(org); }
      return { codes, boxes, flags, base, transfer: [codes.buffer, boxes.buffer, flags.buffer, base.buffer] };
    } finally { pc.release(); }
  },
  /**
   * 文档里的具名目标（LaTeX hyperref 的 cite.xxx 之类），只要名字以 prefix 开头的：
   * [{ name, pageIndex, x, y }]（x / y 是 PDF 用户坐标，原点左下；没给的是 null）。
   * 链接注解拿到的目标 PDFium 已经解析成页码 + 坐标、名字丢了，所以文献卡片靠这张表按位置把名字对回去
   */
  async namedDests({ docId, prefix = "" }) {
    const doc = docs.get(docId);
    const M = native.pdfiumModule, P = M.pdfium, mm = native.memoryManager;
    const docPtr = native.cache.getContext(doc.id).docPtr;
    const n = fn("FPDF_CountNamedDests")(docPtr);
    const out = [];
    const lenPtr = mm.malloc(4), flags = mm.malloc(12), xyz = mm.malloc(12);
    try {
      for (let i = 0; i < n; i++) {
        P.setValue(lenPtr, 0, "i32");
        fn("FPDF_GetNamedDest")(docPtr, i, 0, lenPtr);
        const len = P.getValue(lenPtr, "i32");
        if (len <= 2) continue;
        const buf = mm.malloc(len);
        let name = "", dest = 0;
        try {
          P.setValue(lenPtr, len, "i32");
          dest = fn("FPDF_GetNamedDest")(docPtr, i, buf, lenPtr);
          for (let k = 0; k + 1 < len; k += 2) { const c = P.getValue(buf + k, "i16") & 0xffff; if (!c) break; name += String.fromCharCode(c); }
        } finally { mm.free(buf); }
        if (!dest || !name.startsWith(prefix)) continue;
        const pageIndex = M.FPDFDest_GetDestPageIndex(docPtr, dest);
        if (pageIndex < 0) continue;
        let x = null, y = null;
        if (M.FPDFDest_GetLocationInPage(dest, flags, flags + 4, flags + 8, xyz, xyz + 4, xyz + 8)) {
          if (P.getValue(flags, "i8")) x = P.getValue(xyz, "float");
          if (P.getValue(flags + 4, "i8")) y = P.getValue(xyz + 4, "float");
        }
        out.push({ name, pageIndex, x, y });
      }
    } finally { mm.free(lenPtr); mm.free(flags); mm.free(xyz); }
    return out;
  },
  /**
   * 认文件用（本地 PDF，见 lib/localPdf）：PDF 的文档编号（trailer 里的 /ID，两段：
   * permanent = 文件第一次生成时定下、之后增量保存（Edge / Acrobat 存标注）不变；changing = 每次保存都换）、
   * 元数据里的标题、第一页的文字（找 arXiv 印在页边的「arXiv:2011.03014v2 [astro-ph.CO] …」）
   */
  async identify({ docId }) {
    const doc = docs.get(docId);
    const M = native.pdfiumModule, P = M.pdfium, mm = native.memoryManager;
    const docPtr = native.cache.getContext(doc.id).docPtr;
    const fileId = (type) => {
      const n = fn("FPDF_GetFileIdentifier")(docPtr, type, 0, 0);
      if (n <= 1) return null;
      const buf = mm.malloc(n);
      try {
        fn("FPDF_GetFileIdentifier")(docPtr, type, buf, n);
        let hex = "";
        for (let i = 0; i < n - 1; i++) hex += (P.getValue(buf + i, "i8") & 0xff).toString(16).padStart(2, "0");
        return /^0*$/.test(hex) ? null : hex;
      } finally { mm.free(buf); }
    };
    // embedpdf 包装过的 FPDF_GetMetaText：第二个参数（键名）直接传 JS 字符串（传指针会报 stringToUTF8Array expects a string）
    const meta = (tag) => {
      const n = M.FPDF_GetMetaText(docPtr, tag, 0, 0);
      if (n <= 2) return "";
      const buf = mm.malloc(n);
      try {
        M.FPDF_GetMetaText(docPtr, tag, buf, n);
        let s = "";
        for (let k = 0; k + 1 < n; k += 2) { const c = P.getValue(buf + k, "i16") & 0xffff; if (!c) break; s += String.fromCharCode(c); }
        return s.trim();
      } finally { mm.free(buf); }
    };
    let firstPage = "";
    if (doc.pages.length) {
      const { codes } = await ops.text({ docId, pageIndex: 0 });
      for (const c of codes) if (c) firstPage += c === 2 ? "-" : String.fromCodePoint(c);
    }
    // Subject / Keywords：期刊排版的 PDF 常把「期刊 卷 页 (年). doi:10.…」写在这里（认 DOI 用）
    return { permanentId: fileId(0), changingId: fileId(1), title: meta("Title"), subject: meta("Subject"), keywords: meta("Keywords"),
             firstPage: firstPage.slice(0, 20000) };
  },
  /** 文档属性（点阅读器左上角的标题）：信息字典里的几项 + PDF 版本（14 → "1.4"） */
  async props({ docId }) {
    const doc = docs.get(docId);
    const M = native.pdfiumModule, P = M.pdfium, mm = native.memoryManager;
    const docPtr = native.cache.getContext(doc.id).docPtr;
    const meta = (tag) => {
      const n = M.FPDF_GetMetaText(docPtr, tag, 0, 0);
      if (n <= 2) return "";
      const buf = mm.malloc(n);
      try {
        M.FPDF_GetMetaText(docPtr, tag, buf, n);
        let s = "";
        for (let k = 0; k + 1 < n; k += 2) { const c = P.getValue(buf + k, "i16") & 0xffff; if (!c) break; s += String.fromCharCode(c); }
        return s.trim();
      } finally { mm.free(buf); }
    };
    let version = null;
    const vp = mm.malloc(4);
    try { if (fn("FPDF_GetFileVersion")(docPtr, vp)) { const v = P.getValue(vp, "i32"); if (v > 0) version = `${Math.floor(v / 10)}.${v % 10}`; } }
    catch { /* 没有这个导出就不显示 */ } finally { mm.free(vp); }
    const out = { version };
    for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) out[k] = meta(k);
    return out;
  },
  /**
   * 导出带标注的 PDF：把原文件另开一份（不动正在看的那份），按 items 建标准的 PDF 注释
   * （高亮 / 下划线 / 方框 / 手写 / 文本框 / 便签，外观由 PDFium 生成，Edge、Acrobat、Zotero 都能看能改），
   * 存成新文件返回。items：[{ pageIndex, annotation }]，annotation 是 embedpdf 的注释对象（坐标单位点、原点左上，
   * 见 lib/exportPdf）。建不出来的计数返回，不中断整份导出
   */
  async exportAnnotated({ bytes, items }) {
    const n = await boot();
    const id = `export-${Date.now()}`;
    const doc = await run(n.openDocumentBuffer({ id, content: bytes }));
    let failed = 0;
    try {
      // 文件是我们以前导出过的：同一条笔记的旧注释先去掉，再写新的（别人 / 别的软件加的标注不动）
      stripNamed(doc, new Set(items.map(x => x.annotation.id).filter(Boolean)));
      for (const { pageIndex, annotation } of items) {
        const page = doc.pages[pageIndex];
        if (!page) { failed++; continue; }
        try { await run(n.createPageAnnotation(doc, page, annotation)); } catch { failed++; }
      }
      const out = await run(n.saveAsCopy(doc));
      return { bytes: out, failed, transfer: [out] };
    } finally {
      await run(n.closeDocument(doc)).catch(() => {});
    }
  },
  /** 显示用的这份文档里，去掉名字在 names 里的注释（见 stripNamed） */
  async stripNamed({ docId, names }) {
    return stripNamed(docs.get(docId), new Set(names));
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
