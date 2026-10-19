import { buildBackup, importBackupData, replaceWithBackup, stats } from "./backup";
import { GOOGLE_CLIENT_ID } from "./config";
import { t } from "./i18n";

/**
 * 笔记备份到用户自己的 Google 云端硬盘（设置 → 数据）。**只在 background 里跑**（弹登录窗口、定时备份都在这里）。
 * 做法是标准的**快照备份**（同 Time Machine / 聊天记录备份）：每份是一张完整快照，恢复时选一份放回来；不做逐条同步
 * （多台电脑同步笔记走 ResearchHub 登录同步）。
 *
 * - 授权：chrome.identity.launchWebAuthFlow 走 Google 的 OAuth（隐式流程，1 小时的 access token；Chrome / Edge 都能用）。
 *   权限只要 drive.file —— **只能碰本插件自己建的文件**；外加 openid email，只为显示账号
 * - token 过期：带 login_hint、prompt=none 再走一次（不弹窗）；不行就标 needAuth，提示重新连接
 * - 文件：云端硬盘里一个 `PDF-Reader Backups` 文件夹，每份 `PDF-Reader-backup-YYYYMMDD-HHMM.json`（内容同「导出备份」）。
 *   隐藏属性（appProperties）里记：device（哪台电脑，不出现在文件名里）、day、kind（auto / manual）、papers、anns
 * - 自动备份：笔记变了攒 2 分钟；**一天一份** —— 当天这台电脑的自动备份就更新那一份（连文件名里的时间），第二天才新建
 * - 手动「立即备份」：每次新建一份
 * - 只留最近 KEEP 份，多的移进回收站（云端硬盘回收站里 30 天内还能找回）
 * - 恢复：选一份，「替换」（本机变成那份）或「合并」（同一条留较新的，本机独有的保留）
 *
 * chrome.storage.local：`gdrive` = { email, folderId, auto, lastBackup, lastStats, lastError, needAuth }（不进备份）；
 * `device_id`：这台电脑的随机标识（断开连接也留着）。token 放 chrome.storage.session
 */

const KEY = "gdrive";
const FOLDER = "PDF-Reader Backups";
const KEEP = 10;
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
async function deviceId() {
  const { device_id: d } = await chrome.storage.local.get("device_id");
  if (d) return d;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ device_id: id });
  return id;
}

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const nameOf = (d) => `PDF-Reader-backup-${dayOf(d)}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;

/** 走一次 Google 授权；interactive=false 时不弹窗（静默续期），失败抛错 */
async function authorize(interactive, email) {
  if (!GOOGLE_CLIENT_ID) throw new Error(t("这个版本没有配置 Google 客户端 ID"));
  const redirect = chrome.identity.getRedirectURL("google");
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, response_type: "token", redirect_uri: redirect, scope: SCOPES,
    include_granted_scopes: "true", ...(email ? { login_hint: email } : {}), ...(interactive ? {} : { prompt: "none" }),
  });
  const back = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p}`, interactive });
  const q = new URLSearchParams(new URL(back).hash.replace(/^#/, ""));
  const token = q.get("access_token");
  if (!token) throw new Error(q.get("error") || t("没有拿到授权"));
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
    throw new Error(t("Google 授权过期了，请在「设置 → 数据」里重新连接"));
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
const json = async (res, what) => {
  if (!res.ok) throw new Error(t("{what}失败（{s}）", { what, s: res.status }));
  return res.json();
};

/** 备份文件夹：记着的 id 还在就用；否则找本插件建的同名文件夹；都没有就建一个 */
async function folder() {
  const s = await state();
  if (s?.folderId) {
    const r = await api(`/drive/v3/files/${s.folderId}?fields=id,trashed`);
    if (r.ok && !(await r.json()).trashed) return s.folderId;
  }
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = (await json(await api(`/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`), t("读取云端硬盘"))).files?.[0];
  const id = found?.id || (await json(await api(`/drive/v3/files?fields=id`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }),
  }), t("建备份文件夹"))).id;
  await patchState({ folderId: id });
  return id;
}

