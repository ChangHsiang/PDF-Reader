/**
 * 文字层（看不见、用来选字的那一层），按 PDFium 给的每个字的真实外框摆。
 *
 * 和原来 pdf.js 的文字层的区别：pdf.js 只知道「这一行写了什么」，用系统字体整行拉伸，中间的词前后错开；
 * 我们之前只能拿画布像素去猜每个词在哪（lib/preciseText，误差 1~6px）。PDFium 直接给每个字的外框
 * （worker 的 text()，保留到 1/64 点），这里每个词一个 span，放在它真实的位置上：
 * - left / top 用百分比（页面缩放时不用重排），字号 = 这个词外框的高度（calc(var(--total-scale-factor) * Hpx)）
 * - 宽度靠字间距调：先用 canvas 量出这个词在文字层字体下的自然宽度，差多少用 letter-spacing（em）补，
 *   缩放时跟着字号走
 * - 字体用系统 sans-serif，字号 = 外框高度 ÷（上伸 + 下伸）→ 浏览器画的选中框正好等于外框（见 FONT 的注释）
 * - 词和词之间放一个空格 span（盖住两个词之间的缝），行和行之间放 <br>：复制出来的文字有空格、有换行
 *
 * 选择本身还是浏览器原生的：拖选、双击选词、三击、Shift 扩选、Ctrl+C、右键都现成，
 * 上面读 window.getSelection() 的功能（划选工具条、高亮、翻译）原样能用。
 */

/* 字体用系统的 Arial / sans-serif，**不用** index.css 里那个改了上下伸的 rh-tight：实测 rh-tight（local() 字体 +
   metric override）让一页九百个词的排版从 39ms 变成 174ms，滚动时一卡就是几百毫秒。
   选中框的高度 = 这个字体的上伸 + 下伸（约 1.12 个字号），所以字号取「外框高度 ÷ 这个比例」，内容区正好等于外框；
   比例开页时量一次（不同系统的 sans-serif 不一样） */
const FONT = "Arial, sans-serif";
const P = 96 / 72;                // 1 点 = 96/72 CSS 像素（100% 缩放）
let measureCtx = null;
let ratio = 0;                    // 内容区高度 / 字号
function contentRatio() {
  if (ratio) return ratio;
  const probe = document.createElement("span");
  probe.textContent = "Hg";
  probe.style.cssText = `position:absolute;visibility:hidden;font:100px ${FONT};line-height:1;white-space:pre`;
  document.body.appendChild(probe);
  const rg = document.createRange();
  rg.selectNodeContents(probe);
  const h = rg.getBoundingClientRect().height;
  probe.remove();
  ratio = h > 50 ? h / 100 : 1.15;
  return ratio;
}

/* LaTeX 的重音是单独画的一个字形（´ 叠在 e 上），PDFium 给出来是两个字符「´e」——复制、搜索、翻译都会是
   「D´epartement」。和后面那个字母叠在一起的间距类重音，换成组合符号再合成（é），框取两者的并集 */
const ACCENT = {
  "´": "́", "`": "̀", "¨": "̈", "ˆ": "̂", "^": "̂", "˜": "̃",
  "~": "̃", "¸": "̧", "ˇ": "̌", "˘": "̆", "˚": "̊", "¯": "̄",
  "˙": "̇", "˝": "̋",
};

