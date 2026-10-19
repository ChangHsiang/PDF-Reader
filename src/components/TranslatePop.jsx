import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { translate, cleanForTranslate } from "../lib/translate";
import { useKeepInView } from "../lib/useKeepInView";
import { t } from "../lib/i18n";

/**
 * 划词翻译弹窗：选中文字 → 工具条上点「翻译」（或设置里开了直接翻译）→ 在选区旁弹出译文。
 * 能复制，也能「存为批注」（高亮这段、译文当批注，读外文论文时最常用的就是这一下）。
 *
 * **钉住（pinned）**：变成浮在阅读区上的小窗，点别处 / Esc 都不关，之后每选一段都翻进这里；
 * 拖底栏可以挪位置（位置由外面记住）。钉住时 portal 到 body + fixed —— 留在页面内容层里的话，
 * 一滚动就跟着正文跑走了，那就不叫「常驻」了。
 */
export default function TranslatePop({ text, pos, onClose, onSaveNote, pinned, onPin, fixedPos, onMove }) {
  const [res, setRes] = useState(null);      // { text, engine } | { error }
  const [copied, setCopied] = useState(false);
  const [showSrc, setShowSrc] = useState(false);
  const boxRef = useRef(null);
  useKeepInView(boxRef, [pos?.x, pos?.y, pinned]);

  useEffect(() => {
    if (!text) { setRes(null); return; }
    let alive = true;
    setRes(null);
    translate(text).then(r => { if (alive) setRes(r); }, e => { if (alive) setRes({ error: e.message || t("翻译失败") }); });
    return () => { alive = false; };
  }, [text]);

  useEffect(() => {
    if (pinned) return;                       // 钉住了：点别处、Esc 都不关
    const close = (e) => { if (!boxRef.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [onClose, pinned]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(res.text); } catch { return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /** 钉住后拖底栏挪位置。按下点到窗口左上角的偏移记下来，移动时保持不变；夹在视口里 */
  const startDrag = (e) => {
    if (!pinned || e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    const r = boxRef.current.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => onMove({
      left: Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - r.width),
      top: Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - r.height),
    }, false);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onMove(null, true);                      // 松手：外面把位置存起来
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const togglePin = () => {
    // 从「贴着选区」变成「浮窗」时，就钉在它现在所在的位置，不跳走
    const r = boxRef.current?.getBoundingClientRect();
    onPin(!pinned, r ? { left: r.left, top: r.top } : null);
  };

  const btn = "h-7 px-2.5 rounded-md text-[12px] font-sans text-[#e6e6e6] bg-transparent border-none cursor-pointer hover:bg-[#ffffff26] whitespace-nowrap";
  const box = (
    <div ref={boxRef} className="rh-selbar"
      onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()}
      style={pinned
        ? { position: "fixed", left: fixedPos.left, top: fixedPos.top, zIndex: 150, width: 400, maxWidth: "calc(100vw - 32px)" }
        : { position: "absolute", left: pos.x, top: pos.y, zIndex: 45, width: 400, maxWidth: "calc(100vw - 32px)",
            transform: pos.below ? "translate(-50%, 8px)" : "translate(-50%, calc(-100% - 6px))" }}>
      <div className={`rounded-lg bg-[#323639] border shadow-[0_6px_20px_rgba(0,0,0,0.45)] font-sans select-text
                       ${pinned ? "border-[#7ec8e366]" : "border-[#ffffff26]"}`}>
        <div className="px-3 pt-2.5 pb-2 max-h-[260px] overflow-y-auto thin-scrollbar">
          {showSrc && text && (
            <div className="text-[12px] leading-relaxed text-[#9a9a9a] mb-2 pb-2 border-b border-[#ffffff1a]">
              {cleanForTranslate(text)}
            </div>
          )}
          {!text ? (
            <div className="text-[13px] text-[#9a9a9a] py-1">{t("选中正文里的文字，译文会显示在这里")}</div>
          ) : !res ? (
            <div className="text-[13px] text-[#b8b8b8] py-1">{t("翻译中…")}</div>
          ) : res.error ? (
            <div className="text-[13px] text-[#ff9a9a] py-1">{res.error}</div>
          ) : (
            <div className="text-[14px] leading-relaxed text-[#f2f2f2] whitespace-pre-line">{res.text}</div>
          )}
        </div>
        <div onPointerDown={startDrag} title={pinned ? t("拖动这里可以挪位置") : undefined}
          className={`flex items-center gap-0.5 px-1.5 pb-1.5 select-none ${pinned ? "cursor-move" : ""}`}>
          <span className="flex-1 pl-1.5 text-[10.5px] text-[#7a7a7a]">{res?.engine || ""}</span>
          {text && <button onClick={() => setShowSrc(v => !v)} className={btn}>{showSrc ? t("隐藏原文") : t("原文")}</button>}
          {res?.text && (
            <>
              <button onClick={copy} className={btn}>{copied ? t("✓ 已复制") : t("复制")}</button>
              <button onClick={() => onSaveNote(res.text)} className={btn} title={t("高亮这段，并把译文存成批注")}>{t("存为批注")}</button>
            </>
          )}
          <button onClick={togglePin} title={pinned ? t("取消固定") : t("固定：常驻显示，之后选中的文字都翻译到这里")}
            className={`${btn} px-1.5 ${pinned ? "text-[#7ec8e3] bg-[#7ec8e31f]" : "text-[#9a9a9a]"}`}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill={pinned ? "currentColor" : "none"} stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
          </button>
          <button onClick={onClose} className={`${btn} text-[#9a9a9a]`} title={pinned ? t("关闭（并取消固定）") : t("关闭（Esc）")}>✕</button>
        </div>
      </div>
    </div>
  );
  return pinned ? createPortal(box, document.fullscreenElement || document.body) : box;
}
