import { useEffect, useRef, useState } from "react";
import { Avatar, UserLink, MathText } from "./bits";
import { normTags } from "../lib/notes";
import { pageCanvasBox } from "../lib/pdfAnchor";
import { useKeepInView } from "../lib/useKeepInView";

/**
 * PDF 笔记的三块 UI：高亮层、划选工具条、笔记列表（+ 移动端的浮动入口）。
 * 数据层在 lib/paperNotes.js，锚点数学在 lib/pdfAnchor.js。
 *
 * 这些都活在 PdfViewer 的**固定深色底**上，所以白色一律写死 `#fff`/`#ffffffXX` ——
 * `white` token 在深色模式下是卡面色 #212121，会直接看不见（灯箱踩过）。
 */

export const COLORS = {
  yellow: "255,213,0",
  red:    "230,30,30",      // 大红：网站那套只有五色，插件加的；网站上没有这个色名会按黄色画
  green:  "64,206,120",
  blue:   "80,170,255",
  pink:   "255,120,180",
  purple: "180,130,255",
  black:  "34,34,34",       // 画笔最常用的颜色；高亮选黑色会是一层灰，也能用
};
export const rgba = (name, a) => `rgba(${COLORS[name] || COLORS.yellow},${a})`;

/* ── 手写笔迹（kind = "ink"）────────────────────────────────────────────
   一笔一条标注。rects 里放 [{ x, y, w, h, path: [[x,y],…], lw }]：
   x/y/w/h 是这一笔的外接框（列表排序、跳转定位这些通用逻辑照旧按 rects[0] 用），
   path 是归一化到这一页的点（x 按页宽、y 按页高，0..1），lw 是线宽占页宽的比例 ——
   都是比例，所以缩放时笔迹跟着页面一起变大变小，不用重算。

   画成一张铺满页面的 SVG：viewBox 宽 1000、高按这一页的宽高比，点乘回去。
   **不用 preserveAspectRatio="none" 拉伸**：页面不是正方形，拉伸会让横竖方向的线粗细不一样 */
const SVGNS = "http://www.w3.org/2000/svg";
export const inkPathD = (pts, H) => pts.map(([x, y], i) => `${i ? "L" : "M"}${(x * 1000).toFixed(1)} ${(y * H).toFixed(1)}`).join("")
  + (pts.length === 1 ? `l0.01 0` : "");          // 只点了一下：画成一个圆点

