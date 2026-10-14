import { useEffect, useState } from "react";

/**
 * 插件设置，存 chrome.storage.local 的 `settings` 键（弹窗、阅读器、background 共用；
 * background 只看 intercept）。
 *
 * - intercept：打开 arXiv PDF 时换成插件阅读器
 * - eqCopy：公式编号旁显示「复制 LaTeX」按钮
 * - autoTranslate：选中文字后直接弹译文
 * - translateTarget：auto（外文→中文、中文→英文）/ lib/translate 里 LANGS 的任一种语言代码
 * - translateEngine：auto（网站 DeepSeek 代理，没开通就 Google）/ google / bing / custom
 * - customApi：{ baseUrl, apiKey, model } —— 任何兼容 OpenAI chat/completions 的服务。
 *   Key 只存在本机这个浏览器里，不上传
 */

export const DEFAULT_SETTINGS = {
  intercept: true,
  eqCopy: true,
  autoTranslate: false,
  translateTarget: "auto",
  translateEngine: "auto",
  customApi: { baseUrl: "", apiKey: "", model: "" },
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}),
           customApi: { ...DEFAULT_SETTINGS.customApi, ...(settings?.customApi || {}) } };
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
