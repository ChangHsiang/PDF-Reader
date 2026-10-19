/* arXiv 摘要页（/abs/<id>）上插一条小栏：用笔记阅读器打开 / 我的标注数 / 论文评论数。
   普通脚本（内容脚本不能是 ES 模块），不打包；评论数让 background 去查。
   界面语言同 lib/i18n：设置里的 lang（auto 跟浏览器）。这里拿不到插件页面的 localStorage，读 chrome.storage */
(async () => {
  const m = /\/abs\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z-]+)?\/\d{7})(?:v\d+)?)/i.exec(location.pathname);
  if (!m || document.getElementById("rh-bar")) return;
  const id = m[1];
  const base = `arxiv:${id.replace(/v\d+$/i, "")}`;
  const pdfUrl = `https://arxiv.org/pdf/${id}`;

  const { settings } = await chrome.storage.local.get("settings").catch(() => ({}));
  const pref = settings?.lang;
  const en = pref === "en" || (pref !== "zh" && !/^zh/i.test(chrome.i18n?.getUILanguage?.() || navigator.language || ""));
  const L = en ? {
    read: "Open in PDF-Reader", readTip: "Open the PDF in the extension's reader: highlight, underline, box, comment",
    talk: "Discussion", talkTip: "See or join the discussion on this paper (shared with the ResearchHub website)",
    mine: (n) => `Open in PDF-Reader · ${n} annotations`, talkN: (n) => `Discussion ${n}`,
  } : {
    read: "用笔记阅读器打开", readTip: "在扩展的阅读器里打开 PDF：高亮、划线、框选、批注",
    talk: "论文评论", talkTip: "查看 / 参与这篇论文的讨论（和 ResearchHub 网站互通）",
    mine: (n) => `用笔记阅读器打开 · 我的标注 ${n}`, talkN: (n) => `论文评论 ${n}`,
  };
  if (document.getElementById("rh-bar")) return;

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
  brand.textContent = "PDF-Reader";
  bar.appendChild(brand);
  const readBtn = mk(L.read, L.readTip, () => open());
  const talkBtn = mk(L.talk, L.talkTip, () => open("comments"));

  const anchor = document.querySelector("#abs h1.title") || document.querySelector("h1.title");
  if (anchor) anchor.insertAdjacentElement("afterend", bar);
  else document.body.prepend(bar);

  // 我的标注数：直接读本地存储（和阅读器同一个键）
  const key = `paper:${base}`;
  const showCount = async () => {
    const { [key]: d } = await chrome.storage.local.get(key);
    const n = (d?.anns || []).filter(a => !a.deleted).length;
    readBtn.textContent = n ? L.mine(n) : L.read;
  };
  showCount();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && key in ch) showCount(); });

  chrome.runtime.sendMessage({ type: "comments:count", paperKey: base }).then((n) => {
    if (typeof n === "number" && n > 0) talkBtn.textContent = L.talkN(n);
  }).catch(() => {});
})();
