/**
 * 让文字层（看不见、用来选字的那一层）和画出来的字对齐到「词」。
 *
 * 为什么会偏：pdf.js 的文字层一行一个 span，用系统的 sans-serif 写，再整体横向拉伸到这一行在 PDF 里的宽度。
 * 论文用的是 Computer Modern 之类的字体，每个字母的宽度比例和系统字体差很多 —— 整行两头对上了，
 * 中间的词就前后错开：选中行中间的一个词，高亮框偏左或偏右，边上像多选了个空格（Edge 用的是真实字形位置，所以准）。
 *
 * 做法：页面画完后看画布像素，找出这一行里每个词实际画在哪儿（词和词之间是一段没有墨迹的空白），
 * 然后把这一行的 span 拆成「词 + 空格」的小块，每块用字间距调到正好盖住它的词。
 * - 拆完 span 的文字一字不变（textContent 还是原来那串），所以复制、搜索、标注的上下文全都不受影响
 * - 词数和墨迹段数对不上（公式、上下标、图里的字、空格被压得太窄）就不拆，保持 pdf.js 原样
 * - 宽度用 em：pdf.js 缩放时不重建文字层、只改字号的 CSS 变量，用 px 的话一缩放就又错开了
 * - 原来那个 span 留着（只是里面换成了小块）：pdf.js 的查找高亮靠的就是这些 span 的引用
 */

const INK = 160;          // 亮度低于它算墨迹（黑字、蓝色链接都算；论文里浅灰底的框不算）

/* 小块用的字体（index.css 的 rh-tight）提前加载：量自然宽度时字体还没到的话，量的是后备字体，
   字体一到宽度就变了，对齐全白做 */
const FONT = "16px rh-tight";
try { document.fonts?.load(FONT); } catch { /* 不支持就用 sans-serif，照样能对齐 */ }

/**
 * 这一行字身的上下边（屏幕坐标）：上 = 大写字母 / 升部的顶，下 = 基线。逐行数墨迹：
 * 升部那几行只有 b d l k 和大写字母有墨迹，所以门槛低（最多那一行的 8%）；
 * 基线以下只剩 g p y 的降部，墨迹骤减，所以基线取「还有 30% 墨迹」的最后一行。
 * 上下只多看小半行，别数到上一行 / 下一行的字
 */
function inkBody(data, W, H, x0, x1, r, cr, sy) {
  const ya = Math.max(0, Math.round((r.top - cr.top - r.height * 0.15) * sy));
  const yb = Math.min(H - 1, Math.round((r.bottom - cr.top + r.height * 0.2) * sy));
  const cnt = [];
  let max = 0;
  for (let y = ya; y <= yb; y++) {
    let c = 0;
    for (let x = x0; x <= x1; x += 2) {
      const i = (y * W + x) * 4;
      if (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 < INK) c++;
    }
    cnt.push(c);
    if (c > max) max = c;
  }
  if (!max) return null;
  const top = cnt.findIndex(c => c >= max * 0.08);
  let base = cnt.length - 1;
  while (base > top && cnt[base] < max * 0.3) base--;
  return { top: cr.top + (ya + top) / sy, base: cr.top + (ya + base + 1) / sy };
}