export function inkSvg(inks, box, activeId = null) {
  const H = 1000 * (box.height / Math.max(1, box.width));
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 1000 ${H.toFixed(1)}`);
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none";
  for (const a of inks) {
    const on = a.id === activeId;
    for (const st of a.rects || []) {
      if (!st.path?.length) continue;
      const d = inkPathD(st.path, H);
      const w = Math.max(0.6, (st.lw || 0.003) * 1000);
      const mk = (stroke, width, extra = "") => {
        const el = document.createElementNS(SVGNS, "path");
        el.setAttribute("d", d);
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", stroke);
        el.setAttribute("stroke-width", String(width));
        el.setAttribute("stroke-linecap", "round");
        el.setAttribute("stroke-linejoin", "round");
        el.style.cssText = extra;
        return el;
      };
      if (on) svg.appendChild(mk(rgba(a.color, 0.28), w + 8));              // 选中：外面一圈淡色光晕
      svg.appendChild(mk(rgba(a.color, 0.95), w, "pointer-events:none"));
      /* 点击热区：一条透明的粗线（细笔迹本身根本点不中）。只吃描边、不吃填充 */
      const hit = mk("transparent", Math.max(w + 10, 14), "pointer-events:stroke;cursor:pointer");
      hit.dataset.annId = String(a.id);
      svg.appendChild(hit);
    }
  }
  return svg;
}

/* ── 文本框（kind = "text"，参照 Edge 的「添加文本」）──────────────────────
   rects = [{ x, y, w, h }]（归一化到页面；h 只是存的时候量的高度，显示时按内容自适应），
   body = 文字内容，style = { size, spacing }：字号 / 字间距，单位是 PDF 的 pt。
   显示时写成 calc(var(--total-scale-factor) * Npx) —— 那是 pdf.js 挂在每一页上的缩放系数，
   所以缩放时字号跟着页面一起变，一行代码都不用跑（同高亮矩形用百分比的思路） */
export const TEXT_FONT = "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
export function textBoxEl(a, on) {
  const r = a.rects[0];
  const d = document.createElement("div");
  const size = a.style?.size || 12, sp = a.style?.spacing || 0;
  d.style.cssText =
    `position:absolute;left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;` +
    `font:calc(var(--total-scale-factor) * ${size}px)/1.3 ${TEXT_FONT};` +
    `letter-spacing:calc(var(--total-scale-factor) * ${sp}px);color:${rgba(a.color, 1)};` +
    "white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:auto;cursor:text;padding:2px 4px;box-sizing:border-box;" +
    (on ? `outline:1.5px dashed ${rgba(a.color, 0.8)};outline-offset:1px;border-radius:2px;` : "");
  d.textContent = a.body || "";
  d.dataset.annId = String(a.id);
  return d;
}

/* ── 附注（kind = "note"，参照 Edge / Acrobat 的「附注」）────────────────────
   页面上一个小图标，指上去浮出内容，点开是一张能改、能回复的卡片（NotePopup）。
   rects = [{ x, y, w: 0, h: 0 }]：图标左上角（归一化到页面）。图标**不随缩放变大小**（同 Acrobat），
   所以只存一个点。body = 附注内容，color = 图标颜色，
   style = { replies: [{ id, name, at, text }] }：回复串存在 style 里（0040 的 jsonb 列），不另加列 */
export const NOTE_SIZE = 24;
export const NOTE_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none">' +
  '<path d="M20 15.5a1.5 1.5 0 0 1-1.5 1.5H8.5L4 20.5V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5z"/>' +
  '<path d="M8 8.5h8M8 12.5h5"/></svg>';
const escHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/* 新附注的默认颜色：上次在卡片里选的，per 设备 */
const NOTE_KEY = "rh_note_color";
export const loadNoteColor = () => { try { return localStorage.getItem(NOTE_KEY) || "yellow"; } catch { return "yellow"; } };
export const saveNoteColor = (c) => { try { localStorage.setItem(NOTE_KEY, c); } catch { /* 隐私模式 */ } };

/** 浅色图标上用深色线条（黄色上的白线看不清） */
export const noteInk = (color) => (color === "yellow" ? "#5a4a00" : "#fff");

export function noteIconEl(a, on) {
  const r = a.rects[0];
  const d = document.createElement("div");
  d.className = "rh-note";
  d.style.cssText =
    `position:absolute;left:${r.x * 100}%;top:${r.y * 100}%;width:${NOTE_SIZE}px;height:${NOTE_SIZE}px;` +
    `border-radius:5px;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;` +
    `background:${rgba(a.color, 1)};color:${noteInk(a.color)};` +
    `box-shadow:0 1px 3px rgba(0,0,0,.35)${on ? `,0 0 0 2px #fff,0 0 0 3.5px ${rgba(a.color, 1)}` : ""};`;
  d.innerHTML = NOTE_SVG;
  d.dataset.annId = String(a.id);
  /* 指上去浮出的内容卡（CSS :hover 控制显隐，见 index.css 的 .rh-note-tip）。卡片打开着时不要它 */
  if (!on) { const t = hoverTip(a); if (t) { d.classList.add("rh-has-tip"); d.appendChild(t); } }
  return d;
}

/**
 * 指上去浮出的浅黄内容卡：作者 + 批注 (+ 回复条数)。附注图标和框选框共用（框选原来用浏览器自带的 title，
 * 灰底小字、要停一秒才出来，和附注不是一个样子）。没内容就不出（返回 null）。
 * side：right（默认，贴在宿主右边外侧）/ left（宿主太靠页面右边时）/ below（高亮、下划线：贴在这一行下面）
 */
function hoverTip(a, side = "right") {
  const replies = a.style?.replies || [];
  if (!a.body && !replies.length) return null;
  const t = document.createElement("div");
  t.className = "rh-note-tip" + (side === "left" ? " rh-tip-left" : side === "below" ? " rh-tip-below" : "");
  t.innerHTML = (a._author ? `<b>${escHtml(a._author)}</b>` : "") +
    (a.body ? `<div class="rh-note-tip-body">${escHtml(a.body)}</div>` : "") +
    (replies.length ? `<div class="rh-note-tip-more">${replies.length} 条回复</div>` : "");
  return t;
}

const TEXT_KEY = "rh_text_style";
export function loadTextStyle() {
  try { return { color: "black", size: 12, spacing: 0, ...JSON.parse(localStorage.getItem(TEXT_KEY) || "{}") }; }
  catch { return { color: "black", size: 12, spacing: 0 }; }
}
export const saveTextStyle = (st) => { try { localStorage.setItem(TEXT_KEY, JSON.stringify(st)); } catch { /* 隐私模式 */ } };

/** 点到线段的距离（像素坐标），橡皮擦和选中判断用 */
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas–Peucker 抽稀：手一抖一秒能采上百个点，存之前把几乎在一条直线上的点去掉 */
export function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  let idx = -1, max = 0;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i][0], pts[i][1], ax, ay, bx, by);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

/* 画笔默认样式（颜色 / 粗细），per 设备偏好 */
const PEN_KEY = "rh_pen_style";
export function loadPenStyle() {
  try { return { color: "red", width: 3, ...JSON.parse(localStorage.getItem(PEN_KEY) || "{}") }; }
  catch { return { color: "red", width: 3 }; }
}
export const savePenStyle = (s) => { try { localStorage.setItem(PEN_KEY, JSON.stringify(s)); } catch { /* 隐私模式 */ } };

/* ── 高亮层 ─────────────────────────────────────────────────────────
   直接操作 DOM，不走 React：pdf.js 自己在增删 `.page` 节点（滚远了会拆掉重建），
   React 管不到那棵树；而且高亮要跟着页面走，挂在 `.page` 里最省事。

   **矩形用百分比**，不是像素：`.page` 的绝对定位子元素以它的 padding box 为准，
   而那正好就是画布区（pdf.js 的 9px 是 border，加上我们把 .page 改回 content-box，
   padding box = canvas 尺寸）。于是**缩放时什么都不用重算** —— 页面变大，
   百分比跟着变大，高亮自动贴合。只有页面节点被重建时才要重画。 */
export function useHighlightLayer(viewerElRef, apiRef, ready, annotations, { activeId, onPick, hiddenId }) {
  // onPick 放 ref：它变了不该把整层拆了重建
  const pickRef = useRef(onPick);
  useEffect(() => { pickRef.current = onPick; }, [onPick]);

  useEffect(() => {
    const root = viewerElRef.current;
    if (!root) return;

    const byPage = new Map();
    const byId = new Map();
    annotations.forEach(a => {
      byId.set(String(a.id), a);
      if (!a.rects?.length) return;                   // 页级笔记不画高亮
      const l = byPage.get(a.page) || [];
      l.push(a);
      byPage.set(a.page, l);
    });

    /* **一次只画一页**，不是每来一个事件就把所有页扫一遍。
       pdf.js 从 v5 起有「细节视图」：放大之后它会**边滚边**重渲染可视区那块，
       于是 `pagerendered` 在滚动时是连续不断地来的 —— 原来那份实现每来一次
       就把几十页的高亮全拆了重建，等于把滚动挂在 DOM 重建上。 */
    const paintPage = (pageEl) => {
      const num = Number(pageEl.dataset.pageNumber);
      const list = byPage.get(num) || [];
      let layer = pageEl.querySelector(":scope > .rh-hl");
      if (!list.length) { layer?.remove(); return; }

      /* **幂等**：这一页要画的东西和上次一模一样就直接返回，一个节点都不动。
         除了省事，更要紧的是它能让「画一次 → 触发事件 → 又来画一次」这种
         回环**自己收敛**（第二次不产生任何 DOM 变化，也就不会有第三次）。 */
      const sig = list.map(a => `${a.id}/${a.kind}/${a.color}/${a.style?.dash}/${a.style?.width}/${a.style?.fill ? 1 : 0}/${a.style?.size}/${a.style?.spacing}/${a.kind === "text" || a.kind === "note" || a.kind === "area" ? `${a.rects?.[0]?.x},${a.rects?.[0]?.y},${a.rects?.[0]?.w}` : ""}|${a.body || ""}|${a._author || ""}|${a.style?.replies?.length || 0}/${a.id === hiddenId ? 1 : 0}/${a.id === activeId ? 1 : 0}`).join("|");
      if (layer) {
        if (layer.dataset.sig === sig) return;
      } else {
        layer = document.createElement("div");
        layer.className = "rh-hl";
        /* 整层不吃指针事件，只有矩形自己吃 —— 否则文字层就选不中了，
           而「能接着划选」正是这个功能的核心操作。
           点击**只在层上挂一个**，靠冒泡认 data-ann-id，不给每个矩形各挂一份 */
        layer.style.cssText = "position:absolute;inset:0;z-index:1;pointer-events:none";
        layer.addEventListener("click", (e) => {
          const id = e.target?.dataset?.annId;
          if (!id) return;
          e.stopPropagation();
          const a = byId.get(id);
          if (a) pickRef.current?.(a, e.target);
        });
        pageEl.appendChild(layer);
      }
      layer.dataset.sig = sig;

      const kids = [];
      const inks = [];
      list.forEach(a => {
        const on = a.id === activeId;
        if (a.kind === "ink") { inks.push(a); return; }   // 手写笔迹统一画进一张 SVG（见下面）
        if (a.kind === "note") {                          // 附注图标（见 noteIconEl）
          if (a.id === hiddenId || !a.rects?.[0]) return;
          kids.push(noteIconEl(a, on));
          return;
        }
        if (a.kind === "text") {                          // 文本框（「添加文本」工具，见 TextBoxEditor）
          if (a.id === hiddenId || !a.rects?.[0]) return;  // 正在编辑：由编辑框画
          kids.push(textBoxEl(a, on));
          return;
        }
        /* 区域框选：原样画框，不做行盒修正（框的就是用户拖出来的那块）。
           底色很淡 —— 框里多半是图，盖深了就看不清图了 */
        if (a.kind === "area") {
          if (a.id === hiddenId) return;             // 正在拖动 / 缩放：由编辑框画，这里先不画
          const r = a.rects[0];
          const d = document.createElement("div");
          /* 线型 / 粗细 / 填充是扩展自己加的（存在本地 style 字段，网站上按默认实线 2px 画） */
          const bw = (a.style?.width || 2) + (on ? 1 : 0);
          const dash = a.style?.dash || "solid";
          const fill = !!a.style?.fill;
          d.style.cssText =
            `position:absolute;left:${r.x * 100}%;top:${r.y * 100}%;` +
            `width:${r.w * 100}%;height:${r.h * 100}%;box-sizing:border-box;` +
            `border:${bw}px ${dash} ${rgba(a.color, on ? 1 : 0.85)};` +
            `background:${fill ? rgba(a.color, on ? 0.3 : 0.2) : "transparent"};` +
            `border-radius:2px;cursor:pointer;` +
            /* 不填充的框只有边能点：框里的字还要能划选（框住一段话再在里面高亮是常见操作） */
            `pointer-events:${fill ? "auto" : "none"};`;
          d.dataset.annId = String(a.id);
          /* 批注：指上去浮出和附注一样的浅黄卡片，贴在框的右上角外侧；框太靠页面右边就放到左边。
             正在选中（编辑条开着）时不出，免得和编辑条叠在一起 */
          if (!on) {
            const t = hoverTip(a, r.x + r.w > 0.7 ? "left" : "right");
            if (t) { d.classList.add("rh-has-tip"); d.appendChild(t); }
          }
          if (!fill) {
            const HIT = 7;   // 边上的点击热区（px），比线本身宽，好点中
            [["0", "auto", "-4px", "-4px", `${HIT}px`, "auto"], ["auto", "0", "-4px", "-4px", `${HIT}px`, "auto"],
             ["-4px", "-4px", "0", "auto", "auto", `${HIT}px`], ["-4px", "-4px", "auto", "0", "auto", `${HIT}px`]]
              .forEach(([t, b, l, rr, h, w]) => {
                const e = document.createElement("div");
                e.style.cssText = `position:absolute;top:${t};bottom:${b};left:${l};right:${rr};` +
                  `${h !== "auto" ? `height:${h};` : ""}${w !== "auto" ? `width:${w};` : ""}pointer-events:auto;cursor:pointer;`;
                e.dataset.annId = String(a.id);
                d.appendChild(e);
              });
          }
          kids.push(d);
          return;
        }
        a.rects.forEach(r => {
          const d = document.createElement("div");
          /* **画之前把行盒修一修**（存的仍是原始行盒，重锚点和跳转都按它算）：
             ① 竖向收窄 —— 选区给的是**行盒**，上面有 ascent 空白、下面有 descent，
                照着画就是「上面空一大条」，像标歪了。收成贴着字身的一条才像荧光笔。
                上面收得比下面多：拉丁文的字身本来就偏行盒下半部（cap height 约占
                em 的七成，而 ascender 空白全在上面）。
             ② 横向**往外撑一点点** —— 行盒的左右正好卡在字形边界上，画出来是
                「右边贴着字母」；撑出大约一个像素，两头才有呼吸感。
                撑的量按行高算（行高 ≈ 字号），所以缩放时自动跟着变。 */
          const TOP = 0.20, BOT = 0.08;             // 竖向上下各收掉的比例
          const padX = r.h * 0.07;                  // 横向外扩（相对行高）
          const y = r.y + r.h * TOP, h = r.h * (1 - TOP - BOT);
          const x = r.x - padX, w = r.w + padX * 2;
          /* **不要 mix-blend-mode**：这一层自己是 `absolute + z-index:1`，
             也就是一个独立的层叠上下文 ⇒ 混合只在这一层内部发生，底下的画布
             根本参与不进来，视觉上和不写完全一样（白写）；可它照样把整块推进
             浏览器的混合/合成慢路径，滚动时要为每个矩形单独合成一次。 */
          /* 下划线：同一个字身盒子，只画底边。盒子本身留着（透明）当点击热区 ——
             只有 2px 高的线根本点不中。选中时给一层淡底，好认出是哪条 */
          d.style.cssText = a.kind === "underline"
            ? `position:absolute;left:${x * 100}%;top:${y * 100}%;` +
              `width:${w * 100}%;height:${h * 100}%;box-sizing:border-box;` +
              `border-bottom:2px solid ${rgba(a.color, 0.95)};` +
              `background:${on ? rgba(a.color, 0.22) : "transparent"};` +
              `pointer-events:auto;cursor:pointer;`
            : `position:absolute;left:${x * 100}%;top:${y * 100}%;` +
              `width:${w * 100}%;height:${h * 100}%;` +
              `background:${rgba(a.color, on ? 0.6 : 0.34)};` +
              `border-radius:3px;pointer-events:auto;cursor:pointer;` +
              (on ? `outline:2px solid ${rgba(a.color, 0.9)};` : "");
          d.dataset.annId = String(a.id);
          /* 批注：指上去浮出和附注 / 框选一样的浅黄卡片（原来是浏览器自带的 title）。跨几行的高亮每一行都挂一张，
             出现在鼠标所在那一行的**下方**（放右边会盖住同一行后面的字）。没写批注的不出卡片，也不再拿原文当提示 */
          if (!on) {
            const t = hoverTip(a, "below");
            if (t) { d.classList.add("rh-has-tip"); d.appendChild(t); }
          }
          kids.push(d);
        });
      });
      if (inks.length) kids.push(inkSvg(inks, pageCanvasBox(pageEl), activeId));
      layer.replaceChildren(...kids);
    };

    const paintAll = () => root.querySelectorAll(".page").forEach(paintPage);
    paintAll();

    /* pdf.js 的 `PDFPageView.reset()` 会把它**不认识的子节点全删掉**（滚远了、
       换缩放、细节视图重画都会走到那儿），所以每次页面重渲染之后都要补画。
       **必须用 eventBus，不能用 MutationObserver**（踩过，整页卡死）：paint 自己
       就是往 `.page` 里塞节点，而 observer 盯的正是 childList —— 画一次触发一次。

       **而且要按帧攒批**：事件是一页一条、滚动时连着来的，逐条同步画等于把
       重排重绘钉死在事件派发里。攒到下一帧只画一次，顺带上了一道保险 ——
       万一哪天又出现「画完又触发事件」的回环，它也只会每帧空转一次
       （配合上面的 sig 判等，第二帧就什么都不做了），而不是把主线程锁死。 */
    let raf = 0;
    const dirty = new Set();
    const flush = () => {
      raf = 0;
      const pages = [...dirty];
      dirty.clear();
      pages.forEach(n => {
        const el = root.querySelector(`.page[data-page-number="${n}"]`);
        if (el) paintPage(el);
      });
    };
    const onPageEvent = ({ pageNumber }) => {
      if (!pageNumber) return;
      dirty.add(pageNumber);
      raf ||= requestAnimationFrame(flush);
    };

    const bus = apiRef.current?.eventBus;
    bus?.on("pagerendered", onPageEvent);
    bus?.on("textlayerrendered", onPageEvent);
    return () => {
      bus?.off("pagerendered", onPageEvent);
      bus?.off("textlayerrendered", onPageEvent);
      cancelAnimationFrame(raf);
      root.querySelectorAll(".rh-hl").forEach(n => n.remove());
    };
  }, [viewerElRef, apiRef, ready, annotations, activeId, hiddenId]);
}

/* ── 划选工具条 ─────────────────────────────────────────────────────
   坐标是**相对 `.pdfViewer` 内容坐标**算的，然后直接放进那棵树里 ——
   于是它跟着页面一起滚，不用监听 scroll 重定位（贴锚点的浮层最容易在这儿翻车）。 */
const COLOR_NAMES = { yellow: "黄", red: "红", green: "绿", blue: "蓝", pink: "粉", purple: "紫", black: "黑" };
export const KIND_LABEL = { highlight: "高亮", underline: "下划线", area: "区域", ink: "手写", text: "文本", note: "附注" };

/* 高亮 / 下划线 两颗小图标。只有两个值 ⇒ 点按切换（全站规范），记住上次选的 */
const KindIcon = ({ kind }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {kind === "underline"
      ? <><path d="M6 4v6a6 6 0 0 0 12 0V4" /><line x1="4" y1="21" x2="20" y2="21" /></>
      : <><path d="M9 11l-6 6v3h9l3-3" /><path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" /></>}
  </svg>
);

/**
 * `kind` / `onKind`：文字划选时可在高亮和下划线间切换；区域框选不传 onKind（只有一种）。
 * 色块点下去就是「用这个颜色、按当前类型存」。
 */
export function SelectionBar({ pos, kind = "highlight", onKind, onHighlight, onNote, onTranslate, onCancel, defaultColor }) {
  const barRef = useRef(null);
  useKeepInView(barRef, [pos?.x, pos?.y, pos?.below]);      // 首页顶上的选区：工具条别伸出文档顶端
  if (!pos) return null;
  return (
    <div ref={barRef} style={{ position: "absolute", left: pos.x, top: pos.y, zIndex: 40,
                  /* 和选区 / 标注之间留 10px：mb-1.5 对绝对定位 + transform 不起作用，原来其实是贴着的 */
                  transform: pos.below ? "translate(-50%, 10px)" : "translate(-50%, calc(-100% - 10px))" }}
      onMouseDown={e => e.preventDefault()}          /* 别让点击清掉选区 */
      onPointerDown={e => e.stopPropagation()}       /* 框选模式下别把点工具条当成开始拖框 */
      className="flex items-center gap-0.5 p-1 rounded-lg bg-[#323639] border border-[#ffffff26]
                 shadow-[0_6px_20px_rgba(0,0,0,0.45)] mb-1.5">
      {onKind && (
        <>
          {["highlight", "underline"].map(k => (
            <button key={k} onClick={() => onKind(k)} title={KIND_LABEL[k]}
              className={`w-6 h-6 rounded-md flex items-center justify-center border-none cursor-pointer shrink-0
                ${kind === k ? "text-[#fff] bg-[#ffffff33]" : "text-[#9a9a9a] bg-transparent hover:bg-[#ffffff1a]"}`}>
              <KindIcon kind={k} />
            </button>
          ))}
          <div className="h-4 border-l border-[#ffffff26] mx-1" />
        </>
      )}
      {Object.keys(COLORS).map(c => (
        <button key={c} onClick={() => onHighlight(c)} title={`${KIND_LABEL[kind]}（${COLOR_NAMES[c]}）`}
          className="w-6 h-6 rounded-md border-none cursor-pointer shrink-0 hover:scale-110 transition-transform
                     flex items-end justify-center pb-1"
          style={{ background: rgba(c, kind === "underline" ? 0.18 : 0.9),
                   boxShadow: c === defaultColor ? "0 0 0 2px #323639, 0 0 0 3.5px #fff" : "none" }}>
          {kind === "underline" && <span className="block w-[14px] h-[3px] rounded" style={{ background: rgba(c, 1) }} />}
        </button>
      ))}
      <div className="h-4 border-l border-[#ffffff26] mx-1" />
      {onTranslate && (
        <button onClick={onTranslate} title="翻译选中的文字"
          className="h-6 px-2 rounded-md text-[11.5px] font-sans text-[#e6e6e6]
                     bg-transparent border-none cursor-pointer hover:bg-[#ffffff26] shrink-0">
          翻译
        </button>
      )}
      <button onClick={onNote} title="加批注"
        className="h-6 px-2 rounded-md text-[11.5px] font-sans text-[#e6e6e6]
                   bg-transparent border-none cursor-pointer hover:bg-[#ffffff26] shrink-0">
        批注
      </button>
      <button onClick={onCancel} title="取消"
        className="w-6 h-6 rounded-md text-[#9a9a9a] bg-transparent border-none cursor-pointer
                   hover:bg-[#ffffff26] shrink-0">✕</button>
    </div>
  );
}

/* ── 区域缩略图 ─────────────────────────────────────────────────────
   **不存截图，现场从 PDF 渲染**（Zotero 也是这么做的）：省存储、没有版权顾虑，
   缩放也永远清楚。只渲染框住的那一块 —— 用 render 的 `transform` 把页面平移，
   画布只开裁剪区那么大，不用先画整页再裁。

   缓存按「标注 id + 矩形」记 dataURL：侧栏切 tab、筛选来回切都不重画。
   **串行排队**：一篇论文框了二三十张图时，同时开二三十个渲染任务会把 worker 堵死，
   正文翻页都跟着卡。 */
const thumbCache = new Map();
let thumbQueue = Promise.resolve();

function renderAreaThumb(doc, a) {
  const r = a.rects[0];
  const key = `${a.id}:${r.x},${r.y},${r.w},${r.h}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const job = thumbQueue.then(async () => {
    const p = await doc.getPage(a.page);
    const base = p.getViewport({ scale: 1 });
    /* 目标宽约 440 设备像素（侧栏 220 CSS px × 2 倍屏）；太小的框放大有上限，
       不然一个公式框成 4000px 宽的画布 */
    const scale = Math.min(4, Math.max(0.5, 440 / Math.max(1, base.width * r.w)));
    const vp = p.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(vp.width * r.w));
    c.height = Math.max(1, Math.min(1400, Math.round(vp.height * r.h)));
    await p.render({
      canvas: c, viewport: vp,
      transform: [1, 0, 0, 1, -vp.width * r.x, -vp.height * r.y],
    }).promise;
    return c.toDataURL("image/jpeg", 0.85);
  });
  thumbQueue = job.catch(() => {});
  // 失败了别把坏结果留在缓存里，下次进来再试
  job.catch(() => thumbCache.delete(key));
  thumbCache.set(key, job);
  return job;
}

