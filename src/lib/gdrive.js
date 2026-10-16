import { buildBackup, importBackupData, stats } from "./backup";
import { GOOGLE_CLIENT_ID } from "./config";

/**
 * 笔记备份到用户自己的 Google 云端硬盘（设置 → 数据）。**只在 background 里跑**（弹登录窗口、定时备份都在这里）。
 *
 * - 授权：chrome.identity.launchWebAuthFlow 走 Google 的 OAuth（隐式流程，拿 1 小时的 access token；
 *   Chrome / Edge 都能用）。权限只要 drive.file —— **只能碰本插件自己建的文件**，看不到用户云端硬盘里别的东西；
 *   外加 openid email，只为显示「备份到 xxx@gmail.com」
 * - token 过期：带 login_hint、prompt=none 再走一次（不弹窗）；用户在 Google 那边撤销了授权就提示重新连接
 * - 文件：云端硬盘根目录下一个 PDF-Reader-backup.json（内容同「导出备份」）。换电脑连上同一个 Google 账号，
 *   插件能找到这个文件（drive.file 允许访问本应用建的文件，跨设备也行），点「从云端恢复」合并进来
 * - 自动备份：笔记变了（paper:* 键）就排一个 2 分钟后的闹钟，攒一下再传，不是每改一笔传一次
 *
 * chrome.storage.local 的 `gdrive` 键：{ email, fileId, auto, lastBackup, lastError, needAuth }（不进备份）
 * token 放 chrome.storage.session（关浏览器就没，下次静默再要）
 */

const KEY = "gdrive";
const FILE_NAME = "PDF-Reader-backup.json";
const SCOPES = "https://www.googleapis.com/auth/drive.file openid email";
const API = "https://www.googleapis.com";
export const ALARM = "gdrive-backup";

export const driveConfigured = () => !!GOOGLE_CLIENT_ID;

async function state() {
  const { [KEY]: s } = await chrome.storage.local.get(KEY);
  return s || null;
}
async function patchState(p) {
  const s = { ...(await state()), ...p };
  await chrome.storage.local.set({ [KEY]: s });
  return s;
}

/** 走一次 Google 授权；interactive=false 时不弹窗（静默续期），失败抛错 */
async function authorize(interactive, email) {
  if (!GOOGLE_CLIENT_ID) throw new Error("这个版本没有配置 Google 客户端 ID");
  const redirect = chrome.identity.getRedirectURL("google");
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, response_type: "token", redirect_uri: redirect, scope: SCOPES,
    include_granted_scopes: "true", ...(email ? { login_hint: email } : {}), ...(interactive ? {} : { prompt: "none" }),
  });
  const back = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p}`, interactive });
  const q = new URLSearchParams(new URL(back).hash.replace(/^#/, ""));
  const token = q.get("access_token");
  if (!token) throw new Error(q.get("error") || "没有拿到授权");
  const exp = Date.now() + (Number(q.get("expires_in")) || 3600) * 1000;
  await chrome.storage.session.set({ gdrive_token: { token, exp } });
  return token;
}

/** 拿一个还能用的 token：缓存的 → 静默续期；都不行就标「需要重新连接」 */
async function token() {
  const { gdrive_token: t } = await chrome.storage.session.get("gdrive_token");
  if (t?.token && t.exp - Date.now() > 60_000) return t.token;
  const s = await state();
  try { return await authorize(false, s?.email); }
  catch {
    await patchState({ needAuth: true });
    throw new Error("Google 授权过期了，请在「设置 → 数据」里重新连接");
  }
}

async function api(path, init = {}, retry = true) {
  const t = await token();
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
  if (res.status === 401 && retry) {
    await chrome.storage.session.remove("gdrive_token");
    return api(path, init, false);
  }
  return res;
}

/** 找云端硬盘里那份备份（本插件建的、没进回收站的）：{ id, modifiedTime } 或 null */
async function findFile() {
  const s = await state();
  if (s?.fileId) {
    const r = await api(`/drive/v3/files/${s.fileId}?fields=id,modifiedTime,trashed`);
    if (r.ok) { const f = await r.json(); if (!f.trashed) return f; }
  }
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const r = await api(`/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=1&fields=files(id,modifiedTime)`);
  if (!r.ok) throw new Error(`读取云端硬盘失败（${r.status}）`);
  const f = (await r.json()).files?.[0] || null;
  if (f) await patchState({ fileId: f.id });
  return f;
}

/** 连接：弹 Google 授权窗口，记下账号；云端已经有备份的话返回它的时间（界面上问要不要合并） */
export async function connect() {
  const t = await authorize(true);
  const info = await (await fetch(`${API}/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${t}` } })).json().catch(() => ({}));
  await patchState({ email: info.email || "", needAuth: false, lastError: null, auto: (await state())?.auto ?? true });
  const f = await findFile().catch(() => null);
  return { email: info.email || "", remote: f ? f.modifiedTime : null };
}

export async function disconnect() {
  const { gdrive_token: t } = await chrome.storage.session.get("gdrive_token");
  if (t?.token) fetch(`https://oauth2.googleapis.com/revoke?token=${t.token}`, { method: "POST" }).catch(() => {});
  await chrome.storage.session.remove("gdrive_token");
  await chrome.storage.local.remove(KEY);
  await chrome.alarms.clear(ALARM);
}

export async function setAuto(on) {
  await patchState({ auto: !!on });
  if (!on) await chrome.alarms.clear(ALARM);
}

/** 现在备份一次：有那份文件就覆盖，没有就新建 */
export async function backupNow() {
  try {
    const data = await buildBackup();
    const body = JSON.stringify(data);
    const f = await findFile();
    let r;
    if (f) {
      r = await api(`/upload/drive/v3/files/${f.id}?uploadType=media&fields=id,modifiedTime`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body,
      });
    } else {
      const boundary = "pdfreader" + Math.random().toString(36).slice(2);
      const meta = JSON.stringify({ name: FILE_NAME, mimeType: "application/json", description: "PDF-Reader 插件的笔记备份（可在插件「设置 → 数据」里恢复）" });
      r = await api(`/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`, {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`,
      });
    }
    if (!r.ok) throw new Error(`上传失败（${r.status}）`);
    const out = await r.json();
    const st = stats(data.storage);
    await patchState({ fileId: out.id, lastBackup: new Date().toISOString(), lastError: null, needAuth: false, lastStats: st });
    return { ok: true, ...st };
  } catch (e) {
    await patchState({ lastError: e.message || String(e) });
    return { ok: false, error: e.message || String(e) };
  }
}

/** 从云端那份合并进来（规则同「导入备份」：同一条留较新的） */
export async function restore() {
  try {
    const f = await findFile();
    if (!f) return { ok: false, error: "云端硬盘里还没有备份" };
    const r = await api(`/drive/v3/files/${f.id}?alt=media`);
    if (!r.ok) throw new Error(`下载失败（${r.status}）`);
    const st = await importBackupData(await r.json());
    return { ok: true, ...st };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** 笔记变了：开着自动备份就排一个 2 分钟后的闹钟（一直在改就一直往后推） */
export async function scheduleBackup() {
  const s = await state();
  if (!s?.email || !s.auto || s.needAuth) return;
  await chrome.alarms.create(ALARM, { delayInMinutes: 2 });
}