export function refineTextLayer(pageEl) {
  const tl = pageEl.querySelector(".textLayer");
  const canvas = pageEl.querySelector(".canvasWrapper canvas");
  if (!tl || !canvas?.width || tl.querySelector(".highlight")) return;   // 查找高亮着的时候别动
  if (document.fonts && !document.fonts.check(FONT)) return;   // 字体还在路上：下次再做
  /* 这一页做过了就别再扫：放大后 pdf.js 边滚边重绘可视区，pagerendered 是连续来的。
     查找结束时 pdf.js 会把 span 的文字还原（小块没了），那时由调用方清掉这个标记重做 */
  if (tl.dataset.rhDone) return;
  tl.dataset.rhDone = "1";

  const spans = [...tl.querySelectorAll("span")].filter(s =>
    !s.classList.contains("markedContent") && !s.classList.contains("rh-w") && !s.dataset.rhSkip
    && !s.querySelector(".rh-w") && s.firstChild?.nodeType === 3 && s.childNodes.length === 1
    && /\S\s+\S/.test(s.textContent));
  if (!spans.length) return;

  /* 画布可能不止一张：放大后 pdf.js 的整页画布是低分辨率的（实测 150% 时 525px 宽拉伸到 1218px），
     可视区另画一张清楚的「细节」画布。每一行挑**分辨率最高、又整个盖住这一行**的那张来看，
     不然一个画布像素对应好几个屏幕像素，词的位置只能量到 ±2px */
  const srcs = [...pageEl.querySelectorAll(".canvasWrapper canvas")].map(cv => {
    const rect = cv.getBoundingClientRect();
    return { cv, rect, sx: rect.width ? cv.width / rect.width : 0, sy: rect.height ? cv.height / rect.height : 0, data: null };
  }).filter(x => x.sx > 0 && x.cv.width > 0).sort((a, b) => b.sx - a.sx);
  if (!srcs.length) return;
  const pixels = (src) => {
    if (src.data === null) {
      try { src.data = src.cv.getContext("2d").getImageData(0, 0, src.cv.width, src.cv.height).data; }
      catch { src.data = false; }
    }
    return src.data;
  };
  const covering = (r) => srcs.find(x => x.rect.left <= r.left - 4 && x.rect.right >= r.right + 4
    && x.rect.top <= r.top && x.rect.bottom >= r.bottom && pixels(x));
  /* 只拿得到模糊画布的行先不做（等滚到它、细节画布画到它时再做），不然量出来照样差一两个像素。
     有没做完的行就别打「做完了」的标记，下一次 pagerendered 接着做剩下的 */
  let deferred = 0;
  const sharpEnough = (src) => srcs.length === 1 || src.sx >= srcs[0].sx * 0.7;

  /* ① 读：每个 span 的位置、字号、当前拉伸（一次读完，别读写交替触发反复重排） */
  const jobs = [];
  for (const s of spans) {
    const r = s.getBoundingClientRect();
    const cs = getComputedStyle(s);
    const m = cs.transform.match(/matrix\(([^)]+)\)/);
    const mx = m ? m[1].split(",").map(Number) : [1, 0, 0, 1];
    if (Math.abs(mx[1]) > 1e-3 || Math.abs(mx[2]) > 1e-3) { s.dataset.rhSkip = "1"; continue; }   // 旋转的字不管
    const fontPx = parseFloat(cs.fontSize);
    if (!r.width || !fontPx || !s.offsetWidth) continue;
    jobs.push({ s, r, fontPx, fp: r.width / s.offsetWidth / (parseFloat(cs.getPropertyValue("--scale-x")) || 1) });
  }

  /* ② 算：在画布上找每个词的墨迹段 */
  const plans = [];
  for (const j of jobs) {
    const { s, r } = j;
    const words = s.textContent.split(/\s+/).filter(Boolean);
    const src = covering(r);
    if (!src || !sharpEnough(src)) { deferred++; continue; }   // 还没被清楚的画布画到：先不动
    const { rect: cr, sx, sy, data } = src;
    const W = src.cv.width, H = src.cv.height;
    // 只看字身中间那一截（避开上下两行伸出来的升部 / 降部）
    const y0 = Math.max(0, Math.round((r.top - cr.top + r.height * 0.28) * sy));
    const y1 = Math.min(H - 1, Math.round((r.top - cr.top + r.height * 0.88) * sy));
    const x0 = Math.max(0, Math.round((r.left - cr.left) * sx - 4 * sx));
    const x1 = Math.min(W - 1, Math.round((r.right - cr.left) * sx + 4 * sx));
    if (y1 <= y0 || x1 <= x0) { s.dataset.rhSkip = "1"; continue; }
    const ink = new Uint8Array(x1 - x0 + 1);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const i = (y * W + x) * 4;
        if (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 < INK) { ink[x - x0] = 1; break; }
      }
    }
    const runs = [];
    for (let i = 0; i < ink.length; i++) {
      if (!ink[i]) continue;
      const a = i;
      while (i + 1 < ink.length && ink[i + 1]) i++;
      runs.push([a + x0, i + x0]);
    }
    /* 把字母之间的小缝并掉、留下词之间的大缝。阈值按字号试几档，找一档段数正好等于词数的 */
    const em = j.fontPx * sx;
    let merged = null;
    for (const k of [0.16, 0.12, 0.2, 0.25, 0.09]) {
      const out = [];
      for (const rn of runs) {
        const last = out[out.length - 1];
        if (last && rn[0] - last[1] - 1 < em * k) last[1] = rn[1];
        else out.push([rn[0], rn[1]]);
      }
      if (out.length === words.length) { merged = out; break; }
    }
    if (!merged) { s.dataset.rhSkip = "1"; continue; }
    plans.push({ ...j, merged, cr, sx, body: inkBody(data, W, H, x0, x1, r, cr, sy) });
  }
  if (deferred) delete tl.dataset.rhDone;   // 还有行等着清楚的画布：下次接着做
  if (!plans.length) return;

  /* ③ 写：拆成「词 / 空格」小块（宽度自然），再统一读一次自然宽度 */
  for (const p of plans) {
    const parts = p.s.textContent.match(/\s+|\S+/g);
    p.s.style.setProperty("--scale-x", "1");
    p.s.classList.add("rh-split");        // 样式表靠这个类把整行拉伸压成 1（见 index.css）
    p.s.replaceChildren(...parts.map(t => {
      const c = document.createElement("span");
      c.className = "rh-w";
      c.textContent = t;
      return c;
    }));
    p.parts = parts;
  }
  /* 自然宽度要小数：offsetWidth 是取整的，每块差 ±0.5px，一行十几块累积下来，
     行尾的词能偏 4px（实测标题行「Analytic」整体左移 4px）。getBoundingClientRect 是屏幕像素、
     带着整行的缩放，除以 fp 换回这个 span 里的 CSS 像素 */
  for (const p of plans) p.natural = [...p.s.children].map(c => c.getBoundingClientRect().width / p.fp);

  /* ④ 写：每块的宽度 = 到下一个词起点的距离，靠字间距撑到正好（单位 em，缩放时跟着字号走） */
  for (const p of plans) {
    const { s, r, fontPx, fp, merged, parts, natural, cr, sx } = p;
    const local = (clientPx) => clientPx / fp / fontPx;       // 屏幕像素 → 这个 span 里的 em
    const starts = merged.map(m => cr.left + m[0] / sx);
    const ends = merged.map(m => cr.left + (m[1] + 1) / sx);
    let w = 0, prev = null;
    p.fix = [];
    const kids = [...s.children];
    kids.forEach((c, i) => {
      const t = parts[i];
      let target;                                               // 这一块应该占多宽（屏幕像素）
      if (/\S/.test(t)) {
        target = ends[w] - starts[w];
        if (i === 0) c.style.marginLeft = `${local(starts[0] - r.left)}em`;
      } else {
        // 空格：从上一个词的结尾到下一个词的开头；行首行尾的空格给一点点宽度
        target = w > 0 && w < merged.length ? starts[w] - ends[w - 1] : fontPx * 0.2 * fp;
        if (i === 0) c.style.marginLeft = `${local(starts[0] - r.left - target)}em`;
      }
      /* 用字间距把这一块撑到 / 压到目标宽度，**不用 transform: scaleX**：每块各自一个 transform，
         一页两千多块就是两千多个单独的绘制单元，滚动时新露出来的区域光栅化慢得要命
         （实测滚动中位从 24ms 一帧掉到 105ms）。字间距只是普通的行内文字，画起来和一整行没区别 */
      const nat = natural[i] || 0;
      const n = [...t].length || 1;
      const wl = local(Math.max(0.5, target));                  // 目标宽度（em）
      const ls = (wl * fontPx - nat) / n / fontPx;
      c.style.letterSpacing = `${ls}em`;
      if (/\S/.test(t)) { p.fix.push({ c, want: starts[w], prev }); w++; }
      else prev = { c, ls, n };
    });
  }

  /* ⑤ 校正：字间距按每块单独算，浏览器排版时每个字的位置还会各自取整一点点，一行十几块累积下来，
     行尾能差 1px 多（实测）。统一量一次每个词实际从哪儿开始，差多少就从它前面那个空格里补回来。
     前面的词已经补过的那部分要扣掉，不然补两遍 */
  for (const p of plans) {
    p.fix.forEach(f => { f.got = f.c.getBoundingClientRect().left; });
    if (p.fix[0]) { const b = p.fix[0].c.getBoundingClientRect(); p.box = (b.top + b.bottom) / 2; }
  }
  for (const p of plans) {
    const local = (clientPx) => clientPx / p.fp / p.fontPx;
    /* 竖直：选中框上下居中在字身（大写顶 → 基线）上。pdf.js 按 PDF 字体的上伸量摆这一行，
       和我们字体的基线不一定在一处，框会偏上或偏下（实测「Black」上面空一截、下面贴着基线）。
       用 vertical-align 挪 —— 只是行内排版的偏移，不像 transform 那样每块单独一个绘制单元 */
    if (p.body && p.box != null) {
      const dy = p.box - (p.body.top + p.body.base) / 2;      // 正 = 框偏下，要往上挪
      if (Math.abs(dy) > 0.4 && Math.abs(dy) < p.fontPx * p.fp * 0.4) p.s.style.setProperty("--rh-dy", `${local(dy)}em`);
    }
    let done = 0;
    for (const f of p.fix) {
      const err = f.got - f.want;
      if (f.prev && Math.abs(err - done) > 0.15) {
        f.prev.c.style.letterSpacing = `${f.prev.ls - local(err - done) / f.prev.n}em`;
        done = err;
      }
    }
  }
}

