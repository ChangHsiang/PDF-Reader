import { useState } from "react";
import { signIn, signInWithGoogle } from "../lib/session";
import { SITE_URL } from "../lib/config";
import { t } from "../lib/i18n";

/** ResearchHub 账号登录：用 Google 账号（第一次用会顺便建好 ResearchHub 账号），或邮箱 + 密码。
    邮箱注册要过人机验证，留在网站上做 */
const GoogleG = () => (
  <svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

export default function LoginForm({ onDone, onCancel }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password || busy) return;
    setBusy(true); setErr("");
    const r = await signIn(email.trim(), password).catch(() => ({ error: t("扩展后台没有响应，请重试") }));
    setBusy(false);
    if (r?.error) { setErr(r.error); return; }
    onDone?.(r.session);
  };

  const google = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    const r = await signInWithGoogle().catch(() => ({ error: t("扩展后台没有响应，请重试") }));
    setBusy(false);
    if (r?.error) { if (!r.cancelled) setErr(r.error); return; }
    onDone?.(r.session);
  };

  const field = "w-full h-9 px-3 rounded-lg bg-[#00000059] border border-[#ffffff33] text-[13px] text-[#fff] " +
                "outline-none placeholder:text-[#ffffff59] focus:border-[#ffffff80]";
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 font-sans">
      <div className="text-[14px] text-[#fff] font-bold">{t("登录 ResearchHub")}</div>
      <div className="text-[11.5px] text-[#b8b8b8] leading-relaxed mb-1">
        {t("登录后笔记会和网站同步，还能看别人公开的笔记、参与论文评论。没登录时写的笔记会在登录后一并上传到你的账号。")}
      </div>
      <button type="button" onClick={google} disabled={busy}
        className="h-9 rounded-lg flex items-center justify-center gap-2 text-[13px] font-sans text-[#1f1f1f] bg-[#fff] border-none
                   cursor-pointer hover:bg-[#f1f3f4] disabled:opacity-60">
        <GoogleG />{t("用 Google 账号登录")}
      </button>
      <div className="flex items-center gap-2 text-[11px] text-[#8a8a8a] my-0.5">
        <span className="flex-1 border-t border-[#ffffff26]" />{t("或用邮箱和密码")}<span className="flex-1 border-t border-[#ffffff26]" />
      </div>
      <input className={field} type="email" autoComplete="email" placeholder={t("邮箱")} value={email}
        onChange={e => setEmail(e.target.value)} />
      <input className={field} type="password" autoComplete="current-password" placeholder={t("密码")} value={password}
        onChange={e => setPassword(e.target.value)} />
      {err && <div className="text-[12px] text-[#ff9a9a]">{err}</div>}
      <div className="flex items-center gap-2 mt-1">
        <a href={`${SITE_URL}`} target="_blank" rel="noopener noreferrer"
          className="flex-1 text-[11.5px] text-[#7ec8e3] no-underline hover:underline">{t("没有账号？去网站注册 ↗")}</a>
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="h-8 px-3 rounded-full text-[12.5px] text-[#c8c8c8] bg-transparent border border-[#ffffff33] cursor-pointer hover:bg-[#ffffff1a]">
            {t("取消")}
          </button>
        )}
        <button type="submit" disabled={busy}
          className="h-8 px-4 rounded-full text-[12.5px] font-bold text-[#10232c] bg-[#7ec8e3] border-none cursor-pointer
                     hover:bg-[#9ad5ea] disabled:opacity-50">
          {busy ? t("登录中…") : t("登录")}
        </button>
      </div>
    </form>
  );
}
