# arXiv PDF 笔记阅读器（浏览器扩展）

打开 arXiv 论文的 PDF 时，换成一个带笔记、标注、文献卡片和划词翻译的阅读器。Chrome / Edge（Manifest V3）。PDF 用 [PDFium](https://pdfium.googlesource.com/pdfium/)（Chrome / Edge 自带阅读器用的同一个引擎，WebAssembly 版来自 [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer)）渲染和取字。

界面参照 Edge 自带的 PDF 阅读器和 Google 学术的 PDF 阅读器。目前只支持 arXiv。

## 功能

**标注**
- 划选文字：高亮 / 下划线，7 种颜色，可写批注（支持 `$LaTeX$`）和标签
- 浮动工具条（可拖动、可横排 / 竖排）：区域框选（线型、粗细、填充可调）、画笔、橡皮擦、添加文本框、添加附注（可回复）
- 侧栏：缩略图、目录、笔记列表（搜索，按颜色 / 类型 / 标签筛选），导出 Markdown
- 跨版本：v1 上做的标注在 v2 里按原文重新定位
- 选字按词对齐：文字层按画出来的字形逐词校准，双击选词、划选都贴着字

**读论文**
- 点正文里的引用号弹出文献卡片：标题、作者、摘要 / 插图、被引次数、相关文章、所有版本、引用格式（GB/T 7714 / MLA / APA / BibTeX / EndNote / RIS）
- 带编号的公式旁有「复制 LaTeX」按钮（取自 arXiv 的源码包）
- 划词翻译：Google / 必应 / 任意 OpenAI 兼容接口（DeepSeek、OpenAI、通义、Kimi……），13 种目标语言，可钉住
- 文档内搜索、缩放菜单、全屏、下载

**数据**
- 不登录也能完整使用：笔记存在本机 `chrome.storage.local`
- 可选登录 [ResearchHub](https://researchhub-xi.vercel.app)：笔记和网站双向同步，并能看 / 发论文评论（需要构建时配置后端，见下）

## 安装

**直接用**：到 [Releases](https://github.com/ChangHsiang/PDF-Reader/releases) 下载最新的 `PDF-Reader-*.zip`，解压到一个固定的文件夹，然后按下面第 1、2 步加载这个文件夹。

**升级**：把新版本的文件覆盖到原来那个文件夹，再在扩展管理页点这个插件的刷新按钮。插件有新版本时阅读器会提示。

> ⚠️ **不要在扩展管理页点「移除」**：移除插件时浏览器会把它的数据（所有笔记、标注）一起删掉。
> 重装、换电脑之前，先在阅读器的「设置 → 数据」里**导出备份**，装好后再导入。

**自己构建**：

```bash
npm install
npm run build        # 产物在 dist/
```

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），打开「开发者模式」
2. 「加载已解压的扩展程序」，选 `dist` 文件夹
3. 打开任意 `https://arxiv.org/pdf/…` 链接

开发时用 `npm run watch`，改完代码在扩展管理页点「重新加载」。

## 配置（可选）

复制 `.env.example` 为 `.env.local`。**全部留空也能用**，只是没有登录同步和论文评论：

| 变量 | 作用 |
| --- | --- |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | ResearchHub 的 Supabase 项目：登录同步笔记、论文评论 |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth 客户端 ID：「备份到 Google 云端硬盘」。不填就不显示这项 |

### 用 Google 登录 / 备份到 Google 云端硬盘

插件编号固定是 `jagifojihipdmfigeppilfinllpopfmg`，两个回跳地址都由它定：

1. [Google Cloud 控制台](https://console.cloud.google.com)建一个项目，在「API 和服务 → 库」里启用 **Google Drive API**
2. 「OAuth 同意屏幕」：外部用户；范围加 `drive.file`、`openid`、`email`（都不是敏感范围）
3. 「凭据 → 创建 OAuth 客户端 ID」，类型选 **Web 应用**，「已获授权的重定向 URI」加两条：
   - `https://<Supabase 项目>.supabase.co/auth/v1/callback`（用 Google 登录）
   - `https://jagifojihipdmfigeppilfinllpopfmg.chromiumapp.org/google`（备份到云端硬盘）
4. Supabase 后台 → Authentication → Providers → **Google**：打开，填上一步的客户端 ID 和密钥
5. Supabase 后台 → Authentication → URL Configuration → Redirect URLs 加 `https://jagifojihipdmfigeppilfinllpopfmg.chromiumapp.org/supabase`
6. 客户端 ID 填进 `.env.local` 的 `VITE_GOOGLE_CLIENT_ID`，重新构建

想要大模型翻译的话，不用改配置：在阅读器的设置里选「自定义 API」，填自己的接口地址和 key（只存在本机浏览器里）。

## 用到的外部服务

都是公开接口，不需要 key：

- [INSPIRE-HEP](https://inspirehep.net)、[Semantic Scholar](https://www.semanticscholar.org)、[Crossref](https://www.crossref.org)、[OpenAlex](https://openalex.org)：文献卡片的元数据、插图、相关文章、所有版本
- arXiv：PDF、LaTeX 源码（复制公式）、HTML 版论文（插图的备用来源）
- Google 翻译 / 必应翻译的网页接口：划词翻译（非官方接口，可能随时失效）

## 代码结构

| 路径 | 作用 |
| --- | --- |
| `src/background.js` | Service worker：arXiv PDF 重定向规则、登录态和 token 刷新 |
| `src/components/PdfViewer.jsx` | 阅读器主体：工具栏、侧栏、各种工具模式 |
| `src/components/PdfNotes.jsx` | 高亮层、划选工具条、笔记列表、框选 / 画笔 / 文本框 / 附注 |
| `src/components/RefCard.jsx` | 引用文献卡片（摘要 / 插图 / 所有版本 / 相关文章） |
| `src/components/ImageLightbox.jsx` | 插图全屏查看器 |
| `src/components/EqCopy.js` | 公式旁的「复制 LaTeX」 |
| `src/lib/notes.js` | 本地存储、和网站同步、导出 Markdown |
| `src/lib/pdfium/` · `src/pdfium/worker.js` | 阅读器内核：Worker 里跑 PDFium，按需渲染、按字形外框建文字层、搜索 |
| `src/lib/refs.js` · `cite.js` · `openalex.js` · `figures.js` | 参考文献解析、引用格式、版本 / 相关文章、插图 |
| `src/lib/latexSource.js` | 解析 arXiv 源码包，公式编号 → LaTeX |
| `src/lib/translate.js` | 划词翻译 |
| `public/content-arxiv.js` | arXiv 摘要页上的小栏（用阅读器打开 / 标注数 / 评论数） |

## 许可证

[MIT](LICENSE)
