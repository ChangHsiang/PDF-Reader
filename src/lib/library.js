import { rest, restRows, readSession } from "./session";
import { t } from "./i18n";

/**
 * 文献收藏（和 ResearchHub 网站的「文献收藏」是同一份数据：bookmarks + collections 两张表，kind = arxiv）。
 * 必须登录；RLS 只让读写自己的。字段的写法照网站 ArxivFeed 的 saveBookmarkToCollection：
 * 老列（arxiv_id / summary / published / category）和新列（abstract / year / journal / doi / source / source_id）一起写，
 * 网站的收藏页两种都认。
 *
 * 认「这篇收藏过没有」：网站按 arxiv_id 认（推送页里 arxiv_id = arXiv 号或 DOI）。
 * 这里收藏时 arxiv_id 也写 arXiv 号（没有就写 DOI），查的时候两个都试
 */

const uid = async () => (await readSession())?.uid || null;
const json = async (res) => { try { return res?.ok ? await res.json() : null; } catch { return null; } };

export async function listCollections() {
  const u = await uid();
  if (!u) return [];
  return (await json(await rest(`collections?user_id=eq.${u}&kind=eq.arxiv&select=*&order=created_at.asc`, { auth: true }))) || [];
}

export async function listBookmarks() {
  const u = await uid();
  if (!u) return [];
  return (await json(await rest(`bookmarks?user_id=eq.${u}&select=*&order=created_at.desc`, { auth: true }))) || [];
}

/** 卡片（lib/refs 的 card 格式）对应的收藏行；没收藏返回 null */
export async function findBookmark(c) {
  const u = await uid();
  const keys = [c.arxiv, c.doi].filter(Boolean);
  if (!u || !keys.length) return null;
  const list = keys.map(k => `"${String(k).replace(/"/g, "")}"`).join(",");
  const rows = await json(await rest(`bookmarks?user_id=eq.${u}&arxiv_id=in.(${encodeURIComponent(list)})&select=id,collection_id&limit=1`, { auth: true }));
  return rows?.[0] || null;
}

const SOURCE = { INSPIRE: "inspire", "Semantic Scholar": "semantic", Crossref: "crossref" };

/** 收藏一张卡片到某个收藏夹（null = 未分类） */
export async function saveBookmark(c, collectionId) {
  const u = await uid();
  if (!u) throw new Error(t("登录后才能收藏"));
  const arxiv = c.arxiv ? String(c.arxiv).replace(/v\d+$/, "") : null;
  const authors = (c.people?.length ? c.people.map(p => [p.given, p.family].filter(Boolean).join(" ")) : (c.authors || "").split(/,\s*/))
    .filter(Boolean);
  const source = arxiv ? "arxiv" : SOURCE[c.source] || "other";
  const row = {
    user_id: u,
    arxiv_id: arxiv || c.doi || c.url || c.title,
    title: c.title, authors,
    summary: c.abstract || null, abstract: c.abstract || null,
    published: c.year ? String(c.year) : null, year: c.year ? Number(c.year) || null : null,
    category: null, journal: c.journal || null, doi: c.doi || null,
    pdf_url: arxiv ? `https://arxiv.org/pdf/${arxiv}` : c.pdfUrl || null,
    abs_url: arxiv ? `https://arxiv.org/abs/${arxiv}` : c.doi ? `https://doi.org/${c.doi}` : c.url || null,
    source, source_id: arxiv || c.doi || c.url || null,
    collection_id: collectionId || null,
  };
  const rows = await restRows("bookmarks", { method: "POST", auth: true, body: row });
  if (!rows?.[0]) throw new Error(t("收藏失败，请稍后再试"));
  return rows[0];
}

export async function removeBookmark(id) {
  const res = await rest(`bookmarks?id=eq.${id}`, { method: "DELETE", auth: true });
  return !!res?.ok;
}

export async function updateBookmark(id, patch) {
  const rows = await restRows(`bookmarks?id=eq.${id}`, { method: "PATCH", auth: true, body: patch });
  return rows?.[0] || null;
}

export async function createCollection(name) {
  const u = await uid();
  const rows = await restRows("collections", { method: "POST", auth: true, body: { user_id: u, name, kind: "arxiv" } });
  return rows?.[0] || null;
}

export async function renameCollection(id, name) {
  return (await restRows(`collections?id=eq.${id}`, { method: "PATCH", auth: true, body: { name } }))?.[0] || null;
}

/** 删收藏夹：里面的文献回到未分类（先把它们挪出来，外键才删得掉） */
export async function deleteCollection(id) {
  await rest(`bookmarks?collection_id=eq.${id}`, { method: "PATCH", auth: true, body: { collection_id: null } });
  const res = await rest(`collections?id=eq.${id}`, { method: "DELETE", auth: true });
  return !!res?.ok;
}

/* 收藏时 source_id 可能是一整条 http://arxiv.org/abs/2604.21911v1（网站推送页存的 Atom id）：读出来剥成号本身 */
export const bareArxivId = (s) => String(s || "").replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//i, "").replace(/^arxiv:/i, "").replace(/v\d+$/, "").trim();
export const isArxivId = (s) => /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})$/i.test(s || "");

/** 收藏行 → 它的 arXiv 号（认不出就 null） */
export function arxivOf(b) {
  const inspireRecid = b.source === "inspire" && String(b.source_id || "").startsWith("inspire:");
  const raw = bareArxivId(b.source === "arxiv" || (b.source === "inspire" && !inspireRecid) ? b.source_id : b.arxiv_id);
  return isArxivId(raw) ? raw : null;
}
