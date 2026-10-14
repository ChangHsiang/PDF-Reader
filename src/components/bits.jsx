import { useEffect, useState } from "react";
import { profileUrl } from "../lib/config";

/* 小零件：头像、相对时间、带公式的文本、用户名链接。
   都活在固定深色底上，白色一律写死 #fff / #ffffffXX */

const PALETTE = [
  ["#1b4f72", "#2686b9"], ["#0e6655", "#45b39d"], ["#7d3c98", "#bb8fce"],
  ["#a04000", "#e59866"], ["#1a5276", "#5dade2"], ["#922b21", "#ec7063"],
];
const colorOf = (name = "") => PALETTE[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % PALETTE.length];
const initials = (name = "") => {
  const t = name.trim();
  if (!t) return "?";
  if (/[一-鿿]/.test(t[0])) return t.slice(-2);
  return t.split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
};

export function Avatar({ name, url, size = 28 }) {
  if (url) {
    return <img src={url} alt={name} loading="lazy" className="rounded-full object-cover shrink-0 block"
      style={{ width: size, height: size }} />;
  }
  const [a, b] = colorOf(name);
  return (
    <div className="rounded-full flex items-center justify-center text-[#fff] font-bold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(135deg, ${a}, ${b})` }}>
      {initials(name)}
    </div>
  );
}

/** 名字 → 网站个人主页（新标签页）。网站上的资料卡这里没有，点过去看 */
export function UserLink({ user, className = "", children }) {
  const href = profileUrl(user);
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`no-underline ${className}`}
      onClick={e => e.stopPropagation()}>{children}</a>
  );
}

function timeAgo(ts) {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const TimeText = ({ ts, className = "" }) => ts ? (
  <span className={`cursor-default ${className}`} title={new Date(ts).toLocaleString()}>{timeAgo(ts)}</span>
) : null;

/* ── 带 LaTeX 的文本 ─────────────────────────────────────────────────
   $…$ 行内、$$…$$ 块级；katex 按需加载（绝大多数批注没有公式）。
   网址变链接，@用户名 链到网站主页 */
let katexPromise = null;
const loadKatex = () => {
  katexPromise ||= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([m]) => m.default || m)
    .catch((e) => { katexPromise = null; throw e; });
  return katexPromise;
};
const MATH_RE = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;
const LINK_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)）】」"']|@[A-Za-z0-9_]{2,30})/g;

function plain(text, key) {
  return text.split(LINK_RE).map((seg, i) => {
    if (/^https?:\/\//.test(seg)) {
      return <a key={`${key}-${i}`} href={seg} target="_blank" rel="noopener noreferrer"
        className="text-[#7ec8e3] underline break-all" onClick={e => e.stopPropagation()}>{seg}</a>;
    }
    if (/^@[A-Za-z0-9_]{2,30}$/.test(seg)) {
      return <UserLink key={`${key}-${i}`} user={{ username: seg.slice(1) }}
        className="text-[#7ec8e3] hover:underline">{seg}</UserLink>;
    }
    return seg;
  });
}

export function MathText({ text }) {
  const hasMath = MATH_RE.test(text || "");
  MATH_RE.lastIndex = 0;
  const [katex, setKatex] = useState(null);
  useEffect(() => {
    if (hasMath && !katex) loadKatex().then(k => setKatex(() => k)).catch(() => {});
  }, [hasMath, katex]);
  if (!text) return null;
  if (!hasMath) return <>{plain(text, "t")}</>;
  return (
    <>
      {text.split(MATH_RE).map((seg, i) => {
        const block = seg.startsWith("$$") && seg.endsWith("$$") && seg.length > 4;
        const inline = !block && seg.startsWith("$") && seg.endsWith("$") && seg.length > 2;
        if (!block && !inline) return <span key={i}>{plain(seg, i)}</span>;
        const src = block ? seg.slice(2, -2) : seg.slice(1, -1);
        if (!katex) return <span key={i}>{seg}</span>;
        const html = katex.renderToString(src, { displayMode: block, throwOnError: false, output: "html" });
        return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </>
  );
}

export const Icon = ({ d, size = 15 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
