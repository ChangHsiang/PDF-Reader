/**
 * 正文里点引用号 → 文献卡片（参照 Google 学术 PDF 阅读器）。
 *
 * 两件事：
 * 1. **认出是哪几篇**：LaTeX hyperref 给每条参考文献一个具名目标 `cite.<key>`，
 *    正文里的引用号是指向它的内部链接。把所有 `cite.*` 目标按版面位置排好序，
 *    第 k 个就是第 k 条文献；再从目标所在位置把这一条的原文从文字层里抠出来。
 *    点 `[1–3]` 时按那一行的方括号展开成 1、2、3（hyperref 只给 1 和 3 挂链接）。
 * 2. **查元数据**：物理类论文先问 INSPIRE —— 它按论文里的顺序存着整份参考文献，
 *    每条带编号（label）和对应的文献记录，最准；不在 INSPIRE 上的，从原文里找 arXiv 号 / DOI
 *    问 Semantic Scholar，都没有就把原文交给 Crossref 的 bibliographic 检索。
 *    都查不到也至少把原文显示出来。
 */

import { tokenize } from "./pdfium/textLayer";
import { clientRectToNorm } from "./pdfium/rotate";
import { t } from "./i18n";

const S2 = "https://api.semanticscholar.org/graph/v1/paper";
const S2_FIELDS = "title,authors,year,venue,abstract,citationCount,externalIds,openAccessPdf,url,journal";
const INSPIRE = "https://inspirehep.net/api/literature";
const INSPIRE_FIELDS = "titles,authors.full_name,abstracts,citation_count,publication_info,arxiv_eprints,dois";

