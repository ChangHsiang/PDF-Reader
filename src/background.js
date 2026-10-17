import { signIn, signOut, getToken, getSession, signInWithGoogle } from "./lib/auth";
import { countComments } from "./lib/comments";
import { forgetViewerTab, reopenViewerTabs, clearViewerTabs } from "./lib/tabRestore";
import * as gdrive from "./lib/gdrive";

/**
 * Service worker：
 * 1. 接管 arXiv PDF —— 打开 arxiv.org/pdf/… 时重定向到扩展自己的阅读器
 * 2. 登录态的唯一持有者（见 lib/auth.js 文件头：refresh_token 轮换只能在一处做）
 * 3. 给 arXiv 摘要页上的内容脚本查评论数、开阅读器
 * 4. 插件更新后把被浏览器关掉的阅读器标签重新打开（见 lib/tabRestore）
 */

const VIEWER = chrome.runtime.getURL("viewer.html");
const RULE_REDIRECT = 1;
const RAW_BASE = 100000;        // 会话级放行规则：id = RAW_BASE + tabId

/* 本地 PDF（file://…pdf）：转到阅读器。declarativeNetRequest 管不了 file:// 网址，所以看标签页的地址变化
   （要在扩展管理页给插件打开「允许访问文件网址」，否则这里根本看不到 file:// 的地址）。
   「用浏览器自带阅读器打开」的那个标签放行一次（rawFileTabs） */
const rawFileTabs = new Set();
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const u = info.url;
  if (!u || !/^file:\/\/.+\.pdf(?:[?#].*)?$/i.test(u)) return;
  if (rawFileTabs.has(tabId)) { rawFileTabs.delete(tabId); return; }
  if (!(await getSettings()).interceptLocal) return;
  chrome.tabs.update(tabId, { url: `${VIEWER}?url=${encodeURIComponent(u)}` }).catch(() => {});
});

/* 其他网站的 PDF（设置「其他网站的 PDF 也用」，要可选权限「访问所有网站」）：declarativeNetRequest 只能按网址拦，
   期刊的 PDF 地址多半不以 .pdf 结尾 —— 看响应头：主框架、2xx、Content-Type 是 PDF、不是「下载附件」，就把这个标签转到阅读器。
   webRequest 只观察不拦（MV3 不让阻塞），浏览器自带阅读器会先闪一下。没给权限时这个事件根本不会触发。
   arXiv 归上面的重定向规则管；「用浏览器自带阅读器打开」的标签放行一次（rawWebTabs） */
const rawWebTabs = new Set();
chrome.webRequest?.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode < 200 || d.statusCode >= 300 || /^https?:\/\/([a-z]+\.)?arxiv\.org\//i.test(d.url)) return;
  const h = (n) => d.responseHeaders?.find(x => x.name.toLowerCase() === n)?.value || "";
  const type = h("content-type").toLowerCase();
  const isPdf = type.includes("application/pdf") || (type.includes("octet-stream") && /\.pdf(?:[?#]|$)/i.test(d.url));
  if (!isPdf || /attachment/i.test(h("content-disposition"))) return;
  if (rawWebTabs.has(d.tabId)) { rawWebTabs.delete(d.tabId); return; }
  getSettings().then((st) => {
    if (!st.interceptOnline) return;
    chrome.tabs.update(d.tabId, { url: `${VIEWER}?url=${encodeURIComponent(d.url)}` }).catch(() => {});
  });
}, { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }, ["responseHeaders"]);

chrome.tabs.onRemoved.addListener((tabId) => {
  rawWebTabs.delete(tabId);
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RAW_BASE + tabId] }).catch(() => {});
  forgetViewerTab(tabId);            // 用户自己关的：不用在更新后重新打开
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  // 在线 / 本地两个开关；老的 intercept（一个开关管两样）迁过来（同 lib/settings 的 getSettings，这里不能引带 React 的那个文件）
  const old = settings?.intercept !== false;
  return { ...(settings || {}), interceptOnline: settings?.interceptOnline ?? old, interceptLocal: settings?.interceptLocal ?? old };
}

