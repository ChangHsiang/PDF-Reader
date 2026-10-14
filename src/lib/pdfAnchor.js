/**
 * PDF 标注的**锚点**：选中的文字 ↔ 页面上的位置。
 *
 * 两套锚点同时存，缺一不可：
 * - **坐标**（页码 + 归一化矩形）：画高亮用，同一版论文里精确、零成本。
 * - **文本引用**（quote + 前后各 32 字）：坐标失效时用来重新找回来。
 *   什么时候会失效？作者更新了论文（arXiv v1 → v2），正文整体挪位置 ——
 *   这时坐标会把高亮画到毫不相干的地方，比不画还糟。
 *
 * 坐标**归一化到 0..1**，不是像素：用户缩放、换设备、按宽度重排之后都不用重算。
 *
 * **量的是 `.canvasWrapper` 不是 `.page`**（踩过同源的坑）：pdf.js 给 `.page`
 * 加了 9px 透明边框，而我们又在 index.css 里把它改回了 content-box —— 两个盒子
 * 差 18px，拿错了整层高亮就会往右下偏，越往右下差得越多（当初文字层错位一模一样）。
 */

const CTX = 32;   // 前后上下文各取多少字

/** 从 URL 推出稳定的 paper_key。**带上版本号**：不带的话 arXiv 永远给最新版，
 *  作者一更新，老标注的坐标就全错位了（而我们连「换版本了」都察觉不到） */
export function paperKeyFromUrl(url) {
  const id = arxivIdFromUrl(url);
  return id ? `arxiv:${id}` : "";
}

/* ── arXiv 号（和网站 lib/paperComments 同一套规则） ─────────────────── */

/** 新式 `2608.20339` / 老式 `cond-mat.str-el/0512345`，可带版本号。
    **老式号也认**：网站那条正则只取最后一段，老式号会被切成 `0512345`；
    插件这里只接 arXiv，认不出来就整页没法用，所以放宽 */
const ARXIV_ID = String.raw`(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z-]+)?\/\d{7})(?:v\d+)?`;
const ARXIV_ID_RE = new RegExp(`^${ARXIV_ID}$`, "i");
const ARXIV_URL_RE = new RegExp(String.raw`arxiv\.org\/(?:pdf|abs)\/(${ARXIV_ID})(?:\.pdf)?\/?(?:[?#].*)?$`, "i");

export const isArxivId = (id) => ARXIV_ID_RE.test(String(id || "").trim());
export const arxivIdFromUrl = (url) => ARXIV_URL_RE.exec(url || "")?.[1] || "";
/** 去掉尾部版本号：`2608.20339v1` → `2608.20339` */
export const stripVersion = (id) => String(id || "").trim().replace(/v\d+$/i, "");
/** 评论的 key **不带版本号**（v1 和 v2 底下的讨论说的是同一篇；和笔记正好相反，见 0029） */
export const commentKeyOf = (paperKey) => {
  const m = /^arxiv:(.+)$/.exec(paperKey || "");
  return m ? `arxiv:${stripVersion(m[1])}` : "";
};

/** 'arxiv:2301.12345v2' → { base:'arxiv:2301.12345', version:2 }；没版本号 version 为 null */
export function splitPaperKey(key) {
  const m = /^(.*?)v(\d+)$/.exec(key || "");
  return m ? { base: m[1], version: Number(m[2]) } : { base: key || "", version: null };
}

/** 这两个 key 是不是同一篇论文（版本可以不同） */
export const samePaper = (a, b) => splitPaperKey(a).base === splitPaperKey(b).base;

/** 页面元素 → 用来归一化的盒子（canvas 那一层，见文件头的说明） */
function pageBox(pageEl) {
  const wrap = pageEl.querySelector(".canvasWrapper") || pageEl;
  return wrap.getBoundingClientRect();
}

/**
 * 当前选区 → 按页拆开的锚点数组。
 * 一次选中可能跨好几页，每页各出一条（页级的 rects 各自归一化到自己那一页）。
 * 返回 `[{ page, rects, quote, prefix, suffix }]`，选区为空或不在 PDF 里则返回 []。
 */
export function anchorsFromSelection(sel, container) {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const quote = sel.toString().replace(/\s+/g, " ").trim();
  if (!quote) return [];
  // 选区必须落在 PDF 容器里，否则页面上别处选字也会弹工具条
  if (container && !container.contains(range.commonAncestorContainer)) return [];

  /* 按 `.page` 分组：`getClientRects()` 给的是一堆行矩形（一行一个），
     它不告诉你哪一行属于哪一页 —— 用矩形中心点去命中页面元素 */
  const pages = [...(container || document).querySelectorAll(".pdfViewer .page")];
  const boxes = pages.map(p => ({ el: p, num: Number(p.dataset.pageNumber), box: pageBox(p) }));
  const byPage = new Map();

  for (const r of range.getClientRects()) {
    if (r.width < 0.5 || r.height < 0.5) continue;     // 折行处的零宽矩形
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = boxes.find(b => cx >= b.box.left && cx <= b.box.right && cy >= b.box.top && cy <= b.box.bottom);
    if (!hit) continue;
    const { box } = hit;
    const list = byPage.get(hit.num) || [];
    list.push({
      x: (r.left - box.left) / box.width,
      y: (r.top - box.top) / box.height,
      w: r.width / box.width,
      h: r.height / box.height,
    });
    byPage.set(hit.num, list);
  }
  if (!byPage.size) return [];

  const { prefix, suffix } = contextAround(range);
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, rects]) => ({ page, rects: mergeRows(rects), quote, prefix, suffix }));
}

