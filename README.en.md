# PDF-Reader

[中文](README.md) | **English**

A note-taking PDF reader for arXiv papers, as a browser extension. When you open an arXiv paper or a local PDF, it replaces the built-in viewer with one that lets you take notes, look up references, and translate selections. Works in Chrome and Edge.

The interface follows Edge's built-in PDF viewer and Google Scholar's PDF reader. PDFs are rendered with [PDFium](https://pdfium.googlesource.com/pdfium/), the same engine as the Chrome / Edge viewers. The interface is available in English and Chinese.

## Features

**Annotations**
- Highlight or underline selected text in 7 colors, with comments (`$LaTeX$` supported) and tags
- Area selection, pen, eraser, text boxes, sticky notes (with replies)
- Undo / redo (Ctrl+Z / Ctrl+Y)
- Notes list with search and filters by color / type / tag
- When a paper gets a new version (v1 → v2), annotations find their place in the new text automatically

**Reading**
- Click a citation number to open a reference card: abstract, figures, citation count, related articles, all versions, citation formats, and a one-click save to your library
- Cite the paper you're reading (GB/T 7714 / MLA / APA / BibTeX and more)
- “Copy LaTeX” buttons next to numbered equations
- Translate selections with Google, Bing, or any OpenAI-compatible API (DeepSeek, Qwen, Kimi, …)
- Split view, rotation (all pages or one page), find in document, eye-friendly page colors, full screen, printing
- Remembers where you stopped in every paper

**Data**
- Fully usable without an account; notes are stored on your computer
- Sign in to [ResearchHub](https://researchhub-xi.vercel.app) (Google accounts supported) to sync notes with the website, share your notes, see other people's notes, join paper discussions, and keep a library
- Export a PDF with your annotations as standard PDF annotations that Edge, Acrobat, and Zotero can view and edit
- Back up to a file, or automatically to your own Google Drive

## Install

1. Download the latest `PDF-Reader-*.zip` from [Releases](https://github.com/ChangHsiang/PDF-Reader/releases) and unzip it into a folder you'll keep
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on “Developer mode” in the top right
3. Click “Load unpacked” and choose the folder you just unzipped
4. Open any `https://arxiv.org/pdf/…` link

To open PDFs on your computer, turn on “Allow access to file URLs” in the extension's Details page.

The interface follows your browser's language. To change it, open Settings → Reading → Language in the reader.

## Upgrade

Copy the new version's files **over** the old folder, then click the extension's reload button on the extensions page. The reader tells you when a new version is out.

> ⚠️ **Don't click “Remove” on the extensions page**: removing the extension makes the browser delete its data, including all your notes and annotations.
> Before reinstalling or switching computers, **export a backup** in the reader's Settings → Data, then import it after installing.

## License

[MIT](LICENSE)
