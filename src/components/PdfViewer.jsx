import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  paperKeyFromUrl, anchorsFromSelection, reanchorByQuote, norm as normQuote, areaAnchor, pageCanvasBox, commentKeyOf,
} from "../lib/pdfAnchor";
import {
  baseOf, loadMine, watchPaper, addAnnotation, updateAnnotation, deleteAnnotation, setVisibility,
  copyAnnotation, copiedSourceIds, syncPaper, fetchOthers, normTags, isLocalKey,
  setShareExcluded, loadHiddenOthers, setHiddenOther, undo, redo, historyGroup, historyState, watchHistory, adoptVersionless,
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
import DocProps from "./DocProps";
import CiteDialog from "./CiteDialog";
import LibraryDialog from "./LibraryDialog";
import { useUpdate, openTab } from "../lib/update";
import { useSettings, setSettings } from "../lib/settings";
import { useEquationCopy } from "./EqCopy";
import { extractReferences, citeGroup, citeGroupRect, destKey, paperCard } from "../lib/refs";
import { citeData } from "../lib/cite";
import { takePrefetched } from "../lib/localPdf";
import { findBookmark, saveBookmark, removeBookmark, listCollections } from "../lib/library";
import { sharedPdfium } from "../lib/pdfium/client";
import { toPdfAnnotations } from "../lib/exportPdf";
import { tokenize, trimSelection, buildTextLayer } from "../lib/pdfium/textLayer";
import { clientToNorm, clientRectToNorm, normRectToClient, pageSizePx, localPlacement } from "../lib/pdfium/rotate";
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

/* 阅读位置记在本机：每篇（带版本号）最后看到哪一页、页内滚到几成、缩放方式；刷新 / 再打开时回到那里。
   一个键存一张表，最多记 300 篇（最久没看的先丢） */
const POS_KEY = "rh_pos";
const loadPos = (k) => {
  try { return JSON.parse(localStorage.getItem(POS_KEY) || "{}")[k] || null; } catch { return null; }
};
const savePos = (k, v) => {
  try {
    const m = JSON.parse(localStorage.getItem(POS_KEY) || "{}");
    m[k] = { ...v, t: Date.now() };
    const ks = Object.keys(m);
    if (ks.length > 300) ks.sort((a, b) => m[a].t - m[b].t).slice(0, ks.length - 300).forEach(x => delete m[x]);
    localStorage.setItem(POS_KEY, JSON.stringify(m));
  } catch { /* 存不了就算了 */ }
};

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

/* PDFium（WebAssembly）跑在一个 Worker 里，整个扩展页共用一个（换论文不重启 wasm） */
let docSeq = 0;
const getPdfium = sharedPdfium;

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
const IconSplitV = <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="12" x2="21" y2="12" /></>;
const IconRotate = <><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" /><polyline points="20.5 3.5 20.5 8.5 15.5 8.5" /></>;
/* 单页模式的旋转按钮：箭头中间一个「1」 */
const IconRotateOne = <><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" /><polyline points="20.5 3.5 20.5 8.5 15.5 8.5" />
  <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" fontFamily="system-ui, sans-serif" fill="currentColor" stroke="none">1</text></>;
const IconUndo = <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>;
const IconRedo = <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>;
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
function SyncBadge({ uid, state, pending, onLogin, onSync, manual }) {
  if (!uid) {
    return (
      <button onClick={onLogin} title="笔记目前只存在这台电脑上。登录 ResearchHub 后会和网站同步"
        className="h-7 px-2 rounded-md text-[11.5px] text-[#ffcf7a] bg-[#ffcf7a14] border-none cursor-pointer hover:bg-[#ffcf7a26] shrink-0">
        仅本机 · 登录同步
      </button>
    );
  }
  // 手动同步：有改动时显示「点此同步」，不自动推
  const label = state.busy ? "同步中…" : state.error ? `未同步${pending ? ` ${pending}` : ""}`
    : pending ? (manual ? `${pending} 条未同步 · 同步` : `待同步 ${pending}`) : manual ? "手动同步" : "已同步";
  const color = state.error ? "text-[#ff9a9a]" : state.busy || pending ? "text-[#c8c8c8]" : "text-[#7ee3a0]";
  return (
    <button onClick={onSync} disabled={state.busy}
      title={state.error ? `${state.error}，点一下重试` : manual ? "这篇是手动同步（设置 → 同步），点一下和 ResearchHub 同步" : "和 ResearchHub 同步（点一下立即同步）"}
      className={`h-7 px-2 rounded-md text-[11.5px] bg-transparent border-none cursor-pointer hover:bg-[#ffffff1a] shrink-0 ${color}`}>
      {label}
    </button>
  );
}

export default function PdfViewer({ url, paperKey: givenKey, latestKey, localName, title, session, onLogin, initialPanel }) {
  const containerRef = useRef(null);
  const viewerElRef = useRef(null);
  const apiRef = useRef(null);        // { viewer, linkService, eventBus }
  /* 分屏（SplitPane）开没开 */
  const [splitOpen, setSplitOpen] = useState(false);
  const preSplitRef = useRef(null);        // 开分屏前主阅读区的缩放方式：关分屏时恢复
  /* 只有一个工具栏（同 Zotero）：页码 / 缩放 / 搜索 / 目录 / 缩略图都作用于「最后点过的那一栏」 */
  const [activePane, setActivePane] = useState("main");
  const splitApiRef = useRef(null);
  const [splitReady, setSplitReady] = useState(false);
  const [splitView, setSplitView] = useState({ page: 1, zoom: 1, mode: null });
  const splitContainerRef = useRef(null);
  const splitViewerElRef = useRef(null);
  const [splitOverlay, setSplitOverlay] = useState(null);     // 第二栏的浮层（划选工具条、译文弹窗挂进去）
  /* 分屏时两栏页面一样大（同 Zotero 一开始两栏一模一样）：「适合宽度 / 页面」这类取两栏里算出来较小的那个倍数，
     两栏都用它；数字倍数直接两栏都设。记住是哪种自动方式，栏的尺寸变了再统一算一次 */
  const fitBoth = (v) => {
    const vs = [apiRef.current?.viewer, splitApiRef.current?.viewer].filter(Boolean);
    if (!vs.length) return;
    const preset = /^(page-|auto)/.test(v) ? v : null;
    const sc = preset ? Math.min(...vs.map(x => x._resolve(preset))) : parseFloat(v);
    if (sc > 0) vs.forEach(x => x.setScaleTo(sc, preset));
  };
  const refitBoth = () => {
    if (!splitLiveRef.current) return;          // 正在关分屏：别再统一倍数
    const v = apiRef.current?.viewer.currentScaleValue;
    if (v && /^(page-|auto)/.test(v)) fitBoth(v);
  };
  const splitLiveRef = useRef(false);
  splitLiveRef.current = splitOpen && splitReady;
  const refitBothRef = useRef(refitBoth);
  refitBothRef.current = refitBoth;
  /* 划选发生在哪一栏：工具条、译文弹窗、TransMark 都挂在那一栏的浮层里、按那一栏的坐标放 */
  const [selPane, setSelPane] = useState("main");
  /* 编辑界面（标注编辑条、文本框编辑、附注卡片、框选调整框）挂在哪一栏：在哪一栏放 / 点的就挂在哪一栏 */
  const [editPane, setEditPane] = useState("main");
  const splitOverlayRef = useRef(null);
  const onSplitOverlay = useCallback((el) => { splitOverlayRef.current = el; setSplitOverlay(el); }, []);
  /* 框选 / 画笔 / 橡皮擦 / 添加文本 / 附注这些工具在每一栏上各挂一份（分屏时两栏都能用）。
     fn(P) 收到 { key, container, viewerEl, overlay }，返回清理函数 */
  const forPanes = (fn) => {
    const panes = [{ key: "main", container: containerRef.current, viewerEl: viewerElRef.current, overlay: overlayRef.current }];
    if (splitLiveRef.current) panes.push({ key: "split", container: splitContainerRef.current, viewerEl: splitViewerElRef.current, overlay: splitOverlayRef.current });
    const offs = panes.filter(p => p.container && p.viewerEl).map(fn);
    return () => offs.forEach(f => f?.());
  };
  const paneEls = (p) => (p === "split"
    ? { container: splitContainerRef.current, viewerEl: splitViewerElRef.current }
    : { container: containerRef.current, viewerEl: viewerElRef.current });

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
  // 本地文件的身份由外面认好传进来（lib/localPdf：可能认出是某篇 arXiv 论文，也可能是 file:…）
  const paperKey = useMemo(() => givenKey || paperKeyFromUrl(url), [givenKey, url]);
  const base = baseOf(paperKey);
  const commentKey = commentKeyOf(paperKey);
  const meta = useMemo(() => ({ title, url }), [title, url]);
  /* arXiv 号（不带 arxiv: 前缀）：本地文件认不出是 arXiv 论文时为空 —— 复制公式（要 arXiv 源码）、INSPIRE 查参考文献这些就关掉 */
  const arxivKey = /^arxiv:/.test(paperKey) ? paperKey.replace(/^arxiv:/, "") : "";
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
  const transPos = (rectList, pane = "main") => {
    const els = paneEls(pane);
    const vb = els.viewerEl.getBoundingClientRect();
    const cb = els.container.getBoundingClientRect();
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
  /* 新版本检测（lib/update）：一天最多查一次 GitHub。卡片点 ✕ 是「这次先不提示」，记在这个标签页里 */
  const upd = useUpdate();
  const [updLater, setUpdLater] = useState(() => {
    try { return !!sessionStorage.getItem("rh_upd_later"); } catch { return false; }
  });
  // 公式旁的「复制 LaTeX」按钮（components/EqCopy.js）
  useEquationCopy(viewerElRef, apiRef, doc, arxivKey, settings.eqCopy);
  const autoTransRef = useRef(false);
  autoTransRef.current = settings.autoTranslate;    // 划选监听只挂一次，靠 ref 读最新设置
  const [selPos, setSelPos] = useState(null);
  const [pending, setPending] = useState(null);
  const [draft, setDraft] = useState(null);
  const [fixes, setFixes] = useState({});
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
  /* 同步方式（设置 → 同步）：arXiv 论文和本地文件分开设。自动 = 打开时、改完 1.5 秒后同步；
     手动 = 只有点顶栏的同步按钮（或弹窗里的「全部同步」）才同步 */
  const autoSync = isLocalKey(paperKey) ? settings.syncLocal === "auto" : settings.syncArxiv !== "manual";
  useEffect(() => { if (autoSync) runSync(); }, [runSync, autoSync]);
  const [editTick, setEditTick] = useState(0);
  const bump = () => setEditTick(t => t + 1);
  useEffect(() => {
    if (!uid || !editTick || !autoSync) return;
    const t = setTimeout(runSync, 1500);
    return () => clearTimeout(t);
  }, [uid, editTick, runSync, autoSync]);

  /* 这条标注是不是做在正在看的这个版本上。没带版本号的（以前从 arxiv.org/pdf/<id> 这种地址打开时存的，别人的也可能有）
     算**最新版** —— 那种地址打开的就是当时的最新版。最新版是哪个由 viewer/main.jsx 查 arXiv 摘要页得到（latestKey）；
     还没查到时先当成正在看的这版（和改之前一样），查到了再按它算。明确打开旧版（…v1）时这些笔记不画在 v1 上 */
  const thisVersion = useCallback((k) => !k || k === paperKey
    || (/^arxiv:/.test(k) && !/v\d+$/.test(k) && paperKey.startsWith(`${k}v`) && (!latestKey || latestKey === paperKey)), [paperKey, latestKey]);
  /* 打开的正是最新版：把自己那些没带版本号的笔记正式归到这一版（lib/notes 的 adoptVersionless，公开设置一起带过去） */
  useEffect(() => {
    if (!latestKey || latestKey !== paperKey) return;
    adoptVersionless(latestKey, uid).then(n => { if (n) { reload(); bump(); } }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestKey, paperKey, uid]);
  /* 别的版本做的标注：坐标一律不用，降级成页级 + 「位置可能不准」，再按 quote 找回页码 */
  const applyFix = useCallback((a) => {
    if (thisVersion(a.paper_key)) return a;
    const fix = fixes[a.id];
    return { ...a, rects: null, stale: true, page: fix?.page ?? a.page };
  }, [thisVersion, fixes]);

  const mineView = useMemo(() => mine.map(applyFix), [mine, applyFix]);
  /* 「他人」里自己隐藏掉的标注（lib/notes 的 others_hidden）：正文上不画；列表里收起，可以再显示出来 */
  const [hiddenOthers, setHiddenOthers] = useState(() => new Set());
  useEffect(() => { loadHiddenOthers().then(setHiddenOthers).catch(() => {}); }, []);
  const hideOther = async (a, hide) => setHiddenOthers(await setHiddenOther(a.id, hide));
  const othersView = useMemo(
    () => others.map(o => ({ ...o, annotations: o.annotations.map(applyFix) })),
    [others, applyFix]);

  const foreignIds = useMemo(() => {
    const all = [...mine, ...others.flatMap(o => o.annotations)];
    return all.filter(a => !thisVersion(a.paper_key) && !fixes[a.id]);
  }, [mine, others, thisVersion, fixes]);

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
    if (scope !== "mine") othersView.forEach(o => list.push(...o.annotations.filter(a => !hiddenOthers.has(a.id)).map(a => (a.rects?.length && a.kind !== "ink" && a.kind !== "text"
      ? { ...a, _author: o.author?.name || o.author?.username || "" } : a))));
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, mineView, othersView, me?.name, hiddenOthers]);

  /* 点中的是自己的区域框 ⇒ 进入拖动 / 缩放（正文上那个先不画，由编辑框代替） */
  const editArea = annMenu
    ? mineView.find(x => x.id === annMenu.id && x.kind === "area" && x.rects?.length === 1 && !x.stale) || null
    : null;

  const mineIdsRef = useRef(new Set());
  mineIdsRef.current = new Set(mineView.map(x => x.id));
  const mineViewRef = useRef([]);
  mineViewRef.current = mineView;
  /* 点正文上的标注（两栏各一个）：编辑界面挂在点的那一栏 */
  const makePick = (pane) => (a, el) => {
    setEditPane(pane);
    if (a.kind === "text" && mineIdsRef.current.has(a.id)) { openTextRef.current?.(a); return; }
    if (a.kind === "note") { openNoteRef.current?.(a); return; }
    setActiveId(a.id);
    const r = el?.getBoundingClientRect();
    const vb = paneEls(pane).viewerEl?.getBoundingClientRect();
    if (r && vb) setAnnMenu({ id: a.id, pos: floatPos(r, vb, 120) });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pickMain = useCallback(makePick("main"), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pickSplit = useCallback(makePick("split"), []);
  useHighlightLayer(viewerElRef, apiRef, doc, visibleAnns, {
    hiddenId: editArea?.id || textEdit?.id,
    activeId,
    /* 点正文上的标注：选中它，并在它上方弹出编辑条（换颜色 / 线型 / 批注 / 删除）；
       自己的文本框直接进入编辑（同 Edge：点文字就能改） */
    onPick: pickMain,
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
          // 上次看到哪儿就回到哪儿（缩放方式也一样）；第一次打开默认 100%（纸面原尺寸），不按宽度撑满
          const saved = loadPos(paperKey);
          if (rotationRef.current) viewer.setRotation(rotationRef.current);    // 换了文档（重新加载）：角度照旧
          if (Object.keys(pageRotRef.current).length) viewer.setPageRotations(pageRotRef.current);
          viewer.currentScaleValue = saved?.scale || "page-actual";
          const v = saved?.page && viewer.views[saved.page - 1];
          if (v) { viewer.container.scrollTop = v.slot.offsetTop + (saved.frac || 0) * v.slot.offsetHeight; viewer.update(); }
          if (alive) setZoom(viewer.currentScale);
        });
        eventBus.on("pagechanging", (e) => { if (alive) setPage(e.pageNumber); });
        // presetValue：page-width / page-fit 这类「自动」倍数时有值，下拉菜单靠它打勾
        eventBus.on("scalechanging", (e) => { if (alive) { setZoom(e.scale); setScaleMode(e.presetValue || null); } });

        // 本地 / 其他网站的 PDF 在认身份时已经下过一遍（lib/localPdf），直接用
        let buf = takePrefetched(url);
        if (!buf) {
          const res = await fetch(url, /^https?:/.test(url) && !/arxiv\.org\//.test(url) ? { credentials: "include" } : undefined);
          if (!res.ok) throw new Error(`下载 PDF 失败（${res.status}）`);
          buf = await res.arrayBuffer();
        }
        const bytes = new Uint8Array(buf.slice(0));       // 留一份原始字节给「下载」用（buf 会被转交给 Worker）
        const docId = `d${++docSeq}`;
        const info = await pdf.open(docId, buf);
        if (!alive) { pdf.close(docId); return; }
        /* 文件里自带的标注照旧由 PDF 自己画；只有「我们自己导出的」那几条（注释名 = 本机已有的笔记 id）
           从显示用的这份里去掉，由我们的笔记画 —— 不然叠两层。要在开始画页面之前做 */
        const own = await loadMine(paperKey).then(m => m.annotations.map(a => a.id)).catch(() => []);
        if (own.length) await pdf.stripNamed(docId, own).catch(() => 0);
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

  /* 阅读位置：停下来半秒记一次，关页面 / 刷新前再记一次。分屏时主阅读区的缩放是临时统一过的，记分屏前的那个 */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !doc || !paperKey) return;
    let t = 0;
    const save = () => {
      const v = apiRef.current?.viewer;
      const a = v?._anchor();
      if (a) savePos(paperKey, { page: a.index + 1, frac: +a.frac.toFixed(4), scale: preSplitRef.current || v.currentScaleValue });
    };
    const onScroll = () => { clearTimeout(t); t = setTimeout(save, 500); };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => { clearTimeout(t); save(); el.removeEventListener("scroll", onScroll); window.removeEventListener("pagehide", save); };
  }, [doc, paperKey]);

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
      /* 分屏时栏的尺寸变了（拖分隔条）不重算倍数（同 Zotero）：页面大小不变，只是一栏露出的多一点 / 少一点。
         只在打开分屏、换方向、进出全屏时两栏统一算一次（fitBoth） */
      if (splitLiveRef.current) return;
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
  // 分屏时缩放两栏一起改（两栏页面一样大，见 fitBoth）；页码、搜索还是各管各的
  const setScale = (v) => {
    if (splitOpen && splitReady) { fitBoth(String(v)); return; }
    const a = act(); if (a) a.viewer.currentScaleValue = String(v);
  };
  /* 旋转（同 Edge：每点一下顺时针转 90°，只转显示方向，不改文件；刷新回到不转）。
     分屏时两栏一起转；「适合宽度 / 页面」按转过之后的尺寸重算，两栏照旧一样大 */
  const [rotation, setRotation] = useState(0);
  const rotationRef = useRef(0);
  const rotate = (dir = 1) => {
    const r = (rotationRef.current + (dir > 0 ? 90 : 270)) % 360;
    rotationRef.current = r;              // 连点几下：每下都在上一下的基础上转
    setRotation(r);
    [apiRef.current?.viewer, splitApiRef.current?.viewer].filter(Boolean).forEach(v => v.setRotation(r));
    refitBoth();
  };
  /* 只转一页（旋转按钮旁的下拉）：叠在整体角度上，{ 页下标: 角度 }；转的是当前这一栏正在看的那一页 */
  const [pageRot, setPageRot] = useState({});
  const pageRotRef = useRef({});
  const applyPageRot = (m) => {
    pageRotRef.current = m;
    setPageRot(m);
    [apiRef.current?.viewer, splitApiRef.current?.viewer].filter(Boolean).forEach(v => v.setPageRotations(m));
    refitBoth();
  };
  const rotatePage = (dir) => {
    const i = vPage - 1, m = { ...pageRotRef.current };
    const r = ((m[i] || 0) + (dir > 0 ? 90 : 270)) % 360;
    if (r) m[i] = r; else delete m[i];
    applyPageRot(m);
  };
  /* 旋转按钮转「所有页」还是「当前这一页」（下拉里选，记在本机）；Ctrl+] / Ctrl+[ 也跟着它 */
  const [rotMode, setRotModeRaw] = useState(() => localStorage.getItem("rh_rot_mode") === "page" ? "page" : "all");
  const setRotMode = (m) => { setRotModeRaw(m); localStorage.setItem("rh_rot_mode", m); };
  const rotateBtn = (dir) => (rotMode === "page" ? rotatePage(dir) : rotate(dir));
  const resetAllRot = () => {
    rotationRef.current = 0;
    setRotation(0);
    pageRotRef.current = {};
    setPageRot({});
    [apiRef.current?.viewer, splitApiRef.current?.viewer].filter(Boolean).forEach(v => { v.setPageRotations({}); v.setRotation(0); });
    refitBoth();
  };
  const [propsOpen, setPropsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);       // 文献收藏（头像菜单里打开）
  /* 「引用」这篇论文本身（同文献卡片里的「引用」，GB/T 7714 / MLA / APA + BibTeX 等）：
     arXiv 的按编号查 INSPIRE / Semantic Scholar；本地文件按 PDF 元数据的标题 / 作者查 Crossref，查不到就不给引用 */
  const [selfCite, setSelfCite] = useState(null);       // null | "loading" | card | "none"
  useEffect(() => { setSelfCite(null); }, [paperKey]);      // 换了论文：重新查（没查到的那篇按钮是灰的）
  /* 查这篇的卡片：要连着问好几个接口（INSPIRE 搜编号 → 取记录 → 有 DOI 再问 Crossref 补期刊信息），
     第一次点要等一两秒。所以①打开论文 3 秒后、空闲时先把它查好（结果在 lib/refs、lib/cite 里有缓存），
     ②点的时候框先弹出来（显示「正在整理引用信息…」），查到了再填进去 */
  const lookupSelf = async () => {
    let meta = {};
    if (!arxivKey) meta = await doc.props?.().catch(() => ({})) || {};
    return paperCard({
      arxivBase: arxivKey ? arxivKey.replace(/v\d+$/, "") : null,
      doi: /^doi:/.test(paperKey) ? paperKey.slice(4) : null,
      title: meta.Title || title || (localName || "").replace(/\.pdf$/i, ""), author: meta.Author,
    });
  };
  const lookupSelfRef = useRef(lookupSelf);
  lookupSelfRef.current = lookupSelf;
  useEffect(() => {
    if (!doc) return undefined;
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1));
    const t = setTimeout(() => idle(() => lookupSelfRef.current().then(c => c && citeData(c)).catch(() => {})), 3000);
    return () => clearTimeout(t);
  }, [doc, paperKey]);
  const openSelfCite = async () => {
    if (!doc) return;
    setSelfCite("loading");
    const c = await lookupSelf();
    setSelfCite(s => (s === "loading" ? c || "none" : s));      // 等的时候已经把框关了：不再弹
    if (!c) showToast("没查到这篇论文的引用信息", false);
  };
  /* 「显示标注」（点标题的下拉里开关）：关掉时 PDF 文件里自带的注释不画（两栏都重画），我们自己的标注层由 .rh-hide-annots 藏起来 */
  const showAnnots = settings.showAnnots !== false;
  useEffect(() => {
    [apiRef.current?.viewer, splitApiRef.current?.viewer].filter(Boolean).forEach(v => v.setAnnotations(showAnnots));
  }, [showAnnots, doc, splitReady]);
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

  /* ── 划选 → 工具条（放进 .pdfViewer 的内容坐标里，跟着页面滚）。两栏都能划选：
     工具条挂在划选的那一栏（selPane），坐标按那一栏的 .pdfViewer 算 ── */
  const selWatch = (pane) => {
    const { container: el } = paneEls(pane);
    if (!el) return undefined;
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
        const vb = paneEls(pane).viewerEl?.getBoundingClientRect();
        if (!last || !vb) { clear(); return; }
        setSelPane(pane);
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
          setTrans({ anchors, text: anchors[0].quote, pos: transPosRef.current(rects, pane), pane });
        }
      }, 0);
    };
    el.addEventListener("mouseup", onUp);
    return () => el.removeEventListener("mouseup", onUp);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => selWatch("main"), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => (splitReady ? selWatch("split") : undefined), [splitReady]);

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
    // 收起时标注的「选中」状态也一起取消（以前只收编辑条，标注一直是选中的样子）
    const close = (e) => {
      if (e.target?.closest?.(".rh-selbar") || e.target?.closest?.("[data-ann-id]")) return;
      setAnnMenu(null);
      setActiveId(null);
    };
    const onKey = (e) => { if (e.key === "Escape") { setAnnMenu(null); setActiveId(null); } };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [annMenu]);
  /* 没有编辑条、但有标注是选中的（从笔记列表点过去的那种）：点正文别处 / Esc 也取消选中。
     文本框、附注卡片开着的时候它们自己管 */
  useEffect(() => {
    if (!activeId || annMenu || textEdit || noteEdit) return;
    const off = (e) => {
      if (e.type === "keydown" ? e.key !== "Escape" : (e.target?.closest?.("[data-ann-id]") || e.target?.closest?.(".rh-selbar") || !e.target?.closest?.(".pdfViewer"))) return;
      setActiveId(null);
    };
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", off);
    return () => { window.removeEventListener("pointerdown", off, true); window.removeEventListener("keydown", off); };
  }, [activeId, annMenu, textEdit, noteEdit]);

  /* ── 区域框选：在一页上拖一个框（不跨页），pointer 事件 + capture ── */
  useEffect(() => {
    if (tool !== "area") return;
    return forPanes((P) => {
    const el = P.container;
    let st = null;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const rectOf = (e) => {
      const { box, x0, y0 } = st;
      const [x1, y1] = clientToNorm(st.pageEl, e.clientX, e.clientY, box).map(clamp);   // 转过的页也对（rotate.js）
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
      setEditPane(P.key);
      const box = pageCanvasBox(pageEl);
      const ghost = document.createElement("div");
      /* 拖的时候和拖完等着选颜色的时候都是虚线框，颜色 / 粗细按当前默认样式 */
      const { color, width } = areaStyleRef.current;
      ghost.style.cssText = "position:absolute;z-index:2;pointer-events:none;box-sizing:border-box;" +
        `border:${width}px dashed ${rgba(color, 0.95)};background:${rgba(color, 0.08)};border-radius:2px`;
      pageEl.appendChild(ghost);
      const [x0, y0] = clientToNorm(pageEl, e.clientX, e.clientY, box).map(clamp);
      st = { pageEl, box, ghost, pid: e.pointerId, x0, y0 };
      paintGhost({ x: st.x0, y: st.y0, w: 0, h: 0 });
      try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    };
    const move = (e) => { if (st && e.pointerId === st.pid) paintGhost(rectOf(e)); };
    const up = (e) => {
      if (!st || e.pointerId !== st.pid) return;
      const r = rectOf(e);
      const { box, pageEl, ghost } = st;
      const px = pageSizePx(pageEl);
      const tiny = r.w * px.w < 10 || r.h * px.h < 10;   // 手抖点了一下
      const vb = P.viewerEl?.getBoundingClientRect();
      if (tiny || !vb) { end(); return; }
      end(true);                       // 虚线框留着，直到存好（clearSel 里删）
      ghostRef.current = ghost;
      /* 默认样式已经选好了 ⇒ 松手直接存，不再弹颜色条让人再选一遍；
         存完自动选中它，可以马上拖动 / 缩放 / 改样式 */
      saveAreaRef.current(areaAnchor(pageEl, r), floatPos(normRectToClient(pageEl, r, box), vb, 120));
    };
    const onKey = (e) => { if (e.key === "Escape") { end(); clearSel(); setTool("text"); } };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", end);
    if (P.key === "main") window.addEventListener("keydown", onKey);
    return () => {
      end();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", onKey);
    };
    });
  }, [tool, clearSel, splitReady]);

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
    return forPanes((P) => {
    const el = P.container;
    /* 新文本框的大小：一行高；宽度至少放得下占位提示「在此处开始键入…」（约 10 个字）——
       原来写死 220px，字号一大提示就折成两行（踩过） */
    /* 都按页面方向算（转过的页上文本框跟着页面转，同 Edge），见 rotate.js */
    const geom = (pageEl, e) => {
      const px = pageSizePx(pageEl);
      const st = textStyleRef.current;
      const k = parseFloat(P.viewerEl.style.getPropertyValue("--scale-factor")) || 1.333;
      const fontPx = st.size * k;
      const wPx = Math.min(Math.max(200, fontPx * 10 + 16), px.w);
      const hPx = fontPx * 1.3 + 4;
      // 光标落在框里：左边留 6px，竖直方向在第一行中间
      const [u, v] = clientToNorm(pageEl, e.clientX, e.clientY);
      const x = Math.min(Math.max(0, u - 6 / px.w), 1 - wPx / px.w);
      const y = Math.min(Math.max(0, v - hPx / 2 / px.h), 1 - hPx / px.h);
      return { px, st, x, y, wPx, hPx };
    };

    /* 跟着鼠标的虚线框：告诉你点下去文本框会放在哪儿（参照 Edge）。直接改 DOM，不走 React —— 每次移动都重渲染太浪费 */
    const ghost = document.createElement("div");
    ghost.style.cssText = "position:absolute;z-index:44;pointer-events:none;box-sizing:border-box;display:none;" +
      "border:1.5px dashed #2f7bd8;border-radius:2px;background:rgba(47,123,216,0.04)";
    P.overlay?.appendChild(ghost);
    const hideGhost = () => { ghost.style.display = "none"; };
    const move = (e) => {
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl || textEditRef.current || e.target?.closest?.("[data-ann-id]")) { hideGhost(); return; }
      const { x, y, wPx, hPx } = geom(pageEl, e);
      const pl = localPlacement(pageEl, x, y, P.viewerEl.getBoundingClientRect());
      Object.assign(ghost.style, {
        display: "block", left: `${pl.left}px`, top: `${pl.top}px`, width: `${wPx}px`, height: `${hPx}px`,
        transform: pl.transform || "", transformOrigin: "0 0",
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
      const { px, st, x, y, wPx } = geom(pageEl, e);
      setEditPane(P.key);
      setTextEdit({
        id: null, paper_key: paperKey, page: Number(pageEl.dataset.pageNumber),
        rect: { x, y, w: wPx / px.w, h: 0 },
        body: "", color: st.color, style: { size: st.size, spacing: st.spacing }, orig: "",
      });
    };
    const onKey = (e) => { if (e.key === "Escape" && !textEditRef.current) setTool("text"); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", hideGhost);
    if (P.key === "main") window.addEventListener("keydown", onKey);
    return () => {
      ghost.remove();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", hideGhost);
      window.removeEventListener("keydown", onKey);
    };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, paperKey, splitReady]);

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
    return forPanes((P) => {
    const el = P.container;
    /* 图标放下去的位置：鼠标在页面上时，跟着一个和图标一样大的虚线框（同「添加文本」） */
    /* 图标左上角在页面上的比例坐标（页面方向；图标本身在高亮层里跟着页面转） */
    const where = (pageEl, e) => {
      const px = pageSizePx(pageEl);
      const [u, v] = clientToNorm(pageEl, e.clientX, e.clientY);
      const fw = NOTE_SIZE / px.w, fh = NOTE_SIZE / px.h;
      return { x: Math.min(Math.max(0, u - fw / 2), 1 - fw), y: Math.min(Math.max(0, v - fh / 2), 1 - fh), fw, fh };
    };
    const ghost = document.createElement("div");
    ghost.style.cssText = `position:absolute;z-index:44;pointer-events:none;box-sizing:border-box;display:none;width:${NOTE_SIZE}px;height:${NOTE_SIZE}px;` +
      "border:1.5px dashed #2f7bd8;border-radius:5px;background:rgba(47,123,216,0.06)";
    P.overlay?.appendChild(ghost);
    const hideGhost = () => { ghost.style.display = "none"; };
    const move = (e) => {
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl || noteEditRef.current || e.target?.closest?.("[data-ann-id]")) { hideGhost(); return; }
      const { x, y } = where(pageEl, e);
      const pl = localPlacement(pageEl, x, y, P.viewerEl.getBoundingClientRect());
      Object.assign(ghost.style, { display: "block", left: `${pl.left}px`, top: `${pl.top}px`, transform: pl.transform || "", transformOrigin: "0 0" });
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
      const { x, y } = where(pageEl, e);
      const name = me?.name || "我";
      setEditPane(P.key);
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
    if (P.key === "main") window.addEventListener("keydown", onKey);
    return () => {
      ghost.remove();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", hideGhost);
      window.removeEventListener("keydown", onKey);
    };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, paperKey, me?.name, splitReady]);

  /* 拖动自己的附注图标：直接改图标的 left/top（不走 React），松手再存。
     拖过之后紧跟着的那次 click 吞掉，不然一松手卡片就弹出来了 */
  useEffect(() => {
    if (!doc) return undefined;
    return forPanes((P) => {
    const el = P.container;
    let drag = null;
    const down = (e) => {
      if (e.button !== 0) return;
      const icon = e.target?.closest?.(".rh-note");
      const a = icon && mineViewRef.current.find(x => String(x.id) === icon.dataset.annId);
      if (!a) return;
      const pageEl = icon.closest(".page");
      // 按页面方向算（转过的页上往哪拖都对，见 rotate.js）：起点的比例坐标 + 图标原来的位置
      const [u0, v0] = clientToNorm(pageEl, e.clientX, e.clientY);
      drag = { icon, a, pageEl, px: pageSizePx(pageEl), sx: e.clientX, sy: e.clientY, u0, v0, x0: a.rects[0].x, y0: a.rects[0].y, moved: false };
      e.preventDefault();
    };
    const move = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      const { px } = drag;
      const [u, v] = clientToNorm(drag.pageEl, e.clientX, e.clientY);
      drag.x = Math.min(Math.max(0, drag.x0 + u - drag.u0), 1 - NOTE_SIZE / px.w);
      drag.y = Math.min(Math.max(0, drag.y0 + v - drag.v0), 1 - NOTE_SIZE / px.h);
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
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, paperKey, splitReady]);

  /* ── 画笔 / 橡皮擦 ───────────────────────────────────────────────
     一笔一条标注（kind = "ink"，数据格式见 PdfNotes 的 inkSvg）。
     画的时候先在那一页上挂一张临时 SVG 实时描，松手抽稀后存库，临时的那张随即去掉。
     线宽按「100% 缩放时的像素」选，存成占页宽的比例 —— 换缩放比例时笔迹粗细跟着页面变 */
  const [penStyle, setPenStyle] = useState(loadPenStyle);
  const penStyleRef = useRef(penStyle);
  useEffect(() => { penStyleRef.current = penStyle; savePenStyle(penStyle); }, [penStyle]);
  /* 画笔光标 = 落点：一个和笔同色、同粗（按当前缩放）的圆点，外面一圈白 + 一圈深色，深浅底上都看得见；
     热点在圆心。挂成 :root 上的 CSS 变量，主阅读区和分屏都用（index.css 的 .rh-pen-mode） */
  useEffect(() => {
    const d = Math.min(60, Math.max(3, penStyle.width * zoom));
    const S = 2 * Math.ceil((d + 6) / 2), c = S / 2;     // 边长取偶数，圆心正好落在整像素的热点上
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${S}' height='${S}'>`
      + `<circle cx='${c}' cy='${c}' r='${d / 2 + 1.5}' fill='none' stroke='rgba(0,0,0,0.55)' stroke-width='1'/>`
      + `<circle cx='${c}' cy='${c}' r='${d / 2 + 0.5}' fill='none' stroke='white' stroke-width='1'/>`
      + `<circle cx='${c}' cy='${c}' r='${d / 2}' fill='${rgba(penStyle.color, 0.95)}'/></svg>`;
    document.documentElement.style.setProperty("--rh-pen-cursor",
      `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`);
  }, [penStyle, zoom]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const saveInkRef = useRef(null);
  saveInkRef.current = async (page, stroke) => {
    const row = await addAnnotation(paperKey, meta, {
      page, kind: "ink", color: penStyleRef.current.color, rects: [stroke], quote: null,
    });
    await reload();
    bump();
  };
  const eraseRef = useRef(null);
  eraseRef.current = async (a) => { await deleteAnnotation(a.paper_key || paperKey, a.id); reload(); bump(); };

  useEffect(() => {
    if (tool !== "pen") return;
    return forPanes((P) => {
    const el = P.container;
    let st = null;
    const SVGNS = "http://www.w3.org/2000/svg";
    const norm = (e) => clientToNorm(st.pageEl, e.clientX, e.clientY, st.box);      // 页面方向（转过的页也对）
    const redraw = () => st.path.setAttribute("d", inkPathD(st.pts, st.H));
    const down = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target?.closest?.(".rh-selbar")) return;
      const pageEl = e.target?.closest?.(".page");
      if (!pageEl) return;
      e.preventDefault();
      setAnnMenu(null);
      const box = pageCanvasBox(pageEl);
      const sz = pageSizePx(pageEl);                       // 页面方向的像素尺寸（旋转时和 box 横竖对调）
      const H = 1000 * sz.h / sz.w;
      const lw = penStyleRef.current.width / (sz.w / zoomRef.current);     // 占页宽的比例
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
      st = { pageEl, box, sz, H, lw, svg, path, pid: e.pointerId, pts: [] };
      st.pts.push(norm(e));
      redraw();
      try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    };
    const move = (e) => {
      if (!st || e.pointerId !== st.pid) return;
      const p = norm(e), q = st.pts[st.pts.length - 1];
      // 小于半个像素的移动不记，免得一秒几百个点
      if (Math.hypot((p[0] - q[0]) * st.sz.w, (p[1] - q[1]) * st.sz.h) < 0.5) return;
      st.pts.push(p);
      redraw();
    };
    const up = async (e) => {
      if (!st || e.pointerId !== st.pid) return;
      const s0 = st;
      st = null;
      try { el.releasePointerCapture(s0.pid); } catch { /* 已经释放了 */ }
      /* 抽稀按像素算（偏差 0.6px 以内的点去掉），再换回归一化坐标存 */
      const px = s0.pts.map(([x, y]) => [x * s0.sz.w, y * s0.sz.h]);
      const kept = simplify(px, 0.6).map(([x, y]) => [+(x / s0.sz.w).toFixed(4), +(y / s0.sz.h).toFixed(4)]);
      const xs = kept.map(q => q[0]), ys = kept.map(q => q[1]);
      const padX = s0.lw / 2, padY = padX * s0.sz.w / s0.sz.h;
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
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    if (P.key === "main") window.addEventListener("keydown", onKey);
    return () => {
      st?.svg.remove();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", onKey);
    };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, splitReady]);

  /* 橡皮擦：按住拖过去，碰到的手写笔迹整条删掉（同 Edge 的「笔划橡皮擦」）。只擦自己的、只擦笔迹 */
  useEffect(() => {
    if (tool !== "eraser") return;
    return forPanes((P) => {
    const el = P.container;
    let pressed = null;
    const gone = new Set();
    const R = 8;                                // 橡皮擦半径（px）
    const hitAt = (e) => {
      const pageEl = document.elementsFromPoint(e.clientX, e.clientY).map(n => n.closest?.(".page")).find(Boolean);
      if (!pageEl) return;
      const n = Number(pageEl.dataset.pageNumber);
      // 页面方向的像素坐标（转过的页也对，见 rotate.js）
      const box = pageSizePx(pageEl);
      const [u, v] = clientToNorm(pageEl, e.clientX, e.clientY);
      const px = u * box.w, py = v * box.h;
      for (const a of mineRef.current) {
        if (a.kind !== "ink" || a.page !== n || gone.has(a.id) || !thisVersion(a.paper_key)) continue;
        const hit = (a.rects || []).some(st => {
          const pts = (st.path || []).map(([x, y]) => [x * box.w, y * box.h]);
          const tol = R + (st.lw || 0) * box.w / 2;
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
    if (P.key === "main") window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", onKey);
    };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, paperKey, splitReady]);

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
    const vb = viewerElRef.current?.getBoundingClientRect();
    if (vb) setAnnMenu(m => m && ({ ...m, pos: floatPos(normRectToClient(pageEl, rect), vb, 120) }));
  };
  const saveAnchors = async (anchors, extra = {}) => {
    // 一次划选跨了几页会存成几条：算一步，撤销时一起撤
    await historyGroup(async () => { for (const a of anchors) await addAnnotation(paperKey, meta, { ...a, ...extra }); });
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
    page, canShare: !!uid, doc, activeId,
    // 二级分享：整份分享时某几条不分享；「他人」里隐藏某几条
    onShareExcluded: async (a, excluded) => { await setShareExcluded(a.paper_key || paperKey, a.id, excluded); reload(); bump(); },
    hiddenOthers, onHideOther: hideOther,
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
  /* 搜索选项（搜索框下面那一行）：高亮所有（默认开）/ 区分大小写 / 整词，记在本机 */
  const [findOpts, setFindOptsRaw] = useState(() => {
    const def = { highlightAll: true, caseSensitive: false, entireWord: false };
    try { return { ...def, ...JSON.parse(localStorage.getItem("rh_find_opts") || "{}") }; } catch { return def; }
  });
  const findOptsRef = useRef(findOpts);
  findOptsRef.current = findOpts;
  /* 搜的是哪一栏：每次现查（分屏时是最后点过的那一栏）。
     **别把 act 闭包进 useCallback 里**：那样永远是第一次渲染时的那一栏 —— 分屏后只能搜左栏（踩过） */
  const actRef = useRef(act);
  actRef.current = act;
  const runFind = useCallback((q, again, prev = false) => {
    actRef.current()?.eventBus.dispatch("find", {
      source: window, type: again ? "again" : "", query: q, findPrevious: prev, ...findOptsRef.current,
    });
  }, []);
  const setFindOpt = (k) => {
    const next = { ...findOptsRef.current, [k]: !findOptsRef.current[k] };
    findOptsRef.current = next;
    setFindOptsRaw(next);
    try { localStorage.setItem("rh_find_opts", JSON.stringify(next)); } catch { /* 存不了就算了 */ }
    if (query) runFind(query, false);
    findInputRef.current?.focus();
  };
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
  /* 分屏时换了当前栏：搜索跟过去（另一栏的命中高亮清掉，在这一栏重新搜） */
  const queryRef = useRef("");
  useEffect(() => {
    if (!findOpen || !queryRef.current) return;
    const other = onSplit ? apiRef.current : splitApiRef.current;
    other?.eventBus.dispatch("findbarclose", { source: window });
    runFind(queryRef.current, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSplit]);

  /* ── 撤销 / 恢复（lib/notes 的 undo / redo）──────────────────────────
     撤的是标注的新建、修改、删除（同 Edge：刷新页面就清空）。Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 恢复；
     光标在输入框、文本框、批注编辑里时让给浏览器自己的撤销（撤的是正在打的字） */
  const [hist, setHist] = useState(historyState);
  useEffect(() => watchHistory(() => setHist(historyState())), []);
  const runHistory = async (dir) => {
    if (!(await (dir === "undo" ? undo() : redo()))) return;
    setAnnMenu(null);
    await reload();
    bump();
  };
  const runHistoryRef = useRef(runHistory);
  runHistoryRef.current = runHistory;
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      const t = e.target;
      if (t?.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
      e.preventDefault();
      runHistoryRef.current(k === "y" || e.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+] / Ctrl+[：顺时针 / 逆时针旋转（同 Edge）
  const rotateRef = useRef(rotateBtn);
  rotateRef.current = rotateBtn;
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key !== "]" && e.key !== "[")) return;
      if (e.target?.closest?.("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
      rotateRef.current(e.key === "]" ? 1 : -1);      // 按当前模式：所有页 / 当前页
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const splitDirRef = useRef(splitDir);
  splitDirRef.current = splitDir;
  /* 开分屏时主阅读区改成「适合宽度」（左右分）/「适合页面」（上下分：一栏只有半屏高，按宽度撑满就只露半页）。
     先设上，容器缩窄之后 ResizeObserver 还会按新尺寸再算一次。第二栏照抄主阅读区此刻的缩放方式和位置（SplitPane） */
  const fitFor = (dir) => (dir === "v" ? "page-fit" : "page-width");
  /* 分屏下拉菜单：off / h（左右）/ v（上下）。换方向时两栏都换成对应的「适合」方式，
     等这一帧排完（栏的尺寸变了）再统一算倍数，然后各自对齐到当前这一页的页首，不停在两页中间 */
  const setSplitMode = (m) => {
    if (m === "off") {
      splitLiveRef.current = false;
      setActivePane("main");
      setSplitOpen(false);
      /* 恢复开分屏前的大小。马上设：主阅读区变回原宽时 ResizeObserver 会按这个方式再算一次（「适合宽度」就按原宽算了）；
         等变宽之后再设的话，中间会先按分屏时的「适合页面」闪一下 */
      const prev = preSplitRef.current;
      preSplitRef.current = null;
      if (prev && apiRef.current) apiRef.current.viewer.currentScaleValue = prev;
      return;
    }
    if (m !== splitDir) {
      try { localStorage.setItem("rh_split_dir", m); } catch { /* 存不了就算了 */ }
      setSplitDir(m);
    }
    if (!splitOpen) {
      preSplitRef.current = apiRef.current?.viewer.currentScaleValue || null;
      if (apiRef.current) apiRef.current.viewer.currentScaleValue = fitFor(m);
      setSplitOpen(true);
    } else if (m !== splitDir) {
      setTimeout(() => {
        fitBoth(fitFor(m));
        [apiRef.current, splitApiRef.current].forEach(a => a?.viewer.scrollToPage(a.viewer.currentPageNumber));
      }, 80);
    }
  };
  const toggleSplit = () => setSplitMode(splitOpen ? "off" : splitDir);
  // 第二栏建好了：两栏统一成一样大
  useEffect(() => {
    if (!splitReady) return;
    requestAnimationFrame(() => fitBoth(fitFor(splitDirRef.current)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitReady]);
  const [splitFrac, setSplitFrac] = useState(() => {
    try { const f = parseFloat(localStorage.getItem("rh_split")); return f > 0.15 && f < 0.85 ? f : 0.5; } catch { return 0.5; }
  });
  const splitRowRef = useRef(null);
  const splitBoxRef = useRef(null);         // 第二栏的盒子（拖分隔条时直接改它的宽 / 高）
  const dragSplit = (e) => {
    e.preventDefault();
    const row = splitRowRef.current;
    if (!row) return;
    const el = e.currentTarget;
    const box = splitBoxRef.current;
    el.setPointerCapture(e.pointerId);
    /* 拖的过程中只改第二栏那个盒子的宽 / 高（直接改 DOM，一帧最多一次），不走 React：
       以前每动一下都 setState → 整个阅读器重渲染 + 两栏按新宽度重排、重画页面，每一下卡 0.5~1.5 秒（实测）。
       松手再存 state；倍数不重算（同 Zotero，页面大小不变） */
    let f = splitFrac, raf = 0;
    const move = (ev) => {
      const r = row.getBoundingClientRect();
      // 两边都至少留 280px（上下分时 160px）
      const [len, pos, min] = splitDir === "v" ? [r.height, r.bottom - ev.clientY, 160] : [r.width, r.right - ev.clientX, 280];
      f = Math.min(len - min, Math.max(min, pos)) / len;
      raf ||= requestAnimationFrame(() => {
        raf = 0;
        if (box) box.style[splitDir === "v" ? "height" : "width"] = `${f * 100}%`;
      });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      cancelAnimationFrame(raf);
      if (box) box.style[splitDir === "v" ? "height" : "width"] = `${f * 100}%`;
      setSplitFrac(f);
      try { localStorage.setItem("rh_split", String(f)); } catch { /* 存不了就算了 */ }
    };
    el.addEventListener("pointercancel", up);
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
      const n = clientRectToNorm(pg, r);               // 挂在页面里、按页面方向放（转过的页也对）
      const el = document.createElement("div");
      el.className = "rh-cite-group";
      el.style.cssText = `left:${n.x * 100}%;top:${n.y * 100}%;width:${n.w * 100}%;height:${n.h * 100}%`;
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
        const k = pg.querySelector(".canvasWrapper").offsetWidth / doc.pages[Number(pg.dataset.pageNumber) - 1].size.width;
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
  /* 工具模式（光标、不能选字）：两栏共用 */
  const toolCls = (tool === "area" ? "rh-area-mode" : tool === "pen" ? "rh-area-mode rh-pen-mode" : tool === "eraser" ? "rh-area-mode rh-eraser-mode" : tool === "textbox" ? "rh-area-mode rh-textbox-mode" : tool === "note" ? "rh-area-mode rh-note-mode" : "");
  /* 标注的编辑界面：挂在 editPane 那一栏的浮层里，坐标按那一栏的 .pdfViewer 算 */
  const renderEdit = (pane) => editPane === pane && (
            <>
              {textEdit && (
                <TextBoxEditor key={textEdit.id || "new"} draft={textEdit} viewerEl={paneEls(pane).viewerEl} zoom={zoom}
                  onChange={(patch) => setTextEdit({ ...textEditRef.current, ...patch })}
                  onDone={finishText} onDelete={deleteText} />
              )}
              {noteEdit && (
                <NotePopup key={noteEdit.id || "new-note"} draft={noteEdit} viewerEl={paneEls(pane).viewerEl} zoom={zoom}
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
                <AreaEditBox key={`edit-${editArea.id}`} a={editArea} viewerEl={paneEls(pane).viewerEl} zoom={zoom}
                  onCommit={(rect, pageEl) => commitAreaRect(editArea, rect, pageEl)} />
              )}
              {annMenuView}
            </>
  );
  /* 划选工具条 + 译文弹窗：挂在划选发生的那一栏（selPane / trans.pane）的浮层里 */
  const renderSel = (pane) => (
            <>
              {selPane === pane && selPos && pending && (
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
                                 pos: rects.length ? transPos(rects, selPane) : { ...selPos, below: false }, pane: selPane });
                      clearSel();
                    }}
                    onCancel={clearSel} />
                </div>
              )}
              {trans?.manual && (trans.pane || "main") === pane && <TransMark anchors={trans.anchors} viewerEl={paneEls(pane).viewerEl} zoom={zoom} />}
              {(trans || transPin) && (trans?.pane || "main") === pane && (
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
            </>
  );
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
    const rr = splitRowRef.current?.getBoundingClientRect(), br = tbRef.current?.getBoundingClientRect();
    if (!rr || !br) return { x, y };
    return { x: Math.round(Math.min(Math.max(4, x), Math.max(4, rr.width - br.width - 4))),
             y: Math.round(Math.min(Math.max(4, y), Math.max(4, rr.height - br.height - 4))) };
  };
  const dragTb = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rr = splitRowRef.current.getBoundingClientRect(), br = tbRef.current.getBoundingClientRect();
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
        if (splitLiveRef.current) { refitBothRef.current(); return; }
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
  const fileBase = () => {
    // 本地文件（认不出是 arXiv 的）：用原来的文件名
    const id = arxivKey ? arxivKey.replace(/\//g, "_") : (localName || "document").replace(/\.pdf$/i, "");
    return `${id}${title && title !== localName ? ` - ${title}` : ""}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
  };
  const saveBytes = (bytes, name) => {
    const href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = Object.assign(document.createElement("a"), { href, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };
  const download = async () => {
    if (!doc) return;
    saveBytes(await doc.getData(), `${fileBase()}.pdf`);
  };
  /* 导出带标注的 PDF（lib/exportPdf）：我的标注写成标准的 PDF 注释，存一份新文件下载。
     别的阅读器打开都能看能改；原文件不动 */
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(0);
  const showToast = (text, ok = true) => {
    clearTimeout(toastTimer.current);
    setToast({ text, ok });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };
  /** 原文件 + 我的标注写成标准 PDF 注释（lib/exportPdf）→ { bytes, count, miss } */
  const annotatedBytes = async (anns) => {
    const { items, skipped } = toPdfAnnotations(anns, doc.pages, me?.name || "我");
    const bytes = await doc.getData();
    const { bytes: out, failed } = await sharedPdfium().exportAnnotated(bytes.buffer, items);
    return { bytes: out, count: items.length - failed, miss: skipped + failed };
  };
  const downloadAnnotated = async () => {
    if (!doc) return;
    const anns = mineView.filter(a => !a.deleted);
    if (!anns.length) { showToast("这篇还没有我的标注，可以直接下载原文件", false); return; }
    showToast("正在生成带标注的 PDF…");
    try {
      const { bytes, count, miss } = await annotatedBytes(anns);
      saveBytes(bytes, `${fileBase()} (annotated).pdf`);
      showToast(`已导出 ${count} 条标注${miss ? `，${miss} 条没导出（做于这篇的其它版本、位置对不上，或格式不支持）` : ""}`);
    } catch (e) {
      showToast(`导出失败：${e?.message || e}`, false);
    }
  };
  /* 打印（标题下拉 / Ctrl+P）：把要印的 PDF 放进一个看不见的 iframe，交给浏览器自带的 PDF 阅读器打印 ——
     出来的是矢量的原文（不是截图），浏览器的打印对话框（选打印机、页码范围、横竖向、另存为 PDF）照常用。
     「显示标注」开着、而且这篇有我的标注：印带标注的那份（同「下载带我的标注的 PDF」）；否则印原文件。
     不能直接 window.print()：那样印的是阅读器页面本身（工具栏 + 只渲染了附近几页的画布） */
  const printFrame = useRef(null);
  const printPdf = async () => {
    if (!doc) return;
    const anns = settings.showAnnots === false ? [] : mineView.filter(a => !a.deleted);
    showToast(anns.length ? "正在准备打印（带我的标注）…" : "正在准备打印…");
    try {
      const bytes = anns.length ? (await annotatedBytes(anns)).bytes : await doc.getData();
      printFrame.current?.remove();
      const href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const f = Object.assign(document.createElement("iframe"), { src: href });
      f.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
      f.onload = () => setTimeout(() => {
        try { f.contentWindow.focus(); f.contentWindow.print(); setToast(null); }
        catch (e) { showToast(`打印失败：${e?.message || e}`, false); }
      }, 400);                   // PDF 阅读器加载完文档要一点时间，太早调 print 会印出空白
      document.body.appendChild(f);
      printFrame.current = f;
      setTimeout(() => URL.revokeObjectURL(href), 120_000);
    } catch (e) {
      showToast(`打印失败：${e?.message || e}`, false);
    }
  };
  const printRef = useRef(printPdf);
  printRef.current = printPdf;
  // Ctrl+P：印 PDF（浏览器默认会去印阅读器页面本身）
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); printRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 「用浏览器自带阅读器打开」：background 给这个标签页加一条放行规则再跳过去
  const openRaw = () => chrome.runtime.sendMessage({ type: "viewer:raw", url });

  return (
    <div className="flex flex-col h-screen bg-[#525659]">
      <div className="h-10 shrink-0 flex items-center gap-1 px-1.5 bg-[#323639] border-b border-[#00000040]">
        {/* 三段：左边侧栏开关 + 标题（同 Edge / Chrome 的阅读器），中间翻页和缩放（左右两段等宽，所以它真的居中），右边工具 */}
        <div className="flex-1 basis-0 min-w-0 flex items-center gap-1">
          <TBtn onClick={() => setSideOpen(v => !v)} title="目录 / 缩略图 / 笔记" active={sideOpen}><Icon d={IconSidebar} /></TBtn>
          {/* 点标题弹下拉：文档属性、用浏览器自带的阅读器打开（同 Edge 的「⋯」菜单里那两项） */}
          <TitleMenu label={title || localName || paperKey.replace(/^arxiv:/, "arXiv:")} full={title} disabled={!doc}
            onProps={() => setPropsOpen(true)} onRaw={openRaw}
            onDownload={download} onDownloadAnnotated={downloadAnnotated} onPrint={printPdf}
            showAnnots={settings.showAnnots !== false} onToggleAnnots={() => setSettings({ showAnnots: settings.showAnnots === false })} />
          <TBtn onClick={openSelfCite} disabled={!doc || selfCite === "loading" || selfCite === "none"}
            title={selfCite === "none" ? "没查到这篇论文的引用信息" : "引用"}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z" /></svg>
          </TBtn>
          <SelfBookmark key={paperKey} uid={uid} disabled={!doc} lookup={lookupSelf} onLogin={onLogin} toast={showToast} />
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
        <TBtn onClick={() => rotateBtn(1)} disabled={!doc}
          title={rotMode === "page" ? `顺时针旋转第 ${vPage} 页（Ctrl+]）` : `顺时针旋转所有页（Ctrl+]）`}>
          <Icon d={rotMode === "page" ? IconRotateOne : IconRotate} /></TBtn>
        <RotateMenu disabled={!doc} mode={rotMode} onMode={setRotMode}
          rotated={!!rotation || Object.keys(pageRot).length > 0} onReset={resetAllRot} />
        <div className="h-4 border-l border-[#ffffff26] mx-0.5 shrink-0" />
        <TBtn onClick={() => runHistory("undo")} title="撤销（Ctrl+Z）" disabled={!hist.canUndo}><Icon d={IconUndo} /></TBtn>
        <TBtn onClick={() => runHistory("redo")} title="恢复（Ctrl+Y）" disabled={!hist.canRedo}><Icon d={IconRedo} /></TBtn>
        </div>

        <div className="flex-1 basis-0 min-w-0 flex items-center justify-end gap-1">

        <TBtn onClick={() => (findOpen ? closeFind() : openFind())} title="搜索（Ctrl+F）" active={findOpen}><Icon d={IconSearch} /></TBtn>
        <TBtn onClick={toggleSplit} title={splitOpen ? "关闭分屏" : "分屏：再开一个阅读区看同一篇（各自滚动）"}
          active={splitOpen} disabled={!doc}><Icon d={splitDir === "v" ? IconSplitV : IconSplit} /></TBtn>
        <SplitMenu mode={splitOpen ? splitDir : "off"} disabled={!doc} onPick={setSplitMode} />
        <TBtn onClick={enterFullscreen} title="全屏阅读（Esc 退出）" disabled={!doc}><Icon d={IconFull} /></TBtn>
        <div className="h-4 border-l border-[#ffffff26] mx-0.5 shrink-0" />
        <div className="relative">
          <TBtn onClick={() => setSettingsOpen(true)} title={upd.show ? `设置（有新版本 v${upd.latest.version}）` : "设置"}><Icon d={IconGear} /></TBtn>
          {/* 有新版本（没被忽略）：设置按钮上一个小红点 */}
          {upd.show && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#ff5c5c] pointer-events-none" />}
        </div>
        <SyncBadge uid={uid} state={sync} pending={pendingCount} onLogin={onLogin} onSync={runSync} manual={!autoSync} />
        {commentKey && (
          <TBtn onClick={() => setRightOpen(v => !v)} active={rightOpen} title="论文评论（和 ResearchHub 网站互通）">
            <Icon d={IconChat} />{commentCount ? <span className="tabular-nums">{commentCount}</span> : null}
          </TBtn>
        )}
        {me && <AccountMenu me={me} email={session?.email} onLibrary={() => setLibraryOpen(true)} />}
        </div>
      </div>

      {/* 页面颜色（护眼）的类挂在这一层：正文和左侧栏的缩略图都在它里面，一起变色 */}
      <div className={`relative flex-1 flex min-h-0 rh-paper-${settings.paper || "white"} ${settings.showLinks ? "rh-show-links" : ""} ${settings.showAnnots === false ? "rh-hide-annots" : ""}`}>
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
          <div ref={containerRef}
            className={`absolute inset-0 overflow-auto overscroll-contain thin-scrollbar ${toolCls}`}>
            {/* pdf.js 往这个元素里插 / 删 .page，React 的东西不和它混在一起 */}
            <div ref={viewerElRef} className="pdfViewer relative" />
            {/* 浮层另起一层，和 .pdfViewer 左上角重合、一起滚；坐标照旧按 .pdfViewer 的盒子算。
                **这一层里的兄弟节点 key 不能重**：编辑框和编辑条最早都拿标注 id 当 key，
                重复 key 让 React 跟丢了节点 —— 编辑框关不掉、点一次多一个（踩过） */}
            <div ref={overlayRef} className="absolute left-0 top-0 w-full h-0">
              {renderEdit("main")}
              {linkPv && (
                <LinkPreview pv={linkPv} doc={doc} paper={settings.paper || "white"}
                  onEnter={() => clearTimeout(pvHideRef.current)} onLeave={() => pvHide()} />
              )}
              {refCard && (
                <RefCard key={`${refCard.group.join(",")}@${refCard.current}`} {...refCard}
                  arxivBase={arxivKey ? base.replace(/^arxiv:/, "") : ""}
                  onClose={closeRefCard}
                  onJump={(entry) => {
                    // [1–3] 里没挂链接的那条（比如 2）没有目标名，就跳到它所在的那一页
                    if (entry.dest) apiRef.current?.viewer.goToDest(entry.dest);
                    else if (apiRef.current) apiRef.current.viewer.currentPageNumber = entry.page;
                    setRefCard(null);
                  }}
                  onOpenArxiv={(id) => chrome.runtime.sendMessage({ type: "viewer:open", url: `https://arxiv.org/pdf/${id}` })} />
              )}
              {renderSel("main")}
            </div>
          </div>

          {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
          {selfCite && selfCite !== "none" && (
            <CiteDialog card={typeof selfCite === "object" ? selfCite : null} onClose={() => setSelfCite(null)} />
          )}
          {libraryOpen && <LibraryDialog onClose={() => setLibraryOpen(false)} />}
          {propsOpen && <DocProps doc={doc} url={url} localName={localName} paperKey={paperKey}
            annCount={mineView.length} onClose={() => setPropsOpen(false)} />}
          {toast && (
            <div className={`absolute left-1/2 -translate-x-1/2 bottom-5 z-[60] max-w-[80%] px-3.5 py-2 rounded-lg text-[12.5px] font-sans
                            bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in
                            ${toast.ok ? "text-[#e6e6e6]" : "text-[#ff9a9a]"}`}>{toast.text}</div>
          )}
          {/* 新版本提示（右下角一张小卡片）：下载 / 看更新说明 / 忽略此版本；✕ 只是这次先不提示，下次打开还会出来 */}
          {upd.show && !updLater && (
            <div className="absolute right-4 bottom-4 z-[60] w-[300px] p-3 rounded-lg bg-[#323639] border border-[#ffffff26]
                            shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-[12.5px] font-sans text-[#e6e6e6] animate-fade-in">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <div className="font-bold text-[#fff]">PDF-Reader 有新版本 v{upd.latest.version}</div>
                  <div className="text-[11.5px] text-[#9a9a9a] mt-0.5">当前 v{upd.current}。下载后解压覆盖原来的文件夹，在扩展管理页点刷新；<b className="text-[#ffb36b]">别点「移除」</b>，会删掉笔记。升级前建议先在设置 → 数据里导出备份</div>
                </div>
                <button onClick={() => { setUpdLater(true); try { sessionStorage.setItem("rh_upd_later", upd.latest.version); } catch { /* 无痕 */ } }}
                  title="先不提示（下次打开还会提示）"
                  className="w-6 h-6 -mt-0.5 -mr-1 rounded-md text-[#c8c8c8] bg-transparent border-none cursor-pointer hover:bg-[#ffffff26]">✕</button>
              </div>
              <div className="flex items-center gap-1.5 mt-2.5">
                <button onClick={() => openTab(upd.latest.zip)}
                  className="h-7 px-3 rounded-full text-[12px] font-bold text-[#10232c] bg-[#7ec8e3] hover:bg-[#9ad5ea] border-none cursor-pointer">下载</button>
                <button onClick={() => openTab(upd.latest.url)}
                  className="h-7 px-3 rounded-full text-[12px] text-[#c8c8c8] bg-transparent hover:bg-[#ffffff1a] cursor-pointer"
                  style={{ border: "1px solid #ffffff33" }}>更新说明</button>
                <span className="flex-1" />
                <button onClick={upd.ignore}
                  className="h-7 px-2 rounded-md text-[12px] text-[#9a9a9a] bg-transparent border-none cursor-pointer hover:text-[#e6e6e6] hover:bg-[#ffffff1a]">忽略此版本</button>
              </div>
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
            <div ref={splitBoxRef} className="relative shrink-0 min-w-0 min-h-0" style={splitDir === "v" ? { height: `${splitFrac * 100}%` } : { width: `${splitFrac * 100}%` }}
              onPointerDownCapture={() => setActivePane("split")}>
              <SplitPane doc={doc} main={apiRef} apiRef={splitApiRef} annotations={visibleAnns}
                containerRef={splitContainerRef} viewerElRef={splitViewerElRef} onOverlay={onSplitOverlay}
                onPick={pickSplit} activeId={activeId} hiddenId={editArea?.id || textEdit?.id} modeCls={toolCls}
                arxivId={arxivKey} eqCopy={settings.eqCopy}
                onReady={setSplitReady} onView={setSplitView} />
              {splitOverlay && createPortal(<>{renderEdit("split")}{renderSel("split")}</>, splitOverlay)}
              {activePane === "split" && <div className="rh-pane-active" />}
            </div>
          </>
        )}
          {/* 标注工具条（顶栏放不下了）：浮在阅读区上（分屏时两栏都能放），能拖（抓手 ⠿）、能横竖切换，位置记在本机。
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
          {findOpen && (
            /* 搜索框挂在两栏外面那一层（分屏时点它不会把「当前栏」切回左栏）；第二行是搜索选项 */
            <div className="absolute top-2 right-4 z-[55] flex flex-col gap-1.5 p-2 rounded-lg
                            bg-[#323639] border border-[#ffffff1f] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
              <div className="flex items-center gap-1">
              <div className="relative">
                <input ref={findInputRef} autoFocus value={query} placeholder="在文档中搜索"
                  onChange={e => { setQuery(e.target.value); queryRef.current = e.target.value; runFind(e.target.value, false); if (!e.target.value) setFindCount(null); }}
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
              <div className="flex items-center gap-4 px-0.5 text-[12.5px] font-sans text-[#e6e6e6]">
                {[["highlightAll", "高亮所有"], ["caseSensitive", "区分大小写"], ["entireWord", "整词"]].map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={findOpts[k]} onChange={() => setFindOpt(k)}
                      className="w-3.5 h-3.5 m-0 cursor-pointer accent-[#7ec8e3]" />
                    {label}
                  </label>
                ))}
              </div>
            </div>
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
    return a.rects.map((r, j) => {
      const c = normRectToClient(pageEl, r, box);         // 转过的页也对（rotate.js）
      return <div key={`${i}-${j}`} style={{
        position: "absolute", pointerEvents: "none", borderRadius: 2, background: "rgba(56,132,255,0.28)",
        left: c.left - vb.left, top: c.top - vb.top, width: c.width, height: c.height,
      }} />;
    });
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
          className="w-max p-1 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
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
function SplitPane({ doc, main, apiRef, containerRef, viewerElRef, onOverlay, onPick, activeId, hiddenId, modeCls,
                     annotations, arxivId, eqCopy, onReady, onView }) {
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
    if (m?.rotation) viewer.setRotation(m.rotation);          // 和主阅读区转一样的角度（单独转的页也一样）
    if (m && Object.keys(m.pageRotations).length) viewer.setPageRotations(m.pageRotations);
    viewer.currentScaleValue = m?.currentScaleValue || "page-width";
    // 位置：主阅读区顶上那一页、往下滚了这一页的几成
    const at = m?._anchor();
    if (at) {
      const v = viewer.views[at.index];
      containerRef.current.scrollTop = v.slot.offsetTop + at.frac * v.slot.offsetHeight;
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

  useHighlightLayer(viewerElRef, apiRef, ready, annotations, { onPick, activeId, hiddenId });
  useEquationCopy(viewerElRef, apiRef, ready, arxivId, eqCopy);

  return (
    <div className="relative h-full bg-[#525659]">
      <div ref={containerRef} className={`absolute inset-0 overflow-auto overscroll-contain thin-scrollbar ${modeCls}`}>
        <div ref={viewerElRef} className="pdfViewer relative" />
        {/* 浮层（同主阅读区）：划选工具条、译文弹窗、标注编辑界面由外面 portal 进来 */}
        <div ref={onOverlay} className="absolute left-0 top-0 w-full h-0" />
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

/** 分屏按钮旁的下拉：不分屏 / 左右分屏 / 上下分屏（样式同缩放比例的下拉） */
function SplitMenu({ mode, disabled, onPick }) {
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
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left - 60, window.innerWidth - 170)) });
  };
  const items = [["off", "不分屏", <rect key="r" x="3" y="4" width="18" height="16" rx="2" />],
                 ["h", "左右分屏", IconSplit], ["v", "上下分屏", IconSplitV]];
  return (
    <>
      <button ref={btnRef} onClick={toggle} disabled={disabled} title="分屏方式"
        className={`h-7 w-4 -ml-1 rounded-md flex items-center justify-center border-none shrink-0
          ${disabled ? "text-[#ffffff4d] bg-transparent cursor-not-allowed"
            : pos ? "text-[#fff] bg-[#ffffff33] cursor-pointer" : "text-[#c8c8c8] bg-transparent hover:bg-[#ffffff26] cursor-pointer"}`}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {pos && (
        <div ref={panelRef} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
          className="w-max p-1 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
          {items.map(([v, label, icon]) => (
            <button key={v} onClick={() => { onPick(v); setPos(null); }}
              className="w-full h-8 flex items-center gap-2 pl-2 pr-4 rounded-md text-[13px] font-sans text-[#e6e6e6] bg-transparent
                         border-none cursor-pointer hover:bg-[#ffffff1a] text-left whitespace-nowrap">
              <span className="w-4 text-[#7ec8e3] text-[12px] text-center">{mode === v ? "✓" : ""}</span>
              <Icon d={icon} size={15} />
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** 旋转按钮旁的下拉：按钮转「所有页」还是「当前页」（选中的打勾，按钮图标跟着变）+ 转回原样（样式同分屏下拉） */
function RotateMenu({ disabled, mode, onMode, rotated, onReset }) {
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
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left - 40, window.innerWidth - 140)) });
  };
  const groups = [
    [[() => onMode("all"), "所有页", IconRotate, "", false, mode === "all"],
     [() => onMode("page"), "当前页", IconRotateOne, "", false, mode === "page"]],
    [[onReset, "复原", <><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><polyline points="3.5 3.5 3.5 8.5 8.5 8.5" /></>, "", !rotated]],
  ];
  return (
    <>
      <button ref={btnRef} onClick={toggle} disabled={disabled} title="旋转方式"
        className={`h-7 w-4 -ml-1 rounded-md flex items-center justify-center border-none shrink-0
          ${disabled ? "text-[#ffffff4d] bg-transparent cursor-not-allowed"
            : pos ? "text-[#fff] bg-[#ffffff33] cursor-pointer" : "text-[#c8c8c8] bg-transparent hover:bg-[#ffffff26] cursor-pointer"}`}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {pos && (
        <div ref={panelRef} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
          className="w-max p-1 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
          {groups.map((g, gi) => (
            <div key={gi} className={gi ? "mt-1 pt-1 border-t border-[#ffffff1f]" : ""}>
              {g.map(([fn, label, icon, hint, off, on]) => (
                <button key={label} disabled={off} onClick={() => { fn(); setPos(null); }}
                  className="w-full h-8 flex items-center gap-2 pl-2 pr-6 rounded-md text-[13px] font-sans text-[#e6e6e6] bg-transparent
                             border-none cursor-pointer hover:bg-[#ffffff1a] text-left whitespace-nowrap disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent">
                  <span className="w-4 text-[#7ec8e3] text-[12px] text-center">{on ? "✓" : ""}</span>
                  <span className="w-[15px] flex justify-center">{icon && <Icon d={icon} size={15} />}</span>
                  <span className="flex-1">{label}</span>
                  {hint && <span className="text-[11px] text-[#9a9a9a]">{hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}


/** 头像（已登录）：点开是账号菜单 —— 名字 / 邮箱、文献收藏（弹窗，见 LibraryDialog）、退出登录 */
function AccountMenu({ me, email, onLibrary }) {
  const [pos, setPos] = useState(null);
  /* 退出要点两下（同删除）：第一下变红「再点一下退出」，3 秒内再点才退；菜单收起就复位 */
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t); }, [armed]);
  useEffect(() => { if (!pos) setArmed(false); }, [pos]);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => { if (!panelRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setPos(null); };
    const onKey = (e) => { if (e.key === "Escape") setPos(null); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [pos]);
  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  const item = "w-full h-8 flex items-center gap-2 pl-2.5 pr-4 rounded-md text-[13px] font-sans text-[#e6e6e6] bg-transparent border-none cursor-pointer hover:bg-[#ffffff1a] text-left whitespace-nowrap";
  return (
    <>
      <button ref={btnRef} onClick={toggle} title={`已登录：${me.name}`}
        className={`ml-0.5 shrink-0 p-0.5 rounded-full border-none cursor-pointer ${pos ? "bg-[#ffffff33]" : "bg-transparent hover:bg-[#ffffff26]"}`}>
        <Avatar name={me.name} url={me.avatar_url} size={22} />
      </button>
      {pos && (
        <div ref={panelRef} style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 60 }}
          className="w-max min-w-[180px] p-1 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar name={me.name} url={me.avatar_url} size={30} />
            <div className="min-w-0">
              <div className="text-[13px] text-[#fff] font-bold truncate max-w-[200px]">{me.name}</div>
              {email && <div className="text-[11.5px] text-[#9a9a9a] truncate max-w-[200px]">{email}</div>}
            </div>
          </div>
          <div className="my-1 border-t border-[#ffffff1f]" />
          <button className={item} onClick={() => { setPos(null); onLibrary(); }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21z" /></svg>
            文献收藏
          </button>
          <button className={`${item} ${armed ? "!text-[#ff8a80] !bg-[#ff8a801a]" : ""}`}
            onClick={() => { if (!armed) { setArmed(true); return; } setPos(null); chrome.runtime.sendMessage({ type: "auth:signOut" }); }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
            {armed ? "再点一下退出" : "退出登录"}
          </button>
        </div>
      )}
    </>
  );
}

/** 标题：点开下拉 —— 下载（原文件 / 带我的标注）、打印、用浏览器自带的阅读器打开（新标签）、文档属性。
    标题太长被截断时指上去看得到全名 */
function TitleMenu({ label, full, disabled, onProps, onRaw, onDownload, onDownloadAnnotated, onPrint, showAnnots, onToggleAnnots }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => { if (!panelRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setPos(null); };
    const onKey = (e) => { if (e.key === "Escape") setPos(null); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [pos]);
  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: Math.max(8, r.left) });
  };
  const items = [
    [onDownload, "下载", IconDownload],
    [onDownloadAnnotated, "下载带我的标注的 PDF", <><path d="M12 4v11" /><polyline points="7 10 12 15 17 10" /><path d="M5 20h6" /><path d="M15 20l4-4 2 2-4 4h-2z" /></>],
    [onPrint, "打印", <><polyline points="6 9 6 3 18 3 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" /></>, "Ctrl+P"],
    null,
    // 显示 / 隐藏所有标注（同 Chrome 阅读器「⋮」里的「注释」；存在设置的 showAnnots 里）：前面打勾表示开着
    [onToggleAnnots, "显示标注", null, null, showAnnots],
    null,
    [onRaw, "用浏览器自带的阅读器打开", IconOpen],
    [onProps, "文档属性", <><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="7.8" r="0.6" fill="currentColor" /></>],
  ];
  return (
    <>
      <button ref={btnRef} onClick={toggle} disabled={disabled} title={full || undefined}
        className={`min-w-0 h-7 px-2 rounded-md flex items-center gap-1 text-[13px] text-[#e6e6e6] font-sans border-none text-left
                    cursor-pointer disabled:cursor-default disabled:hover:bg-transparent
                    ${pos ? "bg-[#ffffff26]" : "bg-transparent hover:bg-[#ffffff1a]"}`}>
        <span className="truncate">{label}</span>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
          strokeLinejoin="round" className="shrink-0 text-[#c8c8c8]"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {pos && (
        <div ref={panelRef} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
          className="w-max p-1 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
          {items.map((it, i) => (it ? (
            <button key={it[1]} onClick={() => { setPos(null); it[0](); }}
              className="w-full h-8 flex items-center gap-2 pl-2.5 pr-4 rounded-md text-[13px] font-sans text-[#e6e6e6] bg-transparent
                         border-none cursor-pointer hover:bg-[#ffffff1a] text-left whitespace-nowrap">
              {it[2] ? <Icon d={it[2]} size={15} />
                : <span className="w-[15px] text-center text-[12px] text-[#7ec8e3]">{it[4] ? "✓" : ""}</span>}
              <span className="flex-1">{it[1]}</span>
              {it[3] && <span className="ml-4 text-[11px] text-[#9a9a9a]">{it[3]}</span>}
            </button>
          ) : <div key={i} className="my-1 border-t border-[#ffffff1f]" />))}
        </div>
      )}
    </>
  );
}

/**
 * 收藏当前这篇（标题后、「引用」旁边的星）：和引用卡片上的「收藏」一样进 ResearchHub 的文献收藏（lib/library）。
 * 这篇是哪条记录用「引用」那套查法（lookupSelf：arXiv 查 INSPIRE / S2，本地文件查 Crossref，有缓存）；
 * 查不到的本地文件不能收藏。没收藏时点开「收藏到…」选收藏夹，收藏过的再点取消（实心黄星 = 已收藏）
 */
function SelfBookmark({ uid, disabled, lookup, onLogin, toast }) {
  const [card, setCard] = useState(undefined);     // undefined 没查 / null 查不到 / 卡片
  const [row, setRow] = useState(null);            // 收藏行（null = 没收藏）
  const [pos, setPos] = useState(null);            // 「收藏到…」菜单的位置
  const [cols, setCols] = useState(null);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  // 登录了才查收藏状态（卡片走缓存，打开论文 3 秒后的预取已经查过了）
  useEffect(() => {
    if (!uid || disabled) { setRow(null); return undefined; }
    let alive = true;
    lookupRef.current().then(async (c) => {
      if (!alive) return;
      setCard(c || null);
      if (c) { const r = await findBookmark(c).catch(() => null); if (alive) setRow(r); }
    }).catch(() => { if (alive) setCard(null); });
    return () => { alive = false; };
  }, [uid, disabled]);
  useEffect(() => {
    if (!pos) return undefined;
    const close = (e) => { if (!panelRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setPos(null); };
    const onKey = (e) => { if (e.key === "Escape") setPos(null); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey); };
  }, [pos]);

  const click = async () => {
    if (!uid) { onLogin?.(); return; }
    if (busy) return;
    if (pos) { setPos(null); return; }
    let c = card;
    if (c === undefined) { setBusy(true); c = await lookupRef.current().catch(() => null); setCard(c || null); setBusy(false); }
    if (!c) { toast?.("没查到这篇论文的信息，不能收藏", false); return; }
    if (row) {
      setBusy(true);
      if (await removeBookmark(row.id)) { setRow(null); toast?.("已取消收藏"); } else toast?.("取消收藏失败", false);
      setBusy(false);
      return;
    }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left - 8, window.innerWidth - 240)) });
    if (!cols) listCollections().then(setCols).catch(() => setCols([]));
  };
  const pick = async (colId, name) => {
    setBusy(true);
    try { setRow(await saveBookmark(card, colId)); setPos(null); toast?.(`已收藏到「${name}」`); }
    catch (e) { toast?.(e.message || "收藏失败", false); }
    setBusy(false);
  };
  const saved = !!row;
  const item = "w-full h-8 flex items-center gap-2 pl-2.5 pr-4 rounded-md text-[13px] font-sans text-[#e6e6e6] bg-transparent border-none cursor-pointer hover:bg-[#ffffff1a] text-left whitespace-nowrap disabled:opacity-50";
  return (
    <>
      <button ref={btnRef} onClick={click} disabled={disabled || card === null}
        title={!uid ? "收藏（登录 ResearchHub 后可用）" : card === null ? "没查到这篇论文的信息，不能收藏" : saved ? "已收藏（点一下取消）" : "收藏"}
        className={`h-7 min-w-7 px-1 rounded-md flex items-center justify-center border-none shrink-0
          ${disabled || card === null ? "text-[#ffffff4d] bg-transparent cursor-not-allowed"
            : saved ? "text-[#fbbc04] bg-transparent hover:bg-[#ffffff26] cursor-pointer"
            : pos ? "text-[#fff] bg-[#ffffff33] cursor-pointer" : "text-[#e6e6e6] bg-transparent hover:bg-[#ffffff26] cursor-pointer"}`}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21z" />
        </svg>
      </button>
      {pos && (
        <div ref={panelRef} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
          className="w-max min-w-[200px] max-w-[280px] p-1 rounded-lg bg-[#323639] border border-[#ffffff26] shadow-[0_6px_20px_rgba(0,0,0,0.45)] animate-fade-in">
          <div className="px-2.5 py-1 text-[11px] text-[#9a9a9a] font-sans">收藏到…</div>
          <div className="max-h-[260px] overflow-y-auto thin-scrollbar">
            <button className={item} disabled={busy} onClick={() => pick(null, "未分类")}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
              默认（未分类）
            </button>
            {cols?.length > 0 && <div className="my-1 border-t border-[#ffffff1f]" />}
            {cols === null && <div className="px-2.5 py-1.5 text-[12px] text-[#8a8a8a]">…</div>}
            {cols?.map(c => (
              <button key={c.id} className={item} disabled={busy} onClick={() => pick(c.id, c.name)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
