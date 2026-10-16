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

/* ── 用 Google 账号登录（Supabase 的 OAuth + PKCE）──────────────────────────
   浏览器弹一个 Google 登录窗口（chrome.identity.launchWebAuthFlow，Chrome / Edge 都有），
   Supabase 登录完跳回 https://<插件编号>.chromiumapp.org/supabase?code=…，拿 code + 校验串换 token。
   和网站是同一个 Supabase 项目：同一个邮箱之前用密码注册过的，Supabase 会把两种登录方式并到同一个账号上。
   需要 Supabase 后台打开 Google 登录、并把上面那个回跳地址加进允许列表（README「用 Google 登录」） */
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 新用户（第一次用 Google 登录）还没有资料行：照网站注册时那样建一行。用户名从邮箱前缀来，撞了加数字 */
async function ensureProfile(user, token) {
  const have = await fetchProfile(user.id, token);
  if (have) return have;
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || (user.email || "").split("@")[0] || "user";
  const base = ((user.email || "").split("@")[0] || "user").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) || "user";
  for (let i = 0; i < 4; i++) {
    const username = i ? `${base}${Math.floor(1000 + Math.random() * 9000)}` : base;
    const row = { id: user.id, name, username, institution: "", orcid: null, bio: "", interests: [],
                  avatar: name.slice(0, 2).toUpperCase(), avatar_url: meta.avatar_url || meta.picture || null };
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      if (r.ok) return (await r.json())?.[0] || row;
      if (r.status !== 409) break;              // 409 = 用户名撞了，换一个再试
    } catch { break; }
  }
  return null;
}

export async function signInWithGoogle() {
  if (!chrome.identity?.launchWebAuthFlow) return { error: "这个浏览器不支持弹出 Google 登录" };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const redirect = chrome.identity.getRedirectURL("supabase");
  const url = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}` +
              `&code_challenge=${challenge}&code_challenge_method=s256`;
  let back;
  try { back = await chrome.identity.launchWebAuthFlow({ url, interactive: true }); }
  catch (e) { return { error: /cancel|closed|did not approve/i.test(e?.message || "") ? "已取消" : `Google 登录没有完成：${e?.message || e}` }; }
  const u = new URL(back);
  const q = new URLSearchParams(u.search + "&" + u.hash.replace(/^#/, ""));
  const code = q.get("code");
  if (!code) {
    const msg = q.get("error_description") || q.get("error") || "没有拿到登录结果";
    return { error: /provider is not enabled|unsupported provider/i.test(msg) ? "网站还没打开 Google 登录（Supabase 后台 → Authentication → Providers → Google）" : msg };
  }
  const { res, data, netErr } = await authFetch("/auth/v1/token?grant_type=pkce", { auth_code: code, code_verifier: verifier });
  if (netErr) return { error: netErr };
  if (!res.ok || !data?.access_token) return { error: data?.error_description || data?.msg || "Google 登录失败" };
  const profile = await ensureProfile(data.user, data.access_token);
  const s = {
    access_token: data.access_token, refresh_token: data.refresh_token,
    uid: data.user?.id, email: data.user?.email || "", profile, provider: "google",
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