/** 字符 → 词 / 空格 / 换行。返回 [{ t: "w", text, x, y, w, h, b（第一个字的基线） } | { t: "s" } | { t: "br" }]，坐标单位：点 */
export function tokenize({ codes, boxes, flags, base }) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  const pushSep = (t) => { if (out.length && out[out.length - 1].t === "w") out.push({ t }); else if (t === "br" && out.length && out[out.length - 1].t === "s") out[out.length - 1] = { t }; };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!code) continue;
    // 行尾断词的连字符：PDFium 给的是控制字符 U+0002（复制出来是「prescrip」+ 一个看不见的字符），换回「-」
    let ch = code === 2 || (flags[i] & 2) ? "-" : String.fromCodePoint(code);
    // 间距类重音 + 紧跟着的字母（横向重叠）→ 合成一个字
    const comb = ACCENT[ch];
    if (comb && i + 1 < codes.length && codes[i + 1] && boxes[i * 4 + 2] > 0 && boxes[(i + 1) * 4 + 2] > 0
        && Math.min(boxes[i * 4] + boxes[i * 4 + 2], boxes[(i + 1) * 4] + boxes[(i + 1) * 4 + 2]) - Math.max(boxes[i * 4], boxes[(i + 1) * 4]) > 0) {
      // LaTeX 给 i 加重音时用的是无点的 ı（\'{\i}），「ı + 重音」没有合成字 —— 先换回 i 再合成（í）
      const next = String.fromCodePoint(codes[i + 1]).replace("ı", "i").replace("ȷ", "j");
      if (/\p{L}/u.test(next)) {
        // 把重音的框并进字母的框，跳过重音本身
        const j = i + 1;
        const x0 = Math.min(boxes[i * 4], boxes[j * 4]), y0 = Math.min(boxes[i * 4 + 1], boxes[j * 4 + 1]);
        const x1 = Math.max(boxes[i * 4] + boxes[i * 4 + 2], boxes[j * 4] + boxes[j * 4 + 2]);
        const y1 = Math.max(boxes[i * 4 + 1] + boxes[i * 4 + 3], boxes[j * 4 + 1] + boxes[j * 4 + 3]);
        boxes[j * 4] = x0; boxes[j * 4 + 1] = y0; boxes[j * 4 + 2] = x1 - x0; boxes[j * 4 + 3] = y1 - y0;
        codes[j] = (next + comb).normalize("NFC").codePointAt(0);
        continue;
      }
    }
    if (ch === "\r") continue;
    if (ch === "\n") { flush(); pushSep("br"); continue; }
    if (/\s/.test(ch)) { flush(); pushSep("s"); continue; }
    const w = boxes[i * 4 + 2], h = boxes[i * 4 + 3];
    if (!(w > 0 && h > 0)) { if (cur) cur.text += ch; continue; }      // 没有外框的字（组合符号之类）挂在前一个词上
    const x = boxes[i * 4], y = boxes[i * 4 + 1];
    if (cur) {
      // 和前一个字在不在「同一个词」：竖直方向有重叠（上下标也算同一行），而且横向接得上（缝不超过 0.25 个字高）
      const overlap = Math.min(cur.y + cur.h, y + h) - Math.max(cur.y, y);
      const gap = x - (cur.x + cur.w);
      const sameLine = overlap > Math.min(h, cur.h) * 0.3;
      if (!sameLine || gap > Math.max(h, cur.h) * 0.25 || gap < -Math.max(h, cur.h)) {
        flush();
        pushSep(sameLine ? "s" : "br");
      }
    }
    if (!cur) cur = { t: "w", text: ch, x, y, w, h, b: base?.[i] || y + h };
    else {
      const x1 = Math.max(cur.x + cur.w, x + w), y0 = Math.min(cur.y, y), y1 = Math.max(cur.y + cur.h, y + h);
      cur.text += ch;
      cur.w = x1 - cur.x; cur.y = y0; cur.h = y1 - y0;
    }
  }
  flush();
  return out;
}

/** 这段文字在文字层字体下的自然宽度（单位：字号 = 1 时的宽度） */
function natural(text) {
  measureCtx ||= document.createElement("canvas").getContext("2d");
  measureCtx.font = `100px ${FONT}`;   // 和文字层同一个字体
  return measureCtx.measureText(text).width / 100;
}

/**
 * 生成一页的文字层：返回 { layer（空的 .textLayer 外壳）, nodes（按阅读顺序的 span / br） }。
 * 节点不直接塞进去：调用方在空闲时分批 append（一次全塞，第一次排版要一两百毫秒，见 viewer.js 的 _pumpText）
 */
