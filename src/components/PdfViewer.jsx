import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  paperKeyFromUrl, anchorsFromSelection, reanchorByQuote, norm as normQuote, areaAnchor, pageCanvasBox, commentKeyOf,
} from "../lib/pdfAnchor";
import {
  baseOf, loadMine, watchPaper, addAnnotation, updateAnnotation, deleteAnnotation, setVisibility,
  copyAnnotation, copiedSourceIds, syncPaper, fetchOthers, exportMarkdown, normTags,
} from "../lib/notes";
import { countComments } from "../lib/comments";
import { sitePaperUrl } from "../lib/config";
import {
  useHighlightLayer, SelectionBar, NotesList, AnnEditor, collectTags,
  AreaStyleMenu, AnnMenu, AreaEditBox, loadAreaStyle, saveAreaStyle, rgba,
  PenMenu, loadPenStyle, savePenStyle, inkPathD, simplify, distToSeg,
  TextBoxEditor, loadTextStyle, saveTextStyle, NotePopup, NOTE_SIZE, loadNoteColor, saveNoteColor,
} from "./PdfNotes";
import PaperComments from "./PaperComments";
import RefCard from "./RefCard";
import TranslatePop from "./TranslatePop";
import SettingsDialog from "./SettingsDialog";
import { useSettings } from "../lib/settings";
import { useEquationCopy } from "./EqCopy";
import { extractReferences, citeGroup, citeGroupRect, destKey } from "../lib/refs";
import { createPdfium } from "../lib/pdfium/client";
import { tokenize, trimSelection, buildTextLayer } from "../lib/pdfium/textLayer";
import { EventBus, PdfiumViewer, PdfiumDocument, makeLinkService } from "../lib/pdfium/viewer";
import { Avatar, Icon } from "./bits";

/**
 * 阅读器本体。从网站的 PdfViewer 搬过来，改了三处：
 * - 占满整个标签页（网站那份是嵌在卡片里的一块，所以去掉了全屏和移动端浮层）
 * - 笔记读写走 lib/notes（本地优先，登录了才同步），不再要求登录才能标注
 * - 右边多一栏论文评论
 *
 * pdf.js 的坑（组件层串行 import、.page 的 content-box、按宽度重排、高亮量 .canvasWrapper）
 * 全部原样保留，原因见各处注释和网站 docs/dev/papers.md。
 */

/* 浮在标注 / 选区上方的小工具条的位置（.pdfViewer 内容坐标）。
   上方离阅读区顶边不够 need 像素时翻到下方 —— 否则贴近页顶的框，工具条会被顶栏盖住 */
function floatPos(r, vb, need) {
  const top = document.querySelector(".pdfViewer")?.parentElement?.getBoundingClientRect().top ?? 0;
  const below = r.top - top < need;
  return { x: r.left + r.width / 2 - vb.left, y: (below ? r.bottom : r.top) - vb.top, below };
}

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

/* PDFium（WebAssembly）跑在一个 Worker 里，整个扩展页共用一个（换论文不重启 wasm） */
let pdfiumClient = null;
let docSeq = 0;
const getPdfium = () => (pdfiumClient ||= createPdfium());

const IconSidebar = <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" /></>;
const IconMinus = <line x1="5" y1="12" x2="19" y2="12" />;
const IconPlus = <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>;
const IconUp = <polyline points="18 15 12 9 6 15" />;
const IconDown = <polyline points="6 9 12 15 18 9" />;
const IconSearch = <><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>;
const IconOpen = <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></>;
const IconPen = <><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></>;
const IconTextBox = <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 8h8M12 8v9" /></>;
const IconEraser = <><path d="M20 20H7L3 16a2 2 0 0 1 0-2.8L13.2 3a2 2 0 0 1 2.8 0L21 8a2 2 0 0 1 0 2.8L11 20" /><path d="M6 11l7 7" /></>;
const IconArea = <><path d="M3 8V5a2 2 0 0 1 2-2h3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M21 16v3a2 2 0 0 1-2 2h-3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /></>;
const IconFull = <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>;
const IconDownload = <><path d="M12 4v11" /><polyline points="7 10 12 15 17 10" /><path d="M5 20h14" /></>;
const IconThumbs = <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></>;
const IconOutline = <><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>;
const IconNotes = <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></>;
const IconGear = <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>;
const IconNote = <><path d="M20 15.5a1.5 1.5 0 0 1-1.5 1.5H8.5L4 20.5V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5z" /><path d="M8 8.5h8M8 12.5h5" /></>;
const IconSplit = <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="12" y1="4" x2="12" y2="20" /></>;
const IconRotate = <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><polyline points="20 4 20 10 14 10" /></>;
const IconChat = <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />;

const TBtn = ({ onClick, title, disabled, active, children }) => (
  <button onClick={onClick} title={title} disabled={disabled}
    className={`h-7 min-w-7 px-1 rounded-md flex items-center justify-center gap-1 border-none cursor-pointer shrink-0 text-[11.5px]
      ${disabled ? "text-[#ffffff4d] bg-transparent cursor-not-allowed"
        : active ? "text-[#fff] bg-[#ffffff33]"
        : "text-[#e6e6e6] bg-transparent hover:bg-[#ffffff26]"}`}>
    {children}
  </button>
);

