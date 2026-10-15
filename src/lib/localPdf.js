import { sharedPdfium } from "./pdfium/client";

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
export async function identifyLocalPdf(url) {
  let buf;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    buf = await r.arrayBuffer();
  } catch {
    throw new FileAccessError("读不到这个本地文件");
  }
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
  const paperKey = arxivId ? `arxiv:${arxivId}`
    : info.permanentId ? `file:${info.permanentId}`
    : `file:sha256:${info.hash}`;
  return { paperKey, arxivId, name, title: info.title || null };
}
