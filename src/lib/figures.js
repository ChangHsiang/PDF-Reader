/**
 * 文献卡片的「图片」页。两个来源，按顺序试：
 *
 * 1. INSPIRE 记录的 figures 字段（和 ResearchHub 网站同一个来源，见网站 lib/figures.js）：
 *    他们从 arXiv 的 LaTeX 源里抽好的图（eps 也转成了 png），图注是 LaTeX 原文 —— 用 cleanCaption 擦干净。
 *    覆盖 hep / gr-qc / astro-ph / nucl / 部分 physics
 * 2. arXiv 的 HTML 版论文页（INSPIRE 没收录 / 没有图时）：
 *
 * - 先试 arxiv.org/html/<id>（arXiv 官方从 LaTeX 转的 HTML，2023 年底以后的论文都有，
 *   不少老论文也补转了），没有图再试 ar5iv（arXiv Labs 早年的转换，覆盖更老的论文）
 * - 图在 `figure.ltx_figure` 里，图片地址是相对页面的（`1706.03762v7/Figures/x.png`），按最终地址解析成绝对地址
 * - 转换时没转出来的图（多半是 .eps）标着 `ltx_missing`，src 为空 —— 跳过；一张图都没有的 figure 也跳过
 * - 一个 figure 里可能有好几张子图：整组算一张「图」，缩略图用第一张，放大时全部列出来
 * - 图注里的公式是 MathML，直接取文字会乱成一串：换成 `$alttext$`（LaTeX 原文），交给 MathText 渲染
 * - 结果按 arXiv 号缓存在内存里（翻回同一篇不再下载）；失败不缓存，下次再试
 */

const cache = new Map();

// 正文里的字体命令（caption 常以 {\bf Summary.} 开头）。KaTeX 只管数学模式，
// 这些留在文本里会原样显示成「{\bf ...}」，剥掉命令保留文字。
// **只能用在数学段之外**：\rm 之类在数学里是合法的，
// 连 A_{\rm lens} 的花括号一起剥掉就成了 A_lens，下标直接错（踩过）
const stripFontCmds = (t) => t
  .replace(/\{\s*\\(?:bf|it|em|rm|sf|sc|tt|bfseries|itshape|small|large)\s+([^{}]*)\}/g, "$1")
  .replace(/\\(?:textbf|textit|textrm|textsf|textsc|texttt|emph|mbox)\{([^{}]*)\}/g, "$1");

// caption 是 LaTeX 原文：\cite{} / \ref{} / ~ 这些在正文里没意义，先擦掉再交给 LatexText
export const cleanCaption = (s) => {
  const withMath = String(s || "")
    // LatexText 只认 $...$ / $$...$$，把另一种写法转过去，否则公式会以原文示人
    .replace(/\\\((.+?)\\\)/gs, "$$$1$$")
    .replace(/\\\[(.+?)\\\]/gs, "$$$$$1$$$$");

  // 按数学段切开：捕获组会把分隔符留在结果里，奇数位就是数学段，原样保留
  const cleaned = withMath
    .split(/(\$\$[\s\S]*?\$\$|\$[^$]*\$)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : stripFontCmds(seg)))
    .join("");

  return cleaned
    .replace(/\\cite\{[^}]*\}/g, "")
    .replace(/\\ref\{[^}]*\}/g, "")
    // 其它交叉引用命令也擦掉，不然图注里会原样露出「\eqref{eq:KWcontour}」（网站版同步加了）
    .replace(/\\(?:eqref|autoref|cref|Cref|pageref)\{[^}]*\}/g, "")
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/~/g, " ")
    .replace(/---/g, "—").replace(/--/g, "–")   // LaTeX 的破折号写法
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")   // 删掉 \cite{} 之后常留下的「空格 + 标点」
    .trim();
};

/** INSPIRE 的接口不认版本号：带 v1 是 404（网站上踩过） */
const normId = (s) => String(s || "").trim().replace(/v\d+$/i, "");

async function fromInspire(id) {
  let r;
  try { r = await fetch(`https://inspirehep.net/api/arxiv/${encodeURIComponent(normId(id))}?fields=figures`, { signal: AbortSignal.timeout(15000) }); }
  catch { return null; }
  if (r.status === 404) return [];
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return (j?.metadata?.figures || []).filter(f => f.url)
    .map((f, i) => ({ url: f.url, caption: cleanCaption(f.caption), key: f.key || `i${i}` }));
}

function parseFigures(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  doc.querySelectorAll("figure.ltx_figure").forEach((fig) => {
    // 嵌套的子图 figure 由外层统一收，别重复算
    if (fig.parentElement?.closest("figure.ltx_figure")) return;
    const imgs = [...fig.querySelectorAll("img.ltx_graphics")]
      .filter(img => img.getAttribute("src") && !img.classList.contains("ltx_missing"))
      .map(img => {
        try { return new URL(img.getAttribute("src"), pageUrl).href; } catch { return null; }
      })
      .filter(Boolean);
    if (!imgs.length) return;
    const capEl = [...fig.querySelectorAll("figcaption")].pop();
    let caption = "", tag = "";
    if (capEl) {
      const c = capEl.cloneNode(true);
      c.querySelectorAll("math").forEach(m => m.replaceWith(`$${m.getAttribute("alttext") || ""}$`));
      tag = c.querySelector(".ltx_tag")?.textContent.replace(/[:：.\s]+$/, "").trim() || "";
      c.querySelector(".ltx_tag")?.remove();
      caption = c.textContent.replace(/\s+/g, " ").trim();
    }
    const label = tag || `Figure ${out.length + 1}`;
    // 一个 figure 里的几张子图各算一张（灯箱一张一张翻），图注共用
    imgs.forEach((url, k) => out.push({ url, caption: caption ? `${label}: ${caption}` : label, key: `${label}-${k}` }));
  });
  return out.slice(0, 60);
}

async function tryPage(url) {
  let r;
  // 论文网页版有的好几 MB，网络慢时别让「图片…」一直转下去：20 秒没下完就算失败（卡片上可以重试）
  try { r = await fetch(url, { signal: AbortSignal.timeout(20000) }); } catch { return null; }
  if (!r.ok) return null;
  let html;
  try { html = await r.text(); } catch { return null; }
  // 相对地址按跳转后的最终地址解析：arxiv.org/html/1706.03762 + "1706.03762v7/x.png" → arxiv.org/html/1706.03762v7/x.png
  return parseFigures(html, r.url);
}

/** arXiv 号 → [{ url, caption, key }]（和网站的 fetchFigures 同一个格式，灯箱直接用）；拿不到就是 []（网络错误时抛错，不缓存） */
export function figuresFor(arxivId) {
  const id = String(arxivId || "").trim();
  if (!id) return Promise.resolve([]);
  if (!cache.has(id)) {
    const job = (async () => {
      const ins = await fromInspire(id);
      if (ins?.length) return ins;
      const a = await tryPage(`https://arxiv.org/html/${id}`);
      if (a?.length) return a;
      const b = await tryPage(`https://ar5iv.labs.arxiv.org/html/${id}`);
      if (b?.length) return b;
      if (ins === null && a === null && b === null) throw new Error("network");
      return [];
    })();
    job.catch(() => cache.delete(id));
    cache.set(id, job);
  }
  return cache.get(id);
}