export function buildTextLayer(data, size) {
  const k = contentRatio();
  const items = tokenize(data);
  const W = size.width, H = size.height;
  const layer = document.createElement("div");
  layer.className = "textLayer";
  // 行高 = 内容区比例：内容区的顶正好是 span 的顶（line-height: 1 的话内容区比行高大，会上下各冒出一截）
  layer.style.lineHeight = String(k);
  layer.style.width = `${W * P}px`;            // 100% 缩放下的页面尺寸；当前倍数由 transform 缩（index.css）
  layer.style.height = `${H * P}px`;
  const frag = document.createDocumentFragment();
  /* 坐标、字号全用 100% 缩放下的固定像素，整个文字层再用一个 transform 缩放到当前倍数（见 index.css）：
     缩放时一个词都不用重排（以前字号写成 calc(var(--total-scale-factor) * …)，每个词都要重新算）。
     宽度用 letter-spacing 撑到外框宽度。试过每个词一个 transform: scaleX —— 排版快，但滚动时新露出来的区域
     要逐个画变形过的字，95% 的帧从 17ms 掉到 34~50ms（实测）；字间距只在第一次排版时贵，所以文字层改成
     滚动停下来之后再分批建（见 viewer.js 的 _buildText），不在滚动途中排版 */
  const span = (text, x, y, w, h) => {
    const s = document.createElement("span");
    s.textContent = text;
    const fs = h / k * P;                         // 字号（px）：让内容区（选中框）正好等于外框高度
    const n = [...text].length || 1;
    const ls = (w * P - natural(text) * fs) / n;  // px：撑到外框宽度还差多少，平分给每个字
    s.style.cssText = `left:${(x * P).toFixed(2)}px;top:${(y * P).toFixed(2)}px;font-size:${fs.toFixed(2)}px` +
      (Math.abs(ls) > 0.005 ? `;letter-spacing:${ls.toFixed(3)}px` : "");
    frag.appendChild(s);
    return s;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.t === "w") { span(it.text, it.x, it.y, it.w, it.h); continue; }
    if (it.t === "br") { frag.appendChild(document.createElement("br")); continue; }
    // 空格：盖住前后两个词之间的缝（同一行时）；接不上的话给一个很窄的空格，只为复制时有空格
    const a = items[i - 1], b = items[i + 1];
    if (a?.t === "w" && b?.t === "w" && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0 && b.x > a.x + a.w) {
      span(" ", a.x + a.w, Math.min(a.y, b.y), b.x - (a.x + a.w), Math.max(a.h, b.h));
    } else if (a?.t === "w") {
      span(" ", a.x + a.w, a.y, Math.max(0.01, a.h * 0.05), a.h);
    }
  }
  layer.dataset.words = String(items.filter(x => x.t === "w").length);
  return { layer, nodes: [...frag.childNodes] };
}

/**
 * 拖选由我们接管（单击拖动；双击选词、三击选行仍交给浏览器）：
 * 每个词都是绝对定位的，鼠标落在字和字之间的空白里时，浏览器不知道「最近的字」是哪个，
 * 选区会一下子跳到这一页的开头或结尾（实测：从行间空白拖，选中了整个标题区）。Edge 的做法是吸附到最近的字，这里照做：
 * - 按下：起点 = 鼠标下的字的位置；在空白里就取最近的那个词（竖直距离优先，同一行里再比横向）
 * - 拖动：终点同样取鼠标下 / 最近的字，可以跨页；靠近阅读区上下边缘时自动滚动
 * - Shift + 点击：从原来的起点扩到这里
 */
