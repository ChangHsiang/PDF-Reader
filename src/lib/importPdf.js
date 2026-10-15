/**
 * 导入 PDF 文件里自带的标注（Edge / Acrobat / Zotero 存进去的，或者我们导出的）→ 我们的笔记。
 * 导入之后就和自己画的一样：列表里能看、能改颜色写批注、能删、能同步分享。
 * 文件里那份不再画（worker 的 takeAnnots 已经从显示用的那份里去掉），由我们的标注层画，所以不会叠两层。
 *
 *   Highlight / Underline / Squiggly → 高亮 / 下划线（原文从文字层按四边形取）
 *   Square / Circle                  → 框选（线型、粗细、填充）
 *   Ink                              → 画笔（每一笔一条线）
 *   FreeText                         → 文本框
 *   Text（便签）                      → 附注；回复（IRT 指向它的便签）并进附注的回复里
 *
 * 去重：每条算一个「指纹」（类型 + 页 + 位置取整 + 内容），导入过的指纹记在这篇笔记上（notes.js 的 importAnnotations），
 * 再打开不会重复导入，用户删掉的也不会再冒出来。我们自己导出的文件，注释名（NM）就是笔记 id —— 本地已经有这条就跳过
 */

const PALETTE = {
  yellow: [255, 213, 0], red: [230, 30, 30], green: [64, 206, 120], blue: [80, 170, 255],
  pink: [255, 120, 180], purple: [180, 130, 255], black: [34, 34, 34],
};
/** "#rrggbb" → 最接近的那个色名 */
export function nearestColor(hex, fallback = "yellow") {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
  if (!m) return fallback;
  const c = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  let best = fallback, bd = Infinity;
  for (const [name, p] of Object.entries(PALETTE)) {
    const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

const norm = (r, W, H) => ({ x: r.origin.x / W, y: r.origin.y / H, w: r.size.width / W, h: r.size.height / H });
const round5 = (v) => +v.toFixed(5);
const nr = (r) => ({ x: round5(r.x), y: round5(r.y), w: round5(r.w), h: round5(r.h) });
const iso = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString() : new Date().toISOString());

/** 一条注释的指纹：同一份文件每次打开都一样（NM 可能没有，embedpdf 读的时候会临时编一个，不能靠它） */
const fingerprint = (a, pageIndex) => {
  const r = a.rect;
  return [a.type, pageIndex, Math.round(r.origin.x), Math.round(r.origin.y), Math.round(r.size.width), Math.round(r.size.height),
    (a.contents || "").slice(0, 80)].join("|");
};

/** 高亮 / 下划线盖住的原文：字符中心落在某个四边形里的字，按顺序拼起来 */
function quoteOf(text, segs) {
  if (!text) return null;
  const { codes, boxes } = text;
  let out = "";
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k];
    if (!c) continue;
    const w = boxes[k * 4 + 2], h = boxes[k * 4 + 3];
    if (!(w > 0)) { if (out && !out.endsWith(" ") && (c === 32 || c === 10 || c === 13)) out += " "; continue; }
    const cx = boxes[k * 4] + w / 2, cy = boxes[k * 4 + 1] + h / 2;
    if (segs.some(s => cx >= s.origin.x && cx <= s.origin.x + s.size.width && cy >= s.origin.y && cy <= s.origin.y + s.size.height)) {
      out += c === 2 ? "-" : String.fromCodePoint(c);
    } else if (out && !out.endsWith(" ")) out += " ";
  }
  return out.replace(/\s+/g, " ").trim() || null;
}

/**
 * pages：worker takeAnnots 的结果（按页的注释数组）；docPages：doc.pages；getText(pageIndex)：取这一页的字符（doc.text）
 * 返回 [{ key, nm, ann }]，ann 是待存的笔记字段（不含 id / paper_key / 同步字段）
 */
