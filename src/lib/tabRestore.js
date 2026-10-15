/**
 * 插件更新（或在扩展页点刷新）时，浏览器会把这个插件自己的页面（阅读器标签）全部强制关掉，插件没法阻止，也收不到通知。
 * 补救：每个阅读器标签打开时把自己记下来（地址、窗口、位置、是不是当前标签），用户自己关掉的由 background 删掉记录；
 * 插件更新后重新启动（onInstalled: update）时，还留着的记录就是被浏览器关掉的那些 —— 按原样重新打开。
 * 阅读位置本来就记着（PdfViewer 的 rh_pos），重新打开回到原来那一页。
 *
 * 一个标签一个键（vt:<tabId>），几个标签同时写不会互相覆盖。浏览器重启时标签由浏览器自己恢复，旧记录清掉（onStartup）
 */

const PREFIX = "vt:";

/** 阅读器页面调用：登记自己；切到前台 / 后台时更新「是不是当前标签」和位置 */
export function registerViewerTab() {
  if (!chrome.tabs?.getCurrent) return;
  const save = () => chrome.tabs.getCurrent((t) => {
    if (!t) return;
    chrome.storage.local.set({
      [PREFIX + t.id]: { url: location.href, windowId: t.windowId, index: t.index, pinned: !!t.pinned, active: !document.hidden, t: Date.now() },
    });
  });
  save();
  document.addEventListener("visibilitychange", save);
}

/** background：标签被用户关掉 / 离开阅读器 */
export const forgetViewerTab = (tabId) => chrome.storage.local.remove(PREFIX + tabId).catch(() => {});

async function takeAll() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.map(k => all[k]).filter(v => v?.url);
}

/** background，插件更新后：把被关掉的阅读器标签按原来的窗口 / 位置重新打开，原来在前台的那个仍在前台 */
export async function reopenViewerTabs() {
  const list = (await takeAll()).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const fronts = [];
  for (const v of list) {
    let tab = null;
    try { tab = await chrome.tabs.create({ windowId: v.windowId, index: v.index, url: v.url, active: false, pinned: v.pinned }); }
    catch { tab = await chrome.tabs.create({ url: v.url, active: false }).catch(() => null); }    // 原来的窗口没了
    if (tab && v.active) fronts.push(tab.id);
  }
  for (const id of fronts) await chrome.tabs.update(id, { active: true }).catch(() => {});
}

/** background，浏览器刚启动：标签由浏览器自己恢复（新的 tabId，会重新登记），旧记录作废 */
export const clearViewerTabs = () => takeAll();
