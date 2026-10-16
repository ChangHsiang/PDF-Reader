import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import CiteDialog from "./CiteDialog";
import { useKeepInView } from "../lib/useKeepInView";
import { figuresFor } from "../lib/figures";
import ImageLightbox from "./ImageLightbox";
import { resolveReference } from "../lib/refs";
import { MathText } from "./bits";
import { openAlexMeta, relatedFor, allVersions } from "../lib/openalex";

/**
 * 文献卡片：点正文里的引用号弹出（样式参照 Google 学术 PDF 阅读器）。
 * 一组引用（`[1–3]`）在卡片里左右翻；一个编号对应好几篇时（`[1] A; B`）也拆开翻。
 * 浅色卡片 —— 它浮在白纸上，和学术搜索那张一样，比深色工具条好读。
 */
export default function RefCard({ pos, group, current, entries, arxivBase, onJump, onOpenArxiv, onClose }) {
  // pages = [{ label, entry, card|null }]，按组里的编号展开；每个编号查完才知道有几篇
  const [resolved, setResolved] = useState({});      // label → card[] | "loading"
  /* 当前页按「编号 + 篇内序号」记，不按下标：编号 1 查完才知道有两篇，下标会整体往后挪
     （踩过：点 [3] 打开却停在 [2] 上） */
  const [sel, setSel] = useState({ label: current, sub: 0 });
  const [expanded, setExpanded] = useState(false);
  const [citeOpen, setCiteOpen] = useState(false);
  const cardRef = useRef(null);
  /* 放在引用号上方时卡片往上长：首页顶部的引用一点开，卡片会伸出文档顶端（那里没法再往上滚），
     展开摘要还会继续往上长 —— 伸出去就往下挪回来（见 useKeepInView） */
  useKeepInView(cardRef, [pos.x, pos.y, pos.above]);

  useEffect(() => {
    let alive = true;
    group.forEach(label => {
      const entry = entries.get(label);
      if (!entry) { setResolved(r => ({ ...r, [label]: [] })); return; }
      setResolved(r => (r[label] ? r : { ...r, [label]: "loading" }));
      resolveReference(arxivBase, entry)
        .then(cards => { if (alive) setResolved(r => ({ ...r, [label]: cards })); })
        .catch(() => { if (alive) setResolved(r => ({ ...r, [label]: [] })); });
    });
    return () => { alive = false; };
  }, [group, entries, arxivBase]);

  const pages = group.flatMap(label => {
    const r = resolved[label];
    const entry = entries.get(label) || null;
    if (Array.isArray(r) && r.length) return r.map((card, sub) => ({ label, sub, entry, card }));
    return [{ label, sub: 0, entry, card: null, loading: r === "loading" || r === undefined }];
  });
  const found = pages.findIndex(p => p.label === sel.label && p.sub === sel.sub);
  const idx = found >= 0 ? found : Math.max(0, pages.findIndex(p => p.label === sel.label));
  const setIdx = (f) => {
    const i = Math.min(Math.max(0, typeof f === "function" ? f(idx) : f), pages.length - 1);
    if (pages[i]) setSel({ label: pages[i].label, sub: pages[i].sub });
  };
  const setIdxRef = useRef(setIdx);      // 键盘翻页的监听只挂一次，靠它拿到最新的 pages
  setIdxRef.current = setIdx;
  useEffect(() => { setExpanded(false); }, [sel.label, sel.sub]);

  // 点卡片外面 / Esc 关
  useEffect(() => {
    const close = (e) => {
      if (lightboxRef.current) return;                        // 灯箱是 portal 到 body 的全屏层，点它不算点卡片外面
      if (cardRef.current?.contains(e.target)) return;
      if (e.target?.closest?.(".rh-cite-dialog")) return;      // 引用对话框是 portal 出去的
      if (e.target?.closest?.(".linkAnnotation")) return;     // 点另一个引用号由外面换卡片
      onClose();
    };
    const onKey = (e) => {
      if (lightboxRef.current) return;                        // 灯箱开着：Esc / 方向键归灯箱
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIdxRef.current(i => i - 1);
      if (e.key === "ArrowRight") setIdxRef.current(i => i + 1);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  /* 「相关文章」「所有 N 个版本」（OpenAlex）。换一篇就重新查；点开后卡片正文换成对应的列表 */
  const curCard = pages[idx]?.card || null;
  const [oa, setOa] = useState(null);                // { id, versions, related } | null
  const [subView, setSubView] = useState(null);      // null | { kind: "related"|"versions", items: null|[] }
  useEffect(() => {
    setOa(null); setSubView(null);
    if (!curCard) return;
    let alive = true;
    openAlexMeta(curCard).then(m => { if (alive) setOa(m); });
    return () => { alive = false; };
  }, [curCard]);
  /* 「摘要 | 图片」：在 arXiv 上的文献从它的 HTML 版论文页取插图（lib/figures）。
     figs = undefined 还没查 / "loading" / "error" 网络失败 / [] 没图 / [{ url, caption, key }] */
  const [tab, setTab] = useState("abs");
  const [figs, setFigs] = useState(undefined);
  const [lightbox, setLightbox] = useState(-1);           // 灯箱里看的那张；-1 = 没开
  const lightboxRef = useRef(false);
  lightboxRef.current = lightbox >= 0;
  const [figTry, setFigTry] = useState(0);
  useEffect(() => { setTab("abs"); setLightbox(-1); }, [curCard]);
  useEffect(() => {
    setFigs(undefined);
    if (!curCard?.arxiv) return;
    let alive = true;
    setFigs("loading");
    figuresFor(curCard.arxiv).then(f => { if (alive) setFigs(f); }).catch(() => { if (alive) setFigs("error"); });
    return () => { alive = false; };
  }, [curCard, figTry]);
  const hasFigs = Array.isArray(figs) && figs.length > 0;
  /* 「图片」页签拿不到图时为什么是灰的（指上去看得到）：只出现在能拿到图的文献上的话，
     用户分不清是没这个功能还是坏了（踩过：「没有摘要/图片那一行」） */
  const figWhy = !curCard?.arxiv ? "这篇不在 arXiv 上，拿不到插图"
    : figs === "loading" ? "正在从 arXiv 取插图…"
    : Array.isArray(figs) && !figs.length ? "arXiv 的网页版里没有可用的插图（有的图转换时没转出来）" : "";

  const bodyRef = useRef(null);
  /* 列表还在路上时别让卡片先缩成一行「加载中…」再撑开（踩过：「所有版本」打开时高度跳两下）：
     - 所有版本：条数事先知道（按钮上就写着「所有 N 个版本」）→ 画 N 条同样高度的占位行，数据到了原地替换
     - 相关文章：不知道几条 → 先保持打开前正文的高度（expect = null，minH = 当时正文高） */
  const openSub = async (kind) => {
    const minH = bodyRef.current ? bodyRef.current.clientHeight - 24 : 0;     // 减掉上下内边距 pt-3 + pb-3
    setSubView({ kind, items: null, expect: kind === "versions" ? oa?.versions || null : null, minH });
    const r = kind === "related" ? await relatedFor(curCard) : { source: "OpenAlex", items: oa ? await allVersions(oa.id) : [] };
    setSubView(v => (v?.kind === kind ? { kind, title: curCard?.title, ...r } : v));
  };

  const page = pages[idx];
  if (!page) return null;
  const c = page.card;
  const raw = page.entry?.text?.replace(/^\[\d+\]\s*/, "") || "";
  const titleHref = c?.arxiv ? `https://arxiv.org/abs/${c.arxiv}` : c?.doi ? `https://doi.org/${c.doi}` : c?.url;

  // 没有 PDF 时底部那颗换成「在 Google 中搜索」（同学术搜索）
  const googleQ = c?.title || raw.slice(0, 200);

  const pill = (primary) => `h-9 px-5 rounded-full text-[13.5px] text-[#1a0dab] cursor-pointer flex items-center gap-2 ${primary
    ? "bg-[#d3e3fd] border border-transparent hover:bg-[#c2d7fb]" : "bg-[#fff] border border-[#dadce0] hover:bg-[#f8f9fa]"}`;
  const link = "text-[#1a0dab] no-underline hover:underline";
  const act = "inline-flex items-center gap-1 text-[12.5px] text-[#1a0dab] bg-transparent border-none cursor-pointer p-0 hover:underline whitespace-nowrap";
  const navBtn = "w-7 h-7 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[#444] hover:bg-[#0000000f] disabled:opacity-30 disabled:cursor-default";

  return (
    <div ref={cardRef} style={{ position: "absolute", left: pos.x, top: pos.y, width: pos.w, zIndex: 45,
               transform: pos.above ? "translateY(-100%)" : undefined }}
      onMouseDown={e => e.stopPropagation()} onMouseUp={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
      className="rh-selbar rounded-lg bg-[#fff] text-[#202124] border border-[#dadce0] font-sans
                 shadow-[0_4px_16px_rgba(0,0,0,0.25)] animate-fade-in select-text">
      <div className="flex items-center gap-1 pl-4 pr-2 h-11 border-b border-[#e8eaed]">
        <div className="flex-1 min-w-0 truncate text-[13.5px]">
          [{group.map((g, i) => (
            <span key={g}>
              {i > 0 && ", "}
              <button onClick={() => setIdx(pages.findIndex(p => p.label === g))}
                className={`bg-transparent border-none p-0 cursor-pointer text-[13.5px] ${g === page.label ? "font-bold text-[#202124] bg-[#e8eaed] px-0.5 rounded" : "text-[#5f6368] hover:underline"}`}>
                {g}
              </button>
            </span>
          ))}]
        </div>
        {pages.length > 1 && (
          <>
            <span className="text-[12.5px] text-[#5f6368] tabular-nums mx-1">{idx + 1} / {pages.length}</span>
            <button className={navBtn} disabled={idx === 0} onClick={() => setIdx(i => i - 1)} title="上一篇（←）">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <button className={navBtn} disabled={idx >= pages.length - 1} onClick={() => setIdx(i => i + 1)} title="下一篇（→）">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </>
        )}
        <button className={navBtn} onClick={onClose} title="关闭（Esc）">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
      </div>

      <div ref={bodyRef} className="px-4 pt-3 pb-3 max-h-[340px] overflow-y-auto thin-scrollbar">
        {subView ? (
          <SubList view={subView} onBack={() => setSubView(null)} onOpenArxiv={onOpenArxiv} />
        ) : page.loading ? (
          <CardSkeleton />
        ) : c ? (
          <>
            {c.title ? (
              titleHref
                ? <a href={titleHref} target="_blank" rel="noopener noreferrer" className={`${link} text-[15px] leading-snug`}><MathText text={c.title} /></a>
                : <div className="text-[15px] leading-snug"><MathText text={c.title} /></div>
            ) : (
              <div className="text-[13px] leading-relaxed text-[#202124]">{raw}</div>
            )}
            {/* 作者 / 期刊只占一行（同学术搜索），放不下用省略号，指上去看全的：作者多的文献原来折成两行，
                卡片比加载时的骨架高一截、加载完跳一下 */}
            {(() => {
              const meta = [c.authors.join(", "), [c.venue, c.year].filter(Boolean).join(", ")].filter(Boolean).join(" - ");
              return <div className="text-[12px] text-[#5f6368] mt-1 leading-snug truncate" title={meta}>{meta}</div>;
            })()}
            {(
              /* 摘要 / 图片 两个页签（同学术搜索 PDF 阅读器的文献卡片）。一直显示；拿不到图时「图片」是灰的，title 里写原因 */
              <div className="flex items-center gap-4 mt-2 border-b border-[#e8eaed]">
                {[["abs", "摘要"], ["figs", hasFigs ? `图片 (${figs.length})` : figs === "error" ? "图片（加载失败）" : figs === "loading" ? "图片…" : "图片"]].map(([k, label]) => (
                  <button key={k} onClick={() => setTab(k)} title={k === "figs" ? figWhy : undefined}
                    disabled={k === "figs" && !hasFigs && figs !== "error"}
                    className={`h-8 px-0.5 -mb-px bg-transparent border-0 border-b-2 border-solid cursor-pointer text-[13px] disabled:cursor-default disabled:text-[#9aa0a6]
                      ${tab === k ? "border-[#1a73e8] text-[#1a73e8] font-medium" : "border-transparent text-[#5f6368] hover:text-[#202124]"}`}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {/* 摘要 / 图片 两页共用一个最低高度：图片页是一排 86px 的缩略图 + 滑轨，约 124px；
                摘要折叠时原来 3 行 + 「展开」只有 104px，切页签卡片会跳一下。有图可切时摘要折叠成 4 行，
                再用 minHeight 兜底（摘要短、或者滑轨是悬浮式不占高度时两边也一样高）。展开摘要是用户自己点的，照常变高 */}
            <div style={{ minHeight: PANEL_H, display: "flow-root" }}>   {/* flow-root：里面两种内容的上外边距不一样（8 / 10px），不包住的话会穿出去，两边差 2px */}
            {tab === "figs" && figs === "error" ? (
              <div className="text-[12.5px] text-[#5f6368] mt-2 leading-relaxed">
                没能从 arXiv 取到这篇的网页版（网络慢或连不上）。
                <button onClick={() => setFigTry(t => t + 1)} className={act}>重试</button>
              </div>
            ) : tab === "figs" && Array.isArray(figs) && figs.length > 0 ? (
              <FigureView figs={figs} onOpen={setLightbox} />
            ) : (
              <>
                {c.abstract ? (
                  <div className={`text-[13px] leading-relaxed text-[#3c4043] mt-2 ${expanded ? "" : "line-clamp-4"}`}>
                    <MathText text={c.abstract} />
                  </div>
                ) : (
                  <div className="text-[12.5px] text-[#9aa0a6] mt-2">没有查到摘要</div>
                )}
                {c.abstract && c.abstract.length > 320 && (
                  <button onClick={() => setExpanded(v => !v)} className={`${act} mt-1`}>{expanded ? "收起" : "展开"}</button>
                )}
              </>
            )}
            </div>
            <div className="flex items-center gap-4 flex-wrap mt-2.5">
              <button onClick={() => setCiteOpen(true)} className={act} title="GB/T 7714 / MLA / APA，可导出 BibTeX 等">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z" /></svg>
                引用
              </button>
              {c.citations != null && (
                /* 点过去是「引用了这篇的文献」列表：INSPIRE / Semantic Scholar 各自的页面；
                   Crossref 来的没有这种页面，退回 Google 学术搜这篇 */
                <a href={c.citesUrl || `https://scholar.google.com/scholar?q=${encodeURIComponent(googleQ)}`}
                  target="_blank" rel="noopener noreferrer" className={act}>被引用次数：{c.citations}</a>
              )}
              {(c.arxiv || c.doi) && <button onClick={() => openSub("related")} className={act}>相关文章</button>}
              {oa?.versions > 0 && <button onClick={() => openSub("versions")} className={act}>所有 {oa.versions} 个版本</button>}
              <span className="flex-1" />
              <span className="text-[11px] text-[#9aa0a6]">{c.source}</span>
            </div>
          </>
        ) : (
          /* 查不到：同学术搜索，只摆出参考文献原文（带编号），下面两颗按钮 */
          <div className="text-[13.5px] leading-relaxed text-[#202124]">
            {page.entry?.text || "没有从 PDF 里读出这条参考文献。"}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-4 pb-3">
        {c?.arxiv ? (
          <button onClick={() => onOpenArxiv(c.arxiv)} className={pill(true)}>[PDF] arxiv.org</button>
        ) : c?.pdfUrl ? (
          <a href={c.pdfUrl} target="_blank" rel="noopener noreferrer" className={`${pill(true)} no-underline`}>
            [PDF] {(() => { try { return new URL(c.pdfUrl).hostname.replace(/^www\./, ""); } catch { return "原文"; } })()}
          </a>
        ) : !page.loading && googleQ ? (
          <a href={`https://www.google.com/search?q=${encodeURIComponent(googleQ)}`} target="_blank" rel="noopener noreferrer"
            className={`${pill(false)} no-underline`}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            在 Google 中搜索
          </a>
        ) : null}
        {!page.loading && googleQ && (
          <a href={`https://scholar.google.com/scholar?q=${encodeURIComponent(googleQ)}`} target="_blank" rel="noopener noreferrer"
            className={`${pill(false)} no-underline`}>Google 学术</a>
        )}
        {page.entry && (
          <button onClick={() => onJump(page.entry)} className={pill(false)}>在参考文献中查看</button>
        )}
      </div>

      {citeOpen && c && <CiteDialog card={c} onClose={() => setCiteOpen(false)} />}
      {lightbox >= 0 && hasFigs && (
        <ImageLightbox images={figs} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(-1)} />
      )}
    </div>
  );
}

/**
 * 插图：先直接用 <img> 加载；失败了（网络抖动、被拦）改用 fetch 拿下来转成 blob 再显示 ——
 * fetch 走扩展的 host 权限，不带页面的 Referer / Cookie 限制；再失败就显示「加载失败」，点一下重试。
 * 加载中显示一个淡色占位，免得一片空白看不出是在加载还是坏了
 */
function FigImg({ src, alt, className, onLoad }) {
  const [state, setState] = useState("loading");      // loading | ok | blob | fail
  const [url, setUrl] = useState(src);
  const [tries, setTries] = useState(0);
  useEffect(() => { setState("loading"); setUrl(src); }, [src, tries]);
  useEffect(() => () => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); }, [url]);
  const onError = async () => {
    if (state === "blob" || url.startsWith("blob:")) { setState("fail"); return; }
    setState("blob");
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error(String(r.status));
      setUrl(URL.createObjectURL(await r.blob()));
    } catch { setState("fail"); }
  };
  if (state === "fail") {
    return (
      <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTries(t => t + 1); }}
        className="text-[11.5px] text-[#9aa0a6] cursor-pointer hover:text-[#1a0dab] px-2 text-center">图片加载失败，点击重试</span>
    );
  }
  return (
    <>
      {state !== "ok" && <span className="text-[11.5px] text-[#9aa0a6] px-2">加载中…</span>}
      <img src={url} alt={alt} referrerPolicy="no-referrer" onLoad={() => { setState("ok"); onLoad?.(url); }} onError={onError}
        className={className} style={state === "ok" ? undefined : { position: "absolute", width: 1, height: 1, opacity: 0 }} />
    </>
  );
}

/**
 * 「图片」页：横向缩略图条，点一张打开全屏灯箱（ImageLightbox，和 ResearchHub 网站同一个组件）。
 * 底下是一条细滑轨（浏览器自带的横向滚动条，调细、调浅），拖它或者在图上滚滚轮都能左右翻 ——
 * 原来两头是网站那种左右箭头按钮，盖住了半张缩略图。缩略图底色写死白（图多是白底 / 透明底的曲线图）
 */
function FigureView({ figs, onOpen }) {
  const stripRef = useRef(null);
  /* 竖着滚滚轮也横着翻：只在这条确实能横向滚、而且还没滚到头时接管，
     滚到头了就放行给卡片正文 / 页面，不把滚轮吃死。React 的 onWheel 是 passive 的、拦不住默认滚动，所以手挂 */
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;          // 触控板横向手势：浏览器自己会横滚
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const next = Math.min(max, Math.max(0, el.scrollLeft + e.deltaY));
      if (next === el.scrollLeft) return;
      e.preventDefault();
      el.scrollLeft = next;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [figs]);
  /* 指上缩略图停一下：在它上方浮出一张大一点的预览（同 Claude 的附件预览），不再用浏览器 title 显示长长的图注 */
  const [peek, setPeek] = useState(null);         // { i, rect }
  const loaded = useRef({});                      // 缩略图实际加载成功的地址（可能是 blob:）：预览直接用它，不再下一遍
  const peekTimer = useRef(0);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  const enter = (i) => (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek({ i, rect }), 250);
  };
  const leave = () => { clearTimeout(peekTimer.current); setPeek(null); };
  return (
    <div ref={stripRef} className="flex gap-2 overflow-x-auto mt-2.5 pb-2" onScroll={leave}
      style={{ scrollbarWidth: "thin", scrollbarColor: "#c4c7c5 transparent" }}>
      {figs.map((f, i) => (
        <button key={f.key || i} onClick={() => { leave(); onOpen(i); }} aria-label={`图 ${i + 1}`}
          onMouseEnter={enter(i)} onMouseLeave={leave}
          className="shrink-0 w-[124px] h-[86px] rounded-lg border border-[#dadce0] overflow-hidden cursor-zoom-in p-1
                     bg-[#fff] hover:border-[#1a73e8] transition-colors flex items-center justify-center">
          <FigImg src={f.url} alt={`图 ${i + 1}`} className="w-full h-full object-contain" onLoad={(u) => { loaded.current[i] = u; }} />
        </button>
      ))}
      {peek && figs[peek.i] && <FigPeek src={loaded.current[peek.i] || figs[peek.i].url} n={peek.i + 1} total={figs.length} rect={peek.rect} />}
    </div>
  );
}

/** 缩略图的悬停预览：白底圆角卡片，图按比例放大，底下一行「图 n / 共 N」。放在缩略图上方，上面放不下就放下方 */
const PEEK_W = 340, PEEK_H = 260;
function FigPeek({ src, n, total, rect }) {
  const above = rect.top - PEEK_H - 40 > 8;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - PEEK_W / 2), window.innerWidth - PEEK_W - 8);
  const style = above ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 };
  return createPortal(
    <div style={{ position: "fixed", left, width: PEEK_W, zIndex: 80, pointerEvents: "none", ...style }}
      className="rounded-xl bg-[#fff] border border-[#dadce0] shadow-[0_8px_28px_rgba(0,0,0,0.22)] overflow-hidden animate-fade-in">
      <div className="flex items-center justify-center p-2" style={{ height: PEEK_H }}>
        <img src={src} alt={`图 ${n}`} referrerPolicy="no-referrer" className="max-w-full max-h-full object-contain" />
      </div>
      <div className="px-3 py-1.5 border-t border-[#f1f3f4] text-[11.5px] text-[#5f6368] font-sans flex justify-between">
        <span>图 {n}</span><span className="text-[#9aa0a6]">{n} / {total} · 点击放大</span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 文献还在查的时候先摆一个骨架：结构和行高照查到之后的卡片一模一样（标题 / 作者 / 页签 / 4 行摘要 / 操作行），
 * 查到了原地替换，卡片不先缩成一行「正在查找…」再撑开（踩过：点引用后网络慢，卡片高度跳一下）。
 * 每条灰条前面垫一个看不见的字，让这一行的行高和真的文字行完全一致
 */
const Bar = ({ w, h = "h-3", tone = "bg-[#e8eaed]" }) => (
  <><span className="invisible">.</span><span className={`${h} rounded ${tone}`} style={{ width: w }} /></>
);
function CardSkeleton() {
  return (
    <div className="animate-pulse" aria-label="正在查找这篇文献">
      {/* 标题行和真的一样是行内元素（真的标题是 <a>，直接放在正文里），行盒高度才一致 */}
      <span className="text-[15px] leading-snug">
        <span className="inline-block align-middle h-4 rounded bg-[#e8eaed]" style={{ width: "78%" }} />{"​"}
      </span>
      <div className="text-[12px] leading-snug mt-1 flex items-center"><Bar w="52%" tone="bg-[#f1f3f4]" /></div>
      <div className="flex items-center gap-4 mt-2 border-b border-[#e8eaed]">
        <span className="h-8 -mb-px flex items-center text-[13px]"><Bar w="26px" /></span>
        <span className="h-8 -mb-px flex items-center text-[13px]"><Bar w="40px" /></span>
      </div>
      <div style={{ minHeight: PANEL_H, display: "flow-root" }}>
        <div className="text-[13px] leading-relaxed mt-2">
          {["100%", "96%", "98%", "60%"].map((w, i) => <div key={i} className="flex items-center"><Bar w={w} tone="bg-[#f1f3f4]" /></div>)}
        </div>
      </div>
      <div className="flex items-center gap-4 mt-2.5 text-[12.5px]">
        <span className="flex items-center"><Bar w="34px" /></span>
        <span className="flex items-center"><Bar w="88px" /></span>
        <span className="flex items-center"><Bar w="52px" /></span>
      </div>
    </div>
  );
}

/** 摘要 / 图片 两个页签内容区的最低高度（= 图片页的高度：mt-2.5 + 86px 缩略图 + pb-2 + 滑轨）。
    所有查到的文献都用它（不只是有图的）：这样卡片高度可预测，加载时的骨架才能和最终一样高 */
const PANEL_H = 128;   // 实测图片页 124~126px（滑轨粗细因系统而异），取稍大一点，两边都由 minHeight 撑到同一高度

/** arXiv 的链接认出号来，交给插件阅读器打开 */
const arxivIdOf = (url) => /arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i.exec(url || "")?.[1] || null;

/** 卡片里的「相关文章」/「所有版本」列表 */
function SubList({ view, onBack, onOpenArxiv }) {
  const link = "text-[#1a0dab] no-underline hover:underline";
  const open = (url) => (e) => {
    const id = arxivIdOf(url);
    if (id) { e.preventDefault(); onOpenArxiv(id); }
  };
  const loading = !view.items;
  const count = view.items ? view.items.length : view.expect;
  return (
    <div style={loading && !view.expect ? { minHeight: view.minH || 0 } : undefined}>
      {/* 标题栏：左边一颗圆形「返回」（和卡片顶上的翻页 / 关闭同一种按钮），标题加粗，条数放成灰色小标签，
          下面一道分隔线。原来是一行蓝色的「← 返回」文字链接，看着像正文里的链接、不像按钮 */}
      <div className="flex items-center gap-1.5 -mx-1 mb-1.5 pb-2 border-b border-[#e8eaed]">
        <button onClick={onBack} title="返回文献信息" aria-label="返回"
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-[#f1f3f4] border-none cursor-pointer
                     text-[#3c4043] hover:bg-[#e3e5e8] active:bg-[#d7dade] transition-colors">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
        </button>
        <span className="text-[14px] text-[#202124] font-semibold ml-1">
          {view.kind === "related" ? "相关文章" : "所有版本"}
        </span>
        {count > 0 && (
          <span className="text-[11.5px] text-[#5f6368] bg-[#f1f3f4] rounded-full px-2 leading-[20px] tabular-nums">{count}</span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-[#9aa0a6]">{view.source || ""}</span>
      </div>
      {/* 列表单独包一层：每条的上分隔线用 first:border-t-0 去掉第一条的，标题栏也在同一层的话「第一条」就不是它了，
          标题栏底线和第一条的上线叠成两道（踩过） */}
      <div>
      {loading ? (
        view.expect ? (
          /* 占位行：和真的一条同样的结构和行高（标题一行 13px + 来源一行 11.5px），数据到了高度不变 */
          Array.from({ length: view.expect }, (_, i) => (
            <div key={i} className="py-1.5 border-t border-[#f1f3f4] first:border-t-0 animate-pulse">
              <div className="text-[13px] flex items-center"><span className="invisible">.</span>
                <span className="h-3 rounded bg-[#e8eaed]" style={{ width: `${55 - (i % 3) * 10}%` }} /></div>
              <div className="text-[11.5px] flex items-center"><span className="invisible">.</span>
                <span className="h-2.5 rounded bg-[#f1f3f4] w-[38%]" /></div>
            </div>
          ))
        ) : (
          <div className="text-[13px] text-[#5f6368] py-2">加载中…</div>
        )
      ) : view.items.length === 0 ? (
        <div className="text-[13px] text-[#5f6368] py-2 leading-relaxed">
          {view.kind === "related" ? "Semantic Scholar 没有给这篇推荐相关文章（较早的文献常常没有）。" : "没有查到"}
          {view.kind === "related" && view.title && (
            <> <a href={`https://scholar.google.com/scholar?q=${encodeURIComponent(view.title)}`} target="_blank" rel="noopener noreferrer" className={link}>
              去 Google 学术找</a></>
          )}
        </div>
      ) : view.kind === "related" ? (
        view.items.map((w, i) => (
          <div key={i} className="py-1.5 border-t border-[#f1f3f4] first:border-t-0">
            <a href={w.url} target="_blank" rel="noopener noreferrer" onClick={open(w.url)}
              className={`${link} text-[13.5px] leading-snug`}><MathText text={w.title || "（无标题）"} /></a>
            <div className="text-[11.5px] text-[#5f6368] mt-0.5 leading-snug">
              {[w.authors, [w.venue, w.year].filter(Boolean).join(", ")].filter(Boolean).join(" - ")}
              {w.citations ? ` · 被引 ${w.citations}` : ""}
              {w.pdfUrl && <> · <a href={w.pdfUrl} target="_blank" rel="noopener noreferrer" onClick={open(w.pdfUrl)} className={link}>[PDF]</a></>}
            </div>
          </div>
        ))
      ) : (
        view.items.map((v, i) => (
          <div key={i} className="py-1.5 border-t border-[#f1f3f4] first:border-t-0 flex items-baseline gap-2">
            <div className="flex-1 min-w-0">
              {v.url
                ? <a href={v.url} target="_blank" rel="noopener noreferrer" onClick={open(v.url)} className={`${link} text-[13px]`}>{v.source}</a>
                : <span className="text-[13px]">{v.source}</span>}
              <div className="text-[11.5px] text-[#5f6368]">
                {[v.host, v.version, v.oa ? "开放获取" : null].filter(Boolean).join(" · ")}
              </div>
            </div>
            {v.pdfUrl && (
              <a href={v.pdfUrl} target="_blank" rel="noopener noreferrer" onClick={open(v.pdfUrl)}
                className={`${link} text-[12.5px] shrink-0`}>[PDF]</a>
            )}
          </div>
        ))
      )}
      </div>
    </div>
  );
}
