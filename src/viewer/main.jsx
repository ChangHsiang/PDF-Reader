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

/** 标题和最新版本号：读 arXiv 的摘要页（citation_title、og:url 里带 vN）。
    原来用 export.arxiv.org 的 API，那个接口经常请求不到（标题就空着、版本号也补不上）；API 留作后备 */
const metaCache = new Map();
function fetchMeta(id) {
  if (!metaCache.has(id)) {
    metaCache.set(id, (async () => {
      try {
        const html = await (await fetch(`https://arxiv.org/abs/${id}`)).text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const title = doc.querySelector('meta[name="citation_title"]')?.content?.replace(/\s+/g, " ").trim() || null;
        const version = /v(\d+)\/?$/.exec(doc.querySelector('meta[property="og:url"]')?.content || "")?.[1] || null;
        if (title) return { title, version };
      } catch { /* 走后备 */ }
      try {
        const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
        const xml = new DOMParser().parseFromString(await r.text(), "application/xml");
        const t = xml.querySelector("entry > title")?.textContent;
        const v = /v(\d+)$/.exec(xml.querySelector("entry > id")?.textContent || "")?.[1] || null;
        return { title: t ? t.replace(/\s+/g, " ").trim() : null, version: v };
      } catch { return { title: null, version: null }; }
    })());
  }
  return metaCache.get(id);
}
/** 等一会儿版本号（地址里没写 vN 时）：最多 4 秒，等不到就照原样打开 */
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

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
  /* 地址里没写版本号（arxiv.org/pdf/2011.03014）：先查出最新是 vN 再打开 —— 笔记按版本存、下载的文件名也带版本 */
  const online = !isLocal ? normalize(rawUrl) : null;
  const needVer = !!online && !/v\d+$/.test(online.id);
  const [verId, setVerId] = useState(needVer ? undefined : null);      // undefined = 还在查
  useEffect(() => {
    if (!needVer) return;
    withTimeout(fetchMeta(online.id), 4000).then(m => setVerId(m?.version ? `${online.id}v${m.version}` : null));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const target = isLocal ? (local?.paperKey ? { id: local.arxivId, url: rawUrl, paperKey: local.paperKey } : null)
    : verId ? { id: verId, url: `https://arxiv.org/pdf/${verId}` } : online;
  const [title, setTitle] = useState(null);
  /* arXiv 的最新版本（arxiv:<id>vN，摘要页查到的）：没带版本号的旧笔记只算这一版的（PdfViewer 的 thisVersion） */
  const [latestKey, setLatestKey] = useState(null);
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
    // 标签名同 arXiv 摘要页：「[编号] 标题」（编号不带版本号）
    const bare = target.id.replace(/v\d+$/, "");
    document.title = `[${bare}]`;
    fetchMeta(bare).then(m => {
      if (m?.title) { setTitle(m.title); document.title = `[${bare}] ${m.title}`; }
      if (m?.version) setLatestKey(`arxiv:${bare}v${m.version}`);
    });
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
  if (session === undefined || verId === undefined) return null;   // 登录态 / 版本号还没读到，别先渲染一遍   // 登录态还没读到，别先按「没登录」渲染一遍

  return (
    <>
      <PdfViewer url={target.url} paperKey={target.paperKey} latestKey={latestKey} localName={isLocal ? local.name : null}
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