/* 重定向规则用动态规则：静态规则的 regexSubstitution 里写不了扩展自己的 id。
   只拦 main_frame —— 阅读器自己 fetch PDF 是 xmlhttprequest 类型，不会被绕回来。

   「用浏览器自带阅读器打开」不能靠在链接上加参数放行（试过 `?rh_raw=1`）：
   arXiv 会 301 到去掉查询串的地址，第二跳又被拦回来。改成给**那个标签页**
   加一条会话级放行规则（见 viewer:raw），标签页关了就删 */
async function applyRules() {
  const { interceptOnline } = await getSettings();
  const addRules = interceptOnline ? [
    {
      id: RULE_REDIRECT, priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: `${VIEWER}?url=\\0` } },
      condition: {
        regexFilter: "^https://(www\\.|export\\.)?arxiv\\.org/pdf/[^?#]+",
        resourceTypes: ["main_frame"],
      },
    },
  ] : [];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_REDIRECT],
    addRules,
  });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  applyRules();
  if (reason === "update") reopenViewerTabs();       // 更新 / 在扩展页点刷新：浏览器刚把阅读器标签全关了
});
chrome.runtime.onStartup.addListener(() => { applyRules(); clearViewerTabs(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "settings" in changes) applyRules();
  // 笔记变了：开着「自动备份到 Google 云端硬盘」就排一次（攒 2 分钟）
  if (area === "local" && Object.keys(changes).some(k => k.startsWith("paper:"))) gdrive.scheduleBackup().catch(() => {});
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === gdrive.ALARM) gdrive.backupNow(); });

const handlers = {
  "auth:signIn": (m) => signIn(m.email, m.password),
  "auth:signOut": () => signOut(),
  "auth:google": () => signInWithGoogle(),
  "auth:getToken": (m) => getToken({ force: !!m.force }),
  "auth:session": () => getSession(),
  "comments:count": (m) => countComments(m.paperKey),
  "gdrive:connect": () => gdrive.connect(),
  "gdrive:disconnect": () => gdrive.disconnect(),
  "gdrive:backup": () => gdrive.backupNow(),
  "gdrive:restore": () => gdrive.restore(),
  "gdrive:auto": (m) => gdrive.setAuto(m.on),
  /* 「用浏览器自带的阅读器打开」：在阅读器右边开一个新标签（阅读器留着），先开空白页拿到标签号，
     给它加上放行，再让它去原文件地址（不然又被转回阅读器） */
  "viewer:raw": async (m, sender) => {
    const tab = await chrome.tabs.create({ url: "about:blank", index: sender.tab ? sender.tab.index + 1 : undefined });
    const tabId = tab.id;
    if (/^file:/i.test(m.url || "")) {                // 本地文件：放行这个标签这一次
      rawFileTabs.add(tabId);
      await chrome.tabs.update(tabId, { url: m.url });
      return;
    }
    if (!/arxiv\.org\//i.test(m.url || "")) {           // 其他网站的 PDF：放行这个标签一次（见上面的 webRequest）
      rawWebTabs.add(tabId);
      await chrome.tabs.update(tabId, { url: m.url });
      return;
    }
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RAW_BASE + tabId],
      addRules: [{
        id: RAW_BASE + tabId, priority: 2,
        action: { type: "allow" },
        condition: { tabIds: [tabId], resourceTypes: ["main_frame"], requestDomains: ["arxiv.org"] },
      }],
    });
    await chrome.tabs.update(tabId, { url: m.url });
  },
  "viewer:open": async (m, sender) => {
    const url = `${VIEWER}?url=${encodeURIComponent(m.url)}${m.panel ? `&panel=${m.panel}` : ""}`;
    await chrome.tabs.create({ url, index: sender.tab ? sender.tab.index + 1 : undefined });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg, sender)).then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;   // 异步回复
});
