import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import LoginForm from "./LoginForm";
import ImageLightbox from "./ImageLightbox";
import { MathText } from "./bits";
import { useSession } from "../lib/useSession";
import { figuresFor } from "../lib/figures";
import {
  listBookmarks, listCollections, removeBookmark, updateBookmark,
  createCollection, renameCollection, deleteCollection, arxivOf,
} from "../lib/library";
import { t } from "../lib/i18n";

/**
 * 文献收藏（从 ResearchHub 网站的 Library 搬过来，同一份数据：bookmarks + collections）。
 * 三栏：左边收藏夹 + 标签，中间列表（搜索 / 排序，可以拖到左边的收藏夹里），右边详情（摘要 / 图片、标签、换收藏夹、移除）。
 * 和网站的区别：做成阅读器里的弹窗（点头像 →「文献收藏」，Esc / 点外面关）；深色（同阅读器）；
 * 点标题 / PDF 用本插件的阅读器在新标签打开 arXiv 论文；没有作者资料卡
 */

const openViewer = (url) => chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?url=${encodeURIComponent(url)}`) });
const openTab = (url) => chrome.tabs.create({ url });

const panel = "bg-[#292a2d] border border-[#ffffff14] rounded-2xl";

export default function LibraryDialog({ onClose }) {
  const session = useSession();
  const [bookmarks, setBookmarks] = useState([]);
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCol, setActiveCol] = useState("all");       // all | uncat | <id>
  const [activeTag, setActiveTag] = useState(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState("created");
  const [selectedId, setSelectedId] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    if (!session?.uid) { setLoading(false); return; }
    setLoading(true);
    Promise.all([listBookmarks(), listCollections()]).then(([b, c]) => {
      setBookmarks(b); setCollections(c); setLoading(false);
    });
  }, [session?.uid]);

  const tagCloud = useMemo(() => {
    const m = new Map();
    bookmarks.forEach(b => (b.tags || []).forEach(t => m.set(t, (m.get(t) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [bookmarks]);

  const visible = useMemo(() => {
    let arr = bookmarks;
    if (activeCol === "uncat") arr = arr.filter(b => !b.collection_id);
    else if (activeCol !== "all") arr = arr.filter(b => b.collection_id === activeCol);
    if (activeTag) arr = arr.filter(b => (b.tags || []).includes(activeTag));
    const q = query.trim().toLowerCase();
    if (q) arr = arr.filter(b => `${b.title || ""} ${(b.authors || []).join(" ")} ${b.journal || ""} ${b.abstract || b.summary || ""}`.toLowerCase().includes(q));
    const out = [...arr];
    if (sortKey === "year") out.sort((a, b) => (b.year || 0) - (a.year || 0));
    if (sortKey === "title") out.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    return out;
  }, [bookmarks, activeCol, activeTag, query, sortKey]);

  const selected = visible.find(b => b.id === selectedId) || null;

  // Esc 关弹窗（删除确认开着时只关确认；输入框里的 Esc 留给输入框自己）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (confirmDelete) { setConfirmDelete(null); return; }
      if (e.target?.closest?.("input, textarea")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete, onClose]);

  const counts = useMemo(() => {
    const m = { all: bookmarks.length, uncat: bookmarks.filter(b => !b.collection_id).length };
    collections.forEach(c => { m[c.id] = bookmarks.filter(b => b.collection_id === c.id).length; });
    return m;
  }, [bookmarks, collections]);

  const update = async (id, patch) => {
    setBookmarks(bs => bs.map(b => (b.id === id ? { ...b, ...patch } : b)));
    await updateBookmark(id, patch);
  };
  const remove = async (id) => {
    setBookmarks(bs => bs.filter(b => b.id !== id));
    if (selectedId === id) setSelectedId(null);
    await removeBookmark(id);
  };
  const addCol = async (name) => {
    const c = await createCollection(name);
    if (c) { setCollections(cs => [...cs, c]); setActiveCol(c.id); }
  };
  const renameCol = async (id, name) => {
    setCollections(cs => cs.map(c => (c.id === id ? { ...c, name } : c)));
    await renameCollection(id, name);
  };
  const delCol = async (c) => {
    await deleteCollection(c.id);
    setCollections(cs => cs.filter(x => x.id !== c.id));
    setBookmarks(bs => bs.map(b => (b.collection_id === c.id ? { ...b, collection_id: null } : b)));
    if (activeCol === c.id) setActiveCol("all");
    setConfirmDelete(null);
  };

  let body;
  if (session === undefined || (loading && session?.uid)) {
    body = <div className="flex-1 flex items-center justify-center text-[#9aa0a6] text-[13px]">{t("正在加载…")}</div>;
  } else if (!session?.uid) {
    body = (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className={`${panel} w-full max-w-[380px] p-5`}>
          <LoginForm />
          <div className="text-[11.5px] text-[#9aa0a6] mt-3 leading-relaxed">{t("文献收藏存在 ResearchHub 账号里，和网站上的「文献收藏」是同一份。")}</div>
        </div>
      </div>
    );
  }
  if (body) return <Shell onClose={onClose}>{body}</Shell>;

  return (
    <Shell onClose={onClose}>
    <div className="flex-1 min-h-0 flex gap-3 p-3 pt-0 text-[#e8eaed]">
      <aside className="w-[220px] shrink-0 flex flex-col gap-3 min-h-0">
        <div className="shrink-0 max-h-[60%] flex flex-col min-h-0">
          <CollectionList collections={collections} counts={counts} activeCol={activeCol}
            onSelect={(id) => { setActiveCol(id); setActiveTag(null); }}
            onCreate={addCol} onRename={renameCol} onDelete={setConfirmDelete}
            dragging={!!draggingId}
            onDrop={(bid, cid) => { const b = bookmarks.find(x => x.id === bid); if (b && b.collection_id !== cid) update(bid, { collection_id: cid }); }} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar">
          <div className={`${panel} p-3`}>
            <div className="text-[11px] font-bold text-[#9aa0a6] px-1 pb-2">{t("标签")}</div>
            {tagCloud.length === 0 ? <div className="text-[12px] text-[#7a7a7a] px-1">{t("还没有标签")}</div> : (
              <div className="flex flex-wrap gap-1.5">
                {tagCloud.map(([t, n]) => (
                  <button key={t} onClick={() => setActiveTag(activeTag === t ? null : t)}
                    className={`inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[12px] border cursor-pointer
                      ${activeTag === t ? "bg-[#7ec8e3] text-[#10232c] border-[#7ec8e3]" : "bg-transparent text-[#c8c8c8] border-[#ffffff26] hover:border-[#7ec8e3]"}`}>
                    <span className="truncate max-w-[110px]">{t}</span>
                    <span className={`text-[10px] tabular-nums ${activeTag === t ? "text-[#10232c]/70" : "text-[#8a8a8a]"}`}>{n}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>

      <section className={`${panel} flex-1 min-w-0 flex flex-col overflow-hidden`}>
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#ffffff14]">
          <label className="flex-1 flex items-center gap-2 rounded-full px-3 h-9 bg-[#00000040] border border-[#ffffff1f] focus-within:border-[#7ec8e3]">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#9aa0a6" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t("搜索标题 / 作者 / 期刊 / 摘要…")}
              className="flex-1 bg-transparent outline-none border-none text-[13px] text-[#e8eaed] placeholder:text-[#7a7a7a]" />
          </label>
          {activeTag && (
            <button onClick={() => setActiveTag(null)} className="h-7 px-2.5 rounded-full text-[11.5px] font-bold bg-[#7ec8e3] text-[#10232c] border-none cursor-pointer">{activeTag} ×</button>
          )}
          <MenuSelect value={sortKey} onChange={setSortKey}
            options={[["created", t("最近收藏")], ["year", t("年份")], ["title", t("标题")]]} />
        </div>
        {visible.length === 0 ? (
          <div className="text-center py-20 text-[#9aa0a6]">
            <div className="text-[34px] mb-2">📭</div>
            <div className="text-[14px]">{activeCol === "all" ? t("还没有收藏任何文献") : t("这里还是空的")}</div>
            <div className="text-[11.5px] mt-2">{t("在阅读器里点引用编号，文献卡片上点 ☆ 收藏")}</div>
          </div>
        ) : (
          <ul className="flex-1 min-h-0 overflow-y-auto thin-scrollbar m-0 p-0 list-none divide-y divide-[#ffffff0f]">
            {visible.map(b => {
              const on = b.id === selectedId;
              return (
                <li key={b.id}>
                  <button onClick={() => setSelectedId(b.id)} draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/bookmark-id", b.id); e.dataTransfer.effectAllowed = "move"; setDraggingId(b.id); }}
                    onDragEnd={() => setDraggingId(null)}
                    className={`w-full text-left px-4 py-3 cursor-pointer border-none border-l-2 block select-none
                      ${draggingId === b.id ? "opacity-40" : ""} ${on ? "bg-[#7ec8e31a] border-l-[#7ec8e3]" : "bg-transparent border-l-transparent hover:bg-[#ffffff0a]"}`}>
                    <div className="text-[#f1f1f1] text-[13.5px] font-bold font-serif leading-snug line-clamp-2 mb-1"><MathText text={b.title || t("(无标题)")} /></div>
                    <div className="text-[#a8a8a8] text-[12px] line-clamp-1">{(b.authors || []).slice(0, 3).join(", ")}{(b.authors || []).length > 3 ? " …" : ""}</div>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {b.year && <span className="text-[11px] text-[#8a8a8a] tabular-nums">{b.year}</span>}
                      {b.journal && <span className="text-[11px] text-[#7ec8e3] truncate max-w-[200px]">{b.journal}</span>}
                      {(b.tags || []).slice(0, 3).map(t => <span key={t} className="text-[10.5px] px-1.5 py-px rounded bg-[#ffffff14] text-[#b8b8b8]">{t}</span>)}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <aside className={`${panel} w-[380px] shrink-0 flex flex-col overflow-hidden`}>
        <Detail key={selected?.id || "none"} b={selected} collections={collections} onUpdate={update} onRemove={remove} />
      </aside>

      {confirmDelete && createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 font-sans" onClick={() => setConfirmDelete(null)}>
          <div onClick={e => e.stopPropagation()} className={`${panel} w-[min(92vw,400px)] p-6`}>
            <div className="text-[#fff] font-bold text-[15px] mb-2">{t("删除收藏夹「{name}」？", { name: confirmDelete.name })}</div>
            <div className="text-[#c8c8c8] text-[13px] leading-relaxed mb-5">{t("收藏夹会被删除，里面的文献回到「未分类」。")}</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="h-8 px-4 rounded-full text-[13px] text-[#c8c8c8] bg-transparent border border-[#ffffff33] cursor-pointer hover:bg-[#ffffff1a]">{t("取消")}</button>
              <button onClick={() => delCol(confirmDelete)} className="h-8 px-4 rounded-full text-[13px] font-bold text-[#fff] bg-[#d93025] border-none cursor-pointer hover:bg-[#b3261e]">{t("确定删除")}</button>
            </div>
          </div>
        </div>, document.body)}
    </div>
    </Shell>
  );
}

/** 弹窗外壳：铺满大半个屏幕的深色面板，标题栏 + 关闭；点遮罩关闭 */
function Shell({ onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-[150] bg-black/55 flex items-center justify-center p-6 animate-fade-in font-sans"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[1280px] h-full max-h-[860px] flex flex-col rounded-2xl bg-[#1f2023] border border-[#ffffff26]
                      shadow-[0_16px_48px_rgba(0,0,0,0.55)] overflow-hidden">
        <div className="relative h-11 shrink-0 flex items-center justify-center">
          <span className="text-[14.5px] text-[#fff] font-bold">{t("文献收藏")}</span>
          <button onClick={onClose} title={t("关闭（Esc）")}
            className="absolute right-2 w-8 h-8 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[#c8c8c8] hover:bg-[#ffffff1a]">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** 左栏收藏夹：全部 / 未分类 / 各收藏夹（悬停出重命名、删除）/ 新建；拖文献到「未分类」或某个收藏夹上 = 挪过去 */
function CollectionList({ collections, counts, activeCol, onSelect, onCreate, onRename, onDelete, dragging, onDrop }) {
  const [over, setOver] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);       // { id, name }
  const [name, setName] = useState("");
  const drop = (id) => ({
    onDragOver: (e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } },
    onDragEnter: (e) => { if (dragging) { e.preventDefault(); setOver(id); } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(o => (o === id ? null : o)); },
    onDrop: (e) => {
      if (!dragging) return;
      e.preventDefault();
      const bid = e.dataTransfer.getData("text/bookmark-id");
      setOver(null);
      if (bid) onDrop(bid, id === "uncat" ? null : id);
    },
  });
  const item = (id, label, n, droppable) => {
    const on = activeCol === id, hit = droppable && over === id;
    return (
      <button onClick={() => onSelect(id)} {...(droppable ? drop(id) : {})}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[13px] text-left border cursor-pointer
          ${hit ? "bg-[#7ec8e326] border-[#7ec8e3] text-[#7ec8e3] font-bold"
            : on ? "bg-[#7ec8e31f] text-[#7ec8e3] font-bold border-transparent"
            : `text-[#d0d0d0] bg-transparent hover:bg-[#ffffff0f] ${dragging && droppable ? "border-dashed border-[#ffffff33]" : "border-transparent"}`}`}>
        <span className="truncate">{label}</span>
        <span className={`text-[11px] tabular-nums shrink-0 ${on || hit ? "text-[#7ec8e3]" : "text-[#8a8a8a]"}`}>{n}</span>
      </button>
    );
  };
  const finishCreate = () => { const n = name.trim(); setCreating(false); setName(""); if (n) onCreate(n); };
  const finishRename = () => { const n = name.trim(); const e = editing; setEditing(null); setName(""); if (n && e && n !== e.name) onRename(e.id, n); };
  const input = "w-full bg-[#00000040] outline-none border border-[#7ec8e3] rounded text-[13px] px-2 py-1 text-[#e8eaed]";
  return (
    <div className={`${panel} p-2 flex flex-col min-h-0 max-h-full`}>
      <div className="shrink-0">
        <div className="text-[11px] font-bold text-[#9aa0a6] px-3 pt-1 pb-2">{t("收藏夹")}</div>
        {item("all", t("全部"), counts.all || 0, false)}
        {item("uncat", t("未分类"), counts.uncat || 0, true)}
        <div className="my-1.5 mx-2 border-t border-[#ffffff14]" />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar">
        {collections.map(c => (editing?.id === c.id ? (
          <div key={c.id} className="px-3 py-1.5">
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={finishRename} className={input}
              onKeyDown={e => { if (e.key === "Enter") finishRename(); if (e.key === "Escape") { setEditing(null); setName(""); } }} />
          </div>
        ) : (
          <div key={c.id} className="group relative">
            {item(c.id, c.name, counts[c.id] || 0, true)}
            <div className="hidden group-hover:flex absolute right-1 top-1/2 -translate-y-1/2 items-center gap-0.5">
              <button onClick={(e) => { e.stopPropagation(); setEditing(c); setName(c.name); }} title={t("重命名")}
                className="w-6 h-6 rounded bg-[#3a3b3e] border border-[#ffffff1f] cursor-pointer text-[#b8b8b8] hover:text-[#fff] flex items-center justify-center">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
              </button>
              <button onClick={(e) => { e.stopPropagation(); onDelete(c); }} title={t("删除")}
                className="w-6 h-6 rounded bg-[#3a3b3e] border border-[#ffffff1f] cursor-pointer text-[#b8b8b8] hover:text-[#ff8a80] flex items-center justify-center">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
              </button>
            </div>
          </div>
        )))}
      </div>
      <div className="shrink-0">
        {creating ? (
          <div className="px-3 py-1.5">
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={finishCreate} placeholder={t("收藏夹名称")} className={input}
              onKeyDown={e => { if (e.key === "Enter") finishCreate(); if (e.key === "Escape") { setCreating(false); setName(""); } }} />
          </div>
        ) : (
          <button onClick={() => { setCreating(true); setName(""); }}
            className="w-full flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] text-[#9aa0a6] hover:text-[#7ec8e3] hover:bg-[#ffffff0a] bg-transparent border-none cursor-pointer">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            {t("新建收藏夹")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 小下拉（深色）：排序、详情里的收藏夹 */
function MenuSelect({ value, options, onChange, up = false, className = "" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);
  const cur = options.find(o => o[0] === value)?.[1] || options[0]?.[1];
  return (
    <div ref={ref} className={`relative shrink-0 ${className}`}>
      <button onClick={() => setOpen(o => !o)}
        className="h-9 w-full flex items-center gap-2 px-3 rounded-lg text-[12.5px] text-[#e8eaed] bg-[#00000040] border border-[#ffffff1f] cursor-pointer hover:border-[#ffffff40]">
        <span className="flex-1 text-left truncate max-w-[130px]">{cur}</span>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className={`absolute right-0 ${up ? "bottom-full mb-1" : "top-full mt-1"} w-max min-w-full max-h-[260px] overflow-y-auto thin-scrollbar p-1 rounded-lg bg-[#3b3f42] border border-[#ffffff26] shadow-[0_8px_24px_rgba(0,0,0,0.45)] z-20`}>
          {options.map(([v, label]) => (
            <button key={v} onClick={() => { setOpen(false); onChange(v); }}
              className={`w-full flex items-center gap-2 pl-2 pr-4 h-8 rounded-md text-[12.5px] text-left border-none cursor-pointer whitespace-nowrap
                ${v === value ? "text-[#7ec8e3] bg-[#ffffff12]" : "text-[#e6e6e6] bg-transparent hover:bg-[#ffffff1a]"}`}>
              <span className="w-3 text-[11px]">{v === value ? "✓" : ""}</span>{label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** BibTeX（同网站 Library 的 buildBibtex） */
function buildBibtex(b, arxivId) {
  const first = (b.authors?.[0] || "anon").split(/\s+/).pop().replace(/[^A-Za-z]/g, "") || "anon";
  const yr = b.year || (b.published ? String(b.published).slice(0, 4) : "");
  const word = (b.title || "").split(/\s+/).find(w => w.length > 3)?.replace(/[^A-Za-z0-9]/g, "") || "ref";
  const lines = [`@${b.journal ? "article" : "misc"}{${first.toLowerCase()}${yr}${word.toLowerCase()},`];
  if (b.title) lines.push(`  title = {${b.title}},`);
  if (b.authors?.length) lines.push(`  author = {${b.authors.join(" and ")}},`);
  if (yr) lines.push(`  year = {${yr}},`);
  if (b.journal) lines.push(`  journal = {${b.journal}},`);
  if (b.doi) lines.push(`  doi = {${b.doi}},`);
  if (arxivId) { lines.push(`  eprint = {${arxivId}},`); lines.push("  archivePrefix = {arXiv},"); }
  if (b.abs_url) lines.push(`  url = {${b.abs_url}},`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");
  lines.push("}");
  return lines.join("\n");
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");
  const add = (raw) => {
    const next = [...new Set([...tags, ...String(raw).split(",").map(s => s.trim()).filter(Boolean)])];
    if (next.length !== tags.length) onChange(next);
    setInput("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map(t => (
        <span key={t} className="group inline-flex items-center gap-1 px-2 py-[3px] rounded-full text-[12px] text-[#d0d0d0] border border-[#ffffff26]">
          {t}
          <button onClick={() => onChange(tags.filter(x => x !== t))}
            className="opacity-0 group-hover:opacity-100 w-3.5 h-3.5 rounded-full bg-[#ffffff26] text-[#e0e0e0] hover:bg-[#d93025] border-none cursor-pointer text-[10px] leading-none flex items-center justify-center">×</button>
        </span>
      ))}
      <input value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (input.trim()) add(input); }
          if (e.key === "Backspace" && !input && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={() => { if (input.trim()) add(input); }}
        placeholder={tags.length ? t("+ 添加") : t("+ 添加标签（回车确认）")}
        className="min-w-[100px] flex-1 bg-transparent outline-none border-none text-[12px] text-[#e8eaed] placeholder:text-[#8a8a8a] py-1" />
    </div>
  );
}

function Figures({ arxivId }) {
  const [figs, setFigs] = useState(null);
  const [lb, setLb] = useState(-1);
  useEffect(() => {
    let alive = true;
    if (!arxivId) { setFigs([]); return undefined; }
    figuresFor(arxivId).then(f => { if (alive) setFigs(f); }).catch(() => { if (alive) setFigs([]); });
    return () => { alive = false; };
  }, [arxivId]);
  if (!arxivId) return <div className="text-[12.5px] text-[#9aa0a6] py-3">{t("只有 arXiv 文献能取到插图")}</div>;
  if (figs === null) return <div className="text-[12.5px] text-[#9aa0a6] py-3">{t("正在找插图…")}</div>;
  if (!figs.length) return <div className="text-[12.5px] text-[#9aa0a6] py-3">{t("这篇没有可用的插图")}</div>;
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {figs.map((f, i) => (
          <button key={f.key || i} onClick={() => setLb(i)} aria-label={t("图 {n}", { n: i + 1 })}
            className="rounded-lg border border-[#ffffff1f] overflow-hidden cursor-zoom-in p-1 bg-[#fff] hover:border-[#7ec8e3]">
            <img src={f.url} alt={t("图 {n}", { n: i + 1 })} loading="lazy" draggable={false} referrerPolicy="no-referrer" className="w-full h-[86px] object-contain" />
          </button>
        ))}
      </div>
      {lb >= 0 && <ImageLightbox images={figs} index={lb} onIndex={setLb} onClose={() => setLb(-1)} />}
    </>
  );
}

function Detail({ b, collections, onUpdate, onRemove }) {
  const [tab, setTab] = useState("abstract");
  const [copied, setCopied] = useState(false);
  if (!b) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[#9aa0a6] p-8 text-center">
        <div className="text-[38px] mb-3">📖</div>
        <div className="text-[13px]">{t("从左侧列表中选择一篇文献")}</div>
      </div>
    );
  }
  const arxivId = arxivOf(b);
  // 有 arXiv 号的用本插件的阅读器打开；别的开原文页
  const open = () => (arxivId ? openViewer(`https://arxiv.org/pdf/${arxivId}`) : (b.abs_url || b.doi) && openTab(b.abs_url || `https://doi.org/${b.doi}`));
  const copyBib = async () => {
    try { await navigator.clipboard.writeText(buildBibtex(b, arxivId)); } catch { return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  const btn = "h-8 shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-3 rounded-lg text-[12px] font-bold cursor-pointer border border-[#ffffff26] bg-transparent";
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 p-5 pb-1">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {b.source && (
            <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider ${b.source === "inspire" ? "bg-[#a142f426] text-[#d7aefb]" : "bg-[#f2828226] text-[#f28b82]"}`}>{b.source}</span>
          )}
          {arxivId && <span className="text-[11px] font-mono rounded-md px-1.5 py-0.5 border border-[#ffffff26] text-[#b8b8b8]">{arxivId}</span>}
          {b.doi && <a href={`https://doi.org/${b.doi}`} target="_blank" rel="noopener noreferrer" className="text-[10.5px] text-[#9aa0a6] hover:text-[#7ec8e3] truncate max-w-[180px]">doi:{b.doi}</a>}
          <button onClick={copyBib} title={t("复制 BibTeX")}
            className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-bold font-mono uppercase border cursor-pointer
              ${copied ? "text-[#81c995] border-[#81c99566] bg-[#81c9951a]" : "text-[#7ec8e3] border-[#ffffff26] bg-transparent hover:bg-[#7ec8e31a]"}`}>
            {copied ? t("已复制") : "BibTeX"}
          </button>
        </div>
        <h2 className="text-[#f1f1f1] text-[16px] font-bold font-serif leading-snug mb-2 mt-0">
          <button onClick={open} className="text-left bg-transparent border-none p-0 cursor-pointer text-inherit font-bold font-serif hover:text-[#7ec8e3] hover:underline">
            <MathText text={b.title || t("(无标题)")} />
          </button>
        </h2>
        <div className="text-[#c8c8c8] text-[12.5px] leading-relaxed">{(b.authors || []).join(", ")}</div>
        <div className="flex items-center gap-3 mt-2 text-[12px] text-[#9aa0a6] flex-wrap">
          {b.year && <span className="tabular-nums">{b.year}</span>}
          {b.journal && <span className="text-[#7ec8e3]">{b.journal}</span>}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1 px-5 border-b border-[#ffffff14]">
        {[["abstract", t("摘要")], ["figures", t("图片")]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`relative px-2 pt-1.5 pb-2 text-[13px] cursor-pointer bg-transparent border-none ${tab === k ? "text-[#fff] font-bold" : "text-[#9aa0a6] hover:text-[#d0d0d0]"}`}>
            {label}
            {tab === k && <span className="absolute left-1/2 -translate-x-1/2 bottom-[-1px] h-[3px] w-6 rounded-full bg-[#7ec8e3]" />}
          </button>
        ))}
      </div>
      <div className="px-5 pt-3 pb-4 flex-1 overflow-y-auto overscroll-contain thin-scrollbar min-h-0">
        {tab === "abstract"
          ? <div className="text-[#d0d0d0] text-[13px] leading-[1.7]"><MathText text={b.abstract || b.summary || t("（暂无摘要）")} /></div>
          : <Figures arxivId={arxivId} />}
      </div>
      <div className="shrink-0 flex items-start gap-2.5 px-5 py-2.5 border-t border-[#ffffff14]">
        <span className="text-[11px] font-bold text-[#9aa0a6] shrink-0 pt-[5px]">{t("标签")}</span>
        <div className="flex-1 min-w-0"><TagEditor tags={b.tags || []} onChange={(tags) => onUpdate(b.id, { tags })} /></div>
      </div>
      <div className="shrink-0 p-3 border-t border-[#ffffff14] flex items-center gap-2">
        {(arxivId || b.pdf_url) && (
          <button onClick={() => (arxivId ? openViewer(`https://arxiv.org/pdf/${arxivId}`) : openTab(b.pdf_url))}
            className={`${btn} text-[#f28b82] hover:bg-[#f28b821a]`}>PDF</button>
        )}
        {b.abs_url && <button onClick={() => openTab(b.abs_url)} className={`${btn} text-[#7ec8e3] hover:bg-[#7ec8e31a]`}>{t("摘要页")}</button>}
        <div className="ml-auto flex items-center gap-2 min-w-0">
          <MenuSelect value={b.collection_id || ""} onChange={(v) => onUpdate(b.id, { collection_id: v || null })} up
            options={[["", t("未分类")], ...collections.map(c => [c.id, c.name])]} />
          <button onClick={() => onRemove(b.id)} className={`${btn} text-[#9aa0a6] hover:text-[#f28b82] hover:bg-[#f28b821a]`}>{t("移除")}</button>
        </div>
      </div>
    </div>
  );
}

