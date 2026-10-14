import { useLayoutEffect } from "react";

/**
 * 浮在页面上的卡片 / 工具条，顶边伸出阅读区可视范围时往下挪回来。
 *
 * 这些浮层大多放在点击位置的**上方**、往上长（transform: translateY(-100%)），位置按点的那一刻算。
 * 第一页顶部的引用号、批注一点开，卡片就伸出了文档顶端 —— 上面已经没有内容可以往上滚了，
 * 伸出去的那截永远看不到（踩过：首页的文献卡片标题被顶栏盖住）。展开摘要这类操作还会让卡片变高、继续往上长。
 *
 * 做法：挂上时、以及卡片自己尺寸变化时（ResizeObserver），量一下顶边，比阅读区可视顶边 + 8px 还高就往下挪。
 * 用 CSS 的 `translate` 属性挪，不碰 `transform` / `top`：那两个是组件自己在管（上方 / 下方定位），
 * `translate` 和 `transform` 是叠加的，互不覆盖。滚动时不跟着调 —— 卡片本来就该跟着内容走。
 * 只管顶边：底边伸出去的话往下滚就看得到，往上挪反而会盖住点的那个位置。
 */
export function useKeepInView(ref, deps = []) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = el.closest(".overflow-auto");
    if (!scroller) return;
    const fit = () => {
      el.style.translate = "";
      const r = el.getBoundingClientRect();
      const c = scroller.getBoundingClientRect();
      const dy = Math.max(0, c.top + 8 - r.top);
      if (dy > 0.5) el.style.translate = `0 ${Math.round(dy)}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