export async function fileAnnotsToNotes(pages, docPages, getText, myName) {
  const out = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const list = pages[pageIndex] || [];
    if (!list.length) continue;
    const pg = docPages[pageIndex];
    const W = pg.size.width, H = pg.size.height;
    const byNm = new Map(list.map(a => [a.id, a]));
    // 便签的回复：IRT 指向父便签，并进去，不单独成一条
    const repliesOf = new Map();
    for (const a of list) {
      if (a.type === 1 && a.inReplyToId && byNm.has(a.inReplyToId)) {
        const l = repliesOf.get(a.inReplyToId) || [];
        l.push({ id: crypto.randomUUID(), name: a.author || "", at: iso(a.modified || a.created), text: a.contents || "" });
        repliesOf.set(a.inReplyToId, l);
      }
    }
    let text = null;
    for (const a of list) {
      if (a.type === 1 && a.inReplyToId && byNm.has(a.inReplyToId)) continue;
      const base = {
        page: pageIndex + 1, body: a.contents || "", tags: [],
        created_at: iso(a.created || a.modified), updated_at: iso(a.modified || a.created),
      };
      // 别人写的（作者不是我）：记一下来自谁，列表里显示「来自 PDF 文件 · 作者」
      const fromFile = { author: a.author && a.author !== myName ? a.author : "" };
      let ann = null;
      if (a.type === 9 || a.type === 10 || a.type === 11) {
        const segs = a.segmentRects?.length ? a.segmentRects : [a.rect];
        text ||= await getText(pageIndex).catch(() => null);
        ann = { ...base, kind: a.type === 9 ? "highlight" : "underline", color: nearestColor(a.strokeColor || a.color),
          rects: segs.map(s => nr(norm(s, W, H))), quote: quoteOf(text, segs), style: { fromFile } };
      } else if (a.type === 5 || a.type === 6) {
        const fill = a.color && a.color !== "transparent";
        ann = { ...base, kind: "area", color: nearestColor(a.strokeColor || a.color, "blue"), rects: [nr(norm(a.rect, W, H))],
          style: { dash: a.strokeStyle === 2 ? "dashed" : "solid", width: Math.max(1, Math.round((a.strokeWidth || 1.5) / 0.75)),
                   fill: !!fill, fromFile } };
      } else if (a.type === 15) {
        const lw = (a.strokeWidth || 1) / W;
        const rects = (a.inkList || []).filter(s => s.points?.length).map(s => {
          const xs = s.points.map(p => p.x / W), ys = s.points.map(p => p.y / H);
          const x0 = Math.min(...xs), y0 = Math.min(...ys);
          return { ...nr({ x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }),
                   path: s.points.map(p => [round5(p.x / W), round5(p.y / H)]), lw: +lw.toFixed(5) };
        });
        if (!rects.length) continue;
        ann = { ...base, kind: "ink", color: nearestColor(a.strokeColor || a.color, "black"), rects, style: { fromFile } };
      } else if (a.type === 3) {
        ann = { ...base, kind: "text", color: nearestColor(a.fontColor, "black"), rects: [nr(norm(a.rect, W, H))],
          style: { size: Math.round(a.fontSize || 12), spacing: 0, fromFile } };
      } else if (a.type === 1) {
        /* 便签图标按**底边**对齐：导出时我们写 18 点高，PDFium 生成外观时会改成 20 点、底边不动、往上长 ——
           按顶边取的话每导出 / 导入一次往上挪 2 点 */
        const x = a.rect.origin.x / W, y = Math.max(0, a.rect.origin.y + a.rect.size.height - 18) / H;
        ann = { ...base, kind: "note", color: nearestColor(a.color || a.strokeColor), rects: [nr({ x, y, w: 0, h: 0 })],
          style: { replies: repliesOf.get(a.id) || [], fromFile } };
      }
      if (ann) out.push({ key: fingerprint(a, pageIndex), nm: a.id, ann });
    }
  }
  return out;
}