/**
 * 区域框选 → 锚点。`rect` 是已经归一化到这一页的 {x,y,w,h}。
 *
 * quote 存**框里能抽到的文字**（图注、坐标轴标签、公式里的字母）——
 * 只为了在侧栏里能被搜到，不指望它重锚：图里的字碎、重复多，靠不住。
 * 取法是看文字层的 span **中心点**落没落在框里，比求交集干净（框边上压到半个字不算）。
 */
export function areaAnchor(pageEl, rect) {
  const box = pageBox(pageEl);
  const L = box.left + rect.x * box.width, T = box.top + rect.y * box.height;
  const R = L + rect.w * box.width, B = T + rect.h * box.height;
  const words = [];
  pageEl.querySelectorAll(".textLayer span").forEach(sp => {
    if (sp.children.length) return;                    // 只认叶子，免得父子各算一遍
    const r = sp.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= L && cx <= R && cy >= T && cy <= B && sp.textContent.trim()) words.push(sp.textContent);
  });
  const quote = words.join(" ").replace(/\s+/g, " ").trim().slice(0, 500) || null;
  const round = (v) => +Math.min(1, Math.max(0, v)).toFixed(5);
  return {
    page: Number(pageEl.dataset.pageNumber),
    rects: [{ x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) }],
    quote, prefix: null, suffix: null, kind: "area",
  };
}

/** 页面元素 → 归一化用的盒子（导出给框选拖拽时换算坐标） */
export const pageCanvasBox = pageBox;

/**
 * 把同一行里被拆碎的矩形并起来。
 * pdf.js 的文字层是一个个 span，一行文字常常被切成十几段 —— 不合并的话
 * 一条高亮要存几十个矩形，画出来还会因为亚像素缝隙一道一道的。
 */
function mergeRows(rects) {
  const rows = [];
  for (const r of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find(g => Math.abs(g.y - r.y) < r.h * 0.5 && Math.abs(g.h - r.h) < r.h * 0.5);
    if (row && r.x <= row.x + row.w + 0.01) {          // 同一行且接得上
      row.w = Math.max(row.x + row.w, r.x + r.w) - row.x;
      row.y = Math.min(row.y, r.y);
      row.h = Math.max(row.h, r.h);
    } else if (row) {
      rows.push({ ...r });
    } else {
      rows.push({ ...r });
    }
  }
  return rows.map(r => ({
    x: +r.x.toFixed(5), y: +r.y.toFixed(5), w: +r.w.toFixed(5), h: +r.h.toFixed(5),
  }));
}

/** 选区前后各取 CTX 个字，作为重锚点时的「指纹」 */
function contextAround(range) {
  const textOf = (node) => (node?.textContent || "");
  const layer = range.startContainer.parentElement?.closest?.(".textLayer");
  if (!layer) return { prefix: "", suffix: "" };
  const all = textOf(layer);
  const before = document.createRange();
  before.setStart(layer, 0);
  try { before.setEnd(range.startContainer, range.startOffset); } catch { return { prefix: "", suffix: "" }; }
  const head = before.toString();
  const start = head.length;
  const end = start + range.toString().length;
  return {
    prefix: all.slice(Math.max(0, start - CTX), start).replace(/\s+/g, " "),
    suffix: all.slice(end, end + CTX).replace(/\s+/g, " "),
  };
}

/* ── 四期：跨版本重锚 ──────────────────────────────────────────────── */

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

/**
 * 在**整篇文档的文字**里找回一条标注的位置。
 * 只在「标注做于另一个版本」时才走这条路 —— 同版本直接用坐标，别多花这个钱。
 *
 * `pageTexts`：`[{ page, text }]`，由 PdfViewer 用 `page.getTextContent()` 攒出来。
 * 命中返回页码，没命中返回 null（调用方把它降级成页级笔记，并标「位置可能不准」）。
 *
 * 匹配顺序：**prefix+quote+suffix 整体** → 只有 quote。
 * 先带上下文是因为论文里「we show that」这种短句能出现几十次，
 * 只匹配 quote 会锚到完全不相干的段落 —— 那比锚不上还糟。
 */
export function reanchorByQuote(pageTexts, { quote, prefix, suffix, page }) {
  const q = norm(quote);
  if (!q) return null;
  const withCtx = norm(`${prefix || ""} ${q} ${suffix || ""}`);

  const tryFind = (needle) => {
    if (!needle) return null;
    // 原来那一页优先：论文改版大多只挪一两页，先看邻近的能省很多无用功
    const order = [...pageTexts].sort(
      (a, b) => Math.abs(a.page - page) - Math.abs(b.page - page));
    for (const p of order) {
      if (norm(p.text).includes(needle)) return p.page;
    }
    return null;
  };

  return tryFind(withCtx) ?? tryFind(q);
}