const getJson = async (url) => {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

/* ── 1. 从 PDF 里把参考文献表抠出来 ──────────────────────────────────── */

/**
 * 返回 `{ byName: Map<destName, entry>, byPos: Map<目标位置, entry>, byLabel: Map<label, entry>, list }`，
 * entry = `{ name, dest, label, text, page }`（dest = 跳转目标 { pageIndex, x, y }）；label 是原文里印的编号（作者-年份制就是顺序号）。
 * 没有 `cite.*` 目标（不是 hyperref 生成的 PDF）就返回 null，调用方照常跳转。
 *
 * PDFium 给链接的目标已经解析成「页码 + 坐标」，名字丢了；所以名字从文档的具名目标表里读（连同位置），
 * 链接按位置（destKey）对回去。坐标下面统一换成「原点左下、y 向上」（PDF 用户坐标的习惯，切条的逻辑是按它写的）。
 *
 * 踩过的坑：
 * - `[1–3]` 只有 1 和 3 挂了链接，第 2 条**根本没有目标**。所以不能「一个目标一条」，
 *   要按原文里印的 `[n]` 切条，目标只用来定位参考文献表在哪、以及链接 → 第几条
 */
export const destKey = (pageIndex, x, y) => `${pageIndex}|${x == null ? "-" : Math.round(x)}|${y == null ? "-" : Math.round(y)}`;

export async function extractReferences(doc) {
  const dests = await doc.namedDests("cite.");
  if (!dests.length) return null;

  // 目标 → (页, x, y)，页面坐标（点）再翻成 y 向上
  const pos = dests.filter(d => d.y != null).map(d => {
    const H = doc.pages[d.pageIndex].size.height;
    const p = doc.userToPage(d.pageIndex, d.x, d.y);
    return { name: d.name, dest: { pageIndex: d.pageIndex, x: d.x, y: d.y }, key: destKey(d.pageIndex, d.x, d.y), page: d.pageIndex + 1, x: p.x, y: H - p.y };
  });
  if (!pos.length) return null;

  /* 参考文献表所在的页：第一个目标那页到最后一个目标那页（中间没被引用的条目所在页也算）。
     文字按词取（lib/pdfium/textLayer 的 tokenize），y 用词的基线 */
  const p0 = Math.min(...pos.map(p => p.page)), p1 = Math.max(...pos.map(p => p.page));
  const textOf = {};
  for (let n = p0; n <= p1; n++) {
    const { width: W, height: H } = doc.pages[n - 1].size;
    const items = [];
    let sp = false;
    for (const t of tokenize(await doc.text(n - 1))) {
      if (t.t !== "w") { sp = true; continue; }
      const y = H - t.b;
      // 页眉页脚（页码、期刊名）不要
      if (y > 40 && y < H - 40) items.push({ str: t.text, x: t.x, y, w: t.w, h: t.h * 0.8, sp });
      sp = false;
    }
    textOf[n] = { width: W, items };
  }

  /* 分栏：同一页上的目标 x 分成两簇就是双栏，分界取两簇中间；没有目标的页沿用上一页 */
  const colOf = {};
  for (let n = p0; n <= p1; n++) {
    const xs = pos.filter(p => p.page === n).map(p => p.x).sort((a, b) => a - b);
    /* 分界取**右栏目标的 x**（右栏左边缘），不是两簇中点：左栏一行字会一直写到中线以右，
       取中点的话行尾那几个词被分进右栏（踩过：[1] 的期刊名整段丢了） */
    const gap = xs.reduce((best, x, i) => (i && x - xs[i - 1] > best.d ? { d: x - xs[i - 1], at: x } : best), { d: 0, at: null });
    colOf[n] = gap.d > textOf[n].width * 0.25 ? gap.at : (xs.length > 1 ? null : colOf[n - 1] ?? null);
  }
  const col = (n, x) => (colOf[n] != null && x >= colOf[n] - 4 ? 1 : 0);

  /* 拼成行，按阅读顺序排好：页 → 栏 → 自上而下 */
  const lines = [];
  for (let n = p0; n <= p1; n++) {
    const byCol = [[], []];
    textOf[n].items.forEach(it => byCol[col(n, it.x)].push(it));
    byCol.forEach((its, c) => {
      /* 先按基线聚成行、再在行内按 x 排。不能边排边拼：斜体 / 上标的基线和正文差零点几，
         按 y 排序会把它们排到行首甚至另起一行（踩过：[1] 的期刊名整段丢了） */
      its.sort((a, b) => b.y - a.y);
      const groups = [];
      for (const it of its) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(g.y - it.y) < Math.max(g.h, it.h) * 0.6) g.items.push(it);
        else groups.push({ y: it.y, h: it.h, items: [it] });
      }
      for (const g of groups) {
        g.items.sort((a, b) => a.x - b.x);
        let text = "", right = null;
        for (const it of g.items) {
          if (right !== null && (it.sp || it.x - right > 1.5)) text += " ";
          text += it.str;
          right = it.x + it.w;
        }
        lines.push({ page: n, col: c, y: Math.max(...g.items.map(i => i.y)), x: g.items[0].x, text });
      }
    });
  }

  /* 目标 → 它下面最近的那一行。hyperref 默认把锚点抬高一个 \baselineskip（HyperRaiseLinkDefault），
     于是锚点正好落在**上一条最后一行的基线**上 —— 用 `<= y` 会拿到上一条（踩过：点 [6] 出来 [5]）。
     所以要求那一行在锚点下方至少 2pt */
  const lineOf = (p) => {
    const c = col(p.page, p.x);
    return lines.findIndex(l => l.page === p.page && l.col === c && l.y <= p.y - 2);
  };
  pos.forEach(p => { p.line = lineOf(p); });
  const firstLine = Math.min(...pos.map(p => p.line).filter(i => i >= 0));
  if (!Number.isFinite(firstLine)) return null;

  /* 切条：编号制按行首的 [n] 切（编号要一个接一个，防正文里碰巧有行以 [n] 开头）；
     否则（作者-年份制）一个目标一条 */
  let starts = [];
  let expect = null;
  lines.forEach((l, i) => {
    const m = /^\s*\[(\d+)\]/.exec(l.text);
    if (!m) return;
    const k = Number(m[1]);
    if (expect === null ? (k === 1 || i >= firstLine) : k === expect) { starts.push({ i, label: k }); expect = k + 1; }
  });
  const numeric = starts.length >= Math.min(3, pos.length);
  if (!numeric) {
    starts = [...new Set(pos.map(p => p.line).filter(i => i >= 0))].sort((a, b) => a - b)
      .map((i, k) => ({ i, label: k + 1 }));
  }

  const joinLines = (ls) => {
    let text = "";
    ls.forEach((l, k) => {
      if (k) text = /[a-z]-$/i.test(text) ? text.slice(0, -1) : `${text} `;
      text += l.text;
    });
    return text.replace(/\s+/g, " ").trim().slice(0, 800);
  };
  const list = starts.map((s, k) => {
    const end = Math.min(starts[k + 1]?.i ?? lines.length, s.i + 12);
    return { label: s.label, line: s.i, text: joinLines(lines.slice(s.i, end)), page: lines[s.i].page, name: null };
  });

  // 链接 → 它所在的那一条（目标落在哪条的行区间里）
  const byName = new Map(), byPos = new Map();
  pos.forEach(p => {
    if (p.line < 0) return;
    let e = null;
    for (const x of list) { if (x.line <= p.line) e = x; else break; }
    if (e) { byName.set(p.name, e); byPos.set(p.key, e); if (!e.name) { e.name = p.name; e.dest = p.dest; } }
  });
  return { byName, byPos, byLabel: new Map(list.map(e => [e.label, e])), list };
}

