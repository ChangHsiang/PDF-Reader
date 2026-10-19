import { useEffect } from "react";
import { pageCanvasBox } from "../lib/pdfAnchor";
import { clientRectToNorm, pageSizePx } from "../lib/pdfium/rotate";
import { equationsFor, normLabel, sourceSize } from "../lib/latexSource";
import { t } from "../lib/i18n";

/**
 * 在正文里每个**带编号的独立公式**左边放一颗「复制 LaTeX」按钮。
 *
 * 认公式：文字层里内容正好是「(1)」「(2.3)」「(A4)」「(5b)」的那一小段，而且它左边同一行
 * 隔着一大段空白（独立公式的编号是右对齐到栏边的）—— 正文里「Eq. (3)」这种引用，
 * 左边紧挨着字，不会被当成公式编号。
 * 源码：lib/latexSource 从 arXiv 拿 LaTeX 源码算出「编号 → 公式」。页面上一出现公式编号就在后台预取，
 * 点的时候多半已经好了。
 *
 * 直接操作 DOM（同高亮层）：pdf.js 自己拆建 .page，React 管不到；每次页面 / 文字层重渲染后补画，
 * 按帧攒批 + 签名判等，画一次不会触发下一次。
 */

// 编号最多三位数：参考文献里的「(2017)」这种年份长得一模一样，也是右对齐在行尾（踩过）
const NUM_RE = /^\(\s*([A-Z]?\d{1,3}(?:\.\d{1,3})?[a-z]?)\s*\)$/;

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