function AreaThumb({ doc, a }) {
  const [src, setSrc] = useState(null);
  const [ar, setAr] = useState(null);
  const ok = doc && a.rects?.length === 1;
  useEffect(() => {
    if (!ok) return;
    let alive = true;
    renderAreaThumb(doc, a).then(u => { if (alive) setSrc(u); }).catch(() => {});
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, a.id, ok]);
  if (!ok) return null;
  const r = a.rects[0];
  /* 占位先按「论文页大约 3:4」估一个比例留出高度，图出来后换成真实比例 —— 列表基本不跳 */
  const ratio = ar || Math.max(0.2, (r.w / r.h) * 0.75);
  return (
    <div className="ml-3.5 rounded overflow-hidden bg-[#fff] border border-[#ffffff33]"
      style={{ aspectRatio: String(ratio), maxHeight: 200 }}>
      {src && (
        <img src={src} alt="区域选取" draggable={false}
          onLoad={e => setAr(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight))}
          className="block w-full h-full object-contain" />
      )}
    </div>
  );
}

/** 列表里手写笔迹的预览：按这一笔的外接框裁出来画（页面宽高比按常见论文页 1:1.294 估，只是预览） */
function InkThumb({ a }) {
  const st = a.rects?.[0];
  if (!st?.path?.length) return null;
  const H = 1294;
  const pad = Math.max(st.lw || 0.003, 0.004);
  const vx = (st.x - pad) * 1000, vy = (st.y - pad) * H, vw = (st.w + pad * 2) * 1000, vh = (st.h + pad * 2) * H;
  return (
    <div className="ml-3.5 rounded bg-[#fff] border border-[#ffffff33] px-1.5 py-1">
      <svg viewBox={`${vx} ${vy} ${Math.max(vw, 1)} ${Math.max(vh, 1)}`} className="block w-full" style={{ maxHeight: 90 }}>
        {(a.rects || []).map((r, i) => r.path?.length ? (
          <path key={i} d={inkPathD(r.path, H)} fill="none" stroke={rgba(a.color, 0.95)}
            strokeWidth={Math.max(0.6, (r.lw || 0.003) * 1000)} strokeLinecap="round" strokeLinejoin="round" />
        ) : null)}
      </svg>
    </div>
  );
}

/* ── 一条标注 ─────────────────────────────────────────────────────── */

/** 筛选用的「类型」：页级笔记单独算一类（它没有 rects、也没有 quote） */
export const kindOf = (a) => (a.kind === "area" || a.kind === "underline" || a.kind === "ink" || a.kind === "text" || a.kind === "note")
  ? a.kind
  : (a.quote ? "highlight" : "page");

const KIND_FILTERS = [["highlight", "高亮"], ["underline", "下划线"], ["area", "区域"], ["ink", "手写"], ["text", "文本"], ["note", "附注"], ["page", "整页"]];