/** `[1–3, 7]` 这种组展开成编号数组；不是数字的（作者-年份制）返回 null */
function parseGroup(s) {
  const out = [];
  for (const part of s.split(/[,;]/)) {
    const t = part.trim();
    if (!t) continue;
    const r = /^(\d+)\s*[–—-]\s*(\d+)$/.exec(t);
    if (r) {
      const a = Number(r[1]), b = Number(r[2]);
      if (b < a || b - a > 50) return null;
      for (let k = a; k <= b; k++) out.push(k);
    } else if (/^\d+$/.test(t)) out.push(Number(t));
    else return null;
  }
  return out.length ? out : null;
}

/**
 * 点了某条引用链接之后，它所在那一组的全部编号。
 * 做法：把链接那一行的文字层拼起来，找出所有 `[...]`，挑包含这个编号的那一组。
 * 找不到（作者-年份制、或者方括号被拆到两行）就只有它自己。
 */
/** 链接所在那一行的文字层 span（按页面方向找同一行、从左到右排；转过的页也对，见 pdfium/rotate.js） */
function lineSpans(page, linkEl, leafOnly) {
  const lr = clientRectToNorm(page, linkEl.getBoundingClientRect());
  const cy = lr.y + lr.h / 2;
  return [...page.querySelectorAll(".textLayer span")]
    .filter(sp => !sp.children.length && (!leafOnly || sp.firstChild))
    .map(sp => ({ sp, r: clientRectToNorm(page, sp.getBoundingClientRect()) }))
    .filter(({ r }) => r.w + r.h > 0 && r.y <= cy && r.y + r.h >= cy)
    .sort((a, b) => a.r.x - b.r.x);
}

export function citeGroup(linkEl, label) {
  const page = linkEl.closest(".page");
  if (!page) return [label];
  const spans = lineSpans(page, linkEl, false);
  const line = spans.map(s => s.sp.textContent).join("");
  for (const m of line.matchAll(/\[([^\][]{1,80})\]/g)) {
    const nums = parseGroup(m[1]);
    if (nums?.includes(label)) return nums;
  }
  return [label];
}

/**
 * 点 / 指的这个引用链接所在的那一组 `[...]` 在屏幕上的外框（client 坐标），给「整组一起高亮」用。
 * 和 citeGroup 一样按文字层拼出这一行，找出包含这个编号的方括号，再用 Range 量那几个字。
 * 文字层还没建好（滚动刚停）、或者不是方括号编号（作者-年份制）就返回 null。
 */
export function citeGroupRect(linkEl, label) {
  const page = linkEl.closest(".page");
  if (!page) return null;
  const lr = linkEl.getBoundingClientRect();
  const spans = lineSpans(page, linkEl, true);
  let line = "";
  const at = [];               // 每个 span 在这一行字符串里的起点
  for (const { sp } of spans) { at.push(line.length); line += sp.textContent; }
  const locate = (i) => {      // 行里第 i 个字 → [文本节点, 节点内偏移]
    let k = spans.length - 1;
    while (k > 0 && at[k] > i) k--;
    return [spans[k].sp.firstChild, Math.min(i - at[k], spans[k].sp.firstChild.length)];
  };
  for (const m of line.matchAll(/\[([^\][]{1,80})\]/g)) {
    if (!parseGroup(m[1])?.includes(label)) continue;
    // 必须盖住这个链接本身（同一行可能有两组都含这个编号，罕见）
    const rg = document.createRange();
    rg.setStart(...locate(m.index));
    rg.setEnd(...locate(m.index + m[0].length - 1));
    rg.setEnd(rg.endContainer, Math.min(rg.endOffset + 1, rg.endContainer.length));
    const r = rg.getBoundingClientRect();
    // 外框和链接有重叠（屏幕坐标，转不转都一样）
    if (r.width && r.left <= lr.right && r.right >= lr.left && r.top <= lr.bottom && r.bottom >= lr.top) return r;
  }
  return null;
}

