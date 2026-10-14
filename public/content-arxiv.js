/* arXiv 摘要页（/abs/<id>）上插一条小栏：用笔记阅读器打开 / 我的标注数 / 论文评论数。
   普通脚本（内容脚本不能是 ES 模块），不打包；评论数让 background 去查 */
(() => {
  const m = /\/abs\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z-]+)?\/\d{7})(?:v\d+)?)/i.exec(location.pathname);
  if (!m || document.getElementById("rh-bar")) return;
  const id = m[1];
  const base = `arxiv:${id.replace(/v\d+$/i, "")}`;
  const pdfUrl = `https://arxiv.org/pdf/${id}`;

  const bar = document.createElement("div");
  bar.id = "rh-bar";
  const mk = (label, title, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    bar.appendChild(b);
    return b;
  };
  const open = (panel) => chrome.runtime.sendMessage({ type: "viewer:open", url: pdfUrl, panel });

  const brand = document.createElement("span");
  brand.className = "rh-brand";
  brand.textContent = "ResearchHub";
  bar.appendChild(brand);
  const readBtn = mk("用笔记阅读器打开", "在扩展的阅读器里打开 PDF：高亮、划线、框选、批注", () => open());
  const talkBtn = mk("论文评论", "查看 / 参与这篇论文的讨论（和 ResearchHub 网站互通）", () => open("comments"));

  const anchor = document.querySelector("#abs h1.title") || document.querySelector("h1.title");
  if (anchor) anchor.insertAdjacentElement("afterend", bar);
  else document.body.prepend(bar);

  // 我的标注数：直接读本地存储（和阅读器同一个键）
  const key = `paper:${base}`;
  const showCount = async () => {
    const { [key]: d } = await chrome.storage.local.get(key);
    const n = (d?.anns || []).filter(a => !a.deleted).length;
    readBtn.textContent = n ? `用笔记阅读器打开 · 我的标注 ${n}` : "用笔记阅读器打开";
  };
  showCount();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && key in ch) showCount(); });

  chrome.runtime.sendMessage({ type: "comments:count", paperKey: base }).then((n) => {
    if (typeof n === "number" && n > 0) talkBtn.textContent = `论文评论 ${n}`;
  }).catch(() => {});
})();