export function useEquationCopy(viewerElRef, apiRef, ready, arxivId, enabled) {
  useEffect(() => {
    const root = viewerElRef.current;
    if (!root || !ready || !arxivId || !enabled) return;
    let srcJob = null;
    const source = () => (srcJob ||= equationsFor(arxivId).catch((e) => { srcJob = null; throw e; }));
    let prefetched = false;
    let known = null;          // 源码里存在的编号；源码到之前是 null（先按 PDF 里认出来的画）
    const candCache = new Map();
    let srcSize = null;            // 源码包大小（HEAD 查的），点击时提示用   // 页码 → 这一页认出来的公式编号（位置是比例，量一次就够）
    let bubble = null, bubbleTimer = 0;

    const showBubble = (btn, html, ok) => {
      bubble?.remove();
      clearTimeout(bubbleTimer);
      const layer = btn.parentElement;
      bubble = document.createElement("div");
      bubble.className = "rh-selbar";
      /* 右边和按钮右边对齐、往左展开，贴在按钮正上方 6px：
         - 按钮在编号右边、紧挨页边，以左边为锚点的话可用宽度只剩一条缝，气泡被挤成一竖条（踩过）。
           width:max-content 让它按内容自己的宽度来，max-width 封顶
         - 往上挪用固定距离，不按自身高度的百分比 —— 百分比的话内容越多离按钮越远（踩过） */
      bubble.style.cssText =
        `position:absolute;left:calc(${btn.style.left} + 16px);top:${btn.style.top};` +
        "transform:translate(-100%, calc(-100% - 14px));width:max-content;" +
        "z-index:5;max-width:420px;padding:6px 9px;border-radius:7px;background:#323639;" +
        "border:1px solid #ffffff26;box-shadow:0 6px 20px rgba(0,0,0,.4);font:12px/1.5 system-ui,sans-serif;" +
        `color:${ok ? "#7ee3a0" : "#ffcf7a"};pointer-events:auto;user-select:text;white-space:normal;`;
      bubble.innerHTML = html;
      layer.appendChild(bubble);
      bubbleTimer = setTimeout(() => { bubble?.remove(); bubble = null; }, ok ? 3500 : 4500);
    };
    const esc = (s) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

    const onClick = async (e) => {
      const btn = e.target.closest?.(".rh-eq-btn");
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      const label = btn.dataset.label;
      showBubble(btn, srcSize > 5e6 ? t("正在下载 LaTeX 源码（{mb} MB）…", { mb: (srcSize / 1e6).toFixed(1) }) : t("正在读取 LaTeX 源码…"), true);
      let map;
      try { map = await source(); } catch (err) {
        showBubble(btn, t("读取源码失败：{err}", { err: esc(err.message || t("网络错误")) }), false);
        return;
      }
      if (!map) { showBubble(btn, t("这篇论文在 arXiv 上只有 PDF，没有 LaTeX 源码"), false); return; }
      const hit = map.get(label);
      if (!hit) { showBubble(btn, t("源码里没对上公式 ({n})", { n: esc(label) }), false); return; }
      try { await navigator.clipboard.writeText(hit.latex); } catch { showBubble(btn, t("复制失败（剪贴板没有权限）"), false); return; }
      const preview = hit.latex.length > 160 ? `${hit.latex.slice(0, 160)}…` : hit.latex;
      showBubble(btn, `${t("✓ 已复制 ({n}) 的 LaTeX", { n: esc(label) })}<div style="margin-top:4px;color:#d8d8d8;font:11.5px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all">${esc(preview)}</div>`, true);
    };

    const scanPage = (pageEl) => {
      const tl = pageEl.querySelector(".textLayer");
      let layer = pageEl.querySelector(":scope > .rh-eq");
      const n = Number(pageEl.dataset.pageNumber);
      /* **每页只量一次**：位置存的是占页面的比例，和缩放无关。以前每来一次 pagerendered 就把整页
         几百个文字片段全 getBoundingClientRect 一遍 —— 放大后 pdf.js 边滚边重绘可视区，
         这个事件是连续来的，等于滚动时一直在强制重排 */
      let cands = candCache.get(n);
      if (!cands) {
        if (!tl?.querySelector("span")) { layer?.remove(); return; }   // 文字层还没出来，等 textlayerrendered
        const box = pageCanvasBox(pageEl);
        const sz = pageSizePx(pageEl);
        // 都换成页面方向的比例坐标再比（转过的页也对，见 lib/pdfium/rotate.js）；x 方向的阈值按页宽算
        const spans = [...tl.querySelectorAll("span")]
          .filter(s => !s.children.length && s.textContent.trim())
          .map(s => { const n = clientRectToNorm(pageEl, s.getBoundingClientRect(), box); return { t: s.textContent.trim(), r: { left: n.x, right: n.x + n.w, top: n.y, bottom: n.y + n.h } }; });
        cands = [];
        for (const c of spans) {
          const m = NUM_RE.exec(c.t);
          if (!m) continue;
          const cy = (c.r.top + c.r.bottom) / 2;
          let right = Infinity;
          const leftOnes = [];                                  // 同一行、在编号左边的字
          for (const o of spans) {
            if (o === c || o.r.top > cy || o.r.bottom < cy) continue;
            if (o.r.right <= c.r.left + 0.001) leftOnes.push(o);
            else if (o.r.left >= c.r.right - 0.001) right = Math.min(right, o.r.left);
          }
          /* 右边紧跟着字 = 正文里的引用：折行时「(23) for more…」会排到行首，左边空着（踩过）。
             真的公式编号右对齐在栏边，右边要么没字、要么隔着栏间距到了另一栏 */
          if (right !== Infinity && right - c.r.right < 0.015) continue;
          /* 左边紧挨着字 = 正文里的引用（「Eq. (3)」）。怎么算「紧挨着」：
             - 隔得够远（≥ 1.2% 页宽，约 10px）一定是公式编号
             - 近的话，和**同一行、同一栏**里别的词间距比：比它们明显宽（> 1.6 倍中位数）才是编号。
               两端对齐的正文一行里词间距都差不多（「combined with (19)」每个空格都 7~8px，踩过）；
               公式里的字挨得紧（3px 上下），编号前那道空就显得宽（2011.03014 的 (39) 只隔 9px，以前按 1.2% 漏掉了）
             - 左边只有一两个字、比不出来时，按字号：不到半个字宽算紧挨着 */
          leftOnes.sort((p, q) => q.r.right - p.r.right);
          if (leftOnes.length) {
            const gap = c.r.left - leftOnes[0].r.right;
            if (gap < 0.012) {
              const gaps = [];
              for (let k = 1; k < leftOnes.length; k++) {
                const g = leftOnes[k - 1].r.left - leftOnes[k].r.right;
                if (g > 0.025) break;                            // 到了栏间距：另一栏的字不算
                if (g >= 0) gaps.push(g);
              }
              gaps.sort((p, q) => p - q);
              const fontW = (c.r.bottom - c.r.top) * sz.h / sz.w; // 编号的高度（≈ 字号）换成页宽的比例
              const limit = gaps.length >= 3 ? gaps[gaps.length >> 1] * 1.6 : fontW * 0.5;
              if (gap < limit) continue;
            }
          }
          cands.push({ label: normLabel(m[1]), x: c.r.right, y: cy });
        }
        candCache.set(n, cands);
      }
      // 源码到了：源码里没有这个编号的就不出按钮
      const found = known ? cands.filter(c => known.has(c.label)) : cands;
      const sig = found.map(f => `${f.label}@${f.x.toFixed(3)},${f.y.toFixed(3)}`).join("|");
      if (!found.length) { layer?.remove(); return; }
      if (layer?.dataset.sig === sig) return;
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "rh-eq";
        layer.style.cssText = "position:absolute;inset:0;z-index:3;pointer-events:none";
        layer.addEventListener("click", onClick);
        pageEl.appendChild(layer);
      }
      layer.dataset.sig = sig;
      layer.replaceChildren(...found.map(f => {
        const b = document.createElement("button");
        b.className = "rh-eq-btn rh-selbar";
        b.dataset.label = f.label;
        b.title = t("复制公式 ({n}) 的 LaTeX", { n: f.label });
        b.innerHTML = COPY_ICON;
        // 放在编号右边（栏间空白 / 页边距里），不挤在公式和编号之间
        b.style.left = `calc(${f.x * 100}% + 3px)`;
        b.style.top = `${f.y * 100}%`;
        return b;
      }));
      if (!prefetched) {
        prefetched = true;
        /* 后台预取只取小的（≤ 5 MB）：有的源码包把图一起打进去，几十 MB，不能用户没点就悄悄下载。
           大的等真点了复制按钮再下（气泡里写明大小） */
        setTimeout(async () => {
          srcSize = await sourceSize(arxivId);
          if (srcSize === null || srcSize > 5e6) return;
          source().then((map) => {
            // 源码拿到了：没有源码就整层撤掉；有就按源码里真有的编号过一遍已经画出来的按钮
            known = map ? new Set(map.keys()) : new Set();
            root.querySelectorAll(".page").forEach(scanPage);
          }).catch(() => {});
        }, 1200);
      }
    };

    root.querySelectorAll(".page").forEach(scanPage);
    let raf = 0;
    const dirty = new Set();
    const flush = () => {
      raf = 0;
      [...dirty].forEach(n => {
        const el = root.querySelector(`.page[data-page-number="${n}"]`);
        if (el) scanPage(el);
      });
      dirty.clear();
    };
    const onPage = ({ pageNumber }) => {
      if (!pageNumber) return;
      dirty.add(pageNumber);
      raf ||= requestAnimationFrame(flush);
    };
    const bus = apiRef.current?.eventBus;
    bus?.on("textlayerrendered", onPage);
    bus?.on("pagerendered", onPage);
    return () => {
      bus?.off("textlayerrendered", onPage);
      bus?.off("pagerendered", onPage);
      cancelAnimationFrame(raf);
      clearTimeout(bubbleTimer);
      root.querySelectorAll(".rh-eq").forEach(n => n.remove());
    };
  }, [viewerElRef, apiRef, ready, arxivId, enabled]);
}
