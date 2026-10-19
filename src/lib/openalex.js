import { t } from "./i18n";
/**
 * 文献卡片上的「所有 N 个版本」—— 数据来自 OpenAlex；「相关文章」用 Semantic Scholar 的推荐（见文件末尾）（免费、免 key、有 CORS）。
 * Google 学术那两个链接靠的是它内部的 cluster id，没有公开接口拿不到，所以换成 OpenAlex：
 * - locations：同一篇论文的各个版本（期刊官网、arXiv、机构库……），带开放获取的 PDF 链接
 *
 * 认文献用 DOI；只有 arXiv 号的用 arXiv 的 DOI（10.48550/arXiv.<号>，arXiv 2022 年起给每篇都注册了）。
 */

const API = "https://api.openalex.org";
const getJson = async (url) => {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
};

const doiOf = (c) => c?.doi || (c?.arxiv ? `10.48550/arXiv.${String(c.arxiv).replace(/v\d+$/i, "")}` : null);
const shortId = (url) => String(url || "").replace(/^https:\/\/openalex\.org\//, "");

const metaCache = new Map();
/** 卡片 → { id, versions }；查不到返回 null */
export function openAlexMeta(card) {
  const doi = doiOf(card);
  if (!doi) return Promise.resolve(null);
  if (!metaCache.has(doi)) {
    metaCache.set(doi, getJson(`${API}/works/doi:${encodeURIComponent(doi)}?select=id,locations_count`)
      .then(d => (d?.id ? { id: shortId(d.id), versions: d.locations_count || 0 } : null)));
  }
  return metaCache.get(doi);
}


/** 所有版本：每个 location 一行（出处 + 原文链接 + PDF） */
/** OpenAlex 有些期刊名是两份拼起来的（「Physical review. D/Physical review. D」）：两半一样就只留一份 */
const dedupeName = (n) => {
  const s = String(n || "").trim();
  const parts = s.split("/");
  return parts.length === 2 && parts[0].trim() === parts[1].trim() ? parts[0].trim() : s;
};

export async function allVersions(id) {
  const d = await getJson(`${API}/works/${id}?select=locations`);
  return (d?.locations || []).map(l => {
    let host = null;
    try { host = new URL(l.landing_page_url || l.pdf_url).hostname.replace(/^www\./, ""); } catch { /* 没链接 */ }
    return {
      source: dedupeName(l.source?.display_name) || host || t("未知来源"),
      host,
      url: l.landing_page_url || null,
      pdfUrl: l.pdf_url || null,
      oa: !!l.is_oa,
      version: l.version === "publishedVersion" ? t("正式发表版") : l.version === "acceptedVersion" ? t("接收稿") :
               l.version === "submittedVersion" ? t("预印本") : null,
    };
  });
}

/* ── 相关文章：用 Semantic Scholar 的推荐 ─────────────────────────────────
   没用 OpenAlex 的 related_works：实测对老文献很离谱（Hawking 1971 的「相关」是一堆中子星吸积），
   摆出来只会让人不信这个功能。S2 对近年的论文推荐得很准，老文献常常一条都没有 ——
   那就老实说没有，给一个去 Google 学术找的入口（见 RefCard 的 SubList） */
const S2_REC = "https://api.semanticscholar.org/recommendations/v1/papers/forpaper";
const s2Id = (c) => (c?.arxiv ? `arXiv:${String(c.arxiv).replace(/v\d+$/i, "")}` : c?.doi ? `DOI:${c.doi}` : null);

export async function relatedFor(card) {
  const id = s2Id(card);
  if (id) {
    const d = await getJson(`${S2_REC}/${id}?limit=10&fields=title,year,authors,venue,citationCount,externalIds,openAccessPdf,url`);
    const recs = d?.recommendedPapers || [];
    if (recs.length) {
      return {
        source: "Semantic Scholar",
        items: recs.map(p => {
          const names = (p.authors || []).map(a => a.name);
          const ax = p.externalIds?.ArXiv;
          return {
            title: p.title,
            authors: names.length > 3 ? t("{names} 等", { names: names.slice(0, 3).join(", ") }) : names.join(", "),
            venue: p.venue || null, year: p.year, citations: p.citationCount,
            url: ax ? `https://arxiv.org/abs/${ax}` : p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : p.url,
            pdfUrl: ax ? `https://arxiv.org/pdf/${ax}` : p.openAccessPdf?.url || null,
          };
        }),
      };
    }
  }
  return { source: "Semantic Scholar", items: [] };
}
