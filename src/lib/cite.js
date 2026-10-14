/**
 * 「引用」对话框的数据和格式（参照 Google 学术）：GB/T 7714、MLA、APA 三种格式化文本，
 * 外加 BibTeX / EndNote / RefMan(RIS) / RefWorks 四种导出。
 *
 * INSPIRE 给的期刊名是缩写（Mon.Not.Roy.Astron.Soc.），作者名也常常只有首字母；
 * 有 DOI 的话先问 Crossref 拿全称、期号、页码范围、完整人名，格式化出来才像样。
 */

const getJson = async (url) => {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
};

const cache = new Map();

/** 卡片数据 → 引用用的完整记录 */
export function citeData(c) {
  const key = c.doi || c.arxiv || c.title;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const base = {
        title: c.title || "", people: c.people || [], journal: c.journal || null,
        volume: c.volume || null, issue: c.issue || null, pages: c.pages || null,
        year: c.year || null, doi: c.doi || null, arxiv: c.arxiv || null,
      };
      if (!c.doi) return base;
      const w = (await getJson(`https://api.crossref.org/works/${encodeURIComponent(c.doi)}`))?.message;
      if (!w) return base;
      const people = (w.author || []).map(a => ({ family: a.family || a.name || "", given: a.given || "" }));
      return {
        ...base,
        title: w.title?.[0] || base.title,
        people: people.length ? people : base.people,
        journal: w["container-title"]?.[0] || base.journal,
        volume: w.volume || base.volume,
        issue: w.issue || base.issue,
        pages: w.page || base.pages,
        year: w.issued?.["date-parts"]?.[0]?.[0] || base.year,
      };
    })());
  }
  return cache.get(key);
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

const initials = (given, { dots = true, space = true } = {}) =>
  (given || "").split(/[\s.-]+/).filter(Boolean)
    .map(g => g[0].toUpperCase() + (dots ? "." : "")).join(space ? " " : "");
