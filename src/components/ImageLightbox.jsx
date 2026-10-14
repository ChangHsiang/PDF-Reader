// 从 ResearchHub 网站（researchhub/src/components/ImageLightbox.jsx）原样搬来的插图灯箱，
// 只把 LatexText 换成了插件里的 MathText。两边改动尽量同步。
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { MathText as LatexText } from "./bits";

// ─── 插图灯箱 ─────────────────────────────────────────────────────────────────
// 两端都是**卷轴**：所有图排成一条，轨道整体平移，旧图滑出、新图滑入是同一次位移。
//   桌面端三栏（缩略图轨道 | 功能区 | 图片），卷轴**竖向**，滚轮/箭头翻页
//   移动端只留图，卷轴**横向**跟手，上下滑退出，双指缩放自己实现（不用系统的，
//   那缩的是视觉视口、整页一起放大）
// 两端都用 object-contain 让浏览器做适配，不再自己算 fit —— 之前的显示不全 /
// 放大残影 / 翻页黑帧全部出在那套 fit 的时序上
// 这些小组件都定义在模块作用域：写在组件里等于每次渲染新建一个组件类型，子树会被卸载重建
const ZOOM_MIN = 1, ZOOM_MAX = 5, ZOOM_STEP = 0.25;

// 灯箱里的白全部写死 #fff，不能用 text-white / bg-white：
// 本项目的 white 是主题变量，**暗色下等于卡面色 #212121** —— 在这个固定纯黑的浮层上
// 就成了深灰字配深灰底，只有选中时才看得见（踩过）。
// 底色也不能太淡：/20 起步 + 一圈边框才在深底上立得住
const LbBtn = ({ label, onClick, disabled, children, className = "" }) => (
  <button onClick={onClick} disabled={disabled} aria-label={label} title={label}
    className={`w-10 h-10 rounded-xl flex items-center justify-center
                transition-colors shrink-0 border
                ${disabled
                  ? "bg-[#ffffff0d] text-[#ffffff4d] border-[#ffffff1a] cursor-not-allowed"
                  : "bg-[#ffffff33] text-[#fff] border-[#ffffff4d] hover:bg-[#ffffff66] cursor-pointer"}
                ${className}`}>
    {children}
  </button>
);

