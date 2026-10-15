import { useEffect, useState } from "react";

/**
 * 新版本检测。插件是「加载已解压的扩展程序」装的：浏览器不会自动更新它，插件也不能改写自己的文件 ——
 * 能做的只有查到新版本后提示用户去下载（上架商店后才能真正自动更新）。
 *
 * 查 GitHub 的最新 Release（GitHub API 允许跨域，不用多申请权限；不登录每个 IP 每小时 60 次），一天最多查一次。
 * chrome.storage.local：
 * - update：{ checkedAt, latest: { version, url（Release 页）, zip（安装包下载地址）, notes（更新说明）, publishedAt } }
 * - update_ignored：用户点了「忽略此版本」的那个版本号。只忽略这一个，再出更新的版本照样提示
 */

export const REPO = "ChangHsiang/PDF-Reader";
const DAY = 24 * 3600 * 1000;

export const currentVersion = () => chrome.runtime.getManifest().version;

const parse = (v) => String(v || "").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
/** a 比 b 新？按 x.y.z 逐位比 */
export const isNewer = (a, b) => {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
};

export async function checkUpdate({ force = false } = {}) {
  const { update } = await chrome.storage.local.get("update");
  if (!force && update?.latest && Date.now() - update.checkedAt < DAY) return update.latest;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(r.status === 403 ? "GitHub 查询太频繁，稍后再试" : `GitHub 返回 ${r.status}`);
  const d = await r.json();
  const latest = {
    version: String(d.tag_name || "").replace(/^v/i, ""),
    url: d.html_url,
    zip: d.assets?.find(a => /\.zip$/i.test(a.name))?.browser_download_url || d.html_url,
    notes: String(d.body || "").trim(),
    publishedAt: d.published_at,
  };
  await chrome.storage.local.set({ update: { checkedAt: Date.now(), latest } });
  return latest;
}

/**
 * 给界面用：{ current, latest, hasNew（比当前新）, show（有新版本且没被忽略）, ignored, checking, error, check(), ignore() }。
 * auto：挂载时查一次（一天内查过就直接用缓存）。别的页面查到 / 忽略了，这里跟着变
 */
export function useUpdate(auto = true) {
  const [st, setSt] = useState({ latest: null, ignored: null, checking: false, error: null });
  const load = async (force) => {
    setSt(s => ({ ...s, checking: true, error: null }));
    try {
      const latest = await checkUpdate({ force });
      const { update_ignored } = await chrome.storage.local.get("update_ignored");
      setSt({ latest, ignored: update_ignored || null, checking: false, error: null });
    } catch (e) {
      setSt(s => ({ ...s, checking: false, error: e.message || "检查失败" }));
    }
  };
  useEffect(() => {
    if (auto) load(false);
    const onChange = (c, area) => {
      if (area !== "local" || !("update" in c || "update_ignored" in c)) return;
      chrome.storage.local.get(["update", "update_ignored"]).then(v =>
        setSt(s => ({ ...s, latest: v.update?.latest || s.latest, ignored: v.update_ignored || null })));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const current = currentVersion();
  const hasNew = !!st.latest?.version && isNewer(st.latest.version, current);
  return {
    ...st, current, hasNew,
    show: hasNew && st.ignored !== st.latest.version,
    check: () => load(true),
    ignore: () => st.latest && chrome.storage.local.set({ update_ignored: st.latest.version }),
    unignore: () => chrome.storage.local.remove("update_ignored"),
  };
}

/** 打开安装包下载 / Release 页 / 扩展管理页（Edge 里 chrome://extensions 会自动转到 edge://extensions） */
export const openTab = (url) => chrome.tabs.create({ url });
export const openExtensionsPage = () => openTab(`chrome://extensions/?id=${chrome.runtime.id}`);
