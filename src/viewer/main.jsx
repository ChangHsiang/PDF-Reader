import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import PdfViewer from "../components/PdfViewer";
import LoginForm from "../components/LoginForm";
import { useSession } from "../lib/useSession";
import { arxivIdFromUrl } from "../lib/pdfAnchor";
import { registerViewerTab } from "../lib/tabRestore";

/**
 * 阅读器页面：`viewer.html?url=https://arxiv.org/pdf/2301.12345v2[&panel=comments]`
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

function App() {
  const session = useSession();
  const target = normalize(rawUrl);
  const [title, setTitle] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);

  useEffect(() => {
    if (!target) return;
    document.title = `arXiv:${target.id}`;
    fetchTitle(target.id).then(t => { if (t) { setTitle(t); document.title = t; } });
  }, [target?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) {
    return (
      <div className="h-screen flex items-center justify-center text-[13px] text-[#ddd] font-sans text-center px-6 leading-relaxed">
        这个阅读器目前只支持 arXiv 的论文。<br />
        {rawUrl && <a href={rawUrl} className="text-[#7ec8e3] underline">直接打开原链接</a>}
      </div>
    );
  }
  if (session === undefined) return null;   // 登录态还没读到，别先按「没登录」渲染一遍

  return (
    <>
      <PdfViewer url={target.url} title={title} session={session}
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
