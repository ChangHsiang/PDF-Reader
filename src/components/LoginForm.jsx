import { useState } from "react";
import { signIn } from "../lib/session";
import { SITE_URL } from "../lib/config";

/** ResearchHub 账号登录（邮箱 + 密码）。注册要过人机验证，留在网站上做 */
export default function LoginForm({ onDone, onCancel }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password || busy) return;
    setBusy(true); setErr("");
    const r = await signIn(email.trim(), password).catch(() => ({ error: "扩展后台没有响应，请重试" }));
    setBusy(false);
    if (r?.error) { setErr(r.error); return; }
    onDone?.(r.session);
  };

  const field = "w-full h-9 px-3 rounded-lg bg-[#00000059] border border-[#ffffff33] text-[13px] text-[#fff] " +
                "outline-none placeholder:text-[#ffffff59] focus:border-[#ffffff80]";
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 font-sans">
      <div className="text-[14px] text-[#fff] font-bold">登录 ResearchHub</div>
      <div className="text-[11.5px] text-[#b8b8b8] leading-relaxed mb-1">
        登录后笔记会和网站同步，还能看别人公开的笔记、参与论文评论。没登录时写的笔记会在登录后一并上传到你的账号。
      </div>
      <input className={field} type="email" autoComplete="email" placeholder="邮箱" value={email}
        onChange={e => setEmail(e.target.value)} autoFocus />
      <input className={field} type="password" autoComplete="current-password" placeholder="密码" value={password}
        onChange={e => setPassword(e.target.value)} />
      {err && <div className="text-[12px] text-[#ff9a9a]">{err}</div>}
      <div className="flex items-center gap-2 mt-1">
        <a href={`${SITE_URL}`} target="_blank" rel="noopener noreferrer"
          className="flex-1 text-[11.5px] text-[#7ec8e3] no-underline hover:underline">没有账号？去网站注册 ↗</a>
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="h-8 px-3 rounded-full text-[12.5px] text-[#c8c8c8] bg-transparent border border-[#ffffff33] cursor-pointer hover:bg-[#ffffff1a]">
            取消
          </button>
        )}
        <button type="submit" disabled={busy}
          className="h-8 px-4 rounded-full text-[12.5px] font-bold text-[#10232c] bg-[#7ec8e3] border-none cursor-pointer
                     hover:bg-[#9ad5ea] disabled:opacity-50">
          {busy ? "登录中…" : "登录"}
        </button>
      </div>
    </form>
  );
}
