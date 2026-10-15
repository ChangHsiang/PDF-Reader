import { signIn, signOut, getToken, getSession } from "./lib/auth";
import { countComments } from "./lib/comments";
import { forgetViewerTab, reopenViewerTabs, clearViewerTabs } from "./lib/tabRestore";

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

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RAW_BASE + tabId] }).catch(() => {});
  forgetViewerTab(tabId);            // 用户自己关的：不用在更新后重新打开
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { intercept: true, ...(settings || {}) };
}

/* 重定向规则用动态规则：静态规则的 regexSubstitution 里写不了扩展自己的 id。
   只拦 main_frame —— 阅读器自己 fetch PDF 是 xmlhttprequest 类型，不会被绕回来。

   「用浏览器自带阅读器打开」不能靠在链接上加参数放行（试过 `?rh_raw=1`）：
   arXiv 会 301 到去掉查询串的地址，第二跳又被拦回来。改成给**那个标签页**
   加一条会话级放行规则（见 viewer:raw），标签页关了就删 */
async function applyRules() {
  const { intercept } = await getSettings();
  const addRules = intercept ? [
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
});

const handlers = {
  "auth:signIn": (m) => signIn(m.email, m.password),
  "auth:signOut": () => signOut(),
  "auth:getToken": (m) => getToken({ force: !!m.force }),
  "auth:session": () => getSession(),
  "comments:count": (m) => countComments(m.paperKey),
  "viewer:raw": async (m, sender) => {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RAW_BASE + tabId],
      addRules: [{
        id: RAW_BASE + tabId, priority: 2,
        action: { type: "allow" },
        condition: { tabIds: [tabId], resourceTypes: ["main_frame"], requestDomains: ["arxiv.org"] },
      }],
    });
    forgetViewerTab(tabId);            // 这个标签离开阅读器了
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