const pageRange = (p) => (p ? String(p).replace(/\s*[-–—]+\s*/, "-") : "");
const isPreprint = (d) => !d.journal && d.arxiv;
const sentence = (s) => (s || "").replace(/\s+/g, " ").trim().replace(/[.。]$/, "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

/* ── 三种格式：每个返回 { html, text }（html 带斜体，复制时用纯文本） ─────── */

/** GB/T 7714-2015：姓 + 名首字母（无点），超过 3 人写「等 / et al.」 */
function gbt(d) {
  const names = d.people.map(p => `${p.family} ${initials(p.given, { dots: false, space: false })}`.trim());
  const who = names.length > 3 ? `${names.slice(0, 3).join(", ")}, et al` : names.join(", ");
  const title = sentence(d.title);
  let tail;
  if (isPreprint(d)) tail = `arXiv preprint arXiv:${d.arxiv}, ${d.year || ""}`;
  else {
    const vi = d.volume ? `${d.volume}${d.issue ? `(${d.issue})` : ""}` : "";
    tail = [d.journal, d.year, vi].filter(Boolean).join(", ") + (d.pages ? `: ${pageRange(d.pages)}` : "");
  }
  const text = `${who ? `${who}. ` : ""}${title}[J]. ${tail}.`;
  return { html: esc(text), text };
}

/** MLA 9：「姓, 名」、第二人「名 姓」，三人及以上「第一人, et al.」 */
function mla(d) {
  const P = d.people;
  const full = (p, inverted) => (inverted ? [p.family, p.given].filter(Boolean).join(", ") : [p.given, p.family].filter(Boolean).join(" "));
  let who = "";
  if (P.length === 1) who = full(P[0], true);
  else if (P.length === 2) who = `${full(P[0], true)}, and ${full(P[1])}`;
  else if (P.length > 2) who = `${full(P[0], true)}, et al`;
  const title = sentence(d.title);
  let cont, contHtml;
  if (isPreprint(d)) {
    cont = `arXiv preprint arXiv:${d.arxiv} (${d.year || "n.d."})`;
    contHtml = `<i>arXiv preprint arXiv:${esc(d.arxiv)}</i> (${esc(d.year || "n.d.")})`;
  } else {
    const vi = d.volume ? ` ${d.volume}${d.issue ? `.${d.issue}` : ""}` : "";
    const rest = `${vi}${d.year ? ` (${d.year})` : ""}${d.pages ? `: ${pageRange(d.pages)}` : ""}`;
    cont = `${d.journal || ""}${rest}`;
    contHtml = `<i>${esc(d.journal || "")}</i>${esc(rest)}`;
  }
  // 名字以缩写结尾（"Hawking, S."）时别再补一个点
  const pre = `${who ? `${who.replace(/\.$/, "")}. ` : ""}"${title}." `;
  return { html: `${esc(pre)}${contHtml}.`, text: `${pre}${cont}.` };
}

/** APA 7：「姓, 名首字母.」，最后一人前加 &，最多列 20 人 */
function apa(d) {
  const names = d.people.map(p => `${p.family}${p.given ? `, ${initials(p.given)}` : ""}`);
  let who = "";
  if (names.length === 1) who = names[0];
  else if (names.length > 1 && names.length <= 20) who = `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
  else if (names.length > 20) who = `${names.slice(0, 19).join(", ")}, ... ${names[names.length - 1]}`;
  const head = `${who ? `${who} ` : ""}(${d.year || "n.d."}). ${sentence(d.title)}. `;
  if (isPreprint(d)) {
    const t = `arXiv preprint arXiv:${d.arxiv}`;
    return { html: `${esc(head)}<i>${esc(t)}</i>.`, text: `${head}${t}.` };
  }
  const vol = d.volume ? `, ${d.volume}` : "";
  const iss = d.issue ? `(${d.issue})` : "";
  const pg = d.pages ? `, ${pageRange(d.pages)}` : "";
  return {
    html: `${esc(head)}<i>${esc(d.journal || "")}</i>${vol ? `, <i>${esc(d.volume)}</i>` : ""}${esc(iss + pg)}.`,
    text: `${head}${d.journal || ""}${vol}${iss}${pg}.`,
  };
}

export const FORMATS = [["GB/T 7714", gbt], ["MLA", mla], ["APA", apa]];

/* ── 导出 ──────────────────────────────────────────────────────────── */

const [startPage, endPage] = [(p) => pageRange(p).split("-")[0] || "", (p) => pageRange(p).split("-")[1] || ""];

function bibtexOf(d) {
  const first = d.people[0]?.family?.replace(/[^A-Za-z]/g, "") || "ref";
  const word = (d.title.match(/[A-Za-z]{4,}/) || ["paper"])[0].toLowerCase();
  const f = [
    ["author", d.people.map(p => [p.family, p.given].filter(Boolean).join(", ")).join(" and ")],
    ["title", `{${d.title}}`],
    ...(isPreprint(d)
      ? [["eprint", d.arxiv], ["archivePrefix", "arXiv"]]
      : [["journal", d.journal], ["volume", d.volume], ["number", d.issue], ["pages", d.pages && pageRange(d.pages).replace("-", "--")]]),
    ["year", d.year], ["doi", d.doi],
    ...(!isPreprint(d) && d.arxiv ? [["eprint", d.arxiv], ["archivePrefix", "arXiv"]] : []),
  ].filter(([, v]) => v);
  return `@${isPreprint(d) ? "misc" : "article"}{${first}${d.year || ""}${word},\n${f.map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}\n`;
}

/** EndNote 标记格式（.enw） */
const endnoteOf = (d) => [
  `%0 ${isPreprint(d) ? "Electronic Article" : "Journal Article"}`,
  ...d.people.map(p => `%A ${[p.family, p.given].filter(Boolean).join(", ")}`),
  `%T ${d.title}`, d.journal && `%J ${d.journal}`, d.volume && `%V ${d.volume}`, d.issue && `%N ${d.issue}`,
  d.pages && `%P ${pageRange(d.pages)}`, d.year && `%D ${d.year}`, d.doi && `%R ${d.doi}`,
  d.arxiv && `%U https://arxiv.org/abs/${d.arxiv}`,
].filter(Boolean).join("\n") + "\n";

/** RIS（RefMan / Zotero / Mendeley 都认） */
const risOf = (d) => [
  `TY  - ${isPreprint(d) ? "EJOUR" : "JOUR"}`,
  ...d.people.map(p => `AU  - ${[p.family, p.given].filter(Boolean).join(", ")}`),
  `TI  - ${d.title}`, d.journal && `JO  - ${d.journal}`, d.volume && `VL  - ${d.volume}`, d.issue && `IS  - ${d.issue}`,
  d.pages && `SP  - ${startPage(d.pages)}`, d.pages && endPage(d.pages) && `EP  - ${endPage(d.pages)}`,
  d.year && `PY  - ${d.year}`, d.doi && `DO  - ${d.doi}`, d.arxiv && `UR  - https://arxiv.org/abs/${d.arxiv}`,
  "ER  - ",
].filter(Boolean).join("\n") + "\n";

/** RefWorks 标记格式 */
const refworksOf = (d) => [
  `RT ${isPreprint(d) ? "Web Page" : "Journal Article"}`,
  ...d.people.map(p => `A1 ${[p.family, p.given].filter(Boolean).join(", ")}`),
  `T1 ${d.title}`, d.journal && `JF ${d.journal}`, d.volume && `VO ${d.volume}`, d.issue && `IS ${d.issue}`,
  d.pages && `SP ${startPage(d.pages)}`, d.pages && endPage(d.pages) && `OP ${endPage(d.pages)}`,
  d.year && `YR ${d.year}`, d.doi && `DO ${d.doi}`, d.arxiv && `UL https://arxiv.org/abs/${d.arxiv}`,
].filter(Boolean).join("\n") + "\n";

export const EXPORTS = [
  ["BibTeX", "bib", bibtexOf],
  ["EndNote", "enw", endnoteOf],
  ["RefMan", "ris", risOf],
  ["RefWorks", "txt", refworksOf],
];

/** 导出格式的文本（点按钮复制到剪贴板，不下载文件）。
    BibTeX 有 INSPIRE 现成的就用它的（键名和字段都是物理圈通用的那套） */
export async function exportText(kind, d, { bibtexUrl } = {}) {
  const [, , fn] = EXPORTS.find(e => e[0] === kind);
  if (kind === "BibTeX" && bibtexUrl) {
    try { const t = (await (await fetch(bibtexUrl)).text()).trim(); if (t.startsWith("@")) return `${t}\n`; } catch { /* 用自己生成的 */ }
  }
  return fn(d);
}
