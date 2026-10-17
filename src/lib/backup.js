/**
 * 备份 / 恢复（设置 → 数据）。笔记、标注都存在这个浏览器的插件存储里：在扩展页点「移除」，浏览器会把它们**全部删掉**，
 * 插件管不了（升级只要覆盖文件再点刷新，数据不动）。所以给一个导出成文件、再导入回来的办法。
 *
 * 备份文件（JSON）：{ app: "PDF-Reader", format: 1, version, exportedAt, storage: {...}, local: {...} }
 * - storage：chrome.storage.local 里的笔记（paper:*）、设置（settings）、「他人」里隐藏掉的标注（others_hidden）
 * - local：阅读器页面 localStorage 里的 rh_*（阅读位置、分屏 / 工具条 / 画笔样式这些偏好）
 * 不放进去的：登录凭证（auth）、自定义翻译接口的 API Key —— 备份文件可能随手放在哪儿，别带着密钥；
 * 临时的东西：新版本检查的缓存（update*）、更新时重开标签的登记（vt:*）
 *
 * 导入是**合并**不是覆盖：同一条标注两边都有，留 updated_at 新的那份（删除的墓碑也算一份）；
 * 设置用备份里的（API Key 保留现在的）；偏好只补现在没有的，阅读位置按时间留新的
 */
// 版本号直接读 manifest（不引 lib/update：那边带着 React，后台也要用这个文件）
const currentVersion = () => chrome.runtime.getManifest().version;

const APP = "PDF-Reader";
const FORMAT = 1;
const PAPER = "paper:";

/** 备份内容（导出成文件、存到 Google 云端硬盘都用这一份）。后台没有 localStorage：那时 local 是空的，只少了几项偏好 */
export async function buildBackup() {
  const all = await chrome.storage.local.get(null);
  const storage = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(PAPER) || k === "others_hidden") storage[k] = v;      // 笔记 + 「他人」里隐藏掉的
  }
  if (all.settings) {
    const { customApi, ...rest } = all.settings;
    storage.settings = { ...rest, ...(customApi ? { customApi: { ...customApi, apiKey: "" } } : {}) };
  }
  const local = {};
  try {
    for (let i = 0; i < (globalThis.localStorage?.length || 0); i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("rh_")) local[k] = localStorage.getItem(k);
    }
  } catch { /* 读不了就算了 */ }
  return { app: APP, format: FORMAT, version: currentVersion(), exportedAt: new Date().toISOString(), storage, local };
}

export async function exportBackup() {
  const data = await buildBackup();
  const { storage } = data;
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  const name = `PDF-Reader-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return stats(storage);
}

/** 统计：几篇论文、几条标注（不算删除的墓碑） */
export function stats(storage) {
  let papers = 0, anns = 0;
  for (const [k, v] of Object.entries(storage)) {
    if (!k.startsWith(PAPER)) continue;
    const n = (v?.anns || []).filter(a => !a.deleted).length;
    if (n || Object.keys(v?.notes || {}).length) papers++;
    anns += n;
  }
  return { papers, anns };
}

export async function currentStats() {
  return stats(await chrome.storage.local.get(null));
}

const newer = (a, b) => String(a?.updated_at || a?.created_at || "") >= String(b?.updated_at || b?.created_at || "");

export async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error("不是有效的备份文件（读不出 JSON）"); }
  return importBackupData(data);
}

/** 把一份备份合并进来（规则见文件头）。云端硬盘恢复也走这里 */
export async function importBackupData(data) {
  if (data?.app !== APP || !data.storage) throw new Error("不是 PDF-Reader 的备份文件");
  if (data.format > FORMAT) throw new Error("这个备份是更新的版本导出的，请先把插件升级到最新版");

  const cur = await chrome.storage.local.get(null);
  const out = {};
  for (const [k, v] of Object.entries(data.storage)) {
    if (!k.startsWith(PAPER) || !v) continue;
    const mine = cur[k] || { notes: {}, anns: [] };
    const notes = { ...(mine.notes || {}) };
    for (const [pk, n] of Object.entries(v.notes || {})) {
      if (!notes[pk] || newer(n, notes[pk])) notes[pk] = n;
    }
    const byId = new Map((mine.anns || []).map(a => [a.id, a]));
    for (const a of v.anns || []) {
      const had = byId.get(a.id);
      if (!had || newer(a, had)) byId.set(a.id, a);
    }
    out[k] = { notes, anns: [...byId.values()] };
  }
  if (Array.isArray(data.storage.others_hidden)) {
    out.others_hidden = [...new Set([...(cur.others_hidden || []), ...data.storage.others_hidden])].slice(-5000);
  }
  if (data.storage.settings) {
    const s = data.storage.settings, c = cur.settings || {};
    out.settings = { ...c, ...s, customApi: { ...(s.customApi || {}), apiKey: c.customApi?.apiKey || "" } };
  }
  await chrome.storage.local.set(out);

  try {
    if (!globalThis.localStorage) throw 0;           // 后台里没有 localStorage：偏好跳过
    for (const [k, v] of Object.entries(data.local || {})) {
      if (!k.startsWith("rh_") || typeof v !== "string") continue;
      if (k === "rh_pos") {
        // 阅读位置：两边合并，同一篇留时间新的
        const a = JSON.parse(localStorage.getItem(k) || "{}"), b = JSON.parse(v || "{}");
        for (const [p, pos] of Object.entries(b)) if (!a[p] || (pos?.t || 0) > (a[p]?.t || 0)) a[p] = pos;
        localStorage.setItem(k, JSON.stringify(a));
      } else if (localStorage.getItem(k) == null) localStorage.setItem(k, v);
    }
  } catch { /* 偏好恢复不了不要紧 */ }
  return currentStats();               // 合并之后本机一共多少（界面上说「现在共 X 篇」）
}
