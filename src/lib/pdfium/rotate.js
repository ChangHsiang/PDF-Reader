/**
 * 页面旋转（工具栏的「旋转」，同 Edge：只转显示方向，不改文件）。
 *
 * 转的是整个 `.page`（CSS transform，见 viewer.js 的 _applyScale）：画布、文字层、链接层、高亮层……
 * 都挂在页面里，跟着一起转，**存的比例坐标永远按不旋转的页面算**，不同角度下打开、导出、同步都不受影响。
 * 代价是「屏幕坐标 ↔ 页面坐标」不能再直接拿 getBoundingClientRect 除一下：转过的元素给的是外接框，
 * 横竖对调 / 翻了个儿。凡是拿鼠标位置、选区矩形换算页面坐标的地方，都要经过这里。
 *
 * rot：0 / 90 / 180 / 270，顺时针，记在 `.page` 的 data-rot 上
 */

export const rotOf = (pageEl) => +(pageEl?.dataset?.rot || 0);
const wrapOf = (pageEl) => pageEl.querySelector(".canvasWrapper") || pageEl;
const boxOf = (pageEl) => wrapOf(pageEl).getBoundingClientRect();

/** 单位正方形里的一点，按 rot 顺时针转（页面方向 → 屏幕方向） */
export function rotFrac(rot, u, v) {
  switch (rot) {
    case 90: return [1 - v, u];
    case 180: return [1 - u, 1 - v];
    case 270: return [v, 1 - u];
    default: return [u, v];
  }
}
/** rotFrac 的逆：屏幕方向 → 页面方向 */
export function unrotFrac(rot, bx, by) {
  switch (rot) {
    case 90: return [by, 1 - bx];
    case 180: return [1 - bx, 1 - by];
    case 270: return [1 - by, bx];
    default: return [bx, by];
  }
}

/** 屏幕上一点 → 这一页的比例坐标 [u, v]（页面方向；0~1 以外是在页面外） */
export function clientToNorm(pageEl, x, y, box = boxOf(pageEl)) {
  return unrotFrac(rotOf(pageEl), (x - box.left) / box.width, (y - box.top) / box.height);
}

/** 页面上的比例坐标 → 屏幕坐标 [x, y] */
export function normToClient(pageEl, u, v, box = boxOf(pageEl)) {
  const [bx, by] = rotFrac(rotOf(pageEl), u, v);
  return [box.left + bx * box.width, box.top + by * box.height];
}

/** 屏幕上的矩形（DOMRect）→ 比例矩形 { x, y, w, h } */
export function clientRectToNorm(pageEl, r, box = boxOf(pageEl)) {
  const [a, b] = clientToNorm(pageEl, r.left, r.top, box);
  const [c, d] = clientToNorm(pageEl, r.right, r.bottom, box);
  return { x: Math.min(a, c), y: Math.min(b, d), w: Math.abs(c - a), h: Math.abs(d - b) };
}

/** 比例矩形 → 屏幕上的矩形 { left, top, right, bottom, width, height } */
export function normRectToClient(pageEl, n, box = boxOf(pageEl)) {
  const [a, b] = normToClient(pageEl, n.x, n.y, box);
  const [c, d] = normToClient(pageEl, n.x + n.w, n.y + n.h, box);
  const left = Math.min(a, c), top = Math.min(b, d), right = Math.max(a, c), bottom = Math.max(b, d);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** 这一页画布区不旋转时的 CSS 像素尺寸（transform 不影响 offsetWidth / offsetHeight） */
export function pageSizePx(pageEl) {
  const w = wrapOf(pageEl);
  return { w: w.offsetWidth, h: w.offsetHeight };
}

/**
 * 放在阅读区浮层里、但要和页面一起转的东西（框选的编辑框、正在编辑的文本框）：
 * 左上角放到页面上 (u, v) 那一点在屏幕上的位置，再按页面的角度转。宽高按页面方向的像素给
 * origin：浮层的屏幕左上角（.pdfViewer 的 getBoundingClientRect）
 */
export function localPlacement(pageEl, u, v, origin) {
  const [x, y] = normToClient(pageEl, u, v);
  const rot = rotOf(pageEl);
  return { left: x - origin.left, top: y - origin.top, ...(rot ? { transform: `rotate(${rot}deg)`, transformOrigin: "0 0" } : {}) };
}
