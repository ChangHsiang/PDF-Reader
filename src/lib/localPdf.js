import { sharedPdfium } from "./pdfium/client";
import { t } from "./i18n";

/**
 * 本地 PDF（file:// 打开的）：认出「这是哪一篇」，给笔记当身份（paperKey）。
 *
 * 在线的 arXiv 论文靠网址里的编号；本地文件会改名、会挪位置，所以按文件本身认，依次：
 * 1. **arXiv 论文**：第一页页边印着「arXiv:2011.03014v2 [astro-ph.CO] 31 Mar 2021」→ 直接用 `arxiv:2011.03014v2`，
 *    和在线打开的是同一套笔记（同步、评论、文献卡片、复制公式也都能用）
 * 2. **PDF 的永久编号**（trailer /ID 的第一段）：文件第一次生成时定下，之后在 Edge / Acrobat 里加标注保存（增量保存）
 *    不会变 —— 改名、挪位置、被别的阅读器存过，都还是同一篇 → `file:<编号 hex>`
 * 3. 没有编号的（少数 PDF）：文件内容的 SHA-256 → `file:sha256:<hex>`（内容一改就算新文件）
 *
 * 要读 file:// 的文件，需要在扩展管理页给插件打开「允许访问文件网址」；没开的话 fetch 会失败，提示用户去开。
 *
 * **其他网站的在线 PDF**（设置「其他网站的 PDF 也用」）也走这里，多认一步 **DOI**（PDF 的 Subject / Keywords / 第一页里的
 * `doi:10.…` / `doi.org/10.…`）→ `doi:<小写 DOI>`：同一篇从期刊官网、学校镜像打开都是同一份笔记。
 * 优先级：arXiv 印记 > DOI > 永久编号 > 内容哈希；但本机已经有按文件编号 / 哈希存的笔记时，沿用那个（以前没认 DOI 时存的笔记别丢）。
 * 下载下来的字节留一份（takePrefetched），阅读器打开时直接用，不再下第二遍
 */

export const isLocalPdfUrl = (u) => /^file:\/\/.+\.pdf(?:[?#].*)?$/i.test(String(u || ""));

/** file:///E:/papers/foo%20bar.pdf → foo bar.pdf */
export const fileNameOf = (u) => {
  const p = String(u || "").replace(/[?#].*$/, "").split("/").pop() || "";
  try { return decodeURIComponent(p); } catch { return p; }
};

/** 认 arXiv 的页边印记：「arXiv:编号vN [分类] 日期」。要求带 [分类]，免得把正文里引用的别的 arXiv 论文认成这一篇 */
const STAMP = /arXiv:\s*((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})v\d+)\s*\[[A-Za-z.-]+\]/;

export class FileAccessError extends Error {}

let seq = 0;
const DOI_RE = /(?:\bdoi\s*[:：]?\s*|doi\.org\/)(10\.\d{4,9}\/[^\s"<>,;]+)/i;
const prefetched = new Map();
/** 认文件时下载过的字节（只给一次） */
export function takePrefetched(url) {
  const b = prefetched.get(url);
  prefetched.delete(url);
  return b || null;
}

export const identifyLocalPdf = (url) => identifyPdf(url);

/** online：其他网站的 PDF（带上那个网站的登录 cookie 去取，要登录才能下的期刊 PDF 也能读） */
export async function identifyPdf(url, { online = false } = {}) {
  let buf;
  try {
    const r = await fetch(url, online ? { credentials: "include" } : undefined);
    if (!r.ok) throw Object.assign(new Error(t("下载 PDF 失败（{s}）", { s: r.status })), { http: true });
    buf = await r.arrayBuffer();
  } catch (e) {
    if (online) throw new Error(e?.http ? e.message : t("下载 PDF 失败（网络或权限）"));
    throw new FileAccessError(t("读不到这个本地文件"));
  }
  prefetched.set(url, buf.slice(0));
  const name = fileNameOf(url);
  const sha = async () => [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const pdf = sharedPdfium();
  const docId = `id${++seq}`;
  let info = null;
  try {
    const hash = await sha();                       // 先算：buf 下面要转交给 Worker
    await pdf.open(docId, buf);
    info = await pdf.identify(docId);
    info.hash = hash;
  } finally {
    pdf.close(docId).catch(() => {});
  }
  const arxivId = STAMP.exec(info.firstPage || "")?.[1] || null;
  const doi = DOI_RE.exec(`${info.subject || ""} ${info.keywords || ""} ${(info.firstPage || "").slice(0, 6000)}`)?.[1]
    ?.replace(/[.)\]]+$/, "").toLowerCase() || null;
  const fileKey = info.permanentId ? `file:${info.permanentId}` : `file:sha256:${info.hash}`;
  let paperKey = arxivId ? `arxiv:${arxivId}` : doi ? `doi:${doi}` : fileKey;
  if (!arxivId && doi) {
    const had = await chrome.storage.local.get(`paper:${fileKey}`).catch(() => ({}));
    if (had[`paper:${fileKey}`]) paperKey = fileKey;           // 以前按文件存过笔记：沿用
  }
  return { paperKey, arxivId, doi, name, title: info.title || null };
}