/* ── 2. 查元数据 ──────────────────────────────────────────────────── */

/** 统一成卡片要的形状 */
const card = (o) => ({
  title: null, authors: [], venue: null, year: null, abstract: null, citations: null,
  arxiv: null, doi: null, pdfUrl: null, url: null, bibtexUrl: null, source: null,
  // 给「引用」格式化用的结构化字段：完整作者表（姓 / 名分开）、期刊、卷期页
  people: [], journal: null, volume: null, issue: null, pages: null,
  citesUrl: null,     // 「被引用次数」点过去：引用了这篇的文献列表
  ...o,
});

/** 「姓, 名」或「名 姓」→ { family, given } */
export const splitName = (s) => {
  const t = String(s || "").trim();
  const m = /^([^,]+),\s*(.+)$/.exec(t);
  if (m) return { family: m[1].trim(), given: m[2].trim() };
  const parts = t.split(/\s+/);
  return { family: parts.pop() || "", given: parts.join(" ") };
};

/** INSPIRE 的 publication_info → 期刊 / 卷 / 期 / 页 */
const inspireBiblio = (pi) => {
  const p = Array.isArray(pi) ? pi.find(x => x.journal_title) || pi[0] : pi;
  if (!p) return {};
  const pages = p.page_start ? (p.page_end ? `${p.page_start}-${p.page_end}` : p.page_start) : p.artid || null;
  return { journal: p.journal_title || null, volume: p.journal_volume || null, issue: p.journal_issue || null, pages };
};

const authorLine = (names) => {
  const list = (names || []).filter(Boolean);
  if (!list.length) return [];
  return list.length > 4 ? [...list.slice(0, 3), t("等 {n} 人", { n: list.length })] : list;
};

/** INSPIRE 的人名是「姓, 名」，翻成「名 姓」好读一点 */
const flipName = (s) => {
  const m = /^([^,]+),\s*(.+)$/.exec(s || "");
  return m ? `${m[2]} ${m[1]}` : s;
};

const pubLine = (pi) => {
  const p = Array.isArray(pi) ? pi.find(x => x.journal_title) || pi[0] : pi;
  if (!p) return { venue: null, year: null };
  const venue = p.journal_title
    ? `${p.journal_title}${p.journal_volume ? ` ${p.journal_volume}` : ""}${p.page_start || p.artid ? `, ${p.page_start || p.artid}` : ""}`
    : null;
  return { venue, year: p.year || null };
};

async function fromInspireRecord(recid) {
  const d = await getJson(`${INSPIRE}/${recid}?fields=${INSPIRE_FIELDS}`);
  const m = d?.metadata;
  if (!m) return null;
  const { venue, year } = pubLine(m.publication_info);
  const arxiv = m.arxiv_eprints?.[0]?.value || null;
  const doi = m.dois?.[0]?.value || null;
  /* 没有 arXiv 版的老文献，INSPIRE 不给 PDF；问一下 Semantic Scholar 有没有开放获取的链接
     （学术搜索卡片底部那颗「[PDF] xxx」） */
  let pdfUrl = arxiv ? `https://arxiv.org/pdf/${arxiv}` : null;
  let abstract = m.abstracts?.find(a => a.source === "arXiv")?.value || m.abstracts?.[0]?.value || null;
  if (!pdfUrl && doi) {
    const s2 = await getJson(`${S2}/DOI:${doi}?fields=openAccessPdf,abstract`);
    pdfUrl = s2?.openAccessPdf?.url || null;
    abstract ||= s2?.abstract || null;
  }
  return card({
    title: m.titles?.[0]?.title || null,
    authors: authorLine((m.authors || []).map(a => flipName(a.full_name))),
    people: (m.authors || []).map(a => splitName(a.full_name)),
    ...inspireBiblio(m.publication_info),
    venue, year,
    abstract,
    citations: m.citation_count ?? null,
    arxiv, doi,
    pdfUrl,
    url: `https://inspirehep.net/literature/${recid}`,
    bibtexUrl: `${INSPIRE}/${recid}?format=bibtex`,
    citesUrl: `https://inspirehep.net/literature?q=${encodeURIComponent(`refersto:recid:${recid}`)}`,
    source: "INSPIRE",
  });
}