/** 选区两头的空白去掉（双击选词时 Windows 上会连带选中后面的空格，pdf.js 的文字层里前面也常带一个） */
export function trimSelection(sel) {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const r = sel.getRangeAt(0).cloneRange();
  const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
  const tw = document.createTreeWalker(root.closest?.(".textLayer") || root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (r.intersectsNode(n)) textNodes.push(n);
  if (!textNodes.length) return false;
  const ws = (ch) => /\s/.test(ch);
  let changed = false;
  // 起点往后挪
  for (let i = 0; i < textNodes.length; i++) {
    const n = textNodes[i];
    let off = n === r.startContainer ? r.startOffset : 0;
    while (off < n.length && ws(n.data[off])) off++;
    if (off < n.length) {
      if (n !== r.startContainer || off !== r.startOffset) { r.setStart(n, off); changed = true; }
      break;
    }
  }
  // 终点往前挪
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const n = textNodes[i];
    let off = n === r.endContainer ? r.endOffset : n.length;
    while (off > 0 && ws(n.data[off - 1])) off--;
    if (off > 0) {
      if (n !== r.endContainer || off !== r.endOffset) { r.setEnd(n, off); changed = true; }
      break;
    }
  }
  if (changed && !r.collapsed) { sel.removeAllRanges(); sel.addRange(r); }
  return changed;
}
