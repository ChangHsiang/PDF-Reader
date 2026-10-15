import { PdfAnnotationSubtype, PdfAnnotationBorderStyle, PdfStandardFont, PdfBlendMode, PdfAnnotationName } from "@embedpdf/models";

/**
 * 导出带标注的 PDF：我们的笔记 → 标准的 PDF 注释（写进原文件的一份拷贝，见 worker 的 exportAnnotated）。
 * 别的阅读器（Edge、Acrobat、Zotero、Chrome）打开都能看到、能接着改。
 *
 *   高亮 / 下划线 → Highlight / Underline（每一行一个四边形，批注写进注释的内容）
 *   框选         → Square（线型、粗细、填充照搬）
 *   画笔         → Ink（一条标注里的每一笔都是一条线）
 *   文本框       → FreeText（字号照搬；中文要看对方阅读器的字体，Helvetica 里没有中文字形）
 *   附注         → Text（便签图标，内容 + 回复）
 *   页级笔记     → Text（放在那一页左上角）
 *
 * 坐标：我们存的是相对这一页的比例（原点左上、显示方向），embedpdf 的注释用「点、原点左上、显示方向」，
 * 乘上页面尺寸就是（它自己再换成 PDF 用户坐标，旋转、裁切框都会处理）。
 * 做于这篇论文别的版本的标注坐标对不上（stale），不导出，数量告诉调用方
 */

const COLORS = {
  yellow: [255, 213, 0], red: [230, 30, 30], green: [64, 206, 120], blue: [80, 170, 255],
  pink: [255, 120, 180], purple: [180, 130, 255], black: [34, 34, 34],
};
const hex = (name) => `#${(COLORS[name] || COLORS.yellow).map(v => v.toString(16).padStart(2, "0")).join("")}`;
const PX2PT = 72 / 96;          // 我们的「100% 时的像素」→ 点

/** 归一化矩形 → 点（原点左上） */
const box = (r, W, H) => ({ origin: { x: r.x * W, y: r.y * H }, size: { width: Math.max(0.5, r.w * W), height: Math.max(0.5, r.h * H) } });
const union = (rs) => {
  const x0 = Math.min(...rs.map(r => r.origin.x)), y0 = Math.min(...rs.map(r => r.origin.y));
  const x1 = Math.max(...rs.map(r => r.origin.x + r.size.width)), y1 = Math.max(...rs.map(r => r.origin.y + r.size.height));
  return { origin: { x: x0, y: y0 }, size: { width: x1 - x0, height: y1 - y0 } };
};

/**
 * anns：我的标注（已删除的不要传进来）；pages：doc.pages（[{ size: { width, height } }]）；author：作者名
 * 返回 { items: [{ pageIndex, annotation }], skipped }
 */
export function toPdfAnnotations(anns, pages, author) {
  const items = [];
  let skipped = 0;
  for (const a of anns) {
    const pageIndex = a.page - 1;
    const pg = pages[pageIndex];
    if (!pg || a.stale) { skipped++; continue; }
    const W = pg.size.width, H = pg.size.height;
    const base = {
      // 注释的名字（NM）用笔记的 id：这个文件再用本插件打开时认得出「这条就是我那条」，文件里那份就不画了（不叠两层）
      id: a.id,
      author, contents: a.body || "",
      created: a.created_at ? new Date(a.created_at) : new Date(),
      modified: a.updated_at ? new Date(a.updated_at) : new Date(),
    };
    const kind = a.kind || "highlight";
    if (!a.rects?.length) {
      // 页级笔记：左上角一个便签
      items.push({ pageIndex, annotation: { ...base, type: PdfAnnotationSubtype.TEXT, icon: PdfAnnotationName.Comment,
        rect: { origin: { x: 8, y: 8 }, size: { width: 18, height: 18 } }, color: hex(a.color), opacity: 1 } });
      continue;
    }
    if (kind === "highlight" || kind === "underline") {
      const segs = a.rects.map(r => box(r, W, H));
      items.push({ pageIndex, annotation: { ...base,
        type: kind === "underline" ? PdfAnnotationSubtype.UNDERLINE : PdfAnnotationSubtype.HIGHLIGHT,
        rect: union(segs), segmentRects: segs, strokeColor: hex(a.color), color: hex(a.color), opacity: 1,
        ...(kind === "highlight" ? { blendMode: PdfBlendMode.Multiply } : {}) } });
    } else if (kind === "area") {
      const st = a.style || {};
      items.push({ pageIndex, annotation: { ...base, type: PdfAnnotationSubtype.SQUARE,
        rect: box(a.rects[0], W, H), strokeColor: hex(a.color), color: st.fill ? hex(a.color) : "transparent",
        strokeWidth: (st.width || 2) * PX2PT,
        strokeStyle: st.dash && st.dash !== "solid" ? PdfAnnotationBorderStyle.DASHED : PdfAnnotationBorderStyle.SOLID,
        strokeDashArray: st.dash === "dotted" ? [1, 2] : st.dash && st.dash !== "solid" ? [4, 3] : [],
        opacity: st.fill ? 0.35 : 1 } });
    } else if (kind === "ink") {
      // 一条标注一笔（rects[0]），也兼容一条里存了好几笔
      const strokes = a.rects.filter(r => r.path?.length);
      if (!strokes.length) { skipped++; continue; }
      const lw = (strokes[0].lw || 0.003) * W;
      const inkList = strokes.map(s => ({ points: s.path.map(([x, y]) => ({ x: x * W, y: y * H })) }));
      const pts = inkList.flatMap(s => s.points);
      const pad = lw;
      const x0 = Math.min(...pts.map(p => p.x)) - pad, y0 = Math.min(...pts.map(p => p.y)) - pad;
      const x1 = Math.max(...pts.map(p => p.x)) + pad, y1 = Math.max(...pts.map(p => p.y)) + pad;
      items.push({ pageIndex, annotation: { ...base, contents: "", type: PdfAnnotationSubtype.INK,
        rect: { origin: { x: x0, y: y0 }, size: { width: x1 - x0, height: y1 - y0 } },
        inkList, strokeColor: hex(a.color), color: hex(a.color), strokeWidth: lw, opacity: 1 } });
    } else if (kind === "text") {
      const st = a.style || {};
      const size = st.size || 12;
      const lines = String(a.body || "").split("\n").length;
      const r = a.rects[0];
      items.push({ pageIndex, annotation: { ...base, type: PdfAnnotationSubtype.FREETEXT,
        rect: { origin: { x: r.x * W, y: r.y * H }, size: { width: Math.max(20, r.w * W), height: Math.max(size * 1.4, lines * size * 1.3 + 4) } },
        fontFamily: PdfStandardFont.Helvetica, fontSize: size, fontColor: hex(a.color), textAlign: 0, verticalAlign: 0,
        color: "transparent", opacity: 1 } });
    } else if (kind === "note") {
      const r = a.rects[0];
      const replies = (a.style?.replies || []).map(x => `\n\n— ${x.name || ""}：${x.text || ""}`).join("");
      items.push({ pageIndex, annotation: { ...base, contents: (a.body || "") + replies,
        type: PdfAnnotationSubtype.TEXT, icon: PdfAnnotationName.Comment,
        rect: { origin: { x: r.x * W, y: r.y * H }, size: { width: 18, height: 18 } }, color: hex(a.color), opacity: 1 } });
    } else skipped++;
  }
  return { items, skipped };
}