async function fromS2(id) {
  const d = await getJson(`${S2}/${encodeURIComponent(id).replace(/%3A/g, ":")}?fields=${S2_FIELDS}`);
  if (!d?.title) return null;
  const arxiv = d.externalIds?.ArXiv || null;
  return card({
    title: d.title,
    authors: authorLine((d.authors || []).map(a => a.name)),
    people: (d.authors || []).map(a => splitName(a.name)),
    journal: d.journal?.name || d.venue || null, volume: d.journal?.volume || null,
    pages: d.journal?.pages?.replace(/\s+/g, "") || null,
    venue: d.venue || null, year: d.year || null,
    abstract: d.abstract || null,
    citations: d.citationCount ?? null,
    arxiv, doi: d.externalIds?.DOI || null,
    pdfUrl: arxiv ? `https://arxiv.org/pdf/${arxiv}` : d.openAccessPdf?.url || null,
    url: d.url || null,
    citesUrl: d.paperId ? `https://www.semanticscholar.org/paper/${d.paperId}#citing-papers` : null,
    source: "Semantic Scholar",
  });
}

async function fromCrossref(text) {
  const d = await getJson(`https://api.crossref.org/works?rows=1&query.bibliographic=${encodeURIComponent(text.slice(0, 300))}`);
  const it = d?.message?.items?.[0];
  // Crossref 永远会给一个「最像的」，分数太低就是瞎猜，宁可不显示
  if (!it || (it.score ?? 0) < 60 || !it.title?.[0]) return null;
  const viaS2 = it.DOI ? await fromS2(`DOI:${it.DOI}`) : null;
  if (viaS2) return viaS2;
  return card({
    title: it.title?.[0] || null,
    authors: authorLine((it.author || []).map(a => [a.given, a.family].filter(Boolean).join(" "))),
    people: (it.author || []).map(a => ({ family: a.family || a.name || "", given: a.given || "" })),
    journal: it["container-title"]?.[0] || null, volume: it.volume || null, issue: it.issue || null, pages: it.page || null,
    venue: it["container-title"]?.[0] || null,
    year: it.issued?.["date-parts"]?.[0]?.[0] || null,
    citations: it["is-referenced-by-count"] ?? null,
    doi: it.DOI || null, url: it.DOI ? `https://doi.org/${it.DOI}` : null,
    source: "Crossref",
  });
}

/**
 * 正在看的这篇论文自己的卡片（工具栏「引用」用）：先按 arXiv 号问 INSPIRE，没有就问 Semantic Scholar。
 * 本地文件（不是 arXiv 的）：按 PDF 里的标题 / 作者问 Crossref，标题对得上才算；查不到就没有（不拿元数据瞎凑）
 */
const selfCache = new Map();
export function paperCard({ arxivBase, doi, title, author }) {
  const key = arxivBase || (doi ? `doi:${doi}` : `t:${title}`);
  if (!selfCache.has(key)) {
    const job = (async () => {
      if (arxivBase) {
        const d = await getJson(`${INSPIRE}?q=${encodeURIComponent(`arxiv:${arxivBase}`)}&fields=control_number`);
        const recid = d?.hits?.hits?.[0]?.metadata?.control_number;
        return (recid && await fromInspireRecord(recid)) || await fromS2(`arXiv:${arxivBase}`);
      }
      if (doi) { const c = await fromS2(`DOI:${doi}`); if (c) return c; }
      if (!title) return null;
      const viaCr = await fromCrossref([author, title].filter(Boolean).join(" "));
      return viaCr && normT(viaCr.title) === normT(title) ? viaCr : null;
    })().catch(() => null);
    selfCache.set(key, job.then((c) => { if (!c) selfCache.delete(key); return c; }));
  }
  return selfCache.get(key);
}
const normT = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** INSPIRE 上这篇论文的参考文献表（按 label 分组）。不在 INSPIRE 上返回 null */
const inspireCache = new Map();

