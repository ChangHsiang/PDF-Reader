/**
 * 基于 PDFium 的阅读器内核，替换 pdf.js 的 PDFViewer。
 *
 * **对外故意和 pdf.js 的 PDFViewer 长得一样**（只做这个项目用到的那部分），这样上面那一大堆功能不用改：
 * - DOM：.pdfViewer > .page[data-page-number] > .canvasWrapper > canvas，外加 .annotationLayer（链接）。
 *   高亮层、框选、附注、公式按钮……都是往 .page 里挂东西、按 .canvasWrapper 的盒子算比例坐标
 * - 属性：currentScale / currentScaleValue（数字或 page-actual / page-width / page-height / page-fit / auto）、
 *   currentPageNumber、pagesCount、getPageView(i).renderingState、refresh()
 * - 事件（eventBus）：pagesinit、pagechanging、scalechanging、pagerendered
 * - CSS 变量：.pdfViewer 上的 --scale-factor（= 缩放 × 96/72，文本框的字号按它算）
 *
 * 渲染：
 * - 页面在 Worker 里由 PDFium 画好，ImageBitmap 零拷贝传回来，主线程只负责贴到画布上 —— 滚动时主线程几乎不干活
 * - 只画看得见的页（上下各多留半屏），离得远的页把画布释放掉（几百页的书不会把内存吃光）
 * - 整页画布有像素上限；放大到超过上限时，整页只画一张模糊的打底，看得见的那一块另画一张清楚的「细节」画布
 *   （同 pdf.js 的 detail view），滚停之后再补，不在滚动中途画
 * - 坐标：PDFium 的页面坐标原点在左上、按显示方向（已经算上 CropBox 和 /Rotate），单位 PDF 点；
 *   CSS 像素 = 点 × 96/72 × 缩放，和 pdf.js 一致（标注存的比例坐标两边通用，第 1 步验证过）
 */

import { buildTextLayer, installSelectionHelper } from "./textLayer";
import { PdfiumFind } from "./find";

export const PT2PX = 96 / 72;
const MAX_PIXELS = 16 * 1024 * 1024;     // 整页画布的像素上限（超过就改用打底 + 细节画布）
const RENDER_MARGIN = 0.5;               // 视口上下各多渲染半屏

