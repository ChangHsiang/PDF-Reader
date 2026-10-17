# PDF-Reader

arXiv 论文笔记阅读器（浏览器扩展）。打开 arXiv 论文或本地 PDF 时，换成一个能做笔记、看引用文献、划词翻译的阅读器，支持 Chrome 和 Edge。

界面参照 Edge 自带的 PDF 阅读器和 Google 学术的 PDF 阅读器，PDF 用 [PDFium](https://pdfium.googlesource.com/pdfium/)（Chrome / Edge 自带阅读器的同款引擎）渲染。

## 功能

**标注**
- 划选文字高亮 / 下划线，7 种颜色，可写批注（支持 `$LaTeX$`）和标签
- 框选区域、画笔、橡皮擦、文本框、附注（可回复）
- 撤销 / 恢复（Ctrl+Z / Ctrl+Y）
- 笔记列表：搜索，按颜色 / 类型 / 标签筛选
- 论文更新版本（v1 → v2）后，标注按原文自动找回位置

**读论文**
- 点正文里的引用编号弹出文献卡片：摘要、插图、被引次数、相关文章、所有版本、引用格式，可一键收藏
- 引用当前这篇论文（GB/T 7714 / MLA / APA / BibTeX 等）
- 带编号的公式旁有「复制 LaTeX」按钮
- 划词翻译：Google / 必应 / 任意 OpenAI 兼容接口（DeepSeek、通义、Kimi……）
- 分屏阅读、旋转（整篇或单页）、文档内搜索、护眼页面颜色、全屏、打印
- 记住每篇读到哪儿

**数据**
- 不登录也能完整使用，笔记存在本机
- 登录 [ResearchHub](https://researchhub-xi.vercel.app)（支持 Google 账号）：笔记和网站同步，可以把整份笔记分享给别人、看别人的笔记、参与论文评论，收藏文献
- 导出带标注的 PDF：标注写成标准 PDF 注释，Edge / Acrobat / Zotero 都能看能改
- 备份：导出成文件，或自动备份到自己的 Google 云端硬盘

## 安装

1. 到 [Releases](https://github.com/ChangHsiang/PDF-Reader/releases) 下载最新的 `PDF-Reader-*.zip`，解压到一个固定的文件夹
2. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），打开右上角的「开发者模式」
3. 点「加载已解压的扩展程序」，选刚才解压出来的文件夹
4. 打开任意 `https://arxiv.org/pdf/…` 链接即可

想用它打开电脑上的 PDF：在扩展的「详细信息」里打开「允许访问文件网址」。

## 升级

把新版本的文件**覆盖**到原来那个文件夹，再在扩展管理页点这个插件的刷新按钮。有新版本时阅读器会提示。

> ⚠️ **不要在扩展管理页点「移除」**：移除插件时浏览器会把它的数据（所有笔记、标注）一起删掉。
> 重装、换电脑之前，先在阅读器的「设置 → 数据」里**导出备份**，装好后再导入。

## 许可证

[MIT](LICENSE)
