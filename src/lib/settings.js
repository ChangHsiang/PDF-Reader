import { useEffect, useState } from "react";

/**
 * 插件设置，存 chrome.storage.local 的 `settings` 键（弹窗、阅读器、background 共用；
 * background 只看 intercept）。
 *
 * - intercept：打开 arXiv PDF 时换成插件阅读器
 * - eqCopy：公式编号旁显示「复制 LaTeX」按钮
 * - showLinks：所有链接下面画淡色虚线（作者没给链接上色时也看得出来）
 * - paper：页面颜色（护眼）white / green / sepia / gray / dark，见 PAPERS
 * - autoTranslate：选中文字后直接弹译文
 * - translateTarget：lib/translate 里 LANGS 的任一种语言代码
 * - translateEngine：google / bing / custom
 * - customApi：{ baseUrl, apiKey, model } —— 任何兼容 OpenAI chat/completions 的服务。
 *   Key 只存在本机这个浏览器里，不上传
 */

export const DEFAULT_SETTINGS = {
  intercept: true,
  eqCopy: true,
  showLinks: false,
  paper: "white",
  autoTranslate: false,
  translateTarget: "zh",
  translateEngine: "google",
  customApi: { baseUrl: "", apiKey: "", model: "" },
};

/** 页面颜色（护眼模式）。前四种是在画布上叠一层「正片叠底」的纸色：白底变成这个颜色，黑字还是黑的；
    夜间是把画布反相再转回色相（深底浅字，图的颜色基本保持）。具体画法见 index.css 的 .rh-paper-* */
export const PAPERS = [
  { key: "white", label: "白色", swatch: "#ffffff" },
  { key: "green", label: "豆沙绿", swatch: "#cce8cf" },
  { key: "sepia", label: "米黄", swatch: "#f4ecd8" },
  { key: "gray", label: "浅灰", swatch: "#e4e4e4" },
  { key: "dark", label: "夜间", swatch: "#2b2b2b" },
];

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}),
              customApi: { ...DEFAULT_SETTINGS.customApi, ...(settings?.customApi || {}) } };
  // 以前有「自动」目标语言、「默认」/ 网站 DeepSeek 翻译服务，存过的换成现在的默认值
  if (s.translateTarget === "auto") s.translateTarget = DEFAULT_SETTINGS.translateTarget;
  if (s.translateEngine === "auto" || s.translateEngine === "site") s.translateEngine = DEFAULT_SETTINGS.translateEngine;
  return s;
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function useSettings() {
  const [s, setS] = useState(DEFAULT_SETTINGS);
  useEffect(() => {
    let alive = true;
    getSettings().then(v => { if (alive) setS(v); });
    const onChange = (changes, area) => {
      if (area === "local" && "settings" in changes) getSettings().then(v => { if (alive) setS(v); });
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => { alive = false; chrome.storage.onChanged.removeListener(onChange); };
  }, []);
  return s;
}
