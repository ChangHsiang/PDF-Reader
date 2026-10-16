import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import LoginForm from "../components/LoginForm";
import { Avatar, TimeText } from "../components/bits";
import { useSession } from "../lib/useSession";
import { signOut } from "../lib/session";
import { listLibrary, syncAll } from "../lib/notes";
import { SITE_URL, profileUrl } from "../lib/config";
import { fileNameOf } from "../lib/localPdf";

/** 工具栏弹窗：账号、是否接管 arXiv PDF、我的笔记列表 */

const openViewer = (url) => chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?url=${encodeURIComponent(url)}`) });

function Popup() {
  const session = useSession();
  const uid = session?.uid || null;
  const [lib, setLib] = useState(null);
  const [intercept, setIntercept] = useState(true);
  const [sync, setSync] = useState({ busy: false, msg: "" });
  const [loginOpen, setLoginOpen] = useState(false);
  const [signOutArmed, setSignOutArmed] = useState(false);
  useEffect(() => { if (!signOutArmed) return; const t = setTimeout(() => setSignOutArmed(false), 3000); return () => clearTimeout(t); }, [signOutArmed]);
  // 插件能不能读本地文件（扩展管理页的「允许访问文件网址」）：不能的话提示一句怎么开
  const [fileAccess, setFileAccess] = useState(true);
  useEffect(() => { chrome.extension?.isAllowedFileSchemeAccess?.(setFileAccess); }, []);

  const refresh = useCallback(() => { listLibrary(uid).then(setLib); }, [uid]);
  useEffect(() => { if (session !== undefined) refresh(); }, [session, refresh]);
  useEffect(() => {
    chrome.storage.local.get("settings").then(({ settings }) => setIntercept(settings?.intercept !== false));
  }, []);

  const toggleIntercept = async () => {
    const next = !intercept;
    setIntercept(next);
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings || {}), intercept: next } });
  };

  const doSync = async () => {
    setSync({ busy: true, msg: "" });
    const r = await syncAll(uid);
    setSync({ busy: false, msg: r.ok ? "已同步" : r.error });
    refresh();
  };

  if (session === undefined) return null;
  const pending = (lib || []).reduce((s, p) => s + p.pending, 0);

  return (
    <div className="w-[360px] max-h-[560px] flex flex-col font-sans text-[#e6e6e6]">
      <div className="shrink-0 px-4 py-3 border-b border-[#00000059] flex items-center gap-2.5">
        {session ? (
          <>
            <Avatar name={session.profile?.name || session.email} url={session.profile?.avatar_url} size={30} />
            <div className="flex-1 min-w-0">
              <a href={profileUrl(session.profile) || SITE_URL} target="_blank" rel="noopener noreferrer"
                className="block text-[13px] text-[#fff] font-bold truncate no-underline hover:underline">
                {session.profile?.name || session.email}
              </a>
              <div className="text-[11px] text-[#9a9a9a] truncate">{session.email}</div>
            </div>
            {/* 退出要点两下（同删除）：第一下变红「再点一下」，3 秒内再点才退 */}
            <button onClick={() => { if (!signOutArmed) { setSignOutArmed(true); return; } signOut(); }}
              className={`h-7 px-2.5 rounded-full text-[11.5px] bg-transparent border cursor-pointer whitespace-nowrap
                ${signOutArmed ? "text-[#ff8a80] border-[#ff8a8066] bg-[#ff8a801a]" : "text-[#c8c8c8] border-[#ffffff33] hover:bg-[#ffffff1a]"}`}>
              {signOutArmed ? "再点一下退出" : "退出"}
            </button>
          </>
        ) : loginOpen ? (
          <div className="flex-1"><LoginForm onDone={() => setLoginOpen(false)} onCancel={() => setLoginOpen(false)} /></div>
        ) : (
          <>
            <div className="flex-1 text-[12px] text-[#b8b8b8] leading-relaxed">
              笔记只存在这台电脑上。<br />登录 ResearchHub 可同步到网站、参与评论。
            </div>
            <button onClick={() => setLoginOpen(true)}
              className="h-8 px-3.5 rounded-full text-[12.5px] font-bold text-[#10232c] bg-[#7ec8e3] border-none cursor-pointer hover:bg-[#9ad5ea]">
              登录
            </button>
          </>
        )}
      </div>

      <div className="shrink-0 px-4 py-2.5 border-b border-[#00000059] flex flex-col gap-2">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="flex-1 text-[12.5px]">打开 arXiv / 本地 PDF 时用笔记阅读器</span>
          {/* 只有两个值 ⇒ 开关，点一下就翻 */}
          <button onClick={toggleIntercept} role="switch" aria-checked={intercept}
            className={`relative w-9 h-5 rounded-full border-none cursor-pointer transition-colors shrink-0
              ${intercept ? "bg-[#7ec8e3]" : "bg-[#ffffff33]"}`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-[#fff] transition-all ${intercept ? "left-[18px]" : "left-0.5"}`} />
          </button>
        </label>
        {uid && (
          <div className="flex items-center gap-2">
            <span className={`flex-1 text-[11.5px] ${sync.msg && sync.msg !== "已同步" ? "text-[#ff9a9a]" : "text-[#9a9a9a]"}`}>
              {sync.busy ? "同步中…" : sync.msg || (pending ? `${pending} 条改动待同步` : "笔记已和网站同步")}
            </span>
            <button onClick={doSync} disabled={sync.busy}
              className="h-7 px-2.5 rounded-full text-[11.5px] text-[#c8c8c8] bg-transparent border border-[#ffffff33] cursor-pointer
                         hover:bg-[#ffffff1a] disabled:opacity-50">
              全部同步
            </button>
          </div>
        )}
      </div>

      {!fileAccess && (
        <div className="mx-4 mt-2.5 px-2.5 py-2 rounded-md bg-[#ffffff0d] text-[11.5px] leading-relaxed text-[#9a9a9a]">
          想用它打开本地 PDF？在
          <button onClick={() => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}
            className="mx-1 p-0 bg-transparent border-none cursor-pointer text-[#7ec8e3] underline text-[11.5px]">扩展管理页</button>
          打开 PDF-Reader 的「允许访问文件网址」，之后双击 / 拖进浏览器的 PDF 都会用它打开。
        </div>
      )}
      <div className="px-4 pt-2.5 pb-1 text-[11.5px] text-[#9a9a9a] font-bold">我的笔记</div>
      <div className="flex-1 overflow-y-auto thin-scrollbar px-2 pb-2 min-h-[80px]">
        {lib === null ? null : lib.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-[#9a9a9a] leading-relaxed">
            还没有笔记。打开任意一篇 arXiv 论文的 PDF，选中文字就能高亮、划线、写批注。
          </div>
        ) : lib.map(p => {
          // 本地文件（file:…）：标「本地」，显示文件名；点它按原来的路径重新打开（文件挪走了阅读器会提示）
          const local = /^file:/.test(p.base);
          const fname = local && p.url ? fileNameOf(p.url) : null;
          return (
          <button key={p.base} onClick={() => openViewer(p.url || `https://arxiv.org/pdf/${p.paperKey.replace(/^arxiv:/, "")}`)}
            title={local && p.url ? decodeURI(p.url.replace(/^file:\/\/\/?/, "")) : undefined}
            className="w-full text-left px-2 py-2 rounded-lg bg-transparent border-none cursor-pointer hover:bg-[#ffffff14] block">
            <div className="text-[12.5px] text-[#fff] leading-snug line-clamp-2">{p.title || fname || p.base.replace(/^arxiv:/, "arXiv:")}</div>
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[#9a9a9a]">
              {local
                ? <><span className="px-1 rounded bg-[#ffffff1a] text-[#c8c8c8]">本地</span><span className="truncate max-w-[150px]">{fname || "本地文件"}</span></>
                : <span>{p.base.replace(/^arxiv:/, "arXiv:")}</span>}
              <span>{p.count} 条</span>
              {uid && p.pending > 0 && <span className="text-[#ffcf7a]">{p.pending} 待同步</span>}
              <span className="flex-1" />
              <TimeText ts={p.updated} />
            </div>
          </button>
          );
        })}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Popup />);
