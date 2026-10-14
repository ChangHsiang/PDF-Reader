import { SUPABASE_URL, SUPABASE_ANON_KEY, anonHeaders } from "./config";

/**
 * 阅读器 / 弹窗这边的登录态入口。真正的刷新在 background（见 lib/auth.js 文件头）。
 */

const send = (msg) => chrome.runtime.sendMessage(msg);

export const signIn = (email, password) => send({ type: "auth:signIn", email, password });
export const signOut = () => send({ type: "auth:signOut" });
export const getToken = (force = false) => send({ type: "auth:getToken", force });

export async function readSession() {
  const { auth } = await chrome.storage.local.get("auth");
  return auth || null;
}

/** 当前用户（给评论区显示头像 / 判断是不是自己）。没登录 = null */
export const userOf = (session) => session
  ? { id: session.uid, name: session.profile?.name || session.email, username: session.profile?.username,
      avatar_url: session.profile?.avatar_url }
  : null;

/**
 * 发一个 PostgREST 请求。
 * - `auth: true`：必须登录，带用户 token；401 时强制刷新一次再试
 * - `auth: "optional"`：登录了就带 token（读自己的私有笔记必须这样，见网站 lib/paperNotes 文件头），
 *   没登录或刷不出 token 时退回 anon
 * - 默认：anon
 * 返回 Response；网络错误返回 null。
 */
export async function rest(path, { method = "GET", body, auth = false, prefer } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const make = (tok) => {
    const h = tok ? { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${tok}` } : anonHeaders();
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (prefer) h.Prefer = prefer;
    return fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  try {
    if (!auth) return await make(null);
    let tok = await getToken();
    if (!tok && auth === true) return null;
    let res = await make(tok);
    /* 只有 401 才是 token 过期（Supabase 的 JWT 过期回 401）。403 是 RLS 不让写（比如删别人的评论），
       刷新 token 也没用，还白白轮换一次 refresh_token */
    if (tok && res.status === 401) {
      tok = await getToken(true);
      if (!tok && auth === true) return res;
      res = await make(tok);
    }
    return res;
  } catch {
    return null;
  }
}

/** 写操作别只看 res.ok：RLS 拦掉时 PostgREST 照样 2xx（改了 0 行），要 representation 看数组 */
export async function restRows(path, opts) {
  const res = await rest(path, { prefer: "return=representation", ...opts });
  if (!res || !res.ok) return null;
  const d = await res.json().catch(() => null);
  return Array.isArray(d) ? d : d ? [d] : [];
}