export class EventBus {
  #map = new Map();
  on(name, fn) { (this.#map.get(name) || this.#map.set(name, new Set()).get(name)).add(fn); }
  off(name, fn) { this.#map.get(name)?.delete(fn); }
  dispatch(name, data = {}) { this.#map.get(name)?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
}

/** 文档句柄：给上层用的（页数、原始字节、页面尺寸），具体操作都转给 Worker */
export class PdfiumDocument {
  constructor(pdf, docId, info, bytes) {
    this.pdf = pdf;
    this.docId = docId;
    this.numPages = info.pageCount;
    this.pages = info.pages;              // [{ index, size: { width, height }（点，显示方向）, rotation, crop }]
    this.bytes = bytes;
    this.isPdfium = true;
  }
  getData() { return Promise.resolve(this.bytes.slice()); }
  outline() { return this.pdf.outline(this.docId); }
  links(pageIndex) { return this.pdf.links(this.docId, pageIndex); }
  /** 渲染整页或一块，返回 ImageBitmap（调用方用完要 close） */
  render(pageIndex, scale) { return this.pdf.render(this.docId, pageIndex, scale); }
  renderRect(pageIndex, scale, rect) { return this.pdf.renderRect(this.docId, pageIndex, scale, rect); }
  geometry(pageIndex) { return this.pdf.geometry(this.docId, pageIndex); }
  /** 一页的字符（缓存）：{ codes, boxes, flags }，见 worker 的 text() */
  text(pageIndex) { return (this._text ||= new Map()).get(pageIndex) || this._text.set(pageIndex, this.pdf.text(this.docId, pageIndex).catch((e) => { this._text.delete(pageIndex); throw e; })).get(pageIndex); }
  /** PDF 用户坐标（原点左下，XYZ 跳转用的那种）→ 页面坐标（原点左上，点）。只处理不旋转的页 */
  userToPage(pageIndex, x, y) {
    const p = this.pages[pageIndex];
    if (!p || p.rotation || !p.crop) return { x: x ?? 0, y: y == null ? 0 : p ? p.size.height - y : 0 };
    return { x: x == null ? 0 : x - p.crop.left, y: y == null ? 0 : p.crop.top - y };
  }
  destroy() { return this.pdf.close(this.docId); }
}

export class PdfiumViewer {
  constructor({ container, viewer, eventBus }) {
    this.container = container;
    this.viewer = viewer;
    this.eventBus = eventBus;
    this.doc = null;
    this.views = [];                     // [{ index, div, wrap, canvas, detail, links, renderingState, renderedScale, ... }]
    this._scale = 1;
    this._scaleValue = "page-actual";
    this._page = 1;
    this._raf = 0;
    this._detailTimer = 0;
    this._busy = false;                  // Worker 一次只排一个渲染，近的先画
    this._lastScroll = 0;
    this._onScroll = () => {
      this._lastScroll = performance.now();
      this._raf ||= requestAnimationFrame(() => { this._raf = 0; this.update(); });
    };
    container.addEventListener("scroll", this._onScroll, { passive: true });
    this._unselect = installSelectionHelper(container);
    this.find = new PdfiumFind(this, eventBus);
  }

  get pagesCount() { return this.views.length; }
  get currentScale() { return this._scale; }
  get currentScaleValue() { return this._scaleValue; }
  set currentScaleValue(v) { this._setScale(v); }
  get currentPageNumber() { return this._page; }
  set currentPageNumber(n) { this.scrollToPage(n); }
  getPageView(i) { return this.views[i]; }

  setDocument(doc) {
    this.viewer.replaceChildren();
    this.views.forEach(v => v.canvas && (v.canvas.width = 0));
    this.views = [];
    this.doc = doc;
    this.find?.clear();
    if (this.find) this.find.texts = null;
    if (!doc) return;
    this.views = doc.pages.map((p, i) => {
      const div = document.createElement("div");
      div.className = "page";
      div.dataset.pageNumber = String(i + 1);
      const wrap = document.createElement("div");
      wrap.className = "canvasWrapper";
      div.appendChild(wrap);
      this.viewer.appendChild(div);
      return { index: i, id: i + 1, div, wrap, canvas: null, detail: null, links: null, renderingState: 0, renderedScale: 0, size: p.size };
    });
    this._applyScale(this._scale, null);
    this.eventBus.dispatch("pagesinit", { source: this });
  }

  /** 解析 currentScaleValue：数字，或几种按容器尺寸算的「自动」倍数 */
  _resolve(v) {
    const first = this.doc?.pages[this._page - 1] || this.doc?.pages[0];
    if (!first) return 1;
    const pw = first.size.width * PT2PX, ph = first.size.height * PT2PX;
    const cw = this.container.clientWidth - 40, chh = this.container.clientHeight - 20;   // 留出页边和滚动条
    switch (v) {
      case "page-actual": return 1;
      case "page-width": return Math.max(0.1, cw / pw);
      case "page-height": return Math.max(0.1, chh / ph);
      case "page-fit": return Math.max(0.1, Math.min(cw / pw, chh / ph));
      case "auto": return Math.min(1.25, Math.max(0.1, cw / pw));
      default: { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 1; }
    }
  }

  _setScale(v) {
    const preset = typeof v === "string" && /^(page-|auto)/.test(v) ? v : null;
    const scale = this._resolve(v);
    this._scaleValue = preset || String(scale);
    this._applyScale(scale, preset);
  }

  /** 换缩放：保住当前看着的那一页的相对位置，页面尺寸改了之后滚回去 */
  _applyScale(scale, preset) {
    const anchor = this._anchor();
    this._scale = scale;
    this.viewer.style.setProperty("--scale-factor", String(scale * PT2PX));
    for (const v of this.views) {
      v.div.style.width = `${v.size.width * PT2PX * scale}px`;
      v.div.style.height = `${v.size.height * PT2PX * scale}px`;
      v.renderingState = v.renderedScale === scale ? v.renderingState : 0;
      if (v.detail) { v.detail.remove(); v.detail = null; }
    }
    if (anchor) {
      const v = this.views[anchor.index];
      this.container.scrollTop = v.div.offsetTop + anchor.frac * v.div.offsetHeight - anchor.offset;
    }
    this.eventBus.dispatch("scalechanging", { source: this, scale, presetValue: preset });
    this.update();
  }

  _anchor() {
    const top = this.container.scrollTop;
    const v = this.views.find(v => v.div.offsetTop + v.div.offsetHeight > top);
    if (!v || !v.div.offsetHeight) return null;
    return { index: v.index, frac: (top - v.div.offsetTop) / v.div.offsetHeight, offset: 0 };
  }

  scrollToPage(n, top = null) {
    const v = this.views[n - 1];
    if (!v) return;
    const y = top == null ? 0 : top * PT2PX * this._scale;
    this.container.scrollTop = v.div.offsetTop + y - 6;
    this.update();
  }

  /** 跳转目标：{ pageIndex, x, y }（x / y 是 PDF 用户坐标，可能为空 = 只跳到那一页） */
  goToDest(dest) {
    if (!dest || dest.pageIndex == null || !this.doc) return;
    const p = this.doc.userToPage(dest.pageIndex, dest.x, dest.y);
    this.scrollToPage(dest.pageIndex + 1, dest.y == null ? null : Math.max(0, p.y));
  }

  /** 尺寸 / 滚动变了：算当前页、排渲染、清掉远处的画布 */
  update() {
    if (!this.views.length) return;
    const top = this.container.scrollTop, h = this.container.clientHeight;
    const lo = top - h * RENDER_MARGIN, hi = top + h * (1 + RENDER_MARGIN);
    // 当前页：视口里露出最多的那一页
    let best = this._page, bestArea = -1;
    for (const v of this.views) {
      const a = v.div.offsetTop, b = a + v.div.offsetHeight;
      const vis = Math.min(b, top + h) - Math.max(a, top);
      if (vis > bestArea) { bestArea = vis; best = v.id; }
      v.near = b > lo && a < hi;
      if (!v.near && v.canvas && Math.abs(v.div.offsetTop - top) > h * 4) this._release(v);   // 很远了：释放画布
    }
    if (best !== this._page) {
      this._page = best;
      this.eventBus.dispatch("pagechanging", { source: this, pageNumber: best });
    }
    this._pump();
    clearTimeout(this._detailTimer);
    this._detailTimer = setTimeout(() => this._pumpDetail(), 160);
  }

  refresh() {
    for (const v of this.views) { v.renderingState = 0; v.renderedScale = 0; }
    this.update();
  }

  _release(v) {
    if (v.canvas) { v.canvas.width = v.canvas.height = 0; v.canvas.remove(); v.canvas = null; }
    if (v.detail) { v.detail.remove(); v.detail = null; }
    v.renderingState = 0;
    v.renderedScale = 0;
  }

  /** 挑下一个要画的页：在可视范围附近、还没按当前缩放画过的，离视口中心最近的先画 */
  async _pump() {
    if (this._busy || !this.doc) return;
    const mid = this.container.scrollTop + this.container.clientHeight / 2;
    const todo = this.views.filter(v => v.near && v.renderedScale !== this._scale)
      .sort((a, b) => Math.abs(a.div.offsetTop + a.div.offsetHeight / 2 - mid) - Math.abs(b.div.offsetTop + b.div.offsetHeight / 2 - mid));
    const v = todo[0];
    if (!v) return;
    this._busy = true;
    const scale = this._scale;
    try {
      const dpr = window.devicePixelRatio || 1;
      const full = PT2PX * scale * dpr;
      const px = v.size.width * full * v.size.height * full;
      const s = px > MAX_PIXELS ? full * Math.sqrt(MAX_PIXELS / px) : full;   // 超过上限：打底画低一点
      v.renderingState = 1;
      const { bitmap, width, height } = await this.doc.render(v.index, s);
      if (scale !== this._scale || this.views[v.index] !== v) { bitmap.close(); }
      else {
        if (!v.canvas) {
          v.canvas = document.createElement("canvas");
          v.wrap.prepend(v.canvas);
        }
        v.canvas.width = width;
        v.canvas.height = height;
        v.canvas.getContext("2d").drawImage(bitmap, 0, 0);
        bitmap.close();
        v.lowRes = s < full * 0.999;
        v.renderedScale = scale;
        v.renderingState = 3;
        if (!v.links) this._renderLinks(v);
        this._wantText(v);
        this.eventBus.dispatch("pagerendered", { source: this, pageNumber: v.id });
        // 打底是低分辨率的：细节画布要等打底画完才补（滚动触发的那一次可能来得太早，打底还没画好）
        if (v.lowRes) { clearTimeout(this._detailTimer); this._detailTimer = setTimeout(() => this._pumpDetail(), 60); }
      }
    } catch (e) {
      console.error("[pdfium] render", v.index, e);
      v.renderedScale = scale;            // 别在一页上死循环
    } finally {
      this._busy = false;
    }
    this._pump();
  }

  /** 放大后整页是打底的低分辨率：滚停后给看得见的那一块补一张清楚的 */
  async _pumpDetail() {
    if (!this.doc) return;
    const top = this.container.scrollTop, h = this.container.clientHeight, w = this.container.clientWidth;
    const cb = this.container.getBoundingClientRect();
    for (const v of this.views) {
      if (!v.lowRes || v.renderedScale !== this._scale) continue;
      const a = v.div.offsetTop, b = a + v.div.offsetHeight;
      if (b < top || a > top + h) { if (v.detail) { v.detail.remove(); v.detail = null; } continue; }
      const pr = v.wrap.getBoundingClientRect();
      // 页面上看得见的那一块（CSS 像素，相对页面左上），四周多留 1/4 屏
      const x0 = Math.max(0, cb.left - pr.left - w * 0.25), y0 = Math.max(0, cb.top - pr.top - h * 0.25);
      const x1 = Math.min(pr.width, cb.right - pr.left + w * 0.25), y1 = Math.min(pr.height, cb.bottom - pr.top + h * 0.25);
      if (x1 <= x0 || y1 <= y0) continue;
      const k = PT2PX * this._scale;          // CSS 像素 / 点
      const rect = { x: x0 / k, y: y0 / k, w: (x1 - x0) / k, h: (y1 - y0) / k };
      const key = `${this._scale}|${rect.x.toFixed(1)},${rect.y.toFixed(1)},${rect.w.toFixed(1)},${rect.h.toFixed(1)}`;
      if (v.detailKey === key) continue;
      const scale = this._scale;
      const dpr = window.devicePixelRatio || 1;
      const { bitmap, width, height } = await this.doc.renderRect(v.index, k * dpr, rect);
      if (scale !== this._scale || !v.canvas) { bitmap.close(); continue; }
      const c = v.detail || document.createElement("canvas");
      c.className = "detailView";
      c.width = width; c.height = height;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      Object.assign(c.style, { left: `${x0 / pr.width * 100}%`, top: `${y0 / pr.height * 100}%`, width: `${(x1 - x0) / pr.width * 100}%`, height: `${(y1 - y0) / pr.height * 100}%` });
      if (!v.detail) { v.detail = c; v.wrap.appendChild(c); }
      v.detailKey = key;
      this.eventBus.dispatch("pagerendered", { source: this, pageNumber: v.id, detail: true });
    }
  }

  /**
   * 文字层（lib/pdfium/textLayer.js）。每页只建一次（坐标是 100% 下的固定像素，整层一个 transform 跟着缩放）。
   * **滚动停下来之后、在空闲时分批建**：一页一千个词第一次排版要一两百毫秒（浏览器要逐个词排字），
   * 放在滚动途中就是一卡一卡的（实测最长的一帧 350~500ms）。文字层只在选字时有用，滚动时用不上：
   * - 页面画好时只向 Worker 要这一页的字符数据（不占主线程）
   * - 滚动停了 200ms 之后，空闲时一批 150 个节点往里放（按阅读顺序，选区不受影响），放完发 textlayerrendered
   */
  _wantText(v) {
    if (v.textData || v.textAsked) return;
    v.textAsked = true;
    this.doc.text(v.index).then((d) => { v.textData = d; this._scheduleText(); })
      .catch((e) => { console.error("[pdfium] text", v.index, e); v.textAsked = false; });
  }

  _scheduleText() {
    if (this._textTimer) return;
    const wait = Math.max(0, 200 - (performance.now() - this._lastScroll));
    this._textTimer = setTimeout(() => {
      this._textTimer = 0;
      if (performance.now() - this._lastScroll < 200) { this._scheduleText(); return; }
      const ric = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 16));
      ric((dl) => this._pumpText(dl), { timeout: 600 });
    }, wait);
  }

  _pumpText(deadline) {
    if (performance.now() - this._lastScroll < 200) { this._scheduleText(); return; }
    const mid = this.container.scrollTop + this.container.clientHeight / 2;
    const todo = this.views.filter(v => v.near && v.textData && v.text !== "done")
      .sort((a, b) => Math.abs(a.div.offsetTop + a.div.offsetHeight / 2 - mid) - Math.abs(b.div.offsetTop + b.div.offsetHeight / 2 - mid));
    for (const v of todo) {
      if (!v.textNodes) {
        const { layer, nodes } = buildTextLayer(v.textData, v.size);
        v.wrap.after(layer);              // 画布之上、链接层和高亮层之下
        v.textLayer = layer;
        v.textNodes = nodes;
      }
      while (v.textNodes.length && deadline.timeRemaining() > 4) {
        v.textLayer.append(...v.textNodes.splice(0, 150));
      }
      if (v.textNodes.length) break;     // 这一轮的时间用完了
      v.text = "done";
      v.textNodes = null;
      this.eventBus.dispatch("textlayerrendered", { source: this, pageNumber: v.id });
      if (deadline.timeRemaining() <= 4) break;
    }
    if (this.views.some(v => v.near && v.textData && v.text !== "done")) this._scheduleText();
  }

  /** 链接层：结构照 pdf.js（section.linkAnnotation > a），点内部链接跳转、外部链接新标签页打开。
      不画悬停黄框（PDF 里的链接矩形本来就不贴字，画出来像是偏了；Edge 也不画） */
  async _renderLinks(v) {
    v.links = "loading";
    let links = [];
    try { links = await this.doc.links(v.index); } catch { /* 没有就算了 */ }
    const layer = document.createElement("div");
    layer.className = "annotationLayer";
    const W = v.size.width, H = v.size.height;
    for (const l of links) {
      const sec = document.createElement("section");
      sec.className = "linkAnnotation";
      sec.style.cssText = `left:${l.x / W * 100}%;top:${l.y / H * 100}%;width:${l.w / W * 100}%;height:${l.h / H * 100}%`;
      const a = document.createElement("a");
      if (l.url) { a.href = l.url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
      else {
        a.href = "#";
        a.dataset.destPage = String(l.dest.pageIndex);
        if (l.dest.x != null) a.dataset.destX = String(l.dest.x);
        if (l.dest.y != null) a.dataset.destY = String(l.dest.y);
        // 引用号之类要先给上层截走（文献卡片在容器上用捕获阶段拦，拦了就 stopPropagation，这里收不到）
        a.addEventListener("click", (e) => { e.preventDefault(); this.goToDest(l.dest); });
      }
      sec.appendChild(a);
      layer.appendChild(sec);
    }
    v.div.appendChild(layer);
    v.links = layer;
  }

  destroy() {
    this.container.removeEventListener("scroll", this._onScroll);
    this._unselect?.();
    this.find?.destroy();
    cancelAnimationFrame(this._raf);
    clearTimeout(this._detailTimer);
    clearTimeout(this._textTimer);
    this.setDocument(null);
  }
}

/** 给上层的 linkService（和 pdf.js 的 PDFLinkService 同名的那一个方法） */
export const makeLinkService = (viewer) => ({
  goToDestination: (dest) => { if (dest && typeof dest === "object") viewer.goToDest(dest); },
});