export function inspireReferences(arxivBase) {
  if (!inspireCache.has(arxivBase)) {
    inspireCache.set(arxivBase, (async () => {
      const d = await getJson(`${INSPIRE}?q=${encodeURIComponent(`arxiv:${arxivBase}`)}&fields=references`);
      /* 请求失败（断网 / 超时）≠「不在 INSPIRE 上」：别缓存，不然这一次失败之后整篇的引用卡片
         都退回到不那么准的 Semantic Scholar / Crossref，直到刷新页面 */
      if (d === null) { inspireCache.delete(arxivBase); return null; }
      const refs = d?.hits?.hits?.[0]?.metadata?.references;
      if (!refs?.length) return null;
      const byLabel = new Map();
      refs.forEach(r => {
        const l = Number(r.reference?.label);
        if (!l) return;
        byLabel.set(l, [...(byLabel.get(l) || []), r]);
      });
      return byLabel.size ? byLabel : null;
    })());
  }
  return inspireCache.get(arxivBase);
}

const ARXIV_IN_TEXT = /(?:arXiv:\s*|arxiv\.org\/abs\/)((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i;
const DOI_IN_TEXT = /\b(10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;)\]])/;

/** 原文里认出 arXiv 号 / DOI / 作者姓 + 年份，给校验 INSPIRE 那条对不对得上用 */
const surname = (full) => (/^([^,]+),/.exec(full || "")?.[1] || full || "").trim().split(/\s+/).pop();

/**
 * 一条参考文献（PDF 里第 label 条，原文 text）→ 卡片数组。
 * INSPIRE 上一个编号可能对应好几篇（`[1] A; B` 合在一条里），所以返回数组。
 */
const resolveCache = new Map();
export function resolveReference(arxivBase, entry) {
  const key = `${arxivBase}#${entry.label}`;
  if (!resolveCache.has(key)) {
    const job = (async () => {
      const text = entry.text || "";
      // ① INSPIRE：按编号直接取，顺手用作者姓 / 年份校验一下（防编号错位）
      const ins = arxivBase ? await inspireReferences(arxivBase) : null;
      const items = ins?.get(entry.label);
      if (items?.length) {
        const ok = !text || items.some(r => {
          const ref = r.reference || {};
          const sn = surname(ref.authors?.[0]?.full_name);
          return (sn && text.includes(sn)) || (ref.publication_info?.year && text.includes(String(ref.publication_info.year)));
        });
        if (ok) {
          const cards = await Promise.all(items.map(async (r) => {
            const recid = /\/(\d+)$/.exec(r.record?.$ref || "")?.[1];
            const ref = r.reference || {};
            const viaRecord = recid ? await fromInspireRecord(recid) : null;
            if (viaRecord) return viaRecord;
            const via = ref.arxiv_eprint ? await fromS2(`arXiv:${ref.arxiv_eprint}`)
              : ref.dois?.[0] ? await fromS2(`DOI:${ref.dois[0]}`) : null;
            if (via) return via;
            const { venue, year } = pubLine(ref.publication_info);
            return card({
              title: ref.title?.title || null,
              authors: authorLine((ref.authors || []).map(a => flipName(a.full_name))),
              people: (ref.authors || []).map(a => splitName(a.full_name)),
              ...inspireBiblio(ref.publication_info),
              venue, year, arxiv: ref.arxiv_eprint || null, doi: ref.dois?.[0] || null,
              pdfUrl: ref.arxiv_eprint ? `https://arxiv.org/pdf/${ref.arxiv_eprint}` : null,
              source: "INSPIRE",
            });
          }));
          return cards;
        }
      }
      // ② 原文里有 arXiv 号 / DOI
      const ax = ARXIV_IN_TEXT.exec(text)?.[1];
      if (ax) { const c = await fromS2(`arXiv:${ax}`); if (c) return [c]; }
      const doi = DOI_IN_TEXT.exec(text)?.[1];
      if (doi) { const c = await fromS2(`DOI:${doi}`); if (c) return [c]; }
      // ③ 交给 Crossref 按整条引文猜
      if (text.length > 20) {
        const c = await fromCrossref(text.replace(/^\[\d+\]\s*/, ""));
        if (c) return [c];
      }
      return [];
    })();
    /* 查不到也别缓存：几个接口出错（断网、S2 限流 429）时都是返回 null，和「真的没有」分不出来 ——
       缓存了的话这一条这次会话里就一直显示「找不到」。查到了才缓存 */
    job.then(r => { if (!r.length) resolveCache.delete(key); }, () => resolveCache.delete(key));
    resolveCache.set(key, job);
  }
  return resolveCache.get(key);
}
