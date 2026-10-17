import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import PdfViewer from "../components/PdfViewer";
import LoginForm from "../components/LoginForm";
import { useSession } from "../lib/useSession";
import { arxivIdFromUrl } from "../lib/pdfAnchor";
import { registerViewerTab } from "../lib/tabRestore";
import { isLocalPdfUrl, identifyPdf, fileNameOf, FileAccessError } from "../lib/localPdf";

/**
 * 阅读器页面：`viewer.html?url=https://arxiv.org/pdf/2301.12345v2[&panel=comments]`，
 * 或者本地文件 `viewer.html?url=file:///E:/papers/xxx.pdf`（先认出是哪一篇，见 lib/localPdf）
 * background 的重定向规则、arXiv 摘要页上的按钮、弹窗里的列表都打开这一页。
 */

// 插件更新时浏览器会关掉这个标签：先登记，更新后由 background 重新打开（lib/tabRestore）
registerViewerTab();

const params = new URLSearchParams(location.search);
const rawUrl = params.get("url") || "";
const initialPanel = params.get("panel");

/** 统一成 https://arxiv.org/pdf/<id>：export. / www. / http 都归一，免得同一篇存出好几个 url */
function normalize(u) {
  const id = arxivIdFromUrl(u);
  return id ? { id, url: `https://arxiv.org/pdf/${id}` } : null;
}

/** 标题：arXiv API 的 Atom（PDF 自带的元数据里 arXiv 论文多半没有标题） */
async function fetchTitle(id) {
  try {
    const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
    const xml = new DOMParser().parseFromString(await r.text(), "application/xml");
    const t = xml.querySelector("entry > title")?.textContent;
    return t ? t.replace(/\s+/g, " ").trim() : null;
  } catch { return null; }
}

/* 本地文件，或其他网站的 PDF（不是 arXiv 的 http(s)，由 background 按 Content-Type 转过来）：都先认出是哪一篇（lib/localPdf） */
const isWeb = /^https?:\/\//i.test(rawUrl) && !normalize(rawUrl);
const isLocal = isLocalPdfUrl(rawUrl) || isWeb;

/** 本地文件读不到：多半是没给插件打开「允许访问文件网址」 */
function FileAccessHelp() {
  const open = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  return (
    <div className="h-screen flex items-center justify-center px-6 font-sans">
      <div className="max-w-[460px] text-[13px] text-[#ddd] leading-relaxed">
        <div className="text-[15px] text-[#fff] font-bold mb-2">读不到这个本地文件</div>
        <div>用这个阅读器打开本地 PDF，需要先允许插件访问本地文件：</div>
        <ol className="mt-2 mb-3 pl-5 list-decimal">
          <li>打开<button onClick={open} className="mx-1 p-0 bg-transparent border-none cursor-pointer text-[#7ec8e3] underline text-[13px]">扩展管理页</button>里 PDF-Reader 的「详细信息」</li>
          <li>打开「允许访问文件网址」</li>
          <li>回到这里刷新</li>
        </ol>
        <a href={rawUrl} className="text-[#7ec8e3] underline">用浏览器自带的阅读器打开</a>
        <div className="mt-1 text-[11.5px] text-[#9a9a9a] break-all">{fileNameOf(rawUrl)}</div>
      </div>
    </div>
  );
}

function App() {
  const session = useSession();
  const [local, setLocal] = useState(null);      // 本地文件：{ paperKey, arxivId, name, title } | { error }
  const target = isLocal ? (local?.paperKey ? { id: local.arxivId, url: rawUrl, paperKey: local.paperKey } : null) : normalize(rawUrl);
  const [title, setTitle] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    if (!isLocal) return;
    document.title = fileNameOf(rawUrl);
    identifyPdf(rawUrl, { online: isWeb }).then(setLocal).catch(e => setLocal({ error: e instanceof FileAccessError ? "access" : (e?.message || "打不开") }));
  }, []);

  useEffect(() => {
    if (isLocal && local?.title && !local.arxivId) { setTitle(local.title); document.title = local.title; }
    // 认出 DOI 的：标题用 Crossref 登记的（期刊 PDF 的元数据标题常常是「pone.0000001 1..11」这种排版文件名）
    if (isLocal && local?.doi && !local.arxivId) {
      fetch(`https://api.crossref.org/works/${encodeURIComponent(local.doi)}`).then(r => (r.ok ? r.json() : null))
        .then(d => { const t = d?.message?.title?.[0]?.replace(/\s+/g, " ").trim(); if (t) { setTitle(t); document.title = t; } }).catch(() => {});
    }
    if (!target?.id) return;
    document.title = `arXiv:${target.id}`;
    fetchTitle(target.id).then(t => { if (t) { setTitle(t); document.title = t; } });
  }, [target?.id, local]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (isLocal && !local) {
    return <div className="h-screen flex items-center justify-center text-[13px] text-[#ddd] font-sans">正在打开 {fileNameOf(rawUrl)}…</div>;
  }
  if (isLocal && local.error) {
    if (local.error === "access") return <FileAccessHelp />;
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-2 text-[13px] text-[#ddd] font-sans">
        <div>打不开这个文件：{local.error}</div>
        {isWeb && <a href={rawUrl} className="text-[#7ec8e3] underline" onClick={(e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: "viewer:raw", url: rawUrl }); }}>用浏览器自带的阅读器打开</a>}
      </div>
    );
  }
  if (!target) {
    return (
      <div className="h-screen flex items-center justify-center text-[13px] text-[#ddd] font-sans text-center px-6 leading-relaxed">
        这个地址不是 PDF。<br />
        {rawUrl && <a href={rawUrl} className="text-[#7ec8e3] underline">直接打开原链接</a>}
      </div>
    );
  }
  if (session === undefined) return null;   // 登录态还没读到，别先按「没登录」渲染一遍

  return (
    <>
      <PdfViewer url={target.url} paperKey={target.paperKey} localName={isLocal ? local.name : null}
        title={title || (isLocal ? local.name : null)} session={session}
        onLogin={() => setLoginOpen(true)} initialPanel={initialPanel} />
      {loginOpen && !session && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4 animate-fade-in"
          onMouseDown={e => { if (e.target === e.currentTarget) setLoginOpen(false); }}>
          <div className="w-full max-w-[360px] rounded-xl bg-[#323639] border border-[#ffffff26] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
            <LoginForm onDone={() => setLoginOpen(false)} onCancel={() => setLoginOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