function AnnRow({ a, mine, author, doc, onGo, onEdit, onDelete, onCopy, copied, active, onTag, tagOn }) {
  const k = kindOf(a);
  return (
    <div onClick={() => onGo(a)}
      className={`group px-2 py-1.5 rounded-md cursor-pointer transition-colors
        ${active ? "bg-[#ffffff26]" : "hover:bg-[#ffffff14]"}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        {/* 颜色点的形状跟着类型走：高亮实心圆、下划线一道杠、区域空心方框 —— 不看字也分得出 */}
        {k === "underline" ? (
          <span className="w-[10px] h-[3px] rounded shrink-0" style={{ background: rgba(a.color, 0.95) }} />
        ) : k === "area" ? (
          <span className="w-[10px] h-[8px] rounded-[2px] shrink-0 border-2" style={{ borderColor: rgba(a.color, 0.95) }} />
        ) : k === "note" ? (
          <span className="w-[11px] h-[11px] rounded-[2px] shrink-0 flex items-center justify-center"
            style={{ background: rgba(a.color, 1), color: noteInk(a.color) }}>
            <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3"><path d="M7 9h10M7 14h6" /></svg>
          </span>
        ) : (
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: rgba(a.color, 0.95) }} />
        )}
        <span className="text-[10.5px] text-[#9a9a9a] font-sans tabular-nums shrink-0">P{a.page}</span>
        {k === "page" && (
          <span className="text-[10px] text-[#9a9a9a] font-sans px-1 rounded bg-[#ffffff1a] shrink-0">整页</span>
        )}
        {a.stale && (
          // 跨版本重锚失败/近似命中时的老实交代，别把高亮悄悄画到错的地方
          <span className="text-[10px] text-[#ffcf7a] font-sans px-1 rounded bg-[#ffcf7a1a] shrink-0"
            title="这条标注做于论文的其它版本，位置可能不准">位置可能不准</span>
        )}
        <div className="flex-1 min-w-0" />
        {mine ? (
          /* 编辑 / 删除：图标按钮（原来是「改」「删」两个字，像随手写的批注，不像按钮）。
             平时灰色，指上去出圆底；删除指上去变红，提醒这是破坏性操作 */
          <span className="hidden group-hover:flex items-center gap-0.5 shrink-0 -my-1">
            <button onClick={e => { e.stopPropagation(); onEdit(a); }} title="编辑批注和标签" aria-label="编辑"
              className="w-6 h-6 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer
                         text-[#b8b8b8] hover:text-[#fff] hover:bg-[#ffffff1f]">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            </button>
            <DeleteButton onConfirm={() => onDelete(a)} title="删除" size={24} icon={13} round />
          </span>
        ) : (
          <button onClick={e => { e.stopPropagation(); onCopy(a); }} disabled={copied}
            title={copied ? "已在我的笔记里" : "加进我的笔记"}
            className={`text-[10.5px] px-1.5 rounded border-none shrink-0
              ${copied ? "text-[#7ec8e3] bg-transparent cursor-default"
                       : "text-[#e6e6e6] bg-[#ffffff1a] cursor-pointer hover:bg-[#ffffff33]"}`}>
            {copied ? "✓ 已添加" : "+ 收藏"}
          </button>
        )}
      </div>
      {k === "ink" ? (
        a.stale || !a.rects ? (
          <div className="text-[11px] text-[#9a9a9a] font-sans pl-3.5">手写笔迹（其它版本，预览不可用）</div>
        ) : <InkThumb a={a} />
      ) : k === "area" ? (
        a.stale ? (
          <div className="text-[11px] text-[#9a9a9a] font-sans pl-3.5">区域选取（其它版本，缩略图不可用）</div>
        ) : <AreaThumb doc={doc} a={a} />
      ) : a.quote && (
        <div className={`text-[11.5px] leading-snug text-[#d8d8d8] font-sans line-clamp-3 pl-3.5
                        border-l-2 border-[#ffffff33] ${k === "underline" ? "underline decoration-[#ffffff66] underline-offset-2" : ""}`}>
          {a.quote}
        </div>
      )}
      {a.body && (
        <div className="text-[11.5px] leading-snug text-[#fff] font-sans mt-1 whitespace-pre-line break-words">
          <MathText text={a.body} />
        </div>
      )}
      {k === "note" && a.style?.replies?.length > 0 && (
        <div className="text-[10.5px] text-[#9a9a9a] font-sans mt-0.5">{a.style.replies.length} 条回复</div>
      )}
      {a.tags?.length > 0 && (
        /* 点标签 = 按它筛选（再点一下取消），和 Zotero 侧栏一样 */
        <div className="flex flex-wrap gap-1 mt-1">
          {a.tags.map(t => (
            <button key={t} onClick={e => { e.stopPropagation(); onTag?.(t); }}
              title={tagOn?.(t) ? "取消按这个标签筛选" : "只看带这个标签的"}
              className={`text-[10.5px] font-sans px-1.5 rounded border-none cursor-pointer leading-[18px]
                ${tagOn?.(t) ? "text-[#10232c] bg-[#7ec8e3]" : "text-[#7ec8e3] bg-[#7ec8e31a] hover:bg-[#7ec8e333]"}`}>
              #{t}
            </button>
          ))}
        </div>
      )}
      {!mine && author && (
        <div className="flex items-center gap-1 mt-1">
          <UserLink user={author} className="flex items-center gap-1">
            <Avatar name={author.name} size={14} url={author.avatar_url} />
            <span className="text-[10.5px] text-[#9a9a9a] font-sans hover:text-[#fff]">{author.name}</span>
          </UserLink>
        </div>
      )}
      {mine && a.source_user_id && (
        <div className="text-[10px] text-[#9a9a9a] font-sans mt-1">来自他人笔记</div>
      )}
    </div>
  );
}

/** 按页 → 页内从上到下排（页级笔记排在那一页最前面）。新加的标注不会再堆在列表末尾 */
const byPosition = (a, b) =>
  a.page - b.page || (a.rects?.[0]?.y ?? -1) - (b.rects?.[0]?.y ?? -1);

/** 所有标签（按出现次数排），给筛选面板和编辑框的候选用 */
export function collectTags(lists) {
  const n = new Map();
  lists.forEach(l => l.forEach(a => (a.tags || []).forEach(t => n.set(t, (n.get(t) || 0) + 1))));
  return [...n.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([t]) => t);
}

const toggleIn = (set, v) => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v); else next.add(v);
  return next;
};

/* ── 笔记列表 ───────────────────────────────────────────────────────
   桌面端塞进左侧栏的第三个 tab；移动端由浮动钮拉出来盖在阅读区上。

   **搜索 + 筛选只作用于列表，不动正文上的高亮**（Zotero 也是这样）：
   筛选是「找某一条」，不是「把别的藏起来」—— 正文上的高亮一筛就消失会让人以为删掉了。
   筛选条件：颜色 / 类型 / 标签各自多选，组内是「或」、组间是「且」。 */
