import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { citeData, FORMATS, EXPORTS, exportText } from "../lib/cite";

/**
 * 「引用」对话框（参照 Google 学术）：三种格式各一行，点一行就复制；
 * 底下四颗导出按钮把对应格式复制到剪贴板（不下载文件：粘进 .bib / 文献管理软件更顺手）。
 *
 * portal 到 body + fixed：卡片自己可能带 transform（放在链接上方时 translateY(-100%)），
 * fixed 的子元素会以它为参照，对话框就飘到卡片里去了。
 * 外面的卡片靠 `.rh-cite-dialog` 认出「点的是对话框」，不当成点了卡片外面。
 */
export default function CiteDialog({ card, onClose }) {
  const [data, setData] = useState(null);
  const [copied, setCopied] = useState(null);

  // card 为空 = 还在查这篇是哪条记录（工具栏「引用」先把框弹出来）：先显示「正在整理引用信息…」
  useEffect(() => {
    if (!card) return undefined;
    let alive = true;
    citeData(card).then(d => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [card]);

  // Esc 只关对话框，不连带把卡片也关了（卡片的 Esc 监听挂在 window 冒泡阶段）
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const copy = async (label, text) => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setCopied(label);
    setTimeout(() => setCopied(c => (c === label ? null : c)), 1500);
  };

  return createPortal(
    <div className="rh-cite-dialog fixed inset-0 z-[200] bg-black/40 flex items-center justify-center p-4 animate-fade-in font-sans"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[600px] max-h-[90vh] overflow-y-auto rounded-lg bg-[#fff] text-[#202124] shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
        <div className="relative h-12 flex items-center justify-center border-b border-[#e8eaed]">
          <span className="text-[15px] font-medium">引用</span>
          <button onClick={onClose} title="关闭（Esc）"
            className="absolute right-2 w-8 h-8 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[#5f6368] hover:bg-[#0000000f]">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </div>

        <div className="px-4 py-3">
          {!data ? (
            <div className="text-[13px] text-[#5f6368] py-6 text-center">正在整理引用信息…</div>
          ) : FORMATS.map(([label, fmt]) => {
            const { html, text } = fmt(data);
            return (
              <button key={label} onClick={() => copy(label, text)} title="点击复制"
                className="w-full text-left flex gap-4 px-2 py-2.5 my-1 rounded-md bg-transparent cursor-pointer
                           border border-transparent hover:border-[#dadce0] group">
                <span className="w-[76px] shrink-0 text-[13px] text-[#5f6368] pt-px">
                  {copied === label ? <span className="text-[#188038]">✓ 已复制</span> : label}
                </span>
                <span className="flex-1 min-w-0 text-[13.5px] leading-relaxed text-[#202124] break-words select-text"
                  dangerouslySetInnerHTML={{ __html: html }} />
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 pb-4">
          {EXPORTS.map(([label]) => (
            <button key={label} disabled={!data}
              onClick={async () => copy(label, await exportText(label, data, { bibtexUrl: card?.bibtexUrl }))}
              title={`复制 ${label} 格式`}
              className="flex-1 h-9 rounded-full text-[13px] text-[#1a0dab] bg-[#fff] border border-[#dadce0]
                         cursor-pointer hover:bg-[#f8f9fa] disabled:opacity-40">
              {copied === label ? "✓ 已复制" : label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.fullscreenElement || document.body,   // 全屏时 body 上的东西看不见
  );
}