const Chevron = ({ dir, size = 20 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <polyline points={dir === "up" ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
  </svg>
);

/**
 * 移动端的灯箱（照 X）：整条轨道跟着手指走，松手才吸附 —— 不是「滑够阈值就跳一张」，
 * 那样中间没有跟手过程，观感很生硬。
 *
 * 每张图直接 `object-contain` 让浏览器去适配，不自己算 fit —— 也就没有
 * 「缓存图算不出 fit 显示不全」「先按原图尺寸画一帧的残影」这两类问题（桌面端后来也照此改了）。
 * 双指缩放是自己实现的：交给浏览器的话它缩的是**视觉视口**，整页跟着一起放大。
 *
 * 拖拽期直接写 style（不走 React 重渲染），与两个抽屉同一套做法：
 * - 横向：轨道位移 = -index*100% + dx，松手过 1/4 屏或甩动就翻页，否则弹回
 * - 竖向：整层跟着下移 + 轻微缩小 + 背景变透明，过阈值就关闭（X 的退出手感）
 */
const SLOP = 10;      // 判定横/竖向所需的最小位移
const FLING = 0.5;    // px/ms
const DISMISS = 110;  // 竖向超过它就关闭

function MobileLightbox({ figures, index, onIndex, onClose }) {
  const n = figures.length;
  // 说明/页码/关闭钮这一组浮层是否可见。默认开：全隐的话用户既不知道有说明，
  // 也找不到关闭入口（顶部的 × 现在是唯一的按钮式出口）
  const [chrome, setChrome] = useState(true);
  const rootRef = useRef(null);
  const stageRef = useRef(null);
  const trackRef = useRef(null);
  const idxRef = useRef(index);
  // 每张图的 DOM（双指缩放要直接写它的 transform）、当前缩放与位移、说明栏
  const slideRefs = useRef([]);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const capRef = useRef(null);
  useEffect(() => { idxRef.current = index; }, [index]);

  // 换图就把缩放复位，否则下一张会带着上一张的倍率和位移出场
  useEffect(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    slideRefs.current.forEach(el => { if (el) { el.style.transition = "none"; el.style.transform = ""; } });
  }, [index]);

  const base = (i) => `translate3d(${-i * 100}%,0,0)`;
  const EASE = "transform 260ms cubic-bezier(0.22,0.61,0.36,1)";

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let mode = null;                 // null | pending | x | y | pan | pinch | reject
    let sx = 0, sy = 0, dx = 0, dy = 0, lx = 0, lt = 0, v = 0;
    /* 「这一下动过没有」——**用来在 touchend 里判断是不是轻点**，不是用来吃 click。
       原来的写法是「滑动会补发一次 click，用一个 ref 把它吃掉」，但那前提是错的：
       横滑/竖滑的过程里我们调了 preventDefault()，浏览器**根本不会再补发 click**。
       于是标记一直是 true 挂着，把下一次真正的轻点吃掉了 ——
       表现就是「划到下一张后要点两下浮层才有反应」。
       现在轻点直接在 touchend 里判定，不依赖那个可能永远不来的 click。 */
    let moved = false;
    // 双指缩放的起始量
    let d0 = 0, z0 = 1, p0 = { x: 0, y: 0 };

    const img = () => slideRefs.current[idxRef.current] || null;
    const paintImg = (anim) => {
      const el2 = img();
      if (!el2) return;
      el2.style.transition = anim ? "transform 200ms ease-out" : "none";
      el2.style.transform = `translate3d(${panRef.current.x}px,${panRef.current.y}px,0) scale(${zoomRef.current})`;
    };
    const resetZoom = () => {
      zoomRef.current = 1; panRef.current = { x: 0, y: 0 };
      paintImg(true);
    };
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid  = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    const paintX = (px) => {
      if (trackRef.current) {
        trackRef.current.style.transition = "none";
        trackRef.current.style.transform = `translate3d(calc(${-idxRef.current * 100}% + ${px}px),0,0)`;
      }
    };
    const paintY = (py) => {
      const k = Math.min(1, Math.abs(py) / 400);
      if (stageRef.current) {
        stageRef.current.style.transition = "none";
        stageRef.current.style.transform = `translate3d(0,${py}px,0) scale(${1 - k * 0.15})`;
      }
      el.style.backgroundColor = `rgba(0,0,0,${(0.94 * (1 - k * 0.85)).toFixed(3)})`;
    };
    const settle = () => {
      if (trackRef.current) {
        trackRef.current.style.transition = EASE;
        trackRef.current.style.transform = base(idxRef.current);
      }
      if (stageRef.current) {
        stageRef.current.style.transition = EASE;
        stageRef.current.style.transform = "";
      }
      el.style.backgroundColor = "rgba(0,0,0,0.94)";
    };

    const onStart = (e) => {
      // 在说明栏里起手 = 想滚说明，整套手势直接放行，否则滚说明会带着图一起动
      if (capRef.current?.contains(e.target)) { mode = "reject"; return; }
      if (e.touches.length === 2) {
        mode = "pinch";
        d0 = dist(e.touches[0], e.touches[1]);
        z0 = zoomRef.current;
        p0 = { ...panRef.current };
        moved = true;
        return;
      }
      if (e.touches.length !== 1) { mode = "reject"; return; }
      const t = e.touches[0];
      sx = lx = t.clientX; sy = t.clientY;
      dx = dy = 0; v = 0; lt = e.timeStamp;
      moved = false;
      // 已经放大了：单指是拖着看，不是翻页/退出
      mode = zoomRef.current > 1.01 ? "pan" : "pending";
      if (mode === "pan") p0 = { ...panRef.current };
    };

    const onMove = (e) => {
      if (!mode || mode === "reject") return;

      if (mode === "pinch") {
        if (e.touches.length < 2) return;
        if (e.cancelable) e.preventDefault();
        const nd = dist(e.touches[0], e.touches[1]);
        if (!d0) return;
        const z = Math.min(ZOOM_MAX, Math.max(1, z0 * (nd / d0)));
        const m = mid(e.touches[0], e.touches[1]);
        const el2 = img();
        if (el2) {
          // 以两指中点为锚：变换是 translate(pan) scale(z)、原点在元素中心 C0。
          // 当前矩形中心 = C0 + pan（缩放不移动中心），于是 C0 = center - pan。
          // 记 d = 锚点相对 C0 的位移，则 pan' = d − (z'/z)·(d − pan)
          const r0 = el2.getBoundingClientRect();
          const cx = r0.left + r0.width / 2 - panRef.current.x;
          const cy = r0.top + r0.height / 2 - panRef.current.y;
          const dxA = m.x - cx, dyA = m.y - cy;
          const ratio = z / zoomRef.current;
          panRef.current = {
            x: dxA - ratio * (dxA - panRef.current.x),
            y: dyA - ratio * (dyA - panRef.current.y),
          };
        }
        zoomRef.current = z;
        paintImg(false);
        return;
      }

      if (mode === "pan") {
        if (e.touches.length !== 1) return;
        if (e.cancelable) e.preventDefault();
        const t = e.touches[0];
        panRef.current = { x: p0.x + (t.clientX - sx), y: p0.y + (t.clientY - sy) };
        moved = true;
        paintImg(false);
        return;
      }

      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      dx = t.clientX - sx; dy = t.clientY - sy;
      if (mode === "pending") {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        mode = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        moved = true;
      }
      const dt = e.timeStamp - lt;
      if (dt > 0) v = (t.clientX - lx) / dt;
      lx = t.clientX; lt = e.timeStamp;
      if (e.cancelable) e.preventDefault();
      if (mode === "x") {
        // 到头了加阻尼，给一个「没得翻了」的手感
        const atEdge = (dx > 0 && idxRef.current === 0) || (dx < 0 && idxRef.current === n - 1);
        paintX(atEdge ? dx / 3 : dx);
      } else {
        paintY(dy);
      }
    };

    const onEnd = (e) => {
      /* 轻点 = 一根手指、全程没动过。放在这里判定而不是等 click：
         滑动时 preventDefault 掉了兼容鼠标事件，click 压根不会来。
         放大状态（pan）下的轻点也算，不然放大后就再也切不了浮层 */
      if (!moved && (mode === "pending" || mode === "pan")) {
        setChrome(c => !c);
        mode = null;
        return;
      }
      if (mode === "pinch") {
        // 松手后小于 1 倍就复位（也顺手把拖歪的位移收回来）
        if (zoomRef.current <= 1.02) resetZoom(); else paintImg(true);
        mode = e.touches.length ? "reject" : null;   // 还剩一根手指就别接着当拖动
        return;
      }
      if (mode === "pan") { mode = null; return; }
      if (mode === "x") {
        const w = el.clientWidth || 1;
        const far = Math.abs(dx) > w / 4 || Math.abs(v) > FLING;
        const to = far ? idxRef.current + (dx < 0 ? 1 : -1) : idxRef.current;
        if (to !== idxRef.current && to >= 0 && to < n) {
          idxRef.current = to;
          onIndex(to);
        }
        settle();
      } else if (mode === "y") {
        if (Math.abs(dy) > DISMISS) onClose(); else settle();
      }
      mode = null;
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [n, onIndex, onClose]);

  // 点 tab 之外的方式换图（键盘等）时，把轨道同步过去
  useEffect(() => {
    if (!trackRef.current) return;
    trackRef.current.style.transition = EASE;
    trackRef.current.style.transform = base(index);
  }, [index]);

  const f = figures[index];
  // 说明和页码**浮在图上层**，不占布局（X 就是这样）：点一下图切换显隐。
  // 默认显示，否则用户不知道有说明、也找不到关闭钮
  const chromeCls = (on) =>
    `absolute inset-x-0 z-10 transition-opacity duration-200 ${on ? "opacity-100" : "opacity-0 pointer-events-none"}`;

  return createPortal(
    <div ref={rootRef} style={{ backgroundColor: "rgba(0,0,0,0.94)" }}
      // 点一下 = 切换说明/页码的显隐（不是关闭）。**关闭只靠上下滑** ——
      // 顶部不再放关闭钮，那一层会压住图。
      // 轻点的判定在 touchend 里（见上面 `moved` 的说明），这里不再挂 onClick
      className="fixed inset-0 z-[200] animate-fade-in">

      {/* 图占满整屏：说明和页码改成浮层后，这里不再需要给它们让出高度 */}
      <div ref={stageRef} className="absolute inset-0 overflow-hidden will-change-transform">
        {/* 每张 = 一屏宽；轨道整体平移。
            touch-action:none —— 双指缩放改成自己实现：交给浏览器的话它缩的是**视觉视口**，
            整个窗口连同页面一起放大，而不是只放大图片 */}
        <div ref={trackRef} style={{ transform: base(index), touchAction: "none" }}
          className="h-full flex will-change-transform">
          {figures.map((g, i) => (
            <div key={g.key || i} className="w-full h-full shrink-0 flex items-center justify-center p-2">
              {/* object-contain 让浏览器去适配，不用我们算 fit —— 也就没有
                  「缓存图算不出 fit 显示不全」和「先按原图画一帧的残影」 */}
              <img ref={el => { slideRefs.current[i] = el; }}
                src={g.url} alt={`图 ${i + 1}`} draggable={false}
                loading={Math.abs(i - index) <= 1 ? "eager" : "lazy"}
                className="max-w-full max-h-full object-contain bg-[#fff] rounded-lg select-none
                           will-change-transform" />
            </div>
          ))}
        </div>
      </div>

      {/* 底部浮层：说明 + 页码 */}
      <div className={`${chromeCls(chrome)} bottom-0 px-4 pt-8 pb-[calc(12px+env(safe-area-inset-bottom))]`}
        style={{ background: "linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.75))" }}
        onClick={e => e.stopPropagation()}>
        {/* 页码在说明**上面**：说明可长可短，页码放下面会随着说明长度上下浮动，
            找起来费劲；放上面位置就固定了 */}
        {n > 1 && (
          <div className="text-center text-[#ffffffb3] text-[12px] font-sans tabular-nums mb-1.5">
            {index + 1} / {n}
          </div>
        )}
        {f?.caption && (
          /* capRef：手势那边靠它判断「起手在说明栏里」→ 整套放行，
             否则在说明里上下滚会同时被当成竖向拖拽，图跟着一起动 */
          <div ref={capRef}
            /* **定高**不是 max-h：max-h 会让说明长的时候长驱直入盖住半张图，
               而且每张说明长短不一，翻页时这块高度忽大忽小。定高 76px ≈ 3 行半，
               露出的半行本身就是「还能往下滚」的提示（桌面端灯箱同一套约定）。
               想完全看图就点一下图，整组浮层会隐去 */
            className="h-[76px] overflow-y-auto overscroll-contain thin-scrollbar
                          text-[#ffffffe6] text-[12.5px] leading-relaxed font-sans">
            <LatexText text={f.caption} />
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

/**
 * 桌面端灯箱：**竖向卷轴**（和移动端同构，只是方向从横改竖）。
 * 所有图排成一条，轨道整体平移 -index*100%，旧图滑出、新图滑入是同一次位移 ——
 * 之前是「新图单独滑进来、旧图直接消失」，那不是卷轴，观感始终不对。
 *
 * 顺带把原来那套 fit 数学整个去掉：每张图交给 `object-contain` 让浏览器适配，
 * 和移动端一样。fit 一没，之前反复出问题的几样东西都跟着消失 ——
 * 「缓存图算不出 fit 显示不全」「先按原图尺寸画一帧的残影」「等 fit 期间的可见性时序」。
 * 缩放于是变成纯粹的 zoom（1 = 适应窗口），只作用在当前那张图上。
 */
export default function ImageLightbox({ images: figures, index, onIndex, onClose }) {
  const f = figures[index];
  const n = figures.length;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan]   = useState({ x: 0, y: 0 });
  // 缩略图高度按实测轨道高**向下取整**算，而不是写 calc((100% - 32px)/5)：
  // 百分比要靠逐项亚像素恰好凑满，浏览器缩放/高 DPI 下每项取整误差一累积就溢出几像素，
  // 第 5 张被切掉一线。取整后 5×h + 4×8 一定 ≤ 轨道高，只可能余、不可能缺
  const [thumbH, setThumbH] = useState(76);
  // 缩放/复位要有过渡才不生硬，但**拖动时必须关掉** —— 每帧都在改 pan，
  // 带着过渡就变成「手指走了图才慢慢跟上」，反而像卡顿
  const [smooth, setSmooth] = useState(true);
  // 移动端整套换成横向卷轴 + 系统双指，见 MobileLightbox
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const rootRef  = useRef(null);
  const stageRef = useRef(null);
  const imgRefs  = useRef([]);
  const railRef  = useRef(null);
  const capRef   = useRef(null);
  const dragRef  = useRef(null);
  const touchRef = useRef(null);
  const draggedRef = useRef(false);
  // 滚轮按位移累积判定（不是冷却），见 onWheel 里的说明
  const accRef    = useRef(0);
  const lastWhRef = useRef(0);

  const curImg = () => imgRefs.current[index] || null;
  const clampZ = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

  // 换图只需复位缩放：轨道位移直接由 index 算出来，不用手动搬
  const jump = (i) => { setZoom(1); setPan({ x: 0, y: 0 }); onIndex(((i % n) + n) % n); };
  const go = (d) => jump(index + d);

  /**
   * 以光标为锚缩放：缩放后光标下的那个点仍停在原处。
   * 变换是 translate(pan) scale(z)，原点在元素中心 C（object-contain 之后图本来就是居中的）。
   * 当前矩形中心 = C + pan（缩放不移动中心），于是 C = 矩形中心 − pan；
   * 记 d = 光标相对 C 的位移，解出 pan' = d − (z2/z)·(d − pan)。
   * 与移动端双指用的是同一个式子（那边验算过，偏移 0）。
   */
  const zoomAt = (cx, cy, dir) => {
    const img = curImg();
    const nz = clampZ(zoom + dir * ZOOM_STEP);
    if (nz === zoom) return;
    if (nz === ZOOM_MIN || !img) { setZoom(nz); setPan({ x: 0, y: 0 }); return; }
    const r = img.getBoundingClientRect();
    const c = { x: r.left + r.width / 2 - pan.x, y: r.top + r.height / 2 - pan.y };
    const d = { x: cx - c.x, y: cy - c.y };
    const ratio = nz / zoom;
    setPan({ x: d.x - ratio * (d.x - pan.x), y: d.y - ratio * (d.y - pan.y) });
    setZoom(nz);
  };

  const setZ = (z) => {
    const nz = clampZ(z);
    setZoom(nz);
    if (nz === ZOOM_MIN) setPan({ x: 0, y: 0 });   // 回到适应窗口就居中
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); go(1); }
      if (e.key === "ArrowUp"   || e.key === "ArrowLeft")  { e.preventDefault(); go(-1); }
      if (e.key === "+" || e.key === "=") setZ(zoom + ZOOM_STEP);
      if (e.key === "-") setZ(zoom - ZOOM_STEP);
      if (e.key === "0") setZ(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 翻页后把当前那张缩略图滚进视野：原来只换高亮、轨道不动，
  // 翻过第 5 张之后高亮就跑到看不见的地方了。
  // 用 rect 差值手动 scrollBy，不用 scrollIntoView —— 后者会去找「最近的可滚动祖先」，
  // 可能连带把灯箱底下的 <main> 一起滚
  useEffect(() => {
    const rail = railRef.current;
    const el = rail?.children?.[index];
    if (!rail || !el) return;
    const r = el.getBoundingClientRect(), rr = rail.getBoundingClientRect();
    if (r.top < rr.top)            rail.scrollBy({ top: r.top - rr.top, behavior: "smooth" });
    else if (r.bottom > rr.bottom) rail.scrollBy({ top: r.bottom - rr.bottom, behavior: "smooth" });
  }, [index]);

  // 轨道高度变了就重算缩略图高度（clientHeight 是整数，再向下取整，5 张必定装得下）
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const calc = () => setThumbH(Math.max(40, Math.floor((el.clientHeight - 4 * 8) / 5)));
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n]);

  // 滚轮：在图片上 = 缩放，灯箱里其它任何地方 = 翻页。
  // 监听挂在**整个灯箱**上而不是图片框内：图要是够宽，框里就没有空白可滚了，
  // 那样等于没法用滚轮翻页。
  // 缩略图轨道和说明栏例外 —— 它们各自要滚自己的内容，直接放行。
  // 必须 passive:false 才能 preventDefault，否则滚轮会穿透去滚下面的 main
  // （灯箱是 fixed，本身不挡滚动）
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e) => {
      const inside = (node) => node && (e.target === node || node.contains(e.target));
      if (inside(railRef.current) || inside(capRef.current)) return;   // 让它们自己滚
      e.preventDefault();
      if (inside(curImg())) { zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1); return; }
      if (n < 2) return;
      /* 按**位移累积**判定，不用固定冷却。
         冷却的问题在于它是直接丢弃输入 —— 来回快速滚时大部分 wheel 事件被扔掉，
         手上在动、画面不动，那就是「迟滞感」的来源。
         累积法按「滚了多远」算：滚得快就翻得快，慢滚也不会误触发，没有死区。
         三条细节：
         ① deltaMode 归一化（有的鼠标按「行」甚至「页」报，不换算阈值完全不是一回事）
         ② 停手 150ms 以上视为新的一次手势，累积清零
         ③ **一反向就立刻清零** —— 否则来回滚要先把反方向攒的量抵消掉才动，
            正是「来回快速滚动」最难受的那一下 */
      // 行/页模式的换算系数：一行按 40px 算（16 太小，Firefox 一格 3 行只有 48，
      // 又会够不到阈值 —— 和 Chrome 那格 100 差着一倍，同一个阈值得两边都覆盖）
      const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const t = e.timeStamp;
      if (t - lastWhRef.current > 150) accRef.current = 0;
      lastWhRef.current = t;
      if (px * accRef.current < 0) accRef.current = 0;
      accRef.current += px;
      /* 阈值必须**低于一格滚轮**：Windows/Chrome 一格 deltaY = 100，
         曾设成 110 → 一格永远够不着，150ms 后又清零，轻滑就完全不动了。
         75 仍低于任何一格（Chrome 100 / Firefox 3 行×40=120），轻滑一格照样翻一张；
         触控板那种小步长要多攒一点才翻，一次大力快划就不会窜过去十几张。
         触发后**清零而不是减去阈值**：留余量的话下一格会提前触发，
         快滚时变成一格翻两张 */
      const TH = 75;
      if (Math.abs(accRef.current) < TH) return;
      accRef.current = 0;
      go(px > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // 放大后可拖动查看；1 倍时不拦截，留给点击关闭
  const onPointerDown = (e) => {
    if (zoom <= 1) return;
    setSmooth(false);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y, moved: false };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    d.moved = true;
    setPan({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const onPointerUp = () => {
    setSmooth(true);
    // 拖完松手浏览器还会补一个 click，冒泡到最外层就把灯箱关了 ——
    // 「放大后拖一下就自动关闭」就是这么来的。留个标记让 stage 的 onClick 吃掉它
    draggedRef.current = !!dragRef.current?.moved;
    dragRef.current = null;
  };
  const onStageClick = (e) => {
    if (draggedRef.current) { draggedRef.current = false; e.stopPropagation(); }
  };

  // 触屏笔记本：竖滑翻页（1 倍时才接管，放大后那是拖动查看）
  const onTouchStart = (e) => {
    if (zoom > 1 || e.touches.length !== 1) { touchRef.current = null; return; }
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    const s = touchRef.current;
    touchRef.current = null;
    if (!s || n < 2 || e.touches.length > 0) return;
    const t = e.changedTouches[0];
    const dy = t.clientY - s.y;
    if (Math.abs(dy) < 45 || Math.abs(t.clientX - s.x) > Math.abs(dy)) return;
    go(dy < 0 ? 1 : -1);
  };

  const scrollRail = (dir) => {
    const el = railRef.current;
    if (el) el.scrollBy({ top: dir * Math.max(160, el.clientHeight * 0.8), behavior: "smooth" });
  };

  if (!f) return null;
  if (isMobile) return <MobileLightbox figures={figures} index={index} onIndex={onIndex} onClose={onClose} />;

  return createPortal(
    /* 遮罩用 inline style 而不是 bg-black/xx：这层要是没生效，整个页面透过来、
       按钮和文字全糊在内容上，是这个组件最不能出错的一处，不留给类名生成去赌 */
    <div ref={rootRef} style={{ backgroundColor: "rgba(0,0,0,0.94)" }}
      className="fixed inset-0 z-[200] flex flex-col animate-fade-in" onClick={onClose}>
      {/* 关闭钮浮动：顶栏整条去掉了 —— 它只装一个按钮却占掉一行高度 */}
      <button onClick={onClose} aria-label="关闭"
        className="absolute top-3 right-3 z-20 w-10 h-10 rounded-xl bg-[#ffffff33] border border-[#ffffff4d]
                   text-[#fff] cursor-pointer hover:bg-[#ffffff66] transition-colors text-[20px] leading-none">×</button>

      {/* 整组限宽并居中：不限的话图片区会一路铺到屏幕边，缩略图轨道被顶到最左，
          两者之间空出一大片。pt-3 与右上角关闭钮的 top-3 对齐 */}
      <div className="flex-1 min-h-0 flex w-full max-w-[1020px] mx-auto pt-3">
        {/* 左：竖排缩略图轨道（滚轮直接滑；上下箭头点选），正好露 5 张 */}
        {n > 1 && (
          <div className="flex flex-col items-center justify-start gap-2 w-[132px] shrink-0 pb-2 px-2
                          border-r border-[#ffffff33]" onClick={e => e.stopPropagation()}>
            <LbBtn label="上一批" onClick={() => scrollRail(-1)}><Chevron dir="up" size={18} /></LbBtn>
            <div ref={railRef} className="flex-1 min-h-0 w-full overflow-y-auto no-scrollbar flex flex-col gap-2">
              {figures.map((g, i) => (
                <button key={g.key || i} onClick={() => jump(i)} aria-label={`第 ${i + 1} 张`}
                  style={{ height: thumbH }}
                  className={`shrink-0 w-full rounded-lg overflow-hidden bg-[#fff] p-0.5 cursor-pointer
                              border-2 transition-all
                              ${i === index ? "border-[#fff] opacity-100" : "border-transparent opacity-60 hover:opacity-90"}`}>
                  <img src={g.url} alt="" loading="lazy" draggable={false} className="w-full h-full object-contain" />
                </button>
              ))}
            </div>
            <LbBtn label="下一批" onClick={() => scrollRail(1)}><Chevron dir="down" size={18} /></LbBtn>
          </div>
        )}

        {/* 中：功能区（缩放）。
            **列宽必须和按钮同单位**（踩过，现象是「框线和放大缩小按钮重叠」）：原来列宽写死
            `w-[48px]`（px），按钮却是 `w-10`（2.5rem）—— 只在根字号正好 16px 时 40 < 48 放得下；
            用户浏览器根字号 20px 时按钮 50px，比列还宽，两侧压在分隔线上。
            现在 `w-14`（3.5rem）= 按钮 + 两边各 0.5rem，根字号怎么变都留得出缝 */}
        <div className="flex flex-col items-center gap-2 w-14 shrink-0 pb-3 border-r border-[#ffffff33]"
          onClick={e => e.stopPropagation()}>
          <LbBtn label="放大" onClick={() => setZ(zoom + ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>
            <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v6M8 11h6" />
            </svg>
          </LbBtn>
          <LbBtn label="缩小" onClick={() => setZ(zoom - ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>
            <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M8 11h6" />
            </svg>
          </LbBtn>
          {/* 1 倍 = 适应窗口（object-contain 之后就是这个语义），所以直接显示 zoom */}
          <span className="text-[#fff] text-[12px] font-sans font-semibold tabular-nums">{Math.round(zoom * 100)}%</span>
          <LbBtn label="适应窗口" onClick={() => setZ(1)} disabled={zoom === 1}>
            <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
            </svg>
          </LbBtn>
          {/* 页码钉在功能区**最底部**（mt-auto 顶下去）：视觉上落在图片左下角 */}
          {n > 1 && (
            <span className="mt-auto text-[#ffffffb3] text-[11.5px] font-sans tabular-nums">{index + 1}/{n}</span>
          )}
        </div>

        {/* 右：图片区。上下翻页钮各占一行，不压在图上。
            左内边距明显大于右边：省下来的宽度让给「和缩略图轨道之间的距离」 */}
        <div className="flex-1 min-w-0 flex flex-col items-center pl-12 pr-4 pb-1">
          {n > 1 && (
            <LbBtn label="上一张" onClick={(e) => { e.stopPropagation(); go(-1); }} className="mb-1">
              <Chevron dir="up" />
            </LbBtn>
          )}
          <div ref={stageRef}
            className={`flex-1 min-h-0 w-full overflow-hidden relative
                        ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            onClick={onStageClick}
            onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            {/* 竖向卷轴：每张一屏高，轨道整体平移。旧图滑出、新图滑入是同一次位移，
                中间不存在「谁先消失」的空档 —— 之前的黑帧和残影全都出在那个空档上 */}
            <div className="absolute inset-0 flex flex-col will-change-transform"
              style={{
                transform: `translate3d(0,${-index * 100}%,0)`,
                // 240ms 而不是 320：连续翻页时 CSS 过渡会从**当前位置**重新起算
                // （不是排队），缩短之后快速连翻看起来就是一路滑过去
                transition: "transform 240ms cubic-bezier(0.22,0.61,0.36,1)",
              }}>
              {figures.map((g, i) => (
                <div key={g.key || i} className="w-full h-full shrink-0 flex items-center justify-center p-1">
                  {/* object-contain：适配交给浏览器，不再自己算 fit。
                      缩放/平移只加在当前这张上 */}
                  <img ref={el => { imgRefs.current[i] = el; }}
                    src={g.url} alt={`图 ${i + 1}`} draggable={false}
                    loading={Math.abs(i - index) <= 1 ? "eager" : "lazy"}
                    onClick={e => e.stopPropagation()}
                    style={i === index ? {
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transition: smooth ? "transform 180ms cubic-bezier(0.22,0.61,0.36,1)" : "none",
                    } : undefined}
                    className="max-w-full max-h-full object-contain bg-[#fff] rounded-lg select-none
                               will-change-transform" />
                </div>
              ))}
            </div>
          </div>
          {n > 1 && (
            <LbBtn label="下一张" onClick={(e) => { e.stopPropagation(); go(1); }} className="mt-1">
              <Chevron dir="down" />
            </LbBtn>
          )}
        </div>
      </div>

      {/* caption 高度固定、内部滚动：长短不一的说明不会让图片区忽大忽小 */}
      {f.caption && (
        <div ref={capRef}
          className="shrink-0 h-[104px] overflow-y-auto px-5 py-3 border-t border-[#ffffff33]
                     text-[#ffffffe6] text-[13px] leading-relaxed font-sans"
          onClick={e => e.stopPropagation()}>
          <LatexText text={f.caption} />
        </div>
      )}
    </div>,
    document.body
  );
}
