import { getSettings } from "./settings";
import { t } from "./i18n";

/**
 * 划词翻译。服务按设置选（见 lib/settings）：
 * - google：Google 翻译的公开接口
 * - bing：必应翻译（网页版用的接口，见 viaBing）
 * - custom：用户自己填的 OpenAI 兼容接口（DeepSeek / OpenAI / 通义 / Kimi …）
 *
 * 译成哪种语言：设置里选（LANGS 里的任一种，默认简体中文）。
 */

/** 能译成的语言。code 是设置里存的值；google / bing 是两家各自的语言代码；name 给大模型的提示词用 */
export const LANGS = [
  { code: "zh", label: "简体中文", google: "zh-CN", bing: "zh-Hans", name: "Simplified Chinese" },   // i18n-ignore（语言用自己的名字）
  { code: "zh-TW", label: "繁體中文", google: "zh-TW", bing: "zh-Hant", name: "Traditional Chinese" },   // i18n-ignore
  { code: "en", label: "English", google: "en", bing: "en", name: "English" },
  { code: "ja", label: "日本語", google: "ja", bing: "ja", name: "Japanese" },   // i18n-ignore
  { code: "ko", label: "한국어", google: "ko", bing: "ko", name: "Korean" },
  { code: "fr", label: "Français", google: "fr", bing: "fr", name: "French" },
  { code: "de", label: "Deutsch", google: "de", bing: "de", name: "German" },
  { code: "es", label: "Español", google: "es", bing: "es", name: "Spanish" },
  { code: "pt", label: "Português", google: "pt", bing: "pt", name: "Portuguese" },
  { code: "it", label: "Italiano", google: "it", bing: "it", name: "Italian" },
  { code: "ru", label: "Русский", google: "ru", bing: "ru", name: "Russian" },
  { code: "ar", label: "العربية", google: "ar", bing: "ar", name: "Arabic" },
  { code: "vi", label: "Tiếng Việt", google: "vi", bing: "vi", name: "Vietnamese" },
];
const langOf = (code) => LANGS.find(l => l.code === code) || LANGS[0];

const cache = new Map();

/** PDF 选区里行尾断字（"suffi- ciently"）接回去，多余空白压掉 */
export const cleanForTranslate = (s) => String(s || "")
  .replace(/(\p{L})-\s+(\p{Ll})/gu, "$1$2")
  .replace(/\s+/g, " ")
  .trim();

const systemPrompt = (target) =>
  `You are a professional translation engine. Translate the user's text into ${langOf(target).name}. ` +
  `Output ONLY the translation with no quotes or explanations. ` +
  `Preserve line breaks, LaTeX math ($...$ and $$...$$), URLs and citation markers like [12] exactly as-is. ` +
  `The text comes from an academic paper; keep technical terms accurate.`;

async function viaGoogle(text, target) {
  const tl = langOf(target).google;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text.slice(0, 4500))}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(t("Google 翻译返回 {s}", { s: r.status }));
  const d = await r.json();
  const out = (d?.[0] || []).map(x => x?.[0] || "").join("");
  if (!out) throw new Error(t("没有拿到译文"));
  return { text: out, engine: t("Google 翻译") };
}

/**
 * 必应翻译。微软以前给 Edge 用的免 Key 接口（edge.microsoft.com/translate/auth 拿令牌）2025 年起返回 404，
 * 现在走 bing.com/translator 网页自己用的接口：先 GET 网页，从里面抠出 IG 和 params_AbusePreventionHelper
 * 里的 key / token（有效期 1 小时），再 POST /ttranslatev3。
 * - 国内访问 www.bing.com 会跳到 cn.bing.com：后面的请求发到跳转后的那个域名，令牌是那边发的
 * - 令牌 50 分钟内复用；出错就丢掉，下次重新取
 * - 这不是公开 API，哪天网页改版可能就不能用了 —— 报错时提示换一个服务
 */
let bingSession = null;
async function bingToken() {
  if (bingSession && Date.now() < bingSession.exp) return bingSession;
  const r = await fetch("https://www.bing.com/translator", { credentials: "include" });
  if (!r.ok) throw new Error(t("必应翻译网页打不开（{s}）", { s: r.status }));
  const html = await r.text();
  const ig = html.match(/IG:"([0-9A-F]+)"/)?.[1];
  const ap = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)"/);
  if (!ig || !ap) throw new Error(t("必应翻译网页改版了，暂时用不了（换 Google 或其他服务试试）"));
  // iid 是网页上翻译框的固定编号
  bingSession = { origin: new URL(r.url).origin, ig, iid: "translator.5024", key: ap[1], token: ap[2], exp: Date.now() + 50 * 60e3 };
  return bingSession;
}

async function viaBing(text, target) {
  try {
    const t = await bingToken();
    const r = await fetch(`${t.origin}/ttranslatev3?isVertical=1&IG=${t.ig}&IID=${t.iid}`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ fromLang: "auto-detect", to: langOf(target).bing, text: text.slice(0, 1000), token: t.token, key: t.key }),
    });
    if (!r.ok) throw new Error(t("必应翻译返回 {s}", { s: r.status }));
    const d = await r.json().catch(() => null);
    const out = Array.isArray(d) ? d[0]?.translations?.[0]?.text : null;
    if (!out) throw new Error(d?.ShowCaptcha ? t("必应翻译要求人机验证，暂时用不了（换 Google 或其他服务试试）") : t("必应翻译没有返回译文"));
    return { text: out, engine: t("必应翻译") };
  } catch (e) {
    bingSession = null;
    throw e;
  }
}

/** 填的地址可以是 `https://api.deepseek.com/v1`，也可以已经带着 /chat/completions */
export const chatUrl = (baseUrl) => {
  const b = String(baseUrl || "").trim().replace(/\/+$/, "");
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
};

export async function viaCustom(text, target, api) {
  if (!api?.baseUrl || !api?.model) throw new Error(t("自定义翻译接口还没填完整（设置里填地址和模型）"));
  let r;
  try {
    r = await fetch(chatUrl(api.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(api.apiKey ? { Authorization: `Bearer ${api.apiKey}` } : {}) },
      body: JSON.stringify({
        model: api.model, temperature: 0.3, stream: false,
        messages: [{ role: "system", content: systemPrompt(target) }, { role: "user", content: text }],
      }),
    });
  } catch (e) {
    throw new Error(t("连不上自定义接口：{err}（地址对吗？有没有授权访问这个网站？）", { err: e.message }));
  }
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 160);
    throw new Error(t("自定义接口返回 {s}", { s: r.status }) + (detail ? `: ${detail}` : ""));
  }
  const d = await r.json().catch(() => null);
  const out = d?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error(t("自定义接口没有返回译文"));
  return { text: out, engine: api.model };
}

export async function translate(raw) {
  const text = cleanForTranslate(raw);
  if (!text) throw new Error(t("没有可翻译的文字"));
  const s = await getSettings();
  const target = langOf(s.translateTarget).code;
  const engine = s.translateEngine;
  const key = `${engine}:${engine === "custom" ? `${s.customApi.baseUrl}|${s.customApi.model}` : ""}:${target}:${text}`;
  if (!cache.has(key)) {
    const job = (async () => {
      if (engine === "custom") return viaCustom(text, target, s.customApi);
      if (engine === "google") return viaGoogle(text, target);
      if (engine === "bing") return viaBing(text, target);
      return viaGoogle(text, target);
    })();
    job.catch(() => cache.delete(key));     // 失败别缓存，下次还能重试
    cache.set(key, job);
  }
  return cache.get(key);
}