/** 云端的备份（新的在前）：[{ id, name, time, device, mine, kind, day, papers, anns }] */
async function listRaw() {
  const dir = await folder();
  const q = encodeURIComponent(`'${dir}' in parents and trashed=false`);
  const files = (await json(await api(`/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=100` +
    `&fields=files(id,name,modifiedTime,appProperties)`), t("读取备份列表"))).files || [];
  const me = await deviceId();
  return files.filter(f => /\.json$/i.test(f.name)).map(f => {
    const p = f.appProperties || {};
    return { id: f.id, name: f.name, time: f.modifiedTime, device: p.device || null, mine: p.device === me,
             kind: p.kind || "manual", day: p.day || null, papers: Number(p.papers) || 0, anns: Number(p.anns) || 0 };
  });
}

export async function listBackups() {
  try { return { ok: true, items: await listRaw() }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
}

/** 连接：弹 Google 授权窗口，记下账号；返回云端已有的备份（界面上让用户挑一份恢复） */
export async function connect() {
  const t = await authorize(true);
  const info = await (await fetch(`${API}/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${t}` } })).json().catch(() => ({}));
  await patchState({ email: info.email || "", needAuth: false, lastError: null, auto: (await state())?.auto ?? true });
  const items = await listRaw().catch(() => []);
  return { email: info.email || "", items };
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

/** multipart 上传（新建 POST / 更新 PATCH 都用它：元数据 + 内容一起） */
function multipart(meta, body) {
  const b = "pdfreader" + Math.random().toString(36).slice(2);
  return {
    headers: { "Content-Type": `multipart/related; boundary=${b}` },
    body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
          `--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`,
  };
}

/** 只留最近 KEEP 份：多的移进回收站（不是永久删） */
async function prune() {
  const items = await listRaw();
  for (const f of items.slice(KEEP)) {
    await api(`/drive/v3/files/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
  }
}

/** 备份一次。manual：新建一份；自动：今天这台电脑已有自动备份就更新那份，没有就新建 */
export async function backupNow({ manual = false } = {}) {
  try {
    const data = await buildBackup();
    const body = JSON.stringify(data);
    const st = stats(data.storage);
    const now = new Date();
    const dir = await folder();
    const me = await deviceId();
    const props = { app: "pdf-reader", device: me, day: dayOf(now), kind: manual ? "manual" : "auto", papers: String(st.papers), anns: String(st.anns) };
    const today = manual ? null : (await listRaw()).find(f => f.mine && f.kind === "auto" && f.day === props.day);
    const meta = { name: nameOf(now), mimeType: "application/json", appProperties: props,
                   description: t("PDF-Reader 插件的笔记备份（可在插件「设置 → 数据」里恢复）") };
    const r = today
      ? await api(`/upload/drive/v3/files/${today.id}?uploadType=multipart&fields=id`, { method: "PATCH", ...multipart(meta, body) })
      : await api(`/upload/drive/v3/files?uploadType=multipart&fields=id`, { method: "POST", ...multipart({ ...meta, parents: [dir] }, body) });
    if (!r.ok) throw new Error(t("上传失败（{s}）", { s: r.status }));
    await prune().catch(() => {});
    await patchState({ lastBackup: now.toISOString(), lastError: null, needAuth: false, lastStats: st });
    return { ok: true, ...st };
  } catch (e) {
    await patchState({ lastError: e.message || String(e) });
    return { ok: false, error: e.message || String(e) };
  }
}

/** 从某一份恢复。mode：replace 本机变成那份 / merge 合并（同一条留较新的） */
export async function restore(id, mode = "merge") {
  try {
    const data = await json(await api(`/drive/v3/files/${id}?alt=media`), t("下载备份"));
    const st = mode === "replace" ? await replaceWithBackup(data) : await importBackupData(data);
    return { ok: true, ...st };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** 删一份（移进云端硬盘回收站） */
export async function deleteBackup(id) {
  try {
    const r = await api(`/drive/v3/files/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
    if (!r.ok) throw new Error(t("删除失败（{s}）", { s: r.status }));
    return { ok: true };
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
