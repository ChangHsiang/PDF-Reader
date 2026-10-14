import { SUPABASE_URL, SUPABASE_ANON_KEY, anonHeaders } from "./config";

/**
 * 登录态。**只在 background 里跑**，别的页面（阅读器 / 弹窗）一律发消息过来要 token
 * （见 lib/session.js）。
 *
 * 为什么要集中到一处：Supabase 的 refresh_token 是一次性轮换的，几个阅读器标签页
 * 各自去刷，第二个拿着已经作废的 token 去换会被拒，然后被误判成「登录失效」把人踢下线。
 * 网站那边用 single-flight 解决同一页面里的并发；扩展是多个页面，single-flight
 * 只能放在大家共用的 background 里才管用。
 *
 * 存在 chrome.storage.local 的 `auth` 键：
 *   { access_token, refresh_token, uid, email, profile: { id, name, username, avatar_url } }
 */

const KEY = "auth";
const AUTH_TIMEOUT = 20_000;

const tokenExp = (jwt) => {
  try {
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return (JSON.parse(atob(b64)).exp || 0) * 1000;
  } catch { return 0; }
};

export async function getSession() {
  const { [KEY]: s } = await chrome.storage.local.get(KEY);
  return s || null;
}

async function saveSession(s) {
  if (s) await chrome.storage.local.set({ [KEY]: s });
  else await chrome.storage.local.remove(KEY);
}

/** 认证接口固定用 anon key：带一个过期的用户 token，GoTrue 会先在 JWT 校验上 401 */
async function authFetch(path, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AUTH_TIMEOUT);
  try {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      method: "POST",
      headers: { ...anonHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 空响应 */ }
    return { res, data };
  } catch (e) {
    return { res: null, data: null, netErr: e.name === "AbortError" ? "服务器响应超时，请稍后再试" : "网络连接失败" };
  } finally { clearTimeout(timer); }
}

async function fetchProfile(uid, token) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=id,name,username,avatar_url`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch { return null; }
}

export async function signIn(email, password) {
  const { res, data, netErr } = await authFetch("/auth/v1/token?grant_type=password", { email, password });
  if (netErr) return { error: netErr };
  if (!res.ok || !data?.access_token) {
    const msg = data?.error_description || data?.msg || data?.error?.message || "登录失败";
    return { error: /invalid login/i.test(msg) ? "邮箱或密码不对" : msg };
  }
  const uid = data.user?.id;
  const profile = await fetchProfile(uid, data.access_token);
  const s = {
    access_token: data.access_token, refresh_token: data.refresh_token,
    uid, email: data.user?.email || email, profile,
  };
  await saveSession(s);
  return { session: s };
}

export async function signOut() {
  await saveSession(null);
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const s = await getSession();
    if (!s?.refresh_token) return null;
    const { res, data, netErr } = await authFetch("/auth/v1/token?grant_type=refresh_token",
      { refresh_token: s.refresh_token });
    if (netErr) return null;                 // 断网：保留登录态，下次再试
    if (res.ok && data?.access_token) {
      const next = { ...s, access_token: data.access_token, refresh_token: data.refresh_token || s.refresh_token };
      // 资料顺手更新一下（改了头像 / 名字之后扩展里也跟着变）
      next.profile = (await fetchProfile(s.uid, next.access_token)) || s.profile;
      await saveSession(next);
      return next.access_token;
    }
    // 只有服务端明确拒绝才清登录态；5xx 一律保留
    if (res.status === 400 || res.status === 401 || res.status === 403) await saveSession(null);
    return null;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

/** 拿一个**至少还能用一分钟**的 token；`force` = 刚被 401 过，不管 exp 都刷一次 */
export async function getToken({ force = false } = {}) {
  const s = await getSession();
  if (!s) return null;
  const exp = tokenExp(s.access_token);
  if (!force && exp && exp - Date.now() > 60_000) return s.access_token;
  return refresh();
}