export function installSelectionHelper(container) {
  let drag = null;               // { layer, timer, lastX, lastY }

  /** 一个文字层里离 (x, y) 最近的字符位置：[文本节点, 偏移] */
  const posIn = (layer, x, y) => {
    let best = null, bd = Infinity;
    for (const s of layer.children) {
      if (s.tagName !== "SPAN" || !s.firstChild) continue;
      const r = s.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const d = dy * 8 + dx;             // 先找同一行（竖直距离权重大），再找横向最近
      if (d < bd) { bd = d; best = { s, r }; }
      if (d === 0) break;
    }
    if (!best) return null;
    const t = best.s.firstChild, r = best.r;
    if (x <= r.left) return [t, 0];
    if (x >= r.right) return [t, t.length];
    // 词内：逐个字符量，落在哪个字的左半边就停在它前面
    const rg = document.createRange();
    for (let k = 0; k < t.length; k++) {
      rg.setStart(t, k); rg.setEnd(t, k + 1);
      const cr = rg.getBoundingClientRect();
      if (x < cr.left + cr.width / 2) return [t, k];
    }
    return [t, t.length];
  };
  /** 鼠标下是哪一页的文字层（在页与页的缝里就沿用上一次的） */
  const layerAt = (x, y, fallback) => {
    const page = document.elementsFromPoint(x, y).find(e => e.classList?.contains("page"));
    return page?.querySelector(":scope > .textLayer") || fallback;
  };

  const extend = (x, y) => {
    if (!drag) return;
    const layer = layerAt(x, y, drag.layer);
    drag.layer = layer;
    const p = posIn(layer, x, y);
    if (p) getSelection().extend(p[0], p[1]);
  };
  /* 三击选一整行：每个词都是绝对定位的块，浏览器的「三击选段落」只会选中一个词（实测）。
     这一行 = 前后两个 <br> 之间的那些 span */
  const selectLine = (span) => {
    let first = span, last = span;
    for (let n = span.previousElementSibling; n && n.tagName === "SPAN"; n = n.previousElementSibling) first = n;
    for (let n = span.nextElementSibling; n && n.tagName === "SPAN"; n = n.nextElementSibling) last = n;
    // 行首行尾的空格 span 不算
    while (first !== last && !first.textContent.trim()) first = first.nextElementSibling;
    while (last !== first && !last.textContent.trim()) last = last.previousElementSibling;
    const rg = document.createRange();
    rg.setStart(first.firstChild, 0);
    rg.setEnd(last.firstChild, last.firstChild.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(rg);
  };
  const down = (e) => {
    if (e.button === 0 && e.detail === 3 && e.target?.tagName === "SPAN" && e.target.parentElement?.classList.contains("textLayer")) {
      e.preventDefault();
      selectLine(e.target);
      return;
    }
    if (e.button !== 0 || e.detail > 1) return;                // 双击选词：交给浏览器（一个词就是一个 span，正好）
    const layer = e.target?.closest?.(".textLayer");
    if (!layer || !container.contains(layer)) return;
    const sel = getSelection();
    const p = posIn(layer, e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    // 拦了默认行为，焦点不会自己离开输入框（搜索框、批注框）：手动让它失焦，和点页面的老习惯一致
    const ae = document.activeElement;
    if (ae && ae !== document.body && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) ae.blur();
    if (e.shiftKey && sel.rangeCount) sel.extend(p[0], p[1]);
    else sel.collapse(p[0], p[1]);
    drag = { layer, lastX: e.clientX, lastY: e.clientY, timer: 0 };
    // 靠近上下边缘时持续滚动（自己接管了拖选，浏览器的自动滚动就没了）
    drag.timer = setInterval(() => {
      const cr = container.getBoundingClientRect();
      const edge = 36;
      const dy = drag.lastY < cr.top + edge ? -(cr.top + edge - drag.lastY) : drag.lastY > cr.bottom - edge ? drag.lastY - (cr.bottom - edge) : 0;
      if (dy) { container.scrollTop += Math.max(-40, Math.min(40, dy)); extend(drag.lastX, drag.lastY); }
    }, 30);
  };
  const move = (e) => {
    if (!drag) return;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    extend(e.clientX, e.clientY);
  };
  const up = () => {
    if (!drag) return;
    clearInterval(drag.timer);
    drag = null;
  };
  container.addEventListener("mousedown", down);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  return () => {
    container.removeEventListener("mousedown", down);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (drag) clearInterval(drag.timer);
  };
}

/** 选区两头的空白去掉（双击选词时 Windows 上会连带选中后面的空格；文字层里词和词之间是单独的空格 span） */
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
