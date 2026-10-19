import EN from "../locales/en";

/**
 * 界面语言（中文 / 英文）。代码里的文案照旧写中文，外面套一层 t()：
 *   t("删除")                       → 英文界面查 locales/en.js 里的对照，查不到就原样显示中文
 *   t("第 {n} 页", { n: 3 })        → {名字} 占位，中英文都替换
 * 同一句中文在不同地方要译得不一样时，键写成「中文@@用途」（如 "改@@动词"），中文界面显示 @@ 前面的部分（单个 @ 是正文里的 @用户名，不算）。
 *
 * 选哪种语言：设置里的 lang（auto / zh / en），auto 跟浏览器（zh 开头的用中文，其余英文）。
 * - 插件页面（阅读器、弹窗）是同一个源，共用 localStorage 的 rh_lang —— 同步读，第一次渲染就是对的语言
 * - background（service worker）没有 localStorage：启动时从 chrome.storage 的 settings.lang 读，变了跟着改
 * 改语言后阅读器整页刷新（见设置弹窗），不做运行时热切换
 */

const LS_KEY = "rh_lang";

const browserLang = () => {
  const ui = (globalThis.chrome?.i18n?.getUILanguage?.() || globalThis.navigator?.language || "zh");
  return /^zh/i.test(ui) ? "zh" : "en";
};
export const resolveLang = (pref) => (pref === "zh" || pref === "en" ? pref : browserLang());

let LANG = (() => {
  try { return resolveLang(localStorage.getItem(LS_KEY)); }
  catch { return browserLang(); }            // service worker：没有 localStorage，下面再从 storage 读
})();

if (typeof localStorage === "undefined" && globalThis.chrome?.storage) {
  const apply = (s) => { LANG = resolveLang(s?.lang); };
  chrome.storage.local.get("settings").then(r => apply(r.settings)).catch(() => {});
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.settings) apply(c.settings.newValue); });
}

export const lang = () => LANG;
export const isEn = () => LANG === "en";

/** 存语言偏好（auto / zh / en）到 localStorage，插件各页面下次加载就按它来 */
export function rememberLang(pref) {
  try { localStorage.setItem(LS_KEY, pref || "auto"); } catch { /* 隐私模式 */ }
}

export function t(s, vars) {
  let r = LANG === "en" ? (EN[s] ?? s) : s;
  const at = r.indexOf("@@");
  if (at > 0 && r === s) r = s.slice(0, at);                 // 中文界面（或没译）：去掉「@@用途」
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return r;
}
