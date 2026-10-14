/**
 * 文档内搜索（替换 pdf.js 的 PDFFindController）。和上层的约定照旧：
 * - 收：eventBus「find」{ query, type: "" | "again", findPrevious }、「findbarclose」
 * - 发：「updatefindmatchescount」{ matchesCount: { current, total } }
 *
 * 每页的字符从 PDFium 取（和文字层同一份），搜到的位置用字符的真实外框画出来（每页一层 .rh-find），
 * 当前这一处深一点并滚到视野中间。不区分大小写；连续的空白（含换行）当一个空格，所以跨行的词组也搜得到。
 */
export class PdfiumFind {
  constructor(viewer, eventBus) {
    this.viewer = viewer;
    this.bus = eventBus;
    this.query = "";
    this.matches = [];          // [{ page (0 起), chars: [字符下标...] }]
    this.current = -1;
    this.texts = null;          // 每页：{ str, map（str 下标 → 字符下标） }
    this.seq = 0;
    this.onFind = (e) => this.find(e);
    this.onClose = () => this.clear();
    eventBus.on("find", this.onFind);
    eventBus.on("findbarclose", this.onClose);
  }

  async pageTexts() {
    if (this.texts) return this.texts;
    const doc = this.viewer.doc;
    const out = [];
    for (let i = 0; i < doc.numPages; i++) {
      const { codes } = await doc.text(i);
      let str = "", map = [];
      for (let k = 0; k < codes.length; k++) {
        let ch = codes[k] ? String.fromCodePoint(codes[k]) : "";
        if (!ch) continue;
        if (/\s/.test(ch)) { if (str.endsWith(" ")) continue; ch = " "; }
        for (const c of ch.toLowerCase()) { str += c; map.push(k); }
      }
      out.push({ str, map });
    }
    return (this.texts = out);
  }

  async find({ query, type, findPrevious }) {
    const q = String(query || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!this.viewer.doc) return;
    if (!q) { this.clear(); return; }
    const seq = ++this.seq;
    if (type === "again" && q === this.query && this.matches.length) {
      this.current = (this.current + (findPrevious ? -1 : 1) + this.matches.length) % this.matches.length;
    } else {
      const texts = await this.pageTexts();
      if (seq !== this.seq) return;
      this.query = q;
      this.matches = [];
      texts.forEach(({ str, map }, page) => {
        for (let i = str.indexOf(q); i !== -1; i = str.indexOf(q, i + 1)) {
          this.matches.push({ page, chars: map.slice(i, i + q.length) });
        }
      });
      // 从当前页开始往后找第一处
      const cur = this.viewer.currentPageNumber - 1;
      const first = this.matches.findIndex(m => m.page >= cur);
      this.current = this.matches.length ? (first === -1 ? 0 : first) : -1;
    }
    await this.paint();
    if (seq !== this.seq) return;
    this.reveal();
    this.bus.dispatch("updatefindmatchescount", { matchesCount: { current: this.current + 1, total: this.matches.length } });
  }

  /** 每处命中的外框：同一行的字并成一个矩形（单位：点） */
  async rectsOf(m) {
    const { boxes } = await this.viewer.doc.text(m.page);
    const rects = [];
    for (const k of m.chars) {
      const x = boxes[k * 4], y = boxes[k * 4 + 1], w = boxes[k * 4 + 2], h = boxes[k * 4 + 3];
      if (!(w > 0)) continue;
      const last = rects[rects.length - 1];
      if (last && Math.min(last.y + last.h, y + h) - Math.max(last.y, y) > Math.min(h, last.h) * 0.3 && x >= last.x - 1) {
        const x1 = Math.max(last.x + last.w, x + w), y0 = Math.min(last.y, y), y1 = Math.max(last.y + last.h, y + h);
        last.w = x1 - last.x; last.y = y0; last.h = y1 - y0;
      } else rects.push({ x, y, w, h });
    }
    return rects;
  }

  async paint() {
    const byPage = new Map();
    this.matches.forEach((m, i) => { (byPage.get(m.page) || byPage.set(m.page, []).get(m.page)).push([m, i]); });
    this.viewer.views.forEach(v => { if (!byPage.has(v.index)) v.div.querySelector(":scope > .rh-find")?.remove(); });
    for (const [page, list] of byPage) {
      const v = this.viewer.views[page];
      const size = v.size;
      let layer = v.div.querySelector(":scope > .rh-find");
      if (!layer) { layer = document.createElement("div"); layer.className = "rh-find"; v.div.appendChild(layer); }
      const kids = [];
      for (const [m, i] of list) {
        for (const r of await this.rectsOf(m)) {
          const d = document.createElement("div");
          d.className = i === this.current ? "highlight selected" : "highlight";
          d.style.cssText = `left:${r.x / size.width * 100}%;top:${r.y / size.height * 100}%;width:${r.w / size.width * 100}%;height:${r.h / size.height * 100}%`;
          kids.push(d);
        }
      }
      layer.replaceChildren(...kids);
    }
  }

  /** 当前这一处滚到视野中间（横向也看得见） */
  reveal() {
    const m = this.matches[this.current];
    if (!m) return;
    const v = this.viewer.views[m.page];
    const el = v.div.querySelector(":scope > .rh-find .selected");
    const c = this.viewer.container;
    if (!el) { this.viewer.scrollToPage(m.page + 1); return; }
    const er = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
    c.scrollTop += er.top - cr.top - c.clientHeight / 2 + er.height / 2;
    if (er.left < cr.left || er.right > cr.right) c.scrollLeft += er.left - cr.left - c.clientWidth / 2;
  }

  clear() {
    this.seq++;
    this.query = "";
    this.matches = [];
    this.current = -1;
    this.viewer.views.forEach(v => v.div.querySelector(":scope > .rh-find")?.remove());
  }

  destroy() {
    this.bus.off("find", this.onFind);
    this.bus.off("findbarclose", this.onClose);
    this.clear();
  }
}