/* 目录一项：默认收起只露顶层，点三角展开、点标题跳转（两件事分开） */
function OutlineNode({ node, depth, onGo, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const kids = node.items?.length ? node.items : null;
  return (
    <>
      <div className="flex items-start" style={{ paddingLeft: 2 + depth * 10 }}>
        {kids ? (
          <button onClick={() => setOpen(v => !v)} title={open ? "收起" : "展开"}
            className="w-[18px] h-[22px] shrink-0 flex items-center justify-center rounded
                       bg-transparent border-none cursor-pointer text-[#9a9a9a] hover:text-[#fff] hover:bg-[#ffffff1a]">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
              strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}>
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
        ) : <span className="w-[18px] shrink-0" />}
        <button onClick={() => onGo(node.dest)}
          className="flex-1 min-w-0 text-left py-1.5 px-1 rounded text-[13px] leading-snug font-sans
                     text-[#d8d8d8] bg-transparent border-none cursor-pointer hover:text-[#fff] hover:bg-[#ffffff1a]">
          {node.title || "（无标题）"}
        </button>
      </div>
      {open && kids?.map((c, i) => <OutlineNode key={i} node={c} depth={depth + 1} onGo={onGo} />)}
    </>
  );
}

/* 同步状态：一眼看出笔记现在在哪 —— 只在本机 / 已上云 / 有没推上去的 */
function SyncBadge({ uid, state, pending, onLogin, onSync }) {
  if (!uid) {
    return (
      <button onClick={onLogin} title="笔记目前只存在这台电脑上。登录 ResearchHub 后会和网站同步"
        className="h-7 px-2 rounded-md text-[11.5px] text-[#ffcf7a] bg-[#ffcf7a14] border-none cursor-pointer hover:bg-[#ffcf7a26] shrink-0">
        仅本机 · 登录同步
      </button>
    );
  }
  const label = state.busy ? "同步中…" : state.error ? `未同步${pending ? ` ${pending}` : ""}` : pending ? `待同步 ${pending}` : "已同步";
  const color = state.error ? "text-[#ff9a9a]" : state.busy || pending ? "text-[#c8c8c8]" : "text-[#7ee3a0]";
  return (
    <button onClick={onSync} disabled={state.busy}
      title={state.error ? `${state.error}，点一下重试` : "和 ResearchHub 同步（点一下立即同步）"}
      className={`h-7 px-2 rounded-md text-[11.5px] bg-transparent border-none cursor-pointer hover:bg-[#ffffff1a] shrink-0 ${color}`}>
      {label}
    </button>
  );
}

export default function PdfViewer({ url, title, session, onLogin, initialPanel }) {
  const containerRef = useRef(null);
  const viewerElRef = useRef(null);
  const apiRef = useRef(null);        // { viewer, linkService, eventBus }
  /* 分屏（SplitPane）开没开 */
  const [splitOpen, setSplitOpen] = useState(false);
  /* 只有一个工具栏（同 Zotero）：页码 / 缩放 / 搜索 / 目录 / 缩略图都作用于「最后点过的那一栏」 */
  const [activePane, setActivePane] = useState("main");
  const splitApiRef = useRef(null);
  const [splitReady, setSplitReady] = useState(false);
  const [splitView, setSplitView] = useState({ page: 1, zoom: 1, mode: null });

  // doc 必须进 state（缩略图栏在渲染期用它，读 ref 不会触发重渲染）
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [outline, setOutline] = useState(null);
  /* 左侧栏：**盖在正文上滑出**，不挤压 PDF（同 Edge 的阅读器）。默认收起；
     开没开、停在哪个 tab 都记在本机 —— 自己打开过的，下次进来还开着。
     rh_side 老版本存的是 tab 名或 "none"，这里照样认 */
  const [sideOpen, setSideOpenRaw] = useState(() => { const v = localStorage.getItem("rh_side"); return !!v && v !== "none"; });
  const [sideTab, setSideTabRaw] = useState(() => localStorage.getItem("rh_side_tab") || "notes");   // outline | thumbs | notes
  const setSideOpen = (v) => setSideOpenRaw(prev => {
    const next = typeof v === "function" ? v(prev) : v;
    localStorage.setItem("rh_side", next ? "open" : "none");
    return next;
  });
  const setSideTab = (k) => { setSideTabRaw(k); localStorage.setItem("rh_side_tab", k); setSideOpen(true); };
  const [rightOpen, setRightOpen] = useState(initialPanel === "comments");
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");

  /* ── 笔记 / 标注 ──────────────────────────────────────────────── */
  const uid = session?.uid || null;
  const me = session ? { id: session.uid, name: session.profile?.name || session.email,
                         username: session.profile?.username, avatar_url: session.profile?.avatar_url } : null;
  const paperKey = useMemo(() => paperKeyFromUrl(url), [url]);
  const base = baseOf(paperKey);
  const commentKey = commentKeyOf(paperKey);
  const meta = useMemo(() => ({ title, url }), [title, url]);
  const [myNote, setMyNote] = useState(null);
  const [mine, setMine] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [others, setOthers] = useState([]);
  const [scope, setScope] = useState("all");
  const [activeId, setActiveId] = useState(null);
  const [annMenu, setAnnMenu] = useState(null);     // 点标注弹出的编辑条 { id, pos }
  /* 正在编辑的文本框（「添加文本」工具新放的，或者点了已有的）：
     { id|null, paper_key, page, rect:{x,y,w,h}, body, color, style:{size,spacing}, orig } */
  const [textEdit, setTextEditRaw] = useState(null);
  const textEditRef = useRef(null);
  const setTextEdit = (v) => { textEditRef.current = v; setTextEditRaw(v); };
  /* 打开着的附注卡片：{ id|null, paper_key, page, rect:{x,y}, body, color, replies, at, author, mine, me, orig } */
  const [noteEdit, setNoteEditRaw] = useState(null);
  const noteEditRef = useRef(null);
  const setNoteEdit = (v) => { noteEditRef.current = v; setNoteEditRaw(v); };
  const [trans, setTrans] = useState(null);         // 划词翻译弹窗 { anchors, text, pos }
  const [settingsOpen, setSettingsOpen] = useState(false);
  /* 译文弹窗的位置：默认放在选区**下方**（上方是刚读过的内容，盖住它最碍事），
     下面放不下才翻到上方；水平方向夹在阅读区里，别伸出边外被裁掉 */
  const transPos = (rectList) => {
    const vb = viewerElRef.current.getBoundingClientRect();
    const cb = containerRef.current.getBoundingClientRect();
    const rs = [...rectList].filter(r => r.width > 0.5 && r.height > 0.5);
    const top = Math.min(...rs.map(r => r.top)), bottom = Math.max(...rs.map(r => r.bottom));
    const left = Math.min(...rs.map(r => r.left)), right = Math.max(...rs.map(r => r.right));
    const half = Math.min(200, cb.width / 2 - 16);
    const cx = Math.min(Math.max((left + right) / 2, cb.left + half + 8), cb.right - half - 8);
    const below = cb.bottom - bottom > 220 || cb.bottom - bottom > top - cb.top;
    return { x: cx - vb.left, y: (below ? bottom : top) - vb.top, below };
  };
  /* 翻译框钉住：常驻浮窗，位置和钉住状态都记在本机（刷新后还在） */
  const [transPin, setTransPin] = useState(() => localStorage.getItem("rh_trans_pin") === "1");
  const [transFixed, setTransFixed] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem("rh_trans_pos") || "null"); if (v) return v; } catch { /* 坏值 */ }
    return { left: Math.max(16, window.innerWidth - 440), top: 56 };
  });
  const transPinRef = useRef(transPin);
  transPinRef.current = transPin;
  const pinTrans = (on, rect) => {
    setTransPin(on);
    localStorage.setItem("rh_trans_pin", on ? "1" : "0");
    if (on && rect) { setTransFixed(rect); localStorage.setItem("rh_trans_pos", JSON.stringify(rect)); }
    if (!on) setTrans(null);
  };
  const transFixedRef = useRef(transFixed);
  transFixedRef.current = transFixed;
  const transPosRef = useRef(transPos);
  transPosRef.current = transPos;
  const settings = useSettings();
  // 公式旁的「复制 LaTeX」按钮（components/EqCopy.js）
  useEquationCopy(viewerElRef, apiRef, doc, paperKey.replace(/^arxiv:/, ""), settings.eqCopy);
  const autoTransRef = useRef(false);
  autoTransRef.current = settings.autoTranslate;    // 划选监听只挂一次，靠 ref 读最新设置
  const [selPos, setSelPos] = useState(null);
  const [pending, setPending] = useState(null);
  const [draft, setDraft] = useState(null);
  const [fixes, setFixes] = useState({});
  const [exported, setExported] = useState(false);
  const [sync, setSync] = useState({ busy: false, error: null });
  const [commentCount, setCommentCount] = useState(null);
  const [tool, setTool] = useState("text");
  const toolRef = useRef(tool);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  const [markKind, setMarkKind] = useState(() =>
    localStorage.getItem("rh_mark_kind") === "underline" ? "underline" : "highlight");
  const pickMarkKind = (k) => { setMarkKind(k); localStorage.setItem("rh_mark_kind", k); };

  const reload = useCallback(async () => {
    if (!paperKey) return;
    const r = await loadMine(paperKey, uid);
    setMyNote(r.note); setMine(r.annotations); setPendingCount(r.pending);
  }, [paperKey, uid]);

  useEffect(() => {
    setFixes({});
    reload();
    return watchPaper(paperKey, reload);    // 别的标签页改了、同步写回了，都跟着刷新
  }, [paperKey, reload]);

  useEffect(() => {
    if (!paperKey) return;
    let alive = true;
    fetchOthers(paperKey, uid).then(o => { if (alive) setOthers(o); }).catch(() => {});
    return () => { alive = false; };
  }, [paperKey, uid]);

  useEffect(() => {
    if (!commentKey) return;
    countComments(commentKey).then(n => { if (n !== null) setCommentCount(n); });
  }, [commentKey]);

  /* 同步：打开时一次，之后**每次用户改动**攒 1.5 秒推一次。
     触发源是 editTick（用户动作），不是 pendingCount —— 后者在同步失败时一直非零，
     拿它当触发条件就是每 1.5 秒撞一次墙。失败了不自动重试，等下一次改动或手动点 */
  const syncing = useRef(false);
  const again = useRef(false);
  const runSync = useCallback(async () => {
    if (!uid || !base) return;
    if (syncing.current) { again.current = true; return; }   // 正在同步：完了再补一轮
    syncing.current = true;
    setSync({ busy: true, error: null });
    let r;
    do {
      again.current = false;
      r = await syncPaper(base, uid);
    } while (again.current && r.ok);
    syncing.current = false;
    setSync({ busy: false, error: r.ok ? null : r.error });
  }, [uid, base]);
  useEffect(() => { runSync(); }, [runSync]);
  const [editTick, setEditTick] = useState(0);
  const bump = () => setEditTick(t => t + 1);
  useEffect(() => {
    if (!uid || !editTick) return;
    const t = setTimeout(runSync, 1500);
    return () => clearTimeout(t);
  }, [uid, editTick, runSync]);

  /* 别的版本做的标注：坐标一律不用，降级成页级 + 「位置可能不准」，再按 quote 找回页码 */
  const applyFix = useCallback((a) => {
    if (!a.paper_key || a.paper_key === paperKey) return a;
    const fix = fixes[a.id];
    return { ...a, rects: null, stale: true, page: fix?.page ?? a.page };
  }, [paperKey, fixes]);

  const mineView = useMemo(() => mine.map(applyFix), [mine, applyFix]);
  const othersView = useMemo(
    () => others.map(o => ({ ...o, annotations: o.annotations.map(applyFix) })),
    [others, applyFix]);

  const foreignIds = useMemo(() => {
    const all = [...mine, ...others.flatMap(o => o.annotations)];
    return all.filter(a => a.paper_key && a.paper_key !== paperKey && !fixes[a.id]);
  }, [mine, others, paperKey, fixes]);

  /* 全文按页抽一次就缓存（按 doc 记）：以前「别的版本来的标注」数量每变一次（自己的先到、别人的后到）
     就把整篇重新抽一遍，几十页的论文要白跑好几秒 */
  const pageTextsRef = useRef({ doc: null, job: null });
  useEffect(() => {
    if (!doc || foreignIds.length === 0) return;
    let alive = true;
    (async () => {
      if (pageTextsRef.current.doc !== doc) {
        pageTextsRef.current = {
          doc,
          job: (async () => {
            const out = [];
            for (let i = 1; i <= doc.numPages; i++) {
              try {
                // 和文字层同一份字符（lib/pdfium/textLayer 的 tokenize：连字符、重音都处理过）
                const words = tokenize(await doc.text(i - 1)).filter(t => t.t === "w").map(t => t.text);
                out.push({ page: i, text: normQuote(words.join(" ")) });
              } catch { /* 单页抽不出来就跳过 */ }
            }
            return out;
          })(),
        };
      }
      const texts = await pageTextsRef.current.job;
      if (!alive) return;
      const next = {};
      foreignIds.forEach(a => { next[a.id] = { page: reanchorByQuote(texts, a) ?? a.page }; });
      setFixes(prev => ({ ...prev, ...next }));
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, foreignIds.length]);

  const visibleAnns = useMemo(() => {
    const list = [];
    /* 指上去的浮卡（附注、框选、高亮、下划线）要显示作者名：给这些挂一个 _author（手写、文本框没有浮卡，不用复制） */
    const myName = me?.name || "我";
    if (scope !== "others") list.push(...mineView.map(a => (a.rects?.length && a.kind !== "ink" && a.kind !== "text" ? { ...a, _author: myName } : a)));
    if (scope !== "mine") othersView.forEach(o => list.push(...o.annotations.map(a => (a.rects?.length && a.kind !== "ink" && a.kind !== "text"
      ? { ...a, _author: o.author?.name || o.author?.username || "" } : a))));
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, mineView, othersView, me?.name]);

  /* 点中的是自己的区域框 ⇒ 进入拖动 / 缩放（正文上那个先不画，由编辑框代替） */
  const editArea = annMenu
    ? mineView.find(x => x.id === annMenu.id && x.kind === "area" && x.rects?.length === 1 && !x.stale) || null
    : null;

  const mineIdsRef = useRef(new Set());
  mineIdsRef.current = new Set(mineView.map(x => x.id));
  const mineViewRef = useRef([]);
  mineViewRef.current = mineView;
  useHighlightLayer(viewerElRef, apiRef, doc, visibleAnns, {
    hiddenId: editArea?.id || textEdit?.id,
    activeId,
    /* 点正文上的标注：选中它，并在它上方弹出编辑条（换颜色 / 线型 / 批注 / 删除）；
       自己的文本框直接进入编辑（同 Edge：点文字就能改） */
    onPick: useCallback((a, el) => {
      if (a.kind === "text" && mineIdsRef.current.has(a.id)) { openTextRef.current?.(a); return; }
      if (a.kind === "note") { openNoteRef.current?.(a); return; }
      setActiveId(a.id);
      const r = el?.getBoundingClientRect();
      const vb = viewerElRef.current?.getBoundingClientRect();
      if (r && vb) setAnnMenu({ id: a.id, pos: floatPos(r, vb, 120) });
    }, []),
  });

  /* ── PDFium（lib/pdfium/viewer.js）──────────────────────────────────
     整个文件先下载下来交给 Worker 里的 PDFium 解析（pdf.js 那种按需分段下载这里不需要：arXiv 的论文
     一般几 MB，下载比解析慢得多，解析 15 页才几十毫秒） */
  useEffect(() => {
    let alive = true;
    let viewer = null, handle = null;
    (async () => {
      try {
        const pdf = getPdfium();
        const eventBus = new EventBus();
        viewer = new PdfiumViewer({ container: containerRef.current, viewer: viewerElRef.current, eventBus });
        const linkService = makeLinkService(viewer);
        eventBus.on("pagesinit", () => {
          viewer.currentScaleValue = "page-actual";     // 默认 100%（纸面原尺寸），不按宽度撑满
          if (alive) setZoom(viewer.currentScale);
        });
        eventBus.on("pagechanging", (e) => { if (alive) setPage(e.pageNumber); });
        // presetValue：page-width / page-fit 这类「自动」倍数时有值，下拉菜单靠它打勾
        eventBus.on("scalechanging", (e) => { if (alive) { setZoom(e.scale); setScaleMode(e.presetValue || null); } });

        const res = await fetch(url);
        if (!res.ok) throw new Error(`下载 PDF 失败（${res.status}）`);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf.slice(0));       // 留一份原始字节给「下载」用（buf 会被转交给 Worker）
        const docId = `d${++docSeq}`;
        const info = await pdf.open(docId, buf);
        if (!alive) { pdf.close(docId); return; }
        handle = new PdfiumDocument(pdf, docId, info, bytes);
        viewer.setDocument(handle);
        apiRef.current = { viewer, linkService, eventBus };
        setTotal(handle.numPages);
        setDoc(handle);
        handle.outline().then(o => { if (alive) setOutline(o || []); }).catch(() => { if (alive) setOutline([]); });
      } catch (e) {
        console.error("[PdfViewer]", url, e);
        if (alive) setErr(e?.message || "加载失败");
      }
    })();
    return () => {
      alive = false;
      try { viewer?.destroy(); } catch { /* 已经拆了 */ }
      try { handle?.destroy(); } catch { /* 同上 */ }
      apiRef.current = null;
    };
  }, [url]);

  /* 容器宽度变了要自己重排（组件层不管，官方 viewer 的 app.js 才管）。
     只有「自动」类倍数才跟着变，用户手动定过的别改 */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let w = el.clientWidth, h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w && el.clientHeight === h) return;
      const onlyH = el.clientWidth === w;
      w = el.clientWidth; h = el.clientHeight;
      const v = apiRef.current?.viewer.currentScaleValue;
      // 只是高度变了（上下分屏、拖分隔条）：只有「适合页面 / 高度」要重算
      if (onlyH ? (v === "page-fit" || v === "page-height") : (v === "page-width" || v === "auto" || v === "page-fit" || v === "page-actual")) {
        apiRef.current.viewer.currentScaleValue = v;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [scaleMode, setScaleMode] = useState("page-actual");   // 当前是不是某个自动倍数（下拉菜单打勾用）
  /* 顶栏操作的是哪一栏：分屏时是最后点过的那一栏（见 activePane） */
  const onSplit = splitOpen && activePane === "split" && splitReady;
  const act = () => (onSplit && splitApiRef.current) || apiRef.current;
  const vPage = onSplit ? splitView.page : page;
  const vZoom = onSplit ? splitView.zoom : zoom;
  const vMode = onSplit ? splitView.mode : scaleMode;

  /* 缩放输入框：10%–500%，非法输入还原 */
  const [zoomInput, setZoomInput] = useState("100");
  const zoomEditingRef = useRef(false);
  useEffect(() => { if (!zoomEditingRef.current) setZoomInput(String(Math.round(vZoom * 100))); }, [vZoom]);
  const commitZoomInput = () => {
    const n = parseInt(zoomInput, 10);
    if (Number.isFinite(n) && n > 0) setScale(Math.min(500, Math.max(10, n)) / 100);
    setZoomInput(String(Math.round(vZoom * 100)));
  };
  const setScale = (v) => { const a = act(); if (a) a.viewer.currentScaleValue = String(v); };
  const stepZoom = (dir) => {
    const i = ZOOMS.findIndex(z => z > vZoom + 0.001);
    const next = dir > 0
      ? ZOOMS[i === -1 ? ZOOMS.length - 1 : i]
      : ZOOMS[Math.max(0, (i === -1 ? ZOOMS.length : i) - 2)];
    setScale(next);
  };
  const goPage = (n) => {
    const a = act();
    if (a && n >= 1 && n <= total) a.viewer.currentPageNumber = n;
  };
  // 跳到某条标注：标注的编辑都在主阅读区，总是跳主阅读区
  const goPageMain = (n) => {
    const a = apiRef.current;
    if (a && n >= 1 && n <= total) a.viewer.currentPageNumber = n;
  };
  // 页码输入框用本地 state：滚动会不停改 page，直接绑的话打到一半就被覆盖
  const [pageInput, setPageInput] = useState("");
  const editingRef = useRef(false);
  useEffect(() => { if (!editingRef.current) setPageInput(String(vPage)); }, [vPage]);
  const commitPageInput = () => {
    const n = parseInt(pageInput, 10);
    const ok = Number.isFinite(n) && n >= 1 && n <= total;
    if (ok) goPage(n);
    setPageInput(String(ok ? n : vPage));
  };
  const goDest = (dest) => act()?.linkService.goToDestination(dest);

  /* ── 划选 → 工具条（放进 .pdfViewer 的内容坐标里，跟着页面滚） ── */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const clear = () => { setSelPos(null); setPending(null); };
    const onUp = (e) => {
      if (e.target?.closest?.(".rh-selbar")) return;
      // 框选模式下 pointerup 刚放进 pending，紧跟的 mouseup 读到空选区会把它清掉
      if (toolRef.current !== "text") return;      // 框选 / 画笔 / 橡皮擦模式下不弹划选工具条
      setTimeout(() => {
        const sel = window.getSelection();
        trimSelection(sel);                  // 双击选词会连带两边的空格，先修掉（看得见的选区也一起修）
        const anchors = anchorsFromSelection(sel, el);
        if (!anchors.length) { clear(); return; }
        const rects = sel.getRangeAt(0).getClientRects();
        const last = rects[rects.length - 1];
        const vb = viewerElRef.current?.getBoundingClientRect();
        if (!last || !vb) { clear(); return; }
        setPending(anchors);
        /* 工具条放在**整段选区的最上面**，水平居中于选区。以前按最后一行的上沿放，
           选了好几行时工具条正好盖在前面几行上 */
        const rs = [...rects].filter(r => r.width > 0.5 && r.height > 0.5);
        const top = Math.min(...rs.map(r => r.top));
        const firstLine = rs.filter(r => r.top - top < 2);
        const cx = (Math.min(...firstLine.map(r => r.left)) + Math.max(...firstLine.map(r => r.right))) / 2;
        setSelPos({ x: cx - vb.left, y: top - vb.top });
        /* 设置里开了「选中直接翻译」：工具条照常在上面，译文弹在选区下面 */
        // 翻译框钉住了：不管开没开「直接翻译」，选中的都翻进那个浮窗
        if ((autoTransRef.current || transPinRef.current) && anchors[0].quote?.length > 1) {
          setTrans({ anchors, text: anchors[0].quote, pos: transPosRef.current(rects) });
        }
      }, 0);
    };
    el.addEventListener("mouseup", onUp);
    return () => el.removeEventListener("mouseup", onUp);
  }, []);

  const clearSel = useCallback(() => {
    setSelPos(null); setPending(null);
    ghostRef.current?.remove();          // 框选完还没选颜色时留着的那个虚线框
    ghostRef.current = null;
    window.getSelection()?.removeAllRanges();
  }, []);

  /* ── 文献卡片：点正文里的引用号（hyperref 的 cite.* 链接）弹出，不再直接跳到文末 ──
     捕获阶段拦截：链接元素上自己挂了 onclick 跳转（lib/pdfium/viewer），祖先节点捕获阶段 stopPropagation
     就到不了它。参考文献表第一次点的时候才抽（要读几页文字），之后缓存 */
  const [refCard, setRefCard] = useState(null);      // { group, current, pos }
  const refsRef = useRef(null);
  useEffect(() => {
    refsRef.current = null;
    setRefCard(null);
    const el = containerRef.current;
    if (!el || !doc) return;
    const onClick = async (e) => {
      const a = e.target?.closest?.(".annotationLayer a");
      if (!a?.dataset.destPage) return;
      const num = (v) => (v == null ? null : Number(v));
      const dest = { pageIndex: Number(a.dataset.destPage), x: num(a.dataset.destX), y: num(a.dataset.destY) };
      e.preventDefault();
      e.stopPropagation();
      refsRef.current ||= extractReferences(doc).catch(() => null);
      // 第一次点、后台预扫还没完：给个等待光标，别像点了没反应
      el.style.cursor = "progress";
      const refs = await refsRef.current;
      el.style.cursor = "";
      // 不是指向参考文献的链接（章节、公式、图……）就照常跳转
      const entry = refs?.byPos.get(destKey(dest.pageIndex, dest.x, dest.y));
      if (!entry) { apiRef.current?.viewer.goToDest(dest); return; }
      let group = citeGroup(a, entry.label).filter(l => refs.byLabel.has(l));
      if (!group.includes(entry.label)) group = [entry.label];
      // 卡片放在链接下方（下面放不下就放上方），水平方向夹在可视区里
      const r = a.getBoundingClientRect();
      const vb = viewerElRef.current.getBoundingClientRect();
      const cb = el.getBoundingClientRect();
      const w = Math.min(580, el.clientWidth - 24);
      const minX = cb.left - vb.left + 12, maxX = cb.left - vb.left + el.clientWidth - w - 12;
      const x = Math.min(Math.max(r.left + r.width / 2 - vb.left - w / 2, minX), Math.max(minX, maxX));
      const above = cb.bottom - r.bottom < 320 && r.top - cb.top > cb.bottom - r.bottom;
      setRefCard({ group, current: entry.label, entries: refs.byLabel,
                   pos: { x, w, y: above ? r.top - vb.top - 6 : r.bottom - vb.top + 6, above } });
    };
    el.addEventListener("click", onClick, true);
    /* 打开 3 秒后、浏览器空闲时先把参考文献表抽好：要扫一遍每页的链接注解，长论文得好几秒，
       放到第一次点引用号时才做，那一下就像卡住了 */
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1));
    const t = setTimeout(() => idle(() => { refsRef.current ||= extractReferences(doc).catch(() => null); }), 3000);
    return () => { clearTimeout(t); el.removeEventListener("click", onClick, true); };
  }, [doc]);
  const closeRefCard = useCallback(() => setRefCard(null), []);

  /* 框选默认样式（工具栏框选按钮右边的下拉里改） */
  const [areaStyle, setAreaStyle] = useState(loadAreaStyle);
  const areaStyleRef = useRef(areaStyle);
  useEffect(() => { areaStyleRef.current = areaStyle; saveAreaStyle(areaStyle); }, [areaStyle]);
  const ghostRef = useRef(null);

  /* 点标注弹出的编辑条。点别处 / Esc 收起 */
  useEffect(() => {
    if (!annMenu) return;
    const close = (e) => {
      if (e.target?.closest?.(".rh-selbar") || e.target?.closest?.("[data-ann-id]")) return;
      setAnnMenu(null);
    };
    const onKey = (e) => { if (e.key === "Escape") setAnnMenu(null); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [annMenu]);

  /* ── 区域框选：在一页上拖一个框（不跨页），pointer 事件 + capture ── */
  useEffect(() => {
    if (tool !== "area") return;
    const el = containerRef.current;
    if (!el) return;
    let st = null;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const rectOf = (e) => {
      const { box, x0, y0 } = st;
      const x1 = clamp((e.clientX - box.left) / box.width);
      const y1 = clamp((e.clientY - box.top) / box.height);
      return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    };
    const paintGhost = (r) => {
      Object.assign(st.ghost.style, {
        left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`,
      });
    };
    const end = (keep = false) => {
      if (!st) return;
      if (!keep) st.ghost.remove();
      try { el.releasePointerCapture(st.pid); } catch { /* 已经释放了 */ }
      st = null;
    };
    const down = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target?.closest?.(".rh-selbar")) return;
      // 按在已有的标注上 = 想编辑它，不是开始画新框（否则 pointer capture 会把那次 click 吃掉）
      if (e.target?.closest?.("[data-ann-id]")) return;
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl) return;
      e.preventDefault();
      clearSel();
      setAnnMenu(null);
      const box = pageCanvasBox(pageEl);
      const ghost = document.createElement("div");
      /* 拖的时候和拖完等着选颜色的时候都是虚线框，颜色 / 粗细按当前默认样式 */
      const { color, width } = areaStyleRef.current;
      ghost.style.cssText = "position:absolute;z-index:2;pointer-events:none;box-sizing:border-box;" +
        `border:${width}px dashed ${rgba(color, 0.95)};background:${rgba(color, 0.08)};border-radius:2px`;
      pageEl.appendChild(ghost);
      st = {
        pageEl, box, ghost, pid: e.pointerId,
        x0: clamp((e.clientX - box.left) / box.width), y0: clamp((e.clientY - box.top) / box.height),
      };
      paintGhost({ x: st.x0, y: st.y0, w: 0, h: 0 });
      try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    };
    const move = (e) => { if (st && e.pointerId === st.pid) paintGhost(rectOf(e)); };
    const up = (e) => {
      if (!st || e.pointerId !== st.pid) return;
      const r = rectOf(e);
      const { box, pageEl, ghost } = st;
      const tiny = r.w * box.width < 10 || r.h * box.height < 10;   // 手抖点了一下
      const vb = viewerElRef.current?.getBoundingClientRect();
      if (tiny || !vb) { end(); return; }
      end(true);                       // 虚线框留着，直到存好（clearSel 里删）
      ghostRef.current = ghost;
      /* 默认样式已经选好了 ⇒ 松手直接存，不再弹颜色条让人再选一遍；
         存完自动选中它，可以马上拖动 / 缩放 / 改样式 */
      const top = box.top + r.y * box.height;
      saveAreaRef.current(areaAnchor(pageEl, r), floatPos({ left: box.left + r.x * box.width, width: r.w * box.width, top,
                                                            bottom: top + r.h * box.height }, vb, 120));
    };
    const onKey = (e) => { if (e.key === "Escape") { end(); clearSel(); setTool("text"); } };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", end);
    window.addEventListener("keydown", onKey);
    return () => {
      end();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", onKey);
    };
  }, [tool, clearSel]);

  /* ── 添加文本 ────────────────────────────────────────────────────
     工具打开时点页面空白处放一个文本框（不点到已有标注上），点外面 / Esc 收起：
     有字就存（新建或更新），没字就当没加过、已经存过的就删掉。
     收起和「再放一个」是同一下点击：刚收起的那一下不再新建（同 Edge），所以记一个时间戳 */
  const [textStyle, setTextStyle] = useState(loadTextStyle);
  const textStyleRef = useRef(textStyle);
  textStyleRef.current = textStyle;
  const textClosedAt = useRef(0);
  const overlayRef = useRef(null);       // 浮层那一层（放「添加文本」跟着鼠标的虚线框）
  const openTextRef = useRef(null);
  openTextRef.current = (a) => {
    setAnnMenu(null);
    const r = a.rects[0];
    const t = { id: a.id, paper_key: a.paper_key || paperKey, page: a.page, rect: { x: r.x, y: r.y, w: r.w, h: r.h },
                body: a.body || "", color: a.color, style: { size: 12, spacing: 0, ...a.style } };
    setTextEdit({ ...t, orig: JSON.stringify(t) });
  };
  const finishText = useCallback(async () => {
    const t = textEditRef.current;
    if (!t) return;
    textClosedAt.current = performance.now();
    setTextEdit(null);
    const body = t.body.replace(/\s+$/, "");
    const { orig, ...cur } = t;
    if (!body.trim()) {
      if (t.id) { await deleteAnnotation(t.paper_key, t.id); reload(); bump(); }
      return;
    }
    const st = { size: t.style.size, spacing: t.style.spacing };
    setTextStyle({ color: t.color, ...st });
    saveTextStyle({ color: t.color, ...st });
    const rects = [{ x: +t.rect.x.toFixed(4), y: +t.rect.y.toFixed(4), w: +t.rect.w.toFixed(4), h: +(t.rect.h || 0.02).toFixed(4) }];
    if (t.id) {
      if (orig === JSON.stringify({ ...cur, body })) return;          // 什么都没改
      await updateAnnotation(t.paper_key, t.id, { body, rects, color: t.color, style: st });
    } else {
      await addAnnotation(paperKey, meta, { page: t.page, kind: "text", rects, body, color: t.color, style: st, quote: null });
    }
    reload(); bump();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperKey, meta]);
  const deleteText = async () => {
    const t = textEditRef.current;
    setTextEdit(null);
    if (t?.id) { await deleteAnnotation(t.paper_key, t.id); reload(); bump(); }
  };

  useEffect(() => {
    if (tool !== "textbox") return;
    const el = containerRef.current;
    if (!el) return;
    /* 新文本框的大小：一行高；宽度至少放得下占位提示「在此处开始键入…」（约 10 个字）——
       原来写死 220px，字号一大提示就折成两行（踩过） */
    const geom = (pageEl, e) => {
      const box = pageCanvasBox(pageEl);
      const st = textStyleRef.current;
      const k = parseFloat(viewerElRef.current.style.getPropertyValue("--scale-factor")) || 1.333;
      const fontPx = st.size * k;
      const wPx = Math.min(Math.max(200, fontPx * 10 + 16), box.width);
      const hPx = fontPx * 1.3 + 4;
      // 光标落在框里：左边留 6px，竖直方向在第一行中间
      const left = Math.min(Math.max(box.left, e.clientX - 6), box.right - wPx);
      const top = Math.min(Math.max(box.top, e.clientY - hPx / 2), box.bottom - hPx);
      return { box, st, left, top, wPx, hPx };
    };

    /* 跟着鼠标的虚线框：告诉你点下去文本框会放在哪儿（参照 Edge）。直接改 DOM，不走 React —— 每次移动都重渲染太浪费 */
    const ghost = document.createElement("div");
    ghost.style.cssText = "position:absolute;z-index:44;pointer-events:none;box-sizing:border-box;display:none;" +
      "border:1.5px dashed #2f7bd8;border-radius:2px;background:rgba(47,123,216,0.04)";
    overlayRef.current?.appendChild(ghost);
    const hideGhost = () => { ghost.style.display = "none"; };
    const move = (e) => {
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl || textEditRef.current || e.target?.closest?.("[data-ann-id]")) { hideGhost(); return; }
      const { left, top, wPx, hPx } = geom(pageEl, e);
      const vb = viewerElRef.current.getBoundingClientRect();
      Object.assign(ghost.style, {
        display: "block", left: `${left - vb.left}px`, top: `${top - vb.top}px`, width: `${wPx}px`, height: `${hPx}px`,
      });
    };

    const down = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target?.closest?.(".rh-selbar") || e.target?.closest?.("[data-ann-id]")) return;
      if (textEditRef.current || performance.now() - textClosedAt.current < 300) return;
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl) return;
      e.preventDefault();
      setAnnMenu(null);
      hideGhost();
      const { box, st, left, top, wPx } = geom(pageEl, e);
      setTextEdit({
        id: null, paper_key: paperKey, page: Number(pageEl.dataset.pageNumber),
        rect: { x: (left - box.left) / box.width, y: (top - box.top) / box.height, w: wPx / box.width, h: 0 },
        body: "", color: st.color, style: { size: st.size, spacing: st.spacing }, orig: "",
      });
    };
    const onKey = (e) => { if (e.key === "Escape" && !textEditRef.current) setTool("text"); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", hideGhost);
    window.addEventListener("keydown", onKey);
    return () => {
      ghost.remove();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", hideGhost);
      window.removeEventListener("keydown", onKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, paperKey]);

  /* ── 附注（kind = "note"，数据格式见 PdfNotes 的 noteIconEl）──────────────
     「添加附注」工具：点页面放一个图标，旁边弹出卡片写内容；放一个就退出这个工具（同 Edge）。
     点已有的图标打开卡片；自己的图标按住能拖动换位置。卡片收起时保存：
     新附注没写内容就当没加过，已有的附注内容和回复都删空了就删掉 */
  const openNoteRef = useRef(null);
  const noteClosedAt = useRef(0);
  openNoteRef.current = (a) => {
    setAnnMenu(null);
    const isMine = mineIdsRef.current.has(a.id);
    const r = a.rects[0];
    const n = {
      id: a.id, paper_key: a.paper_key || paperKey, page: a.page, rect: { x: r.x, y: r.y },
      body: a.body || "", color: a.color, replies: a.style?.replies || [], at: a.created_at || a.updated_at,
      author: a._author || (isMine ? me?.name || "我" : ""), mine: isMine, me: me?.name || "我",
    };
    setActiveId(a.id);
    setNoteEdit({ ...n, orig: JSON.stringify([n.body, n.replies, n.color, n.rect]) });
  };
  const finishNote = useCallback(async () => {
    const n = noteEditRef.current;
    if (!n) return;
    noteClosedAt.current = performance.now();
    setNoteEdit(null);
    setActiveId(null);
    if (!n.mine) return;
    const body = n.body.replace(/\s+$/, "");
    if (!body.trim() && !n.replies.length) {
      if (n.id) { await deleteAnnotation(n.paper_key, n.id); reload(); bump(); }
      return;
    }
    const style = { replies: n.replies };
    if (n.id) {
      if (n.orig === JSON.stringify([body, n.replies, n.color, n.rect])) return;      // 什么都没改
      const rects = [{ x: +n.rect.x.toFixed(4), y: +n.rect.y.toFixed(4), w: 0, h: 0 }];
      await updateAnnotation(n.paper_key, n.id, { body, style, color: n.color, rects });
    } else {
      const rects = [{ x: +n.rect.x.toFixed(4), y: +n.rect.y.toFixed(4), w: 0, h: 0 }];
      await addAnnotation(paperKey, meta, { page: n.page, kind: "note", rects, body, color: n.color, style, quote: null });
    }
    reload(); bump();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperKey, meta]);
  const deleteNote = async () => {
    const n = noteEditRef.current;
    setNoteEdit(null);
    setActiveId(null);
    if (n?.id) { await deleteAnnotation(n.paper_key, n.id); reload(); bump(); }
  };

  useEffect(() => {
    if (tool !== "note") return;
    const el = containerRef.current;
    if (!el) return;
    /* 图标放下去的位置：鼠标在页面上时，跟着一个和图标一样大的虚线框（同「添加文本」） */
    const where = (pageEl, e) => {
      const box = pageCanvasBox(pageEl);
      return {
        box,
        left: Math.min(Math.max(box.left, e.clientX - NOTE_SIZE / 2), box.right - NOTE_SIZE),
        top: Math.min(Math.max(box.top, e.clientY - NOTE_SIZE / 2), box.bottom - NOTE_SIZE),
      };
    };
    const ghost = document.createElement("div");
    ghost.style.cssText = `position:absolute;z-index:44;pointer-events:none;box-sizing:border-box;display:none;width:${NOTE_SIZE}px;height:${NOTE_SIZE}px;` +
      "border:1.5px dashed #2f7bd8;border-radius:5px;background:rgba(47,123,216,0.06)";
    overlayRef.current?.appendChild(ghost);
    const hideGhost = () => { ghost.style.display = "none"; };
    const move = (e) => {
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl || noteEditRef.current || e.target?.closest?.("[data-ann-id]")) { hideGhost(); return; }
      const { left, top } = where(pageEl, e);
      const vb = viewerElRef.current.getBoundingClientRect();
      Object.assign(ghost.style, { display: "block", left: `${left - vb.left}px`, top: `${top - vb.top}px` });
    };
    const down = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target?.closest?.(".rh-selbar") || e.target?.closest?.("[data-ann-id]")) return;
      if (noteEditRef.current || performance.now() - noteClosedAt.current < 300) return;
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl) return;
      e.preventDefault();
      setAnnMenu(null);
      hideGhost();
      // 图标中心落在点的位置（就是虚线框的位置），整个图标留在页面里
      const { box, left, top } = where(pageEl, e);
      const x = (left - box.left) / box.width, y = (top - box.top) / box.height;
      const name = me?.name || "我";
      setNoteEdit({
        id: null, paper_key: paperKey, page: Number(pageEl.dataset.pageNumber), rect: { x, y },
        body: "", color: loadNoteColor(), replies: [], at: new Date().toISOString(), author: name, mine: true, me: name, orig: "",
      });
      setTool("text");
    };
    const onKey = (e) => { if (e.key === "Escape") setTool("text"); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", hideGhost);
    window.addEventListener("keydown", onKey);
    return () => {
      ghost.remove();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", hideGhost);
      window.removeEventListener("keydown", onKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, paperKey, me?.name]);

  /* 拖动自己的附注图标：直接改图标的 left/top（不走 React），松手再存。
     拖过之后紧跟着的那次 click 吞掉，不然一松手卡片就弹出来了 */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !doc) return;
    let drag = null;
    const down = (e) => {
      if (e.button !== 0) return;
      const icon = e.target?.closest?.(".rh-note");
      const a = icon && mineViewRef.current.find(x => String(x.id) === icon.dataset.annId);
      if (!a) return;
      const pageEl = icon.closest(".page");
      const r = icon.getBoundingClientRect();
      drag = { icon, a, box: pageCanvasBox(pageEl), sx: e.clientX, sy: e.clientY, l: r.left, t: r.top, moved: false };
      e.preventDefault();
    };
    const move = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      const { box } = drag;
      drag.x = Math.min(Math.max(0, drag.l + dx - box.left), box.width - NOTE_SIZE) / box.width;
      drag.y = Math.min(Math.max(0, drag.t + dy - box.top), box.height - NOTE_SIZE) / box.height;
      drag.icon.style.left = `${drag.x * 100}%`;
      drag.icon.style.top = `${drag.y * 100}%`;
    };
    const up = async () => {
      const d = drag;
      drag = null;
      if (!d?.moved) return;
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      await updateAnnotation(d.a.paper_key || paperKey, d.a.id,
        { rects: [{ x: +d.x.toFixed(4), y: +d.y.toFixed(4), w: 0, h: 0 }] });
      reload(); bump();
    };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, paperKey]);

  /* ── 画笔 / 橡皮擦 ───────────────────────────────────────────────
     一笔一条标注（kind = "ink"，数据格式见 PdfNotes 的 inkSvg）。
     画的时候先在那一页上挂一张临时 SVG 实时描，松手抽稀后存库，临时的那张随即去掉。
     线宽按「100% 缩放时的像素」选，存成占页宽的比例 —— 换缩放比例时笔迹粗细跟着页面变 */
  const [penStyle, setPenStyle] = useState(loadPenStyle);
  const penStyleRef = useRef(penStyle);
  useEffect(() => { penStyleRef.current = penStyle; savePenStyle(penStyle); }, [penStyle]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const inkUndo = useRef([]);                 // 本次会话画的笔迹，Ctrl+Z 依次撤
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const saveInkRef = useRef(null);
  saveInkRef.current = async (page, stroke) => {
    const row = await addAnnotation(paperKey, meta, {
      page, kind: "ink", color: penStyleRef.current.color, rects: [stroke], quote: null,
    });
    inkUndo.current.push({ id: row.id, paper_key: paperKey });
    await reload();
    bump();
  };
  const eraseRef = useRef(null);
  eraseRef.current = async (a) => { await deleteAnnotation(a.paper_key || paperKey, a.id); reload(); bump(); };

  useEffect(() => {
    if (tool !== "pen") return;
    const el = containerRef.current;
    if (!el) return;
    let st = null;
    const SVGNS = "http://www.w3.org/2000/svg";
    const norm = (e) => [(e.clientX - st.box.left) / st.box.width, (e.clientY - st.box.top) / st.box.height];
    const redraw = () => st.path.setAttribute("d", inkPathD(st.pts, st.H));
    const down = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target?.closest?.(".rh-selbar")) return;
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl) return;
      e.preventDefault();
      setAnnMenu(null);
      const box = pageCanvasBox(pageEl);
      const H = 1000 * box.height / box.width;
      const lw = penStyleRef.current.width / (box.width / zoomRef.current);     // 占页宽的比例
      const svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("viewBox", `0 0 1000 ${H.toFixed(1)}`);
      svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:4";
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", rgba(penStyleRef.current.color, 0.95));
      path.setAttribute("stroke-width", String(Math.max(0.6, lw * 1000)));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      pageEl.appendChild(svg);
      st = { pageEl, box, H, lw, svg, path, pid: e.pointerId, pts: [] };
      st.pts.push(norm(e));
      redraw();
      try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    };
    const move = (e) => {
      if (!st || e.pointerId !== st.pid) return;
      const p = norm(e), q = st.pts[st.pts.length - 1];
      // 小于半个像素的移动不记，免得一秒几百个点
      if (Math.hypot((p[0] - q[0]) * st.box.width, (p[1] - q[1]) * st.box.height) < 0.5) return;
      st.pts.push(p);
      redraw();
    };
    const up = async (e) => {
      if (!st || e.pointerId !== st.pid) return;
      const s0 = st;
      st = null;
      try { el.releasePointerCapture(s0.pid); } catch { /* 已经释放了 */ }
      /* 抽稀按像素算（偏差 0.6px 以内的点去掉），再换回归一化坐标存 */
      const px = s0.pts.map(([x, y]) => [x * s0.box.width, y * s0.box.height]);
      const kept = simplify(px, 0.6).map(([x, y]) => [+(x / s0.box.width).toFixed(4), +(y / s0.box.height).toFixed(4)]);
      const xs = kept.map(q => q[0]), ys = kept.map(q => q[1]);
      const padX = s0.lw / 2, padY = padX * s0.box.width / s0.box.height;
      const stroke = {
        x: +(Math.min(...xs) - padX).toFixed(4), y: +(Math.min(...ys) - padY).toFixed(4),
        w: +(Math.max(...xs) - Math.min(...xs) + padX * 2).toFixed(4),
        h: +(Math.max(...ys) - Math.min(...ys) + padY * 2).toFixed(4),
        path: kept, lw: +s0.lw.toFixed(5),
      };
      await saveInkRef.current(Number(s0.pageEl.dataset.pageNumber), stroke);
      s0.svg.remove();                          // 正式的那张已经由高亮层画出来了
    };
    const onKey = (e) => {
      if (e.key === "Escape") { setTool("text"); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const last = inkUndo.current.pop();
        if (last) eraseRef.current(last);
      }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    window.addEventListener("keydown", onKey);
    return () => {
      st?.svg.remove();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", onKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /* 橡皮擦：按住拖过去，碰到的手写笔迹整条删掉（同 Edge 的「笔划橡皮擦」）。只擦自己的、只擦笔迹 */
  useEffect(() => {
    if (tool !== "eraser") return;
    const el = containerRef.current;
    if (!el) return;
    let pressed = null;
    const gone = new Set();
    const R = 8;                                // 橡皮擦半径（px）
    const hitAt = (e) => {
      const pageEl = document.elementsFromPoint(e.clientX, e.clientY).map(n => n.closest?.(".page")).find(Boolean);
      if (!pageEl) return;
      const n = Number(pageEl.dataset.pageNumber);
      const box = pageCanvasBox(pageEl);
      const px = e.clientX - box.left, py = e.clientY - box.top;
      for (const a of mineRef.current) {
        if (a.kind !== "ink" || a.page !== n || gone.has(a.id) || a.paper_key !== paperKey) continue;
        const hit = (a.rects || []).some(st => {
          const pts = (st.path || []).map(([x, y]) => [x * box.width, y * box.height]);
          const tol = R + (st.lw || 0) * box.width / 2;
          if (pts.length === 1) return Math.hypot(px - pts[0][0], py - pts[0][1]) < tol;
          for (let i = 1; i < pts.length; i++) {
            if (distToSeg(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < tol) return true;
          }
          return false;
        });
        if (hit) { gone.add(a.id); eraseRef.current(a); }
      }
    };
    const down = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target?.closest?.(".rh-selbar")) return;
      e.preventDefault();
      setAnnMenu(null);
      pressed = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
      hitAt(e);
    };
    const move = (e) => { if (pressed === e.pointerId) hitAt(e); };
    const up = (e) => {
      if (pressed !== e.pointerId) return;
      pressed = null;
      try { el.releasePointerCapture(e.pointerId); } catch { /* 已经释放了 */ }
    };
    const onKey = (e) => { if (e.key === "Escape") setTool("text"); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", onKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, paperKey]);

  /* ── 写 ─────────────────────────────────────────────────────── */
  const saveArea = async (anchor, pos) => {
    const st = areaStyleRef.current;
    const row = await addAnnotation(paperKey, meta, {
      ...anchor, color: st.color, style: { dash: st.dash, width: st.width, fill: !!st.fill },
    });
    clearSel();
    await reload();
    bump();
    setActiveId(row.id);
    setAnnMenu({ id: row.id, pos });
  };
  const saveAreaRef = useRef(saveArea);
  saveAreaRef.current = saveArea;      // 框选的事件监听只挂一次，靠它拿到最新的 paperKey / 样式

  /** 拖动 / 缩放松手：存新矩形，框里的字重新抽一遍（只为搜索），编辑条跟着挪过去 */
  const commitAreaRect = async (a, rect, pageEl) => {
    const quote = areaAnchor(pageEl, rect).quote;
    await updateAnnotation(a.paper_key || paperKey, a.id, { rects: [rect], quote });
    reload(); bump();
    const box = pageCanvasBox(pageEl);
    const vb = viewerElRef.current?.getBoundingClientRect();
    if (vb) {
      const top = box.top + rect.y * box.height;
      setAnnMenu(m => m && ({ ...m, pos: floatPos({ left: box.left + rect.x * box.width, width: rect.w * box.width, top,
                                                     bottom: top + rect.h * box.height }, vb, 120) }));
    }
  };
  const saveAnchors = async (anchors, extra = {}) => {
    for (const a of anchors) await addAnnotation(paperKey, meta, { ...a, ...extra });
    clearSel();
    reload(); bump();
  };

  const goAnn = (a) => {
    setActiveId(a.id);
    goPageMain(a.page);
    // 页面是懒渲染的，跳过去那一刻高亮还不存在 —— 等几帧再滚
    let tries = 0;
    const tick = () => {
      const el = viewerElRef.current?.querySelector(`.page[data-page-number="${a.page}"] .rh-hl > div`);
      if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
      if (tries++ < 20) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const tags = normTags(draft.tags);
    if (draft.id) {
      await updateAnnotation(draft.paper_key || paperKey, draft.id, { body: draft.body || null, tags });
      setDraft(null);
      reload(); bump();
      return;
    }
    await saveAnchors(draft.anchors, {
      color: draft.color || "yellow", body: draft.body || null, tags,
      ...(draft.kind ? { kind: draft.kind } : {}),
    });
    setDraft(null);
  };

  const doExport = async () => {
    const names = {};
    othersView.forEach(o => { if (o.author) names[o.author.id] = o.author.username || o.author.name; });
    const md = exportMarkdown({ paperTitle: title, paperUrl: url, paperKey, annotations: mineView, authorNames: names });
    try { await navigator.clipboard.writeText(md); } catch { return; }
    setExported(true);
    setTimeout(() => setExported(false), 1600);
  };

  /** 页级笔记：长公式、整张图、「这一页的推导有问题」这类没法划选的东西 */
  const addPageNote = () => setDraft({
    anchors: [{ page, rects: null, quote: null, prefix: null, suffix: null }],
    page, quote: null, body: "", tags: [],
  });

  const notesProps = {
    mine: mineView, others: othersView, copiedIds: copiedSourceIds(mine),
    scope, setScope, onGo: goAnn,
    onEdit: (a) => setDraft({
      id: a.id, paper_key: a.paper_key, page: a.page, quote: a.quote, body: a.body || "",
      kind: a.kind, rects: a.rects, tags: a.tags || [],
    }),
    onDelete: async (a) => { await deleteAnnotation(a.paper_key || paperKey, a.id); reload(); bump(); },
    onCopy: async (a) => { await copyAnnotation(paperKey, meta, a); reload(); bump(); },
    onAddPageNote: addPageNote,
    visibility: myNote?.visibility || "private",
    onVisibility: async (v) => { await setVisibility(paperKey, meta, v); reload(); bump(); },
    onExport: doExport, exported, page, canShare: !!uid, doc, activeId,
  };
  /* 点中的那条标注：自己的能改，别人的能收藏 */
  const menuAnn = annMenu && (mineView.find(x => x.id === annMenu.id)
    || othersView.flatMap(o => o.annotations.map(a => ({ ...a, author: o.author }))).find(x => x.id === annMenu.id));
  const menuMine = !!menuAnn && mineView.some(x => x.id === menuAnn.id);
  const patchAnn = async (patch) => {
    await updateAnnotation(menuAnn.paper_key || paperKey, menuAnn.id, patch);
    reload(); bump();
  };
  const annMenuView = menuAnn && (
    <AnnMenu key={`menu-${menuAnn.id}`} pos={annMenu.pos} a={menuAnn} mine={menuMine} author={menuAnn.author}
      copied={copiedSourceIds(mine).has(menuAnn.source_annotation_id || menuAnn.id)}
      onColor={(c) => patchAnn({ color: c })}
      onStyle={(st) => patchAnn({ style: { dash: "solid", width: 2, ...menuAnn.style, ...st } })}
      onEdit={() => { notesProps.onEdit(menuAnn); setAnnMenu(null); }}
      onDelete={async () => { setAnnMenu(null); await notesProps.onDelete(menuAnn); }}
      onCopy={async () => { await notesProps.onCopy(menuAnn); setAnnMenu(null); }}
      onClose={() => setAnnMenu(null)} />
  );
  const allTags = useMemo(() => collectTags([mine, ...others.map(o => o.annotations)]), [mine, others]);
  const areaPending = pending?.[0]?.kind === "area";

  /* ── 文档内搜索（样式照 Chrome / 学术搜索 PDF 阅读器：浮在正文右上角的一条，
     输入框里带「第几处 / 共几处」，旁边上一处 / 下一处 / 关闭） ── */
  const findInputRef = useRef(null);
  const [findCount, setFindCount] = useState(null);   // { current, total } | null
  const runFind = useCallback((q, again, prev = false) => {
    act()?.eventBus.dispatch("find", {
      source: window, type: again ? "again" : "", query: q,
      caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: prev,
    });
  }, []);
  const openFind = useCallback(() => {
    setFindOpen(true);
    // 已经开着时再按 Ctrl+F：聚焦并全选，方便直接换关键词
    setTimeout(() => { findInputRef.current?.focus(); findInputRef.current?.select(); }, 0);
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindCount(null);
    // 清掉正文里的命中高亮（两栏都清）
    [apiRef.current, splitApiRef.current].forEach(a => a?.eventBus.dispatch("findbarclose", { source: window }));
  }, []);
  useEffect(() => {
    // 两栏的搜索各自独立：只听当前那一栏的计数
    const bus = act()?.eventBus;
    if (!bus) return;
    const onCount = ({ matchesCount }) => matchesCount && setFindCount({ ...matchesCount });
    const onState = ({ matchesCount }) => matchesCount && setFindCount({ ...matchesCount });
    bus.on("updatefindmatchescount", onCount);
    bus.on("updatefindcontrolstate", onState);
    return () => { bus.off("updatefindmatchescount", onCount); bus.off("updatefindcontrolstate", onState); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, onSplit]);

  // Ctrl/⌘+F 打开文档内搜索（不然会落到浏览器的页面搜索，搜不到没渲染的页）
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFind]);

  /* ── 全屏 / 下载 ──────────────────────────────────────────────────
     全屏只放阅读区（不带工具栏），Esc 由浏览器负责退出。适应宽度 / 高度这类自动倍数
     由上面的 ResizeObserver 跟着重排；全屏的尺寸变化是异步的，再补一次保险 */
  const readerRef = useRef(null);
  /* 分屏（SplitPane）：左右（h）或上下（v）。第二栏占整个阅读区域的比例，拖中间的分隔条改；方向和比例记在本机 */
  const [splitDir, setSplitDir] = useState(() => { try { return localStorage.getItem("rh_split_dir") === "v" ? "v" : "h"; } catch { return "h"; } });
  const flipSplit = () => {
    const n = splitDir === "h" ? "v" : "h";
    try { localStorage.setItem("rh_split_dir", n); } catch { /* 存不了就算了 */ }
    setSplitDir(n);
    // 换方向时两栏都换成对应的「适合」方式
    [apiRef.current, splitApiRef.current].forEach(a => { if (a) a.viewer.currentScaleValue = fitFor(n); });
    // 栏的尺寸要等这一帧排完才变（ResizeObserver 会再算一次倍数）；之后各自对齐到当前这一页的页首，不停在两页中间
    setTimeout(() => [apiRef.current, splitApiRef.current].forEach(a => a?.viewer.scrollToPage(a.viewer.currentPageNumber)), 120);
  };
  /* 开分屏时主阅读区改成「适合宽度」（左右分）/「适合页面」（上下分：一栏只有半屏高，按宽度撑满就只露半页）。
     先设上，容器缩窄之后 ResizeObserver 还会按新尺寸再算一次。第二栏照抄主阅读区此刻的缩放方式和位置（SplitPane） */
  const fitFor = (dir) => (dir === "v" ? "page-fit" : "page-width");
  const toggleSplit = () => {
    if (!splitOpen && apiRef.current) apiRef.current.viewer.currentScaleValue = fitFor(splitDir);
    if (splitOpen) setActivePane("main");
    setSplitOpen(v => !v);
  };
  const [splitFrac, setSplitFrac] = useState(() => {
    try { const f = parseFloat(localStorage.getItem("rh_split")); return f > 0.15 && f < 0.85 ? f : 0.5; } catch { return 0.5; }
  });
  const splitRowRef = useRef(null);
  const dragSplit = (e) => {
    e.preventDefault();
    const row = splitRowRef.current;
    if (!row) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let f = splitFrac;
    const move = (ev) => {
      const r = row.getBoundingClientRect();
      // 两边都至少留 280px（上下分时 160px）
      const [len, pos, min] = splitDir === "v" ? [r.height, r.bottom - ev.clientY, 160] : [r.width, r.right - ev.clientX, 280];
      f = Math.min(len - min, Math.max(min, pos)) / len;
      setSplitFrac(f);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      try { localStorage.setItem("rh_split", String(f)); } catch { /* 存不了就算了 */ }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  /* ── 链接预览（同 Zotero）：指在正文的内部链接上停一下，浮出目标的预览 ──
     - 引用号：参考文献原文（[1–10] 这种按整组展开，指 1 或 10 都出全部十条）
     - 其他（章节、公式、图、脚注）：目标那一页的图，滚到目标位置，预览框里还能接着滚
     两栏都有（事件挂在分屏外面那一层）。移进预览框不消失，方便滚动 / 复制 */
  const [linkPv, setLinkPv] = useState(null);       // { kind: "refs" | "page", rect, entries | dest }
  const pvHideRef = useRef(0);
  const pvHide = useCallback((ms = 220) => {
    clearTimeout(pvHideRef.current);
    pvHideRef.current = setTimeout(() => setLinkPv(null), ms);
  }, []);
  useEffect(() => {
    const root = splitRowRef.current;
    setLinkPv(null);
    if (!root || !doc) return;
    let timer = 0, cur = null, refsVal = null, mark = null;
    const linkOf = (t) => t?.closest?.(".annotationLayer a[data-dest-page]");
    const num = (v) => (v == null ? null : Number(v));
    const destOf = (a) => ({ pageIndex: Number(a.dataset.destPage), x: num(a.dataset.destX), y: num(a.dataset.destY) });
    /* 引用号整组一起高亮：hyperref 只给 [1–10] 的 1 和 10 挂链接，指哪个都把整个方括号框起来
       （量文字层里这一组的位置；单个链接自己的黄框这时不画，免得叠两层） */
    const unmark = () => { mark?.el.remove(); mark?.a.classList.remove("rh-grouped"); mark = null; };
    const markGroup = (a) => {
      const entry = refsVal?.byPos.get(destKey(...Object.values(destOf(a))));
      if (!entry || mark?.a === a) return;
      unmark();
      const r = citeGroupRect(a, entry.label);
      const pg = a.closest(".page");
      if (!r || !pg) return;
      const pr = pg.querySelector(".canvasWrapper").getBoundingClientRect();
      const el = document.createElement("div");
      el.className = "rh-cite-group";
      el.style.cssText = `left:${(r.left - pr.left) / pr.width * 100}%;top:${(r.top - pr.top) / pr.height * 100}%;` +
        `width:${r.width / pr.width * 100}%;height:${r.height / pr.height * 100}%`;
      pg.appendChild(el);
      a.classList.add("rh-grouped");
      mark = { a, el };
    };
    const show = async (a) => {
      const dest = destOf(a);
      refsRef.current ||= extractReferences(doc).catch(() => null);
      const refs = await refsRef.current;
      refsVal = refs;
      if (cur !== a || !a.isConnected) return;
      markGroup(a);
      const rect = a.getBoundingClientRect();
      const entry = refs?.byPos.get(destKey(dest.pageIndex, dest.x, dest.y));
      if (entry) {
        let group = citeGroup(a, entry.label).filter(l => refs.byLabel.has(l));
        if (!group.includes(entry.label)) group = [entry.label];
        setLinkPv({ kind: "refs", rect, entries: group.map(l => refs.byLabel.get(l)) });
      } else {
        // 预览按正文当前的缩放画（字和正在读的一样大）：量链接所在这一页画布的 CSS 宽度 / 点宽
        const pg = a.closest(".page");
        const k = pg.querySelector(".canvasWrapper").getBoundingClientRect().width / doc.pages[Number(pg.dataset.pageNumber) - 1].size.width;
        setLinkPv({ kind: "page", rect, dest, k });
      }
    };
    const over = (e) => {
      const a = linkOf(e.target);
      if (!a) return;
      clearTimeout(pvHideRef.current);
      if (a === cur || e.buttons) return;
      cur = a;
      markGroup(a);
      clearTimeout(timer);
      timer = setTimeout(() => show(a), 350);
    };
    const out = (e) => {
      const a = linkOf(e.target);
      if (!a || (e.relatedTarget && a.contains(e.relatedTarget))) return;
      clearTimeout(timer);
      cur = null;
      unmark();
      pvHide();
    };
    // 点了（弹文献卡片 / 跳转）、滚动、按键：预览收起。预览框挂在 body 上（portal），框里的操作不会冒泡到这里
    const close = (e) => {
      if (e?.type === "keydown" && (e.ctrlKey || e.metaKey || e.key === "Control" || e.key === "Meta" || e.key === "Shift")) return;
      clearTimeout(timer); cur = null; unmark(); clearTimeout(pvHideRef.current); setLinkPv(null);
    };
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerout", out);
    root.addEventListener("pointerdown", close, true);
    root.addEventListener("wheel", close, { passive: true });
    window.addEventListener("keydown", close);
    return () => {
      clearTimeout(timer);
      unmark();
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerout", out);
      root.removeEventListener("pointerdown", close, true);
      root.removeEventListener("wheel", close);
      window.removeEventListener("keydown", close);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);
  const enterFullscreen = () => { readerRef.current?.requestFullscreen?.().catch(() => {}); };

  /* ── 浮动标注工具条：能拖、能横竖切换，位置和方向记在本机 ──
     pos = null：还没拖过，竖排贴左边上下居中 / 横排贴顶边左右居中（左侧栏打开时让开）；
     拖过之后 pos = { x, y }（相对阅读区左上角），窗口变小时夹回阅读区里 */
  const TB_KEY = "rh_toolbar";
  const [tb, setTbRaw] = useState(() => {
    try { return { pos: null, horiz: false, ...JSON.parse(localStorage.getItem(TB_KEY) || "{}") }; }
    catch { return { pos: null, horiz: false }; }
  });
  const setTb = (fn) => setTbRaw(prev => {
    const next = typeof fn === "function" ? fn(prev) : fn;
    try { localStorage.setItem(TB_KEY, JSON.stringify(next)); } catch { /* 隐私模式 */ }
    return next;
  });
  const tbRef = useRef(null);
  const clampTb = (x, y) => {
    const rr = readerRef.current?.getBoundingClientRect(), br = tbRef.current?.getBoundingClientRect();
    if (!rr || !br) return { x, y };
    return { x: Math.round(Math.min(Math.max(4, x), Math.max(4, rr.width - br.width - 4))),
             y: Math.round(Math.min(Math.max(4, y), Math.max(4, rr.height - br.height - 4))) };
  };
  const dragTb = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rr = readerRef.current.getBoundingClientRect(), br = tbRef.current.getBoundingClientRect();
    const ox = e.clientX - br.left, oy = e.clientY - br.top;
    const move = (ev) => setTbRaw(p => ({ ...p, pos: clampTb(ev.clientX - ox - rr.left, ev.clientY - oy - rr.top) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setTb(p => p);                                   // 松手才写本机存储，拖的过程中不写
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // 横竖切换 / 窗口变小后，工具条可能伸出阅读区：夹回来
  useEffect(() => {
    if (!tb.pos) return;
    const fix = () => setTbRaw(p => {
      if (!p.pos) return p;
      const c = clampTb(p.pos.x, p.pos.y);
      return c.x === p.pos.x && c.y === p.pos.y ? p : { ...p, pos: c };
    });
    fix();
    window.addEventListener("resize", fix);
    return () => window.removeEventListener("resize", fix);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tb.horiz, !!tb.pos, doc]);
  useEffect(() => {
    const onFs = () => {
      const refit = () => {
        const v = apiRef.current?.viewer.currentScaleValue;
        if (v === "page-width" || v === "page-height" || v === "page-fit" || v === "auto") apiRef.current.viewer.currentScaleValue = v;
      };
      refit();
      setTimeout(refit, 150);
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /** 下载已经加载好的字节（不再请求一次 arXiv）；文件名 = arXiv 号 + 标题 */
  const download = async () => {
    if (!doc) return;
    const bytes = await doc.getData();
    const id = paperKey.replace(/^arxiv:/, "").replace(/\//g, "_");
    const name = `${id}${title ? ` - ${title}` : ""}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
    const href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = Object.assign(document.createElement("a"), { href, download: `${name}.pdf` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };

  // 「用浏览器自带阅读器打开」：background 给这个标签页加一条放行规则再跳过去
  const openRaw = () => chrome.runtime.sendMessage({ type: "viewer:raw", url });

  return (
    <div className="flex flex-col h-screen bg-[#525659]">
      <div className="h-10 shrink-0 flex items-center gap-1 px-1.5 bg-[#323639] border-b border-[#00000040]">
        {/* 三段：左边侧栏开关 + 标题（同 Edge / Chrome 的阅读器），中间翻页和缩放（左右两段等宽，所以它真的居中），右边工具 */}
        <div className="flex-1 basis-0 min-w-0 flex items-center gap-1">
          <TBtn onClick={() => setSideOpen(v => !v)} title="目录 / 缩略图 / 笔记" active={sideOpen}><Icon d={IconSidebar} /></TBtn>
          <div className="min-w-0 px-2 truncate text-[13px] text-[#e6e6e6] font-sans" title={title || undefined}>
            {title || paperKey.replace(/^arxiv:/, "arXiv:")}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1">
        <TBtn onClick={() => goPage(vPage - 1)} title="上一页" disabled={vPage <= 1}><Icon d={IconUp} /></TBtn>
        <TBtn onClick={() => goPage(vPage + 1)} title="下一页" disabled={vPage >= total}><Icon d={IconDown} /></TBtn>
        {doc ? (
          <div className="flex items-center gap-1 px-0.5 shrink-0 text-[11.5px] font-sans tabular-nums">
            <input value={pageInput} inputMode="numeric" aria-label="跳转到指定页" title="输入页码后回车跳转"
              style={{ width: `${String(total).length + 1}ch` }}
              onFocus={(e) => { editingRef.current = true; e.target.select(); }}
              onBlur={() => { editingRef.current = false; commitPageInput(); }}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") { setPageInput(String(vPage)); e.currentTarget.blur(); }
              }}
              className="text-center bg-transparent rounded px-0.5 py-px outline-none border border-transparent
                         text-[#e6e6e6] tabular-nums hover:border-[#ffffff40] focus:border-[#ffffff80] focus:bg-[#00000059]" />
            <span className="text-[#ffffffb3]">/ {total}</span>
          </div>
        ) : <span className="text-[11.5px] text-[#e6e6e6] font-sans px-1 shrink-0">…</span>}
        <div className="h-4 border-l border-[#ffffff26] mx-0.5 shrink-0" />
        <TBtn onClick={() => stepZoom(-1)} title="缩小" disabled={vZoom <= ZOOMS[0]}><Icon d={IconMinus} /></TBtn>
        <TBtn onClick={() => stepZoom(1)} title="放大" disabled={vZoom >= ZOOMS[ZOOMS.length - 1]}><Icon d={IconPlus} /></TBtn>
        {/* 缩放比例可直接输入（同页码框：本地 state，滚轮 / 按钮改了倍数时不在输入就跟着变） */}
        <div className="flex items-center shrink-0 text-[11.5px] font-sans tabular-nums text-[#e6e6e6]">
          <input value={zoomInput} aria-label="缩放比例" title="输入百分比后回车"
            style={{ width: "4ch" }}
            onFocus={(e) => { zoomEditingRef.current = true; e.target.select(); }}
            onBlur={() => { zoomEditingRef.current = false; commitZoomInput(); }}
            onChange={(e) => setZoomInput(e.target.value.replace(/\D/g, "").slice(0, 3))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") { setZoomInput(String(Math.round(vZoom * 100))); e.currentTarget.blur(); }
            }}
            className="text-right bg-transparent rounded px-0.5 py-px outline-none border border-transparent text-[#e6e6e6]
                       tabular-nums hover:border-[#ffffff40] focus:border-[#ffffff80] focus:bg-[#00000059]" />
          <span className="pr-0.5">%</span>
        </div>
        <ZoomMenu zoom={vZoom} mode={vMode} onPick={setScale} />
        </div>

        <div className="flex-1 basis-0 min-w-0 flex items-center justify-end gap-1">

        <TBtn onClick={() => (findOpen ? closeFind() : openFind())} title="搜索（Ctrl+F）" active={findOpen}><Icon d={IconSearch} /></TBtn>
        <TBtn onClick={toggleSplit} title={splitOpen ? "关闭分屏" : "分屏：右边再开一个阅读区看同一篇（各自滚动、缩放）"}
          active={splitOpen} disabled={!doc}><Icon d={IconSplit} /></TBtn>
        {splitOpen && (
          <TBtn onClick={flipSplit} title={splitDir === "v" ? "改成左右分屏" : "改成上下分屏"}><Icon d={IconRotate} /></TBtn>
        )}
        <TBtn onClick={enterFullscreen} title="全屏阅读（Esc 退出）" disabled={!doc}><Icon d={IconFull} /></TBtn>
        <TBtn onClick={download} title="下载 PDF" disabled={!doc}><Icon d={IconDownload} /></TBtn>
        <TBtn onClick={openRaw} title="用浏览器自带的阅读器打开原文件"><Icon d={IconOpen} /></TBtn>
        <div className="h-4 border-l border-[#ffffff26] mx-0.5 shrink-0" />
        <TBtn onClick={() => setSettingsOpen(true)} title="设置"><Icon d={IconGear} /></TBtn>
        <SyncBadge uid={uid} state={sync} pending={pendingCount} onLogin={onLogin} onSync={runSync} />
        {commentKey && (
          <TBtn onClick={() => setRightOpen(v => !v)} active={rightOpen} title="论文评论（和 ResearchHub 网站互通）">
            <Icon d={IconChat} />{commentCount ? <span className="tabular-nums">{commentCount}</span> : null}
          </TBtn>
        )}
        {me && (
          <span className="ml-0.5 shrink-0" title={`已登录：${me.name}`}><Avatar name={me.name} url={me.avatar_url} size={22} /></span>
        )}
        </div>
      </div>

      {/* 页面颜色（护眼）的类挂在这一层：正文和左侧栏的缩略图都在它里面，一起变色 */}
      <div className={`relative flex-1 flex min-h-0 rh-paper-${settings.paper || "white"}`}>
        {/* 左侧栏：绝对定位盖在阅读区上，transform 滑进滑出（不改正文宽度，所以页面不会跟着重排 / 跳动）。
            关着的时候也挂着（inert + 移出视口）：再打开时目录展开状态、笔记筛选条件都还在，
            缩略图在视口外不会被 IntersectionObserver 触发渲染 */}
        <aside inert={!sideOpen} aria-hidden={!sideOpen}
          className="absolute left-0 top-0 bottom-0 z-[60] w-[328px] flex bg-[#3c4043] border-r border-[#00000040]
                     transition-[transform,box-shadow] duration-200 ease-out"
          style={{ transform: sideOpen ? "translateX(0)" : "translateX(-100%)",
                   boxShadow: sideOpen ? "6px 0 24px rgba(0,0,0,0.35)" : "none" }}>
          {/* 竖排图标切 tab */}
          <div className="w-11 shrink-0 flex flex-col items-center gap-1 pt-12 border-r border-[#00000033]">
            {[["thumbs", "缩略图", IconThumbs], ["outline", "目录", IconOutline], ["notes", "笔记", IconNotes]].map(([k, label, icon]) => (
              <button key={k} onClick={() => setSideTab(k)} title={label}
                className={`relative w-9 h-9 rounded-md flex items-center justify-center border-none cursor-pointer
                  ${sideTab === k ? "text-[#fff] bg-[#ffffff1f]" : "text-[#b8b8b8] bg-transparent hover:bg-[#ffffff14] hover:text-[#fff]"}`}>
                <Icon d={icon} size={17} />
                {k === "notes" && visibleAnns.length > 0 && (
                  <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[#7ec8e3] text-[#10232c]
                                   text-[9px] font-bold font-sans flex items-center justify-center tabular-nums">
                    {visibleAnns.length > 99 ? "99+" : visibleAnns.length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="h-11 shrink-0 flex items-center justify-between pl-3 pr-1.5">
              <span className="text-[15px] text-[#fff] font-bold font-sans">
                {{ thumbs: "缩略图", outline: "目录", notes: "笔记" }[sideTab]}
              </span>
              <button onClick={() => setSideOpen(false)} title="收起"
                className="w-8 h-8 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer text-[#c8c8c8] hover:bg-[#ffffff1a]">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
              </button>
            </div>
            {sideTab === "notes" ? (
              <NotesList {...notesProps} />
            ) : (
              <div className="flex-1 overflow-y-auto overscroll-contain thin-scrollbar py-1 pr-1">
                {sideTab === "outline" ? (
                  outline === null ? <div className="px-3 py-3 text-[12px] text-[#b8b8b8] font-sans">读取中…</div>
                  : outline.length === 0 ? <div className="px-3 py-3 text-[12px] text-[#b8b8b8] font-sans leading-relaxed">这份 PDF 没有内置章节目录</div>
                  /* 只有一个顶层节点（多半是论文标题）时直接展开，不然一打开目录就只看到一行 */
                  : outline.map((n, i) => <OutlineNode key={i} node={n} depth={0} onGo={goDest} defaultOpen={outline.length === 1} />)
                ) : <Thumbs doc={doc} total={total} page={vPage} onGo={goPage} />}
              </div>
            )}
          </div>
        </aside>

        <div ref={splitRowRef} className={`relative flex-1 min-w-0 min-h-0 flex ${splitOpen && splitDir === "v" ? "flex-col" : ""}`}>
        <div ref={readerRef} className="relative flex-1 min-w-0 min-h-0 bg-[#525659]"
          onPointerDownCapture={() => setActivePane("main")}>
          {splitOpen && activePane === "main" && <div className="rh-pane-active" />}
          {/* 标注工具条（顶栏放不下了）：浮在阅读区上，能拖（抓手 ⠿）、能横竖切换，位置记在本机。
              没拖过时竖排贴左边上下居中 / 横排贴顶边左右居中，左侧栏滑出来时跟着让开。
              居中用一层不吃指针的 flex 外壳，**不用 translate(-50%)**：带 transform 的祖先会让里面
              position:fixed 的下拉菜单改成相对它定位，菜单就跑到别处去了（踩过） */}
          {doc && (
            <div className={tb.pos ? "absolute z-[50] pointer-events-none"
              : `absolute z-[50] flex pointer-events-none transition-[left] duration-200 ease-out
                 ${tb.horiz ? "top-2.5 right-0 justify-center" : "inset-y-0 items-center"}`}
              style={tb.pos ? { left: tb.pos.x, top: tb.pos.y } : { left: sideOpen ? 328 + 10 : 10 }}>
            <div ref={tbRef}
              className={`pointer-events-auto flex ${tb.horiz ? "flex-row items-center" : "flex-col items-stretch"} gap-0.5 p-1
                          rounded-xl bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.4)]`}>
              <div onPointerDown={dragTb} title="拖动工具条"
                className={`flex items-center justify-center rounded-md cursor-move text-[#9a9a9a] hover:text-[#fff] hover:bg-[#ffffff1a]
                            touch-none ${tb.horiz ? "w-3 self-stretch" : "h-3"}`}>
                <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor" style={{ transform: tb.horiz ? "rotate(90deg)" : "none" }}>
                  {[2, 6, 10].flatMap(x => [4, 8].map(y => <circle key={`${x}${y}`} cx={x} cy={y} r="1.1" />))}
                </svg>
              </div>
              {/* 横竖切换放在抓手后面第一个：工具条按左上角定位，切换后它基本还在原处，鼠标不用追着找
                  （放最后的话一切换就跑到别处去了）。图标画的是切过去之后的样子 */}
              <div className="flex items-center justify-center">
                <TBtn onClick={() => setTb(p => ({ ...p, horiz: !p.horiz }))} title={tb.horiz ? "改成竖排" : "改成横排"}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                    {tb.horiz ? <rect x="8" y="3" width="8" height="18" rx="2" /> : <rect x="3" y="8" width="18" height="8" rx="2" />}
                  </svg>
                </TBtn>
              </div>
              <div className={tb.horiz ? "self-stretch border-l border-[#ffffff26] mx-0.5 my-1" : "border-t border-[#ffffff26] mx-1 my-0.5"} />
              {[
                ["area", IconArea, "退出框选（Esc）", "框选区域：拖一个框标注图、表或公式",
                  <AreaStyleMenu key="m" value={areaStyle} onChange={setAreaStyle} dir={tb.horiz ? "down" : "right"} corner={!tb.horiz} />],
                ["pen", IconPen, "退出画笔（Esc）", "画笔：在页面上手写（Ctrl+Z 撤销上一笔）",
                  <PenMenu key="m" value={penStyle} onChange={setPenStyle} dir={tb.horiz ? "down" : "right"} corner={!tb.horiz} />],
                ["eraser", IconEraser, "退出橡皮擦（Esc）", "橡皮擦：擦掉手写笔迹（高亮和框不受影响）"],
                ["textbox", IconTextBox, "退出添加文本（Esc）", "添加文本：点页面放一个文本框"],
                ["note", IconNote, "退出添加附注（Esc）", "添加附注：点页面放一个附注"],
              ].map(([k, icon, offTitle, onTitle, menu]) => (
                <div key={k} className={tb.horiz ? "flex items-center" : "relative flex justify-center"}>
                  <TBtn onClick={() => { clearSel(); setTool(t => (t === k ? "text" : k)); }}
                    active={tool === k} title={tool === k ? offTitle : onTitle}>
                    <Icon d={icon} />
                  </TBtn>
                  {menu}
                </div>
              ))}
            </div>
            </div>
          )}
          <div ref={containerRef}
            className={`absolute inset-0 overflow-auto overscroll-contain thin-scrollbar ${tool === "area" ? "rh-area-mode" : tool === "pen" ? "rh-area-mode rh-pen-mode" : tool === "eraser" ? "rh-area-mode rh-eraser-mode" : tool === "textbox" ? "rh-area-mode rh-textbox-mode" : tool === "note" ? "rh-area-mode rh-note-mode" : ""}`}>
            {/* pdf.js 往这个元素里插 / 删 .page，React 的东西不和它混在一起 */}
            <div ref={viewerElRef} className="pdfViewer relative" />
            {/* 浮层另起一层，和 .pdfViewer 左上角重合、一起滚；坐标照旧按 .pdfViewer 的盒子算。
                **这一层里的兄弟节点 key 不能重**：编辑框和编辑条最早都拿标注 id 当 key，
                重复 key 让 React 跟丢了节点 —— 编辑框关不掉、点一次多一个（踩过） */}
            <div ref={overlayRef} className="absolute left-0 top-0 w-full h-0">
              {textEdit && (
                <TextBoxEditor key={textEdit.id || "new"} draft={textEdit} viewerEl={viewerElRef.current} zoom={zoom}
                  onChange={(patch) => setTextEdit({ ...textEditRef.current, ...patch })}
                  onDone={finishText} onDelete={deleteText} />
              )}
              {noteEdit && (
                <NotePopup key={noteEdit.id || "new-note"} draft={noteEdit} viewerEl={viewerElRef.current} zoom={zoom}
                  onChange={(patch) => {
                    const n = { ...noteEditRef.current, ...patch };
                    setNoteEdit(n);
                    /* 换颜色：记成以后新附注的默认色；已经存过的附注马上改（页面上的图标立刻变色，不等卡片收起） */
                    if (patch.color) {
                      saveNoteColor(patch.color);
                      if (n.id) updateAnnotation(n.paper_key, n.id, { color: patch.color }).then(() => { reload(); bump(); });
                    }
                  }}
                  onDone={finishNote} onDelete={deleteNote} />
              )}
              {editArea && (
                <AreaEditBox key={`edit-${editArea.id}`} a={editArea} viewerEl={viewerElRef.current} zoom={zoom}
                  onCommit={(rect, pageEl) => commitAreaRect(editArea, rect, pageEl)} />
              )}
              {annMenuView}
              {linkPv && (
                <LinkPreview pv={linkPv} doc={doc} paper={settings.paper || "white"}
                  onEnter={() => clearTimeout(pvHideRef.current)} onLeave={() => pvHide()} />
              )}
              {refCard && (
                <RefCard key={`${refCard.group.join(",")}@${refCard.current}`} {...refCard}
                  arxivBase={base.replace(/^arxiv:/, "")}
                  onClose={closeRefCard}
                  onJump={(entry) => {
                    // [1–3] 里没挂链接的那条（比如 2）没有目标名，就跳到它所在的那一页
                    if (entry.dest) apiRef.current?.viewer.goToDest(entry.dest);
                    else if (apiRef.current) apiRef.current.viewer.currentPageNumber = entry.page;
                    setRefCard(null);
                  }}
                  onOpenArxiv={(id) => chrome.runtime.sendMessage({ type: "viewer:open", url: `https://arxiv.org/pdf/${id}` })} />
              )}
              {selPos && pending && (
                <div className="rh-selbar">
                  <SelectionBar pos={selPos}
                    kind={areaPending ? "area" : markKind}
                    onKind={areaPending ? null : pickMarkKind}
                    defaultColor={areaPending ? areaStyle.color : null}
                    onHighlight={(c) => saveAnchors(pending, areaPending
                      ? { color: c, style: { dash: areaStyle.dash, width: areaStyle.width } }
                      : { color: c, kind: markKind })}
                    onNote={() => {
                      setDraft({
                        anchors: pending, page: pending[0].page, quote: pending[0].quote, body: "",
                        kind: areaPending ? "area" : markKind, rects: pending[0].rects, tags: [],
                      });
                      clearSel();
                    }}
                    onTranslate={areaPending ? null : () => {
                      const sel = window.getSelection();
                      const rects = sel?.rangeCount ? sel.getRangeAt(0).getClientRects() : [];
                      // manual：浏览器选区会被清掉，原文改由 TransMark 标出来，不然看不出翻的是哪段
                      setTrans({ anchors: pending, text: pending[0].quote, manual: true,
                                 pos: rects.length ? transPos(rects) : { ...selPos, below: false } });
                      clearSel();
                    }}
                    onCancel={clearSel} />
                </div>
              )}
              {trans?.manual && <TransMark anchors={trans.anchors} viewerEl={viewerElRef.current} zoom={zoom} />}
              {(trans || transPin) && (
                /* 钉住时 key 固定：换一段文字只是换内容，浮窗不重建（不闪、不丢位置） */
                <TranslatePop key={transPin ? "pinned" : trans.text} text={trans?.text || ""} pos={trans?.pos}
                  pinned={transPin} fixedPos={transFixed} onPin={pinTrans}
                  onMove={(pos, done) => {
                    // ref 立刻跟上：松手那一下比重渲染先到，读 state 会存成上一步的位置
                    if (pos) { transFixedRef.current = pos; setTransFixed(pos); }
                    if (done) localStorage.setItem("rh_trans_pos", JSON.stringify(transFixedRef.current));
                  }}
                  onClose={() => { if (transPin) pinTrans(false); setTrans(null); }}
                  onSaveNote={async (translated) => {
                    if (!trans) return;
                    await saveAnchors(trans.anchors, { color: "yellow", kind: markKind, body: translated });
                    if (!transPin) setTrans(null);
                  }} />
              )}
            </div>
          </div>

          {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
          {findOpen && (
            <div className="absolute top-2 right-4 z-30 flex items-center gap-1 p-2 rounded-lg
                            bg-[#323639] border border-[#ffffff1f] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
              <div className="relative">
                <input ref={findInputRef} autoFocus value={query} placeholder="在文档中搜索"
                  onChange={e => { setQuery(e.target.value); runFind(e.target.value, false); if (!e.target.value) setFindCount(null); }}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === "Enter" && query) { e.preventDefault(); runFind(query, true, e.shiftKey); }
                    if (e.key === "Escape") closeFind();
                  }}
                  className="h-8 w-[260px] pl-2.5 pr-16 rounded-md bg-[#00000059] border border-[#ffffff33]
                             text-[13px] text-[#fff] font-sans outline-none placeholder:text-[#ffffff59] focus:border-[#ffffff80]" />
                {query && findCount && (
                  <span className={`absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] font-sans tabular-nums pointer-events-none
                    ${findCount.total ? "text-[#c8c8c8]" : "text-[#ff9a9a]"}`}>
                    {findCount.total ? `${findCount.current} / ${findCount.total}` : "0 / 0"}
                  </span>
                )}
              </div>
              <TBtn onClick={() => query && runFind(query, true, true)} title="上一处（Shift+Enter）" disabled={!findCount?.total}>
                <Icon d={IconUp} size={17} />
              </TBtn>
              <TBtn onClick={() => query && runFind(query, true)} title="下一处（Enter）" disabled={!findCount?.total}>
                <Icon d={IconDown} size={17} />
              </TBtn>
              <TBtn onClick={closeFind} title="关闭（Esc）">
                <Icon d={<><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></>} size={16} />
              </TBtn>
            </div>
          )}

          <AnnEditor draft={draft} onChange={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)}
            showTags tagSuggestions={allTags} doc={doc} />
          {(err || !doc) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2
                            text-[13px] font-sans text-[#ddd] pointer-events-none">
              {err ? (
                <>
                  <div>PDF 加载失败</div>
                  <div className="text-[11.5px] text-[#ffffff80] max-w-[80%] text-center break-words leading-relaxed">{err}</div>
                  <button onClick={openRaw} className="text-[#7ec8e3] underline pointer-events-auto bg-transparent border-none cursor-pointer text-[13px]">用浏览器自带阅读器打开 ↗</button>
                </>
              ) : "正在加载 PDF…"}
            </div>
          )}
        </div>
        {splitOpen && doc && (
          <>
            <div onPointerDown={dragSplit} title={splitDir === "v" ? "拖动调整高度" : "拖动调整宽度"}
              className={`shrink-0 bg-[#2a2c2e] hover:bg-[#4a90d9] active:bg-[#4a90d9] transition-colors touch-none
                ${splitDir === "v" ? "h-1.5 cursor-row-resize" : "w-1.5 cursor-col-resize"}`} />
            <div className="relative shrink-0 min-w-0 min-h-0" style={splitDir === "v" ? { height: `${splitFrac * 100}%` } : { width: `${splitFrac * 100}%` }}
              onPointerDownCapture={() => setActivePane("split")}>
              <SplitPane doc={doc} main={apiRef} apiRef={splitApiRef} annotations={visibleAnns}
                arxivId={paperKey.replace(/^arxiv:/, "")} eqCopy={settings.eqCopy}
                onReady={setSplitReady} onView={setSplitView} />
              {activePane === "split" && <div className="rh-pane-active" />}
            </div>
          </>
        )}
        </div>

        {rightOpen && commentKey && (
          <aside className="relative w-[340px] shrink-0 bg-[#3c4043] border-l border-[#00000040] flex flex-col">
            <div className="shrink-0 h-8 flex items-center justify-between pl-3 pr-1 border-b border-[#00000040]">
              <span className="text-[12px] text-[#fff] font-bold font-sans">论文评论</span>
              <button onClick={() => setRightOpen(false)} title="收起"
                className="w-7 h-7 rounded-md text-[#c8c8c8] bg-transparent border-none cursor-pointer hover:bg-[#ffffff26]">✕</button>
            </div>
            <div className="flex-1 min-h-0">
              <PaperComments paperKey={commentKey} me={me} onLogin={onLogin}
                sitePaperUrl={sitePaperUrl(paperKey)} onCount={setCommentCount} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

/** 缩略图栏：进视口才画 */
function Thumbs({ doc, total, page, onGo }) {
  const holders = useRef([]);
  const done = useRef(new Set());
  const urls = useRef([]);
  // 换文档 / 卸载时把缩略图的 blob URL 释放掉
  useEffect(() => () => { urls.current.forEach(u => URL.revokeObjectURL(u)); urls.current = []; }, [doc]);
  useEffect(() => {
    if (!doc || !total) return;
    const io = new IntersectionObserver(async (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const n = Number(en.target.dataset.p);
        if (done.current.has(n)) continue;
        done.current.add(n);
        try {
          // 按屏幕的实际像素比画（高分屏清楚，普通屏不白白画两倍大）；PDFium 在 Worker 里画好传回来
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const pg = doc.pages[n - 1];
          const { bitmap, width, height } = await doc.render(n - 1, (264 * dpr) / pg.size.width);
          const c = document.createElement("canvas");
          c.width = width; c.height = height;
          c.getContext("2d").drawImage(bitmap, 0, 0);
          bitmap.close();
          /* 画完转成 JPEG 图片、扔掉画布：画布的像素一直占着内存（一页约 1MB，几百页的书就是几百 MB），
             图片的解码数据浏览器在它滚出视野后可以回收 */
          const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
          c.width = c.height = 0;
          if (!blob) throw new Error("toBlob");
          const img = new Image();
          img.src = URL.createObjectURL(blob);
          urls.current.push(img.src);
          img.style.cssText = "width:100%;height:auto;display:block";
          img.alt = `第 ${n} 页`;
          en.target.replaceChildren(img);
        } catch { done.current.delete(n); }
      }
    }, { rootMargin: "300px 0px" });
    holders.current.slice(0, total).forEach(el => el && io.observe(el));
    return () => io.disconnect();
  }, [doc, total]);
  if (!doc) return null;
  return (
    <div className="px-2">
      {Array.from({ length: total }, (_, i) => (
        <button key={i} onClick={() => onGo(i + 1)}
          className={`w-full mb-2 p-0 bg-transparent border-2 rounded cursor-pointer block
            ${page === i + 1 ? "border-[#7ec8e3]" : "border-transparent"}`}>
          <div data-p={i + 1} ref={el => { holders.current[i] = el; }}
            className="rh-thumb relative w-full bg-[#fff]" style={{ aspectRatio: "1 / 1.414" }} />
          <div className="text-[10.5px] text-[#b8b8b8] font-sans tabular-nums text-center pt-0.5">{i + 1}</div>
        </button>
      ))}
    </div>
  );
}

/** 翻译时把原文标成浅蓝（浏览器选区点按钮后就没了）。坐标每次渲染从页面盒子现量，缩放后也对得上 */
function TransMark({ anchors, viewerEl }) {
  if (!viewerEl) return null;
  const vb = viewerEl.getBoundingClientRect();
  return anchors.flatMap((a, i) => {
    const pageEl = viewerEl.querySelector(`.page[data-page-number="${a.page}"]`);
    if (!pageEl || !a.rects) return [];
    const box = pageCanvasBox(pageEl);
    return a.rects.map((r, j) => (
      <div key={`${i}-${j}`} style={{
        position: "absolute", pointerEvents: "none", borderRadius: 2, background: "rgba(56,132,255,0.28)",
        left: box.left - vb.left + r.x * box.width, top: box.top - vb.top + r.y * box.height,
        width: r.w * box.width, height: r.h * box.height,
      }} />
    ));
  });
}

/* 缩放比例旁的下拉（参照 Acrobat）：几个常用比例 + 实际大小 / 适合页面 / 适合宽度。
   取代原来那颗「适应宽度 / 适应高度」来回切的按钮。当前是哪一项就打勾：
   自动倍数看 pdf.js 给的 presetValue，固定比例看数值 */
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5];
const FIT_MODES = [["page-actual", "实际大小"], ["page-fit", "适合页面"], ["page-width", "适合宽度"]];

function ZoomMenu({ zoom, mode, onPick }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setPos(null);
    };
    const onKey = (e) => { if (e.key === "Escape") setPos(null); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [pos]);
  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: Math.max(8, r.left - 70) });
  };
  const pick = (v) => { onPick(v); setPos(null); };
  const isFit = mode && mode !== "page-actual";
  const Item = ({ on, label, onClick }) => (
    <button onClick={onClick}
      className="w-full h-8 flex items-center gap-2 pl-2 pr-4 rounded-md text-[13px] font-sans text-[#e6e6e6] bg-transparent
                 border-none cursor-pointer hover:bg-[#ffffff1a] text-left whitespace-nowrap">
      <span className="w-4 text-[#7ec8e3] text-[12px] text-center">{on ? "✓" : ""}</span>
      {label}
    </button>
  );
  return (
    <>
      <button ref={btnRef} onClick={toggle} title="缩放比例 / 适合页面 / 适合宽度"
        className={`h-7 w-5 -ml-1 rounded-md flex items-center justify-center border-none cursor-pointer shrink-0
          ${pos ? "text-[#fff] bg-[#ffffff33]" : "text-[#c8c8c8] bg-transparent hover:bg-[#ffffff26]"}`}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {pos && (
        <div ref={panelRef} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
          className="min-w-[150px] p-1 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
          {ZOOM_PRESETS.map(z => (
            <Item key={z} label={`${Math.round(z * 100)}%`} onClick={() => pick(z)}
              on={!isFit && Math.abs(zoom - z) < 0.005} />
          ))}
          <div className="my-1 mx-2 border-t border-[#ffffff1f]" />
          {FIT_MODES.map(([v, label]) => (
            <Item key={v} label={label} onClick={() => pick(v)} on={mode === v} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * 分屏的第二栏：再开一个阅读区看同一篇，自己滚、自己缩放（比如一栏读正文，另一栏停在某张图 / 公式 / 参考文献那页）。
 * 和主阅读区共用同一个 PDFium 文档（Worker 里只解析一次），只是另起一个 PdfiumViewer。
 * 没有自己的工具栏（同 Zotero）：顶栏作用于最后点过的那一栏，这里只把页码 / 缩放报上去（onView），把 api 交出去（apiRef）。
 * 打开时照抄主阅读区此刻的缩放方式（「适合宽度」这类按自己的栏宽重算）和看到的位置，一出来两栏一模一样。
 * 标注照样画出来（只看，点了不弹编辑条），公式旁的复制按钮也有；划选只能复制，加标注 / 翻译在主阅读区做。
 */
function SplitPane({ doc, main, apiRef, annotations, arxivId, eqCopy, onReady, onView }) {
  const containerRef = useRef(null);
  const viewerElRef = useRef(null);
  const [ready, setReady] = useState(null);

  useEffect(() => {
    if (!doc) return;
    const eventBus = new EventBus();
    const viewer = new PdfiumViewer({ container: containerRef.current, viewer: viewerElRef.current, eventBus });
    const report = () => onView({ page: viewer.currentPageNumber, zoom: viewer.currentScale,
                                  mode: /^(page-|auto)/.test(viewer.currentScaleValue) ? viewer.currentScaleValue : null });
    eventBus.on("pagechanging", report);
    eventBus.on("scalechanging", report);
    viewer.setDocument(doc);
    const m = main.current?.viewer;
    viewer.currentScaleValue = m?.currentScaleValue || "page-width";
    // 位置：主阅读区顶上那一页、往下滚了这一页的几成
    const at = m?._anchor();
    if (at) {
      const v = viewer.views[at.index];
      containerRef.current.scrollTop = v.div.offsetTop + at.frac * v.div.offsetHeight;
      containerRef.current.scrollLeft = m.container.scrollLeft;
      viewer.update();
    }
    report();
    apiRef.current = { viewer, linkService: makeLinkService(viewer), eventBus };
    setReady(doc);
    onReady(true);
    return () => { apiRef.current = null; setReady(null); onReady(false); viewer.destroy(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // 栏的尺寸变了（拖分隔条、换方向）：「适合宽度 / 页面」这类按新尺寸重算
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let w = el.clientWidth, h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w && el.clientHeight === h) return;
      w = el.clientWidth; h = el.clientHeight;
      const v = apiRef.current?.viewer;
      if (v && /^(page-|auto)/.test(v.currentScaleValue)) v.currentScaleValue = v.currentScaleValue;
    });
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useHighlightLayer(viewerElRef, apiRef, ready, annotations, { onPick: useCallback(() => {}, []) });
  useEquationCopy(viewerElRef, apiRef, ready, arxivId, eqCopy);

  return (
    <div className="relative h-full bg-[#525659]">
      <div ref={containerRef} className="absolute inset-0 overflow-auto overscroll-contain thin-scrollbar">
        <div ref={viewerElRef} className="pdfViewer relative" />
      </div>
    </div>
  );
}

/**
 * 链接预览浮框（见 PdfViewer 里的「链接预览」）。fixed 定位：放在链接下方，下面放不下就放上方，左右夹在窗口里；
 * 一个小三角指着链接。**挂在 body 上（portal）**：放在阅读区里的话，框里按下 / 滚轮会被阅读区当成「点了正文 / 滚了正文」
 * 把框关掉，划选还会被文字层的拖选接管（踩过）。护眼 / 夜间的颜色靠外面再套一层 rh-paper-*。
 * 引用号是一张文字卡（每条参考文献的原文）；别的链接是目标那一页的图（和正文一样大，滚到目标位置，红点标出目标）。
 */
function LinkPreview({ pv, doc, paper, onEnter, onLeave }) {
  // 页面图：和正文一样大（最宽 900、不超出窗口），高度约半屏；文字卡固定宽、最大高度 300
  const W = pv.kind === "page" ? Math.round(Math.min(doc.pages[pv.dest.pageIndex].size.width * pv.k, 900, window.innerWidth - 16)) : 460;
  const H = pv.kind === "page" ? Math.round(Math.min(420, window.innerHeight * 0.45)) : 300;
  const r = pv.rect;
  const GAP = 10;
  const below = window.innerHeight - r.bottom >= H + GAP + 8 || r.top < H + GAP + 8;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 8));
  const pos = below ? { top: Math.min(r.bottom + GAP, window.innerHeight - H - 8) } : { bottom: window.innerHeight - r.top + GAP };
  const ax = Math.max(14, Math.min(r.left + r.width / 2 - left, W - 14));     // 三角的横坐标（相对框）
  return createPortal(
    <div className={`rh-paper-${paper}`}>
      <div className="fixed z-[70] animate-fade-in" style={{ left, width: W, ...pos }} onPointerEnter={onEnter} onPointerLeave={onLeave}>
        <div className="absolute w-3 h-3 bg-[#fff] border-[#0000002e] rotate-45"
          style={{ left: ax - 6, ...(below ? { top: -6, borderLeftWidth: 1, borderTopWidth: 1 } : { bottom: -6, borderRightWidth: 1, borderBottomWidth: 1 }) }} />
        <div className="relative rounded-lg bg-[#fff] border border-[#0000002e] shadow-[0_8px_28px_rgba(0,0,0,0.35)] overflow-hidden">
          {pv.kind === "page"
            ? <PagePreview doc={doc} dest={pv.dest} width={W} height={H} />
            : (
              <div className="overflow-y-auto rh-light-scroll px-3.5 py-2.5 flex flex-col gap-2 text-[13px] leading-[1.5] text-[#222] font-sans select-text"
                style={{ maxHeight: H }}>
                {pv.entries.map(e => <div key={e.label}>{/^\s*\[/.test(e.text) ? e.text : `[${e.label}] ${e.text}`}</div>)}
              </div>
            )}
        </div>
        {/* 三角盖住框的边线那一段（同色），看起来是从框里长出来的 */}
        <div className="absolute w-3 h-3 bg-[#fff] rotate-45 pointer-events-none"
          style={{ left: ax - 6, ...(below ? { top: -5 } : { bottom: -5 }), clipPath: below ? "polygon(0 0, 100% 0, 0 100%)" : "polygon(100% 0, 100% 100%, 0 100%)" }} />
      </div>
    </div>,
    document.body,
  );
}

function PagePreview({ doc, dest, width, height }) {
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const pageRef = useRef(null);
  const page = doc.pages[dest.pageIndex];
  const k = width / page.size.width;                 // CSS 像素 / 点
  const at = dest.y == null ? null : doc.userToPage(dest.pageIndex, dest.x, dest.y);
  useEffect(() => {
    let alive = true;
    const dpr = window.devicePixelRatio || 1;
    doc.render(dest.pageIndex, k * dpr).then(({ bitmap, width: bw, height: bh }) => {
      const c = canvasRef.current;
      if (!alive || !c) { bitmap.close(); return; }
      c.width = bw; c.height = bh;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
    }).catch(() => {});
    /* 文字层（和正文同一套，lib/pdfium/textLayer）：预览里也能划选复制。外层挂 pdfViewer 和 --scale-factor，
       index.css 里文字层的样式、缩放就都对上了 */
    doc.text(dest.pageIndex).then((data) => {
      const host = pageRef.current;
      if (!alive || !host) return;
      const { layer, nodes } = buildTextLayer(data, page.size);
      layer.append(...nodes);
      host.querySelector(":scope > .textLayer")?.remove();
      host.appendChild(layer);
    }).catch(() => {});
    // 目标位置放在预览框靠上一点（留一行上文）；只给了页码的跳到页首
    if (boxRef.current) boxRef.current.scrollTop = Math.max(0, (at ? at.y : 0) * k - 24);
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, dest.pageIndex, dest.y, width]);
  return (
    <div ref={boxRef} className="overflow-y-auto overflow-x-hidden rh-light-scroll" style={{ height }}>
      <div ref={pageRef} className="pdfViewer relative" style={{ width, height: page.size.height * k, padding: 0, "--scale-factor": k }}>
        <div className="rh-thumb absolute inset-0 bg-[#fff]"><canvas ref={canvasRef} className="block w-full h-full" /></div>
        {/* 目标位置（跳转会落到的那一点）：红点，同 Zotero。放在 rh-thumb 外面，夜间模式的反相不会把它变成青色 */}
        {at && (
          <div className="absolute w-3 h-3 rounded-full bg-[#e53935] opacity-85 pointer-events-none"
            style={{ left: Math.max(2, Math.min(at.x * k, width - 14)) - 6, top: at.y * k - 6 }} />
        )}
      </div>
    </div>
  );
}