export function NotesList({
  mine, others, copiedIds, scope, setScope, onGo, onEdit, onDelete, onCopy,
  onAddPageNote, visibility, onVisibility, onExport, exported, page, canShare, doc, activeId,
}) {
  const showMine = scope === "mine" || scope === "all";
  const showOthers = scope === "others" || scope === "all";
  const otherCount = others.reduce((s, o) => s + o.annotations.length, 0);

  const [q, setQ] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [colors, setColors] = useState(() => new Set());
  const [kinds, setKinds] = useState(() => new Set());
  const [tags, setTags] = useState(() => new Set());

  const allTags = collectTags([mine, ...others.map(o => o.annotations)]);
  const nFilters = colors.size + kinds.size + tags.size;
  const active = nFilters > 0 || q.trim() !== "";
  const clearAll = () => { setQ(""); setColors(new Set()); setKinds(new Set()); setTags(new Set()); };

  const needle = q.trim().toLowerCase();
  const pass = (a, author) => {
    if (colors.size && !colors.has(a.color)) return false;
    if (kinds.size && !kinds.has(kindOf(a))) return false;
    if (tags.size && !(a.tags || []).some(t => tags.has(t))) return false;
    if (!needle) return true;
    const hay = [a.quote, a.body, ...(a.tags || []), author?.name, author?.username]
      .filter(Boolean).join("\n").toLowerCase();
    return hay.includes(needle.replace(/^#/, ""));
  };

  const mineShown = showMine ? mine.filter(a => pass(a)).sort(byPosition) : [];
  const othersShown = showOthers
    ? others.flatMap(o => o.annotations.filter(a => pass(a, o.author)).map(a => ({ a, author: o.author })))
        .sort((x, y) => byPosition(x.a, y.a))
    : [];
  const totalInScope = (showMine ? mine.length : 0) + (showOthers ? otherCount : 0);
  const shown = mineShown.length + othersShown.length;

  const tagOn = (t) => tags.has(t);
  const onTag = (t) => { setTags(s => toggleIn(s, t)); };

  const chip = (on) => `text-[10.5px] font-sans px-1.5 rounded border-none cursor-pointer leading-[20px] whitespace-nowrap
    ${on ? "text-[#10232c] bg-[#7ec8e3]" : "text-[#c8c8c8] bg-[#ffffff14] hover:bg-[#ffffff26]"}`;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 头：范围切换 + 可见性。只有两个/三个值，用点按切换而不是下拉（全站规范） */}
      <div className="shrink-0 px-2 py-1.5 border-b border-[#00000040] flex flex-col gap-1.5">
        <div className="flex items-center gap-0.5">
          {[["mine", `我的 ${mine.length}`], ["others", `他人 ${otherCount}`], ["all", "全部"]].map(([k, label]) => (
            <button key={k} onClick={() => setScope(k)}
              className={`flex-1 py-1 rounded text-[11px] font-sans border-none cursor-pointer whitespace-nowrap
                ${scope === k ? "text-[#fff] bg-[#ffffff26] font-bold" : "text-[#b8b8b8] bg-transparent hover:bg-[#ffffff14]"}`}>
              {label}
            </button>
          ))}
        </div>
        {(
          <div className="flex items-center gap-1">
            <button onClick={onAddPageNote} title={`给第 ${page} 页加一条笔记`}
              className="flex-1 py-1 rounded text-[11px] font-sans text-[#e6e6e6] bg-[#ffffff1a]
                         border-none cursor-pointer hover:bg-[#ffffff33] whitespace-nowrap">
              + 第 {page} 页
            </button>
            {/* 公开 / 私有：一眼看出**当前是什么状态**，不是「点了会变成什么」。
                没登录时笔记只在本机，谈不上公开，不出这颗 */}
            {canShare && <button onClick={() => onVisibility(visibility === "public" ? "private" : "public")}
              title={visibility === "public" ? "所有人可见，点一下改成仅自己" : "仅自己可见，点一下公开"}
              className={`py-1 px-2 rounded text-[11px] font-sans border-none cursor-pointer whitespace-nowrap
                ${visibility === "public" ? "text-[#7ec8e3] bg-[#7ec8e31a]" : "text-[#b8b8b8] bg-[#ffffff1a]"}`}>
              {visibility === "public" ? "公开" : "私有"}
            </button>}
            {/* 复制反馈走全站的「就地变身」：变绿 + 换文案，不弹浮动气泡 */}
            <button onClick={onExport} title="导出为 Markdown（复制到剪贴板）"
              className={`py-1 px-2 rounded text-[11px] font-sans border-none cursor-pointer whitespace-nowrap
                ${exported ? "text-[#7ee3a0] bg-[#7ee3a01a]" : "text-[#b8b8b8] bg-[#ffffff1a] hover:bg-[#ffffff33]"}`}>
              {exported ? "✓ 已复制" : "导出"}
            </button>
          </div>
        )}

        {/* 搜索 + 筛选开关 */}
        <div className="flex items-center gap-1">
          <div className="flex-1 min-w-0 relative">
            <input value={q} onChange={e => setQ(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") setQ(""); }}
              placeholder="搜索原文、批注、标签"
              className="w-full h-[26px] pl-2 pr-6 rounded bg-[#00000059] border border-[#ffffff26]
                         text-[11.5px] text-[#fff] font-sans outline-none
                         placeholder:text-[#ffffff59] focus:border-[#ffffff66]" />
            {q && (
              <button onClick={() => setQ("")} title="清空"
                className="absolute right-0.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded text-[11px] leading-none
                           text-[#9a9a9a] bg-transparent border-none cursor-pointer hover:text-[#fff]">✕</button>
            )}
          </div>
          <button onClick={() => setFilterOpen(v => !v)} title="按颜色 / 类型 / 标签筛选"
            className={`h-[26px] px-1.5 rounded flex items-center gap-1 text-[11px] font-sans border-none cursor-pointer shrink-0
              ${filterOpen || nFilters ? "text-[#fff] bg-[#ffffff26]" : "text-[#b8b8b8] bg-[#ffffff14] hover:bg-[#ffffff26]"}`}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            {nFilters > 0 && <span className="tabular-nums">{nFilters}</span>}
          </button>
        </div>

        {filterOpen && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <div className="flex items-center gap-1">
              {Object.keys(COLORS).map(c => (
                <button key={c} onClick={() => setColors(s => toggleIn(s, c))} title={COLOR_NAMES[c]}
                  className="w-[18px] h-[18px] rounded-full border-none cursor-pointer shrink-0 p-0"
                  style={{
                    background: rgba(c, 0.9),
                    boxShadow: colors.has(c) ? "0 0 0 2px #323639, 0 0 0 4px #fff" : "none",
                    opacity: colors.size && !colors.has(c) ? 0.35 : 1,
                  }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {KIND_FILTERS.map(([k, label]) => (
                <button key={k} onClick={() => setKinds(s => toggleIn(s, k))} className={chip(kinds.has(k))}>
                  {label}
                </button>
              ))}
            </div>
            {allTags.length > 0 ? (
              <div className="flex flex-wrap gap-1 max-h-[84px] overflow-y-auto thin-scrollbar">
                {allTags.map(t => (
                  <button key={t} onClick={() => onTag(t)} className={chip(tags.has(t))}>#{t}</button>
                ))}
              </div>
            ) : (
              <div className="text-[10.5px] text-[#8a8a8a] font-sans">还没有标签。在「改」里可以给标注加标签。</div>
            )}
          </div>
        )}

        {active && (
          <div className="flex items-center justify-between text-[10.5px] font-sans text-[#9a9a9a]">
            <span className="tabular-nums">{shown} / {totalInScope} 条</span>
            <button onClick={clearAll}
              className="px-1 rounded text-[10.5px] text-[#7ec8e3] bg-transparent border-none cursor-pointer hover:bg-[#ffffff14]">
              清除筛选
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain thin-scrollbar px-1 py-1">
        {mineShown.map(a => (
          <AnnRow key={a.id} a={a} mine doc={doc} active={a.id === activeId}
            onGo={onGo} onEdit={onEdit} onDelete={onDelete} onTag={onTag} tagOn={tagOn} />
        ))}
        {mineShown.length > 0 && othersShown.length > 0 && (
          <div className="mx-2 my-1.5 border-t border-[#ffffff1a]" />
        )}
        {othersShown.map(({ a, author }) => (
          <AnnRow key={a.id} a={a} author={author} doc={doc} active={a.id === activeId}
            onGo={onGo} onCopy={onCopy} onTag={onTag} tagOn={tagOn}
            copied={copiedIds.has(a.source_annotation_id || a.id)} />
        ))}
        {shown === 0 && (
          <div className="px-2 py-4 text-[11.5px] text-[#b8b8b8] font-sans leading-relaxed">
            {active && totalInScope > 0
              ? "没有符合条件的标注。"
              : "还没有笔记。选中正文可以高亮、划线或加批注；左边工具条的框选可以框住图表和公式；也可以直接给当前页记一条。"}
          </div>
        )}
      </div>
    </div>
  );
}


/* ── 标签输入 ───────────────────────────────────────────────────────
   回车 / 逗号（中英文都认）落一个标签，空着按退格删最后一个。
   下面列出已有标签当候选（按用得多少排）—— 标签的价值全在「复用同一个词」，
   每次凭记忆手打很容易打出「方法」「方法论」「methods」三个来。 */
function TagInput({ tags, onChange, suggestions }) {
  const [text, setText] = useState("");
  const commit = (raw) => {
    const parts = raw.split(/[,，]/).map(s => s.replace(/^#+/, "").trim()).filter(Boolean);
    if (!parts.length) return;
    onChange(normTags([...tags, ...parts]));
    setText("");
  };
  const t = text.replace(/^#+/, "").trim().toLowerCase();
  const cands = suggestions.filter(s => !tags.includes(s) && (!t || s.toLowerCase().includes(t))).slice(0, 10);
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1 rounded-lg bg-[#00000059] border border-[#ffffff33]
                      px-1.5 py-1 focus-within:border-[#ffffff80]">
        {tags.map(x => (
          <span key={x} className="flex items-center gap-0.5 text-[11.5px] font-sans text-[#7ec8e3]
                                   bg-[#7ec8e31a] rounded px-1.5 leading-[22px]">
            #{x}
            <button onClick={() => onChange(tags.filter(y => y !== x))} title="去掉这个标签"
              className="text-[11px] leading-none text-[#7ec8e3] bg-transparent border-none cursor-pointer
                         px-0.5 hover:text-[#fff]">✕</button>
          </span>
        ))}
        <input value={text}
          onChange={e => {
            const v = e.target.value;
            if (/[,，]/.test(v)) commit(v); else setText(v);
          }}
          onKeyDown={e => {
            e.stopPropagation();
            // 输入法组字中的回车是在选字，不是提交
            if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commit(text); }
            if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={() => commit(text)}
          placeholder={tags.length ? "" : "加标签（回车确认）"}
          className="flex-1 min-w-[96px] bg-transparent border-none outline-none py-0.5
                     text-[12.5px] text-[#fff] font-sans placeholder:text-[#ffffff59]" />
      </div>
      {cands.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {cands.map(s => (
            <button key={s} onMouseDown={e => e.preventDefault()} onClick={() => onChange(normTags([...tags, s]))}
              className="text-[11px] font-sans text-[#c8c8c8] bg-[#ffffff14] rounded px-1.5 leading-[20px]
                         border-none cursor-pointer hover:bg-[#ffffff26]">
              #{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 批注编辑框 ─────────────────────────────────────────────────────
   高亮是一下就完成的动作，批注要打字 —— 弹一个小框，别在侧栏里就地编辑
   （侧栏太窄，而且写的时候看不见原文）。
   `showTags = false`：0031 没跑，库里没有 tags 列，输入了也存不下，干脆不出 */
export function AnnEditor({ draft, onChange, onSave, onCancel, showTags, tagSuggestions = [], doc }) {
  const taRef = useRef(null);
  // 跟着「打开」聚焦，不是跟着挂载 —— 这个组件一直挂着，没 draft 时只是 return null
  const open = !!draft;
  useEffect(() => { if (open) taRef.current?.focus(); }, [open]);
  if (!draft) return null;
  const label = draft.kind === "area" ? " · 区域选取"
    : draft.kind === "underline" ? " · 下划线"
    : draft.quote ? "" : " · 整页笔记";
  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center justify-center
                    bg-black/50 p-3 animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-full max-w-[420px] max-h-full overflow-y-auto thin-scrollbar rounded-xl bg-[#323639]
                      border border-[#ffffff26] shadow-[0_16px_48px_rgba(0,0,0,0.5)] p-3">
        <div className="text-[11px] text-[#9a9a9a] font-sans mb-1.5 tabular-nums">
          第 {draft.page} 页{label}
        </div>
        {draft.kind === "area" && draft.rects?.length === 1 ? (
          <div className="mb-2 max-w-[240px]">
            <AreaThumb doc={doc} a={{ id: draft.id || "draft", page: draft.page, rects: draft.rects }} />
          </div>
        ) : draft.quote && (
          <div className="text-[11.5px] leading-snug text-[#d8d8d8] font-sans line-clamp-3 mb-2
                          pl-2 border-l-2 border-[#ffffff33]">
            {draft.quote}
          </div>
        )}
        <textarea ref={taRef} value={draft.body || ""} rows={4}
          onChange={e => onChange({ ...draft, body: e.target.value })}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(); }
            if (e.key === "Escape") onCancel();
          }}
          placeholder="写下你的批注…（支持 $公式$）"
          className="w-full resize-none rounded-lg bg-[#00000059] border border-[#ffffff33]
                     px-2.5 py-2 text-[13px] text-[#fff] font-sans outline-none
                     placeholder:text-[#ffffff66] focus:border-[#ffffff80]" />
        {showTags && (
          <TagInput tags={draft.tags || []} suggestions={tagSuggestions}
            onChange={(tags) => onChange({ ...draft, tags })} />
        )}
        <div className="flex items-center justify-end gap-2 mt-2">
          <button onClick={onCancel}
            className="h-8 px-3 rounded-full text-[12.5px] font-sans text-[#c8c8c8] whitespace-nowrap
                       bg-transparent border border-[#ffffff33] cursor-pointer hover:bg-[#ffffff1a]">
            取消
          </button>
          <button onClick={onSave}
            className="h-8 px-4 rounded-full text-[12.5px] font-bold font-sans text-[#10232c] whitespace-nowrap
                       bg-[#7ec8e3] border-none cursor-pointer hover:bg-[#9ad5ea]">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 区域框的线型 / 粗细 ─────────────────────────────────────────────
   默认值存 localStorage（per 设备偏好）；每条框自己的值存在标注的 style 字段 */
export const DASHES = [["solid", "实线"], ["dashed", "虚线"], ["dotted", "点线"]];
export const WIDTHS = [1, 2, 3, 4];
const AREA_KEY = "rh_area_style";
export function loadAreaStyle() {
  try { return { color: "blue", dash: "solid", width: 2, fill: false, ...JSON.parse(localStorage.getItem(AREA_KEY) || "{}") }; }
  catch { return { color: "blue", dash: "solid", width: 2, fill: false }; }
}
export const saveAreaStyle = (s) => { try { localStorage.setItem(AREA_KEY, JSON.stringify(s)); } catch { /* 隐私模式 */ } };

/** 线型示意：一小段横线，按真实 border 画，所见即所得 */
const DashSample = ({ dash, width = 2, color = "#e6e6e6" }) => (
  <span className="block w-[22px]" style={{ borderTop: `${width}px ${dash} ${color}` }} />
);

/**
 * 删除按钮，要点两下（笔记列表、标注编辑条、附注卡片共用）。不用「确认删除」这种文字，在按钮本身上做状态：
 * - 平时：灰色垃圾桶；指上去变红、出淡红底
 * - 点第一下：「待删除」—— 实心红底、白色图标，垃圾桶盖子掀开并抖一下；title 变成「再点一下删除」
 * - 再点一下才删。3 秒内没点、或者鼠标移开（给 0.8 秒余量），自动回到平时的样子
 * light：放在浅色底上（附注卡片）；round：圆形（列表里的小按钮）
 */
export function DeleteButton({ onConfirm, title = "删除", size = 24, icon = 14, light = false, round = false }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const disarmIn = (ms) => { clearTimeout(timer.current); timer.current = setTimeout(() => setArmed(false), ms); };
  const click = (e) => {
    e.stopPropagation();
    if (armed) { clearTimeout(timer.current); setArmed(false); onConfirm(); return; }
    setArmed(true);
    disarmIn(3000);
  };
  const idle = light ? "text-[#666] hover:text-[#d93025] hover:bg-[#d930251a]" : "text-[#c0c0c0] hover:text-[#ff8a8a] hover:bg-[#ff8a8a1f]";
  return (
    <button onClick={click} onMouseLeave={() => { if (armed) disarmIn(800); }} onMouseEnter={() => { if (armed) disarmIn(3000); }}
      title={armed ? "再点一下删除" : title} aria-label={armed ? "再点一下删除" : title}
      className={`${round ? "rounded-full" : "rounded-md"} shrink-0 flex items-center justify-center border-none cursor-pointer transition-colors
        ${armed ? "rh-armed bg-[#d93025] text-[#fff] hover:bg-[#b3261e]" : `bg-transparent ${idle}`}`}
      style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={icon} height={icon} fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" style={{ overflow: "visible" }}>
        <g className="rh-lid"><path d="M3 6h18" /><path d="M8 6V4h8v2" /></g>
        <path d="M6 6l1 14h10l1-14" /><path d="M10 11v5M14 11v5" />
      </svg>
    </button>
  );
}

/** 一排颜色方块。框选、画笔、文本框三处共用，形状和顺序都一样（顺序 = COLORS 的顺序） */
function ColorSwatches({ value, onChange, light }) {
  return (
    <div className="flex items-center gap-1">
      {Object.keys(COLORS).map(c => (
        <button key={c} onClick={() => onChange(c)} title={COLOR_NAMES[c]}
          className="w-6 h-6 rounded-md border-none cursor-pointer shrink-0 p-0"
          style={{ background: rgba(c, 0.9), boxShadow: c === value ? (light ? "0 0 0 2px #f6f6f6, 0 0 0 3.5px #333" : "0 0 0 2px #323639, 0 0 0 3.5px #fff") : "none" }} />
      ))}
    </div>
  );
}

/** 颜色 / 线型 / 粗细 / 填充四排选项，下拉菜单和点击框弹出的编辑条共用 */
function StylePicker({ color, dash, width, fill, onColor, onDash, onWidth, onFill }) {
  const row = "flex items-center gap-1";
  const opt = (on) => `h-7 min-w-7 px-1.5 rounded-md flex items-center justify-center border-none cursor-pointer
    ${on ? "bg-[#ffffff33]" : "bg-transparent hover:bg-[#ffffff1a]"}`;
  return (
    <div className="flex flex-col gap-1.5">
      {onColor && (
        <ColorSwatches value={color} onChange={onColor} />
      )}
      {onDash && (
        <div className={row}>
          {DASHES.map(([k, label]) => (
            <button key={k} onClick={() => onDash(k)} title={label} className={opt(dash === k)}>
              <DashSample dash={k} color={rgba(color, 1)} />
            </button>
          ))}
        </div>
      )}
      {onWidth && (
        <div className={row}>
          {WIDTHS.map(w => (
            <button key={w} onClick={() => onWidth(w)} title={`${w} 像素`} className={opt(width === w)}>
              <DashSample dash="solid" width={w} color={rgba(color, 1)} />
            </button>
          ))}
        </div>
      )}
      {onFill && (
        /* 只有两个值 ⇒ 点按切换，按钮上画的就是效果本身（空心框 / 实心框） */
        <div className={row}>
          {[[false, "无填充"], [true, "填充"]].map(([v, label]) => (
            <button key={label} onClick={() => onFill(v)} title={label} className={`${opt(!!fill === v)} gap-1.5 text-[11px] text-[#e6e6e6] font-sans`}>
              <span className="block w-[14px] h-[11px] rounded-[2px]"
                style={{ border: `1.5px solid ${rgba(color, 1)}`, background: v ? rgba(color, 0.35) : "transparent" }} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 工具条上打开样式面板的那颗小按钮。两种样子：
 * - 横排：工具右边一个小箭头（▾）
 * - 竖排（corner）：叠在工具按钮右下角的小三角（同 Photoshop / Figma 的工具栏）。竖排时右边再挂一个箭头，
 *   有下拉的和没下拉的工具就对不齐，图标整体偏左、右边空一条（踩过）；角标不占宽度，一列按钮都居中
 */
function MenuTrigger({ btnRef, open, onClick, title, dir, corner }) {
  if (corner) {
    return (
      <button ref={btnRef} onClick={onClick} title={title}
        className={`absolute right-0 bottom-0 w-3 h-3 p-0 rounded-br-md border-none cursor-pointer flex items-end justify-end
          bg-transparent ${open ? "text-[#fff]" : "text-[#b8b8b8] hover:text-[#fff]"}`}>
        <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor"><path d="M10.5 5.5v5h-5z" /></svg>
      </button>
    );
  }
  return (
    <button ref={btnRef} onClick={onClick} title={title}
      className={`h-7 w-3 rounded-md flex items-center justify-center border-none cursor-pointer shrink-0
        ${open ? "text-[#fff] bg-[#ffffff33]" : "text-[#c8c8c8] bg-transparent hover:bg-[#ffffff26]"}`}>
      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round"><polyline points={dir === "down" ? "6 9 12 15 18 9" : "9 6 15 12 9 18"} /></svg>
    </button>
  );
}

/** 工具条下拉面板的位置：竖排时往右展开，横排时往下展开。工具条能拖到任何地方，
    所以那边放不下就翻到另一边（下面不够往上开、右边不够往左开），最后再夹进窗口。h 是面板的大致高度 */
const menuPos = (r, dir, w, h) => {
  const W = window.innerWidth, H = window.innerHeight;
  if (dir === "down") {
    const top = r.bottom + 6 + h <= H - 8 ? r.bottom + 6 : r.top - 6 - h;
    return { top: Math.max(8, top), left: Math.max(8, Math.min(r.left - 8, W - w - 8)) };
  }
  const left = r.right + 10 + w <= W - 8 ? r.right + 10 : r.left - 10 - w;
  return { top: Math.max(8, Math.min(r.top - 8, H - h - 8)), left: Math.max(8, left) };
};

/* 浮动工具条上框选按钮右边的小下拉（往右展开）：默认颜色 / 线型 / 粗细（参照 Edge 的「绘制」下拉）。
   面板用 fixed + 按钮的位置定位，免得被工具栏的 overflow 裁掉 */
export function AreaStyleMenu({ value, onChange, dir = "right", corner = false }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setPos(null);
    };
    const onKey = (e) => { if (e.key === "Escape") setPos(null); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [pos]);
  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos(menuPos(r, dir, 216, 175));
  };
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <>
      <MenuTrigger btnRef={btnRef} open={!!pos} onClick={toggle} title="框选的默认颜色、线型和粗细" dir={dir} corner={corner} />
      {/* 216 = 7 个色块（24px + 间距 4px）一排 192 + 左右内边距：原来 200 宽，最后一个色块冒出面板 */}
      {pos && (
        <div ref={panelRef} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
          className="w-[216px] p-2.5 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
          <div className="text-[11px] text-[#9a9a9a] font-sans mb-1.5">框选默认样式</div>
          <StylePicker {...value} onColor={c => set({ color: c })} onDash={d => set({ dash: d })} onWidth={w => set({ width: w })}
            onFill={f => set({ fill: f })} />
        </div>
      )}
    </>
  );
}

/* ── 点击正文上的标注弹出的编辑条 ─────────────────────────────────────
   以前点框 / 高亮只是「选中」，改颜色、删除都得跑去侧栏找那一条 —— 太绕。
   自己的：换颜色（框还能换线型粗细）/ 批注 / 删除；别人的：收藏。
   和划选工具条一样放在 .pdfViewer 的内容坐标里，跟着页面滚 */
export function AnnMenu({ pos, a, mine, copied, author, onColor, onStyle, onEdit, onDelete, onCopy, onClose }) {
  const menuRef = useRef(null);
  useKeepInView(menuRef, [pos?.x, pos?.y, pos?.below, a?.id]);
  if (!pos || !a) return null;
  const isArea = a.kind === "area";
  const btn = "h-7 px-2 rounded-md text-[11.5px] font-sans text-[#e6e6e6] bg-transparent border-none cursor-pointer hover:bg-[#ffffff26] shrink-0 whitespace-nowrap";
  return (
    <div ref={menuRef} style={{ position: "absolute", left: pos.x, top: pos.y, zIndex: 40,
                  /* 和选区 / 标注之间留 10px：mb-1.5 对绝对定位 + transform 不起作用，原来其实是贴着的 */
                  transform: pos.below ? "translate(-50%, 10px)" : "translate(-50%, calc(-100% - 10px))" }}
      onMouseDown={e => e.preventDefault()} onPointerDown={e => e.stopPropagation()}
      className="rh-selbar mb-1.5 p-1.5 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)]">
      {mine ? (
        <div className="flex items-start gap-1.5">
          <StylePicker color={a.color} dash={a.style?.dash || "solid"} width={a.style?.width || 2} fill={!!a.style?.fill}
            onFill={isArea ? (f => onStyle({ fill: f })) : null}
            onColor={onColor}
            onDash={isArea ? (d => onStyle({ dash: d })) : null}
            onWidth={isArea ? (w => onStyle({ width: w })) : null} />
          <div className="self-stretch border-l border-[#ffffff26]" />
          {/* 批注 / 删除：图标按钮（和笔记列表里的同一套：铅笔、垃圾桶），文字放进 title。
              原来是「批注」「删除」两行字，挤在颜色块旁边像两条菜单项。删除要点两下（见 DeleteButton） */}
          <div className="flex flex-col gap-1 items-center">
            <button onClick={onEdit} title={a.body ? "编辑批注和标签" : "写批注 / 加标签"} aria-label="批注"
              className="w-8 h-8 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer
                         text-[#d0d0d0] hover:text-[#fff] hover:bg-[#ffffff26]">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            </button>
            <DeleteButton onConfirm={onDelete} title="删除这条标注" size={32} icon={16} />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          {author && <span className="text-[11px] text-[#9a9a9a] font-sans px-1">{author.name}</span>}
          <button onClick={onCopy} disabled={copied} className={btn}>{copied ? "✓ 已在我的笔记" : "+ 收藏到我的笔记"}</button>
          <button onClick={onClose} className={btn}>✕</button>
        </div>
      )}
    </div>
  );
}

/* ── 选中的区域框：拖动 / 缩放 ────────────────────────────────────────
   点中自己的框（或刚框完）时，正文上的那个框先不画（useHighlightLayer 的 hiddenId），
   由这个编辑框代替：中间拖动整体移动，八个把手缩放，松手才写库。
   放在 .pdfViewer 的内容坐标里（同划选工具条），跟着页面滚；坐标每次渲染从页面盒子现量，
   所以缩放之后（zoom 变了会重渲染）也对得上 */
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CURSOR = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

export function AreaEditBox({ a, viewerEl, onCommit }) {
  const [r, setR] = useState(a.rects[0]);
  const rRef = useRef(r);
  rRef.current = r;
  const key = JSON.stringify(a.rects[0]);
  useEffect(() => { setR(JSON.parse(key)); }, [key]);   // 存好之后以库里的为准

  const pageEl = viewerEl?.querySelector(`.page[data-page-number="${a.page}"]`);
  if (!pageEl) return null;
  const box = pageCanvasBox(pageEl);
  const vb = viewerEl.getBoundingClientRect();
  const W = box.width, H = box.height;

  const start = (mode) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const sx = e.clientX, sy = e.clientY, r0 = rRef.current;
    const minW = 12 / W, minH = 12 / H;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const move = (ev) => {
      const dx = (ev.clientX - sx) / W, dy = (ev.clientY - sy) / H;
      if (mode === "move") {
        setR({ ...r0, x: clamp(r0.x + dx, 0, 1 - r0.w), y: clamp(r0.y + dy, 0, 1 - r0.h) });
        return;
      }
      let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
      if (mode.includes("w")) x1 = clamp(r0.x + dx, 0, x2 - minW);
      if (mode.includes("e")) x2 = clamp(r0.x + r0.w + dx, x1 + minW, 1);
      if (mode.includes("n")) y1 = clamp(r0.y + dy, 0, y2 - minH);
      if (mode.includes("s")) y2 = clamp(r0.y + r0.h + dy, y1 + minH, 1);
      setR({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const nr = rRef.current;
      const round = (v) => +v.toFixed(5);
      if (["x", "y", "w", "h"].some(k => Math.abs(nr[k] - r0[k]) > 1e-4)) {
        onCommit({ x: round(nr.x), y: round(nr.y), w: round(nr.w), h: round(nr.h) }, pageEl);
      }
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const bw = (a.style?.width || 2) + 1;
  const col = rgba(a.color, 1);
  const hpos = (h) => ({
    left: h.includes("w") ? 0 : h.includes("e") ? "100%" : "50%",
    top: h.includes("n") ? 0 : h.includes("s") ? "100%" : "50%",
  });
  return (
    <div className="rh-selbar" onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()}
      style={{
        position: "absolute", zIndex: 35, boxSizing: "border-box", borderRadius: 2,
        left: box.left - vb.left + r.x * W, top: box.top - vb.top + r.y * H, width: r.w * W, height: r.h * H,
        border: `${bw}px ${a.style?.dash || "solid"} ${col}`,
        background: a.style?.fill ? rgba(a.color, 0.3) : rgba(a.color, 0.06),
      }}>
      <div onPointerDown={start("move")} title="拖动移动" style={{ position: "absolute", inset: 0, cursor: "move" }} />
      {HANDLES.map(h => (
        <div key={h} onPointerDown={start(h)}
          style={{
            position: "absolute", ...hpos(h), width: 9, height: 9, transform: "translate(-50%,-50%)",
            background: "#fff", border: `1.5px solid ${col}`, borderRadius: 2, cursor: CURSOR[h],
          }} />
      ))}
    </div>
  );
}

/* ── 画笔下拉（参照 Edge 的「绘制」）：颜色一排 + 预览笔画 + 粗细滑块 ──────── */

export function PenMenu({ value, onChange, dir = "right", corner = false }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setPos(null);
    };
    const onKey = (e) => { if (e.key === "Escape") setPos(null); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [pos]);
  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos(menuPos(r, dir, 240, 205));
  };
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <>
      <MenuTrigger btnRef={btnRef} open={!!pos} onClick={toggle} title="画笔颜色和粗细" dir={dir} corner={corner} />
      {pos && (
        <div ref={panelRef} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
          className="w-[240px] p-3 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in font-sans">
          <div className="text-[12.5px] text-[#f2f2f2] font-bold mb-2">颜色</div>
          <ColorSwatches value={value.color} onChange={c => set({ color: c })} />
          {/* 预览：一道波浪线，颜色和粗细都是当前选的 */}
          <svg viewBox="0 0 200 44" className="block w-full my-2.5">
            <path d="M8 30 C 40 6, 70 6, 100 22 S 160 38, 192 14" fill="none" stroke={rgba(value.color, 1)}
              strokeWidth={value.width * 1.6} strokeLinecap="round" />
          </svg>
          <div className="text-[12.5px] text-[#f2f2f2] font-bold mb-1">粗细</div>
          <input type="range" min="1" max="12" step="1" value={value.width}
            onChange={e => set({ width: Number(e.target.value) })}
            className="w-full accent-[#7ec8e3] cursor-pointer" />
          <div className="flex justify-between text-[11px] text-[#9a9a9a]"><span>细</span><span>粗</span></div>
        </div>
      )}
    </>
  );
}

/* ── 文本框编辑器（「添加文本」工具 / 点已有的文本框）──────────────────────
   放在浮层里（同 AreaEditBox），坐标和字号按页面盒子现量：浮层不在 .page 里，
   拿不到 pdf.js 的 --total-scale-factor，所以从 .pdfViewer 上的 --scale-factor 读（它是数字）。
   左边 ⋮⋮ 拖动移动，右边圆钮拖宽度；上面一条工具：颜色 / 字号 ± / 字间距 ± / 删除。
   点外面或 Esc 收起：有字就存，没字就当没加过（已经存过的就删掉） */

export function TextBoxEditor({ draft, viewerEl, onChange, onDone, onDelete }) {
  const taRef = useRef(null);
  const boxRef = useRef(null);
  const [colorOpen, setColorOpen] = useState(false);
  const pageEl = viewerEl?.querySelector(`.page[data-page-number="${draft.page}"]`);

  // 内容一变就把高度撑开（textarea 不会自己长高）
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    /* 顺手把高度记进 rect.h（存库后当外接框用：列表排序、跳转定位）。差得不多就不更新，免得来回重渲染 */
    const pg = viewerEl?.querySelector(`.page[data-page-number="${draft.page}"]`);
    const ph = pg ? pageCanvasBox(pg).height : 0;
    if (ph) {
      const h = ta.offsetHeight / ph;
      if (Math.abs(h - (draft.rect.h || 0)) > 0.002) onChange({ rect: { ...draft.rect, h } });
    }
  });
  useEffect(() => { taRef.current?.focus(); }, []);

  useEffect(() => {
    const close = (e) => { if (!boxRef.current?.contains(e.target)) onDone(); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(); } };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey, true); };
  }, [onDone]);

  if (!pageEl) return null;
  const box = pageCanvasBox(pageEl);
  const vb = viewerEl.getBoundingClientRect();
  const W = box.width, H = box.height;
  const k = parseFloat(viewerEl.style.getPropertyValue("--scale-factor")) || 1.333;   // = 缩放 × 96/72
  const r = draft.rect, st = draft.style;

  /* 拖动（mode = move）/ 拉宽度（mode = width）。按下时记住起点，移动时改 draft */
  const drag = (mode) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const sx = e.clientX, sy = e.clientY, r0 = { ...r };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const move = (ev) => {
      const dx = (ev.clientX - sx) / W, dy = (ev.clientY - sy) / H;
      if (mode === "move") onChange({ rect: { ...r0, x: clamp(r0.x + dx, 0, 1 - r0.w), y: clamp(r0.y + dy, 0, 0.98) } });
      else onChange({ rect: { ...r0, w: clamp(r0.w + dx, 40 / W, 1 - r0.x) } });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      taRef.current?.focus();
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const setStyle = (patch) => onChange({ style: { ...st, ...patch } });
  const tb = "h-8 min-w-8 px-1.5 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer text-[#e6e6e6] hover:bg-[#ffffff1f] disabled:opacity-35 disabled:cursor-default";
  const sep = <div className="h-5 border-l border-[#ffffff26] mx-0.5" />;

  return (
    <div ref={boxRef} className="rh-selbar" onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()}
      style={{ position: "absolute", zIndex: 46, left: box.left - vb.left + r.x * W, top: box.top - vb.top + r.y * H, width: r.w * W }}>
      {/* 工具条，贴在框的上方 */}
      {/* z-index 别省：颜色面板从这条下面展开，没有它会被后面的文本框盖住（踩过） */}
      <div style={{ zIndex: 2 }}
        className="absolute left-0 bottom-full mb-2 flex items-center gap-0.5 p-1 rounded-lg bg-[#323639] border border-[#ffffff26]
                      shadow-[0_6px_20px_rgba(0,0,0,0.45)] whitespace-nowrap">
        <div className="relative">
          <button className={tb} onClick={() => setColorOpen(v => !v)} title="文字颜色">
            <span className="flex flex-col items-center leading-none">
              <span className="text-[14px] font-semibold">A</span>
              <span className="block w-4 h-[3px] rounded mt-0.5" style={{ background: rgba(draft.color, 1) }} />
            </span>
            <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3" className="ml-1"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {colorOpen && (
            /* 往上展开：往下会正好盖住正在编辑的文本框 */
            <div className="absolute left-0 bottom-full mb-1 p-2.5 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)]">
              <ColorSwatches value={draft.color} onChange={c => { onChange({ color: c }); setColorOpen(false); taRef.current?.focus(); }} />
            </div>
          )}
        </div>
        {sep}
        <button className={tb} onClick={() => setStyle({ size: Math.min(72, st.size + 1) })} disabled={st.size >= 72} title={`增大字号（${st.size}pt）`}>
          <span className="text-[15px]">A</span><span className="text-[10px] -mt-2">ˆ</span>
        </button>
        <button className={tb} onClick={() => setStyle({ size: Math.max(6, st.size - 1) })} disabled={st.size <= 6} title={`减小字号（${st.size}pt）`}>
          <span className="text-[15px]">A</span><span className="text-[10px] -mt-1">ˇ</span>
        </button>
        {sep}
        <button className={tb} onClick={() => setStyle({ spacing: Math.min(10, +(st.spacing + 0.5).toFixed(1)) })} disabled={st.spacing >= 10} title="加大字间距">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l3.5-9L12 13M6.3 10h4.4" /><path d="M13 4l3 9 3-9" /><path d="M3 19h18M3 19l2.5-2M3 19l2.5 2M21 19l-2.5-2M21 19l-2.5 2" /></svg>
        </button>
        <button className={tb} onClick={() => setStyle({ spacing: Math.max(-2, +(st.spacing - 0.5).toFixed(1)) })} disabled={st.spacing <= -2} title="减小字间距">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l3.5-9L12 13M6.3 10h4.4" /><path d="M13 4l3 9 3-9" /><path d="M3 19h6M9 19l-2.5-2M9 19l-2.5 2M21 19h-6M15 19l2.5-2M15 19l2.5 2" /></svg>
        </button>
        {sep}
        <button className={tb} onClick={onDelete} title="删除这个文本框">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
        </button>
      </div>

      {/* 框本身：左边拖动把手、右边拉宽度的圆钮 */}
      <div className="relative" style={{ outline: "1.5px dashed #2f7bd8", outlineOffset: 1, borderRadius: 2 }}>
        <div onPointerDown={drag("move")} title="拖动移动"
          className="absolute top-0 bottom-0 -left-3 w-3 flex items-center justify-center bg-[#2f7bd8] rounded-l cursor-move">
          <svg viewBox="0 0 6 12" width="5" height="10" fill="#fff"><circle cx="1.5" cy="2" r="1" /><circle cx="4.5" cy="2" r="1" /><circle cx="1.5" cy="6" r="1" /><circle cx="4.5" cy="6" r="1" /><circle cx="1.5" cy="10" r="1" /><circle cx="4.5" cy="10" r="1" /></svg>
        </div>
        <textarea ref={taRef} value={draft.body} rows={1} placeholder="在此处开始键入…"
          onChange={e => onChange({ body: e.target.value })}
          onKeyDown={e => e.stopPropagation()}
          className="block w-full resize-none overflow-hidden bg-[#ffffffd9] border-none outline-none m-0 placeholder:text-[#9aa0a6]"
          style={{
            font: `${st.size * k}px/1.3 ${TEXT_FONT}`, letterSpacing: `${st.spacing * k}px`,
            color: rgba(draft.color, 1), padding: "2px 4px", boxSizing: "border-box",
          }} />
        <div onPointerDown={drag("width")} title="拖动调整宽度"
          className="absolute top-1/2 -right-[7px] w-3 h-3 -translate-y-1/2 rounded-full bg-[#fff] border-2 border-[#2f7bd8] cursor-ew-resize" />
      </div>
    </div>
  );
}

/* ── 附注卡片（kind = "note"，参照 Edge）────────────────────────────────
   点页面上的附注图标弹出来，挂在图标右边（右边放不下就放左边）。自己的附注：正文直接改、能回复、能删；
   别人公开的附注只读。点外面 / Esc / ✕ 收起时由调用方保存（同文本框：没内容的新附注就当没加过）。
   新附注还没存的时候页面上没有图标，卡片自己画一个占位的 */
const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};

export function NotePopup({ draft, viewerEl, onChange, onDone, onDelete }) {
  const cardRef = useRef(null);
  useKeepInView(cardRef, [draft.page, draft.rect.x, draft.rect.y]);
  const bodyRef = useRef(null);
  const replyRef = useRef(null);
  const [reply, setReply] = useState("");
  const pageEl = viewerEl?.querySelector(`.page[data-page-number="${draft.page}"]`);
  const mine = draft.mine;
  const replies = draft.replies || [];

  useEffect(() => {
    const ta = bodyRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  });
  useEffect(() => { if (mine && !draft.body) bodyRef.current?.focus(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const close = (e) => { if (!cardRef.current?.contains(e.target)) onDone(); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(); } };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey, true); };
  }, [onDone]);

  if (!pageEl) return null;
  const box = pageCanvasBox(pageEl);
  const vb = viewerEl.getBoundingClientRect();
  const iconL = box.left - vb.left + draft.rect.x * box.width;
  const iconT = box.top - vb.top + draft.rect.y * box.height;
  const CARD_W = 280;
  // 右边放不下（贴着页面右边的附注）就放到图标左边
  const right = iconL + NOTE_SIZE + 8 + CARD_W <= vb.width - 8;
  const left = right ? iconL + NOTE_SIZE + 8 : Math.max(4, iconL - 8 - CARD_W);

  const post = () => {
    const t = reply.trim();
    if (!t) return;
    onChange({ replies: [...replies, { id: crypto.randomUUID(), name: draft.me || "我", at: new Date().toISOString(), text: t }] });
    setReply("");
  };
  const ib = "w-6 h-6 rounded flex items-center justify-center bg-transparent border-none cursor-pointer text-[#666] hover:bg-[#0000000f] hover:text-[#222]";

  return (
    <>
      {!draft.id && (
        <div style={{ position: "absolute", left: iconL, top: iconT, width: NOTE_SIZE, height: NOTE_SIZE, zIndex: 45,
                      borderRadius: 5, background: rgba(draft.color, 1), color: noteInk(draft.color),
                      display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,.35)" }}
          dangerouslySetInnerHTML={{ __html: NOTE_SVG }} />
      )}
      <div ref={cardRef} onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()}
        style={{ position: "absolute", left, top: iconT - 4, width: CARD_W, zIndex: 46,
                 border: `1.5px solid ${rgba(draft.color, 1)}` }}
        className="rh-selbar font-sans rounded-lg bg-[#f6f6f6] shadow-[0_6px_20px_rgba(0,0,0,0.3)] text-[#222]">
        <div className="flex items-center gap-1.5 pl-3 pr-1.5 pt-2 pb-1">
          <span className="text-[13px] font-bold truncate">{draft.author || "我"}</span>
          <span className="text-[11.5px] text-[#888] shrink-0">{fmtTime(draft.at)}</span>
          <span className="flex-1" />
          {mine && draft.id && <DeleteButton onConfirm={onDelete} title="删除这条附注（连同回复）" size={24} icon={14} light />}
          <button onClick={onDone} title="关闭（Esc）" className={ib}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="px-3 pb-2">
          {mine ? (
            <textarea ref={bodyRef} value={draft.body} rows={1} placeholder="添加附注…"
              onChange={e => onChange({ body: e.target.value })}
              className="w-full resize-none bg-transparent border-none outline-none text-[13px] leading-[1.5] text-[#222] p-0 font-sans placeholder:text-[#999]" />
          ) : (
            <div className="text-[13px] leading-[1.5] whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto">{draft.body}</div>
          )}
          {replies.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-2 max-h-[220px] overflow-y-auto">
              {replies.map(r => (
                <div key={r.id} className="group border-t border-[#0000001a] pt-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-bold truncate">{r.name}</span>
                    <span className="text-[11px] text-[#888] shrink-0">{fmtTime(r.at)}</span>
                    <span className="flex-1" />
                    {mine && (
                      <button onClick={() => onChange({ replies: replies.filter(x => x.id !== r.id) })} title="删除这条回复"
                        className="hidden group-hover:block text-[11px] text-[#b44] bg-transparent border-none cursor-pointer px-1">删除</button>
                    )}
                  </div>
                  <div className="text-[12.5px] leading-[1.5] whitespace-pre-wrap break-words">{r.text}</div>
                </div>
              ))}
            </div>
          )}
          {mine && (
            <div className="mt-2 pt-2 border-t border-[#0000001a]" title="图标颜色">
              <ColorSwatches light value={draft.color} onChange={c => onChange({ color: c })} />
            </div>
          )}
          {mine && (draft.body.trim() || replies.length > 0) && (
            <div className="mt-2">
              <input ref={replyRef} value={reply} onChange={e => setReply(e.target.value)} placeholder="添加回复…"
                onKeyDown={e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); post(); } }}
                className="w-full h-8 px-2 rounded-md bg-[#fff] border border-[#d0d0d0] text-[12.5px] text-[#222] outline-none focus:border-[#7a9cc6] font-sans" />
              <div className="flex justify-end mt-1.5">
                <button onClick={post} disabled={!reply.trim()}
                  className="h-7 px-3 rounded-md text-[12px] border-none cursor-pointer font-sans bg-[#2f6fbf] text-[#fff] disabled:bg-[#e2e2e2] disabled:text-[#9a9a9a] disabled:cursor-default">
                  发布
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
