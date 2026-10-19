import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";

/**
 * 文档属性（点阅读器左上角的标题打开，参照 Edge / Chrome 的「文档属性」）。
 * 文件、信息字典、PDF 三组照抄浏览器那份；最后多一组「本插件」：认出的是哪一篇（笔记跟着它走）、我在这篇的标注数。
 * 信息字典和 PDF 版本由 PDFium 读（worker 的 props），页数 / 页面尺寸 / 文件大小手上本来就有
 */

const PT2MM = 25.4 / 72;
/** 常见纸张（毫米，竖放），差 2mm 以内就算 */
const PAPER_SIZES = [["A3", 297, 420], ["A4", 210, 297], ["A5", 148, 210], ["B5", 176, 250], ["Letter", 215.9, 279.4], ["Legal", 215.9, 355.6]];

function pageSizeText(size) {
  if (!size) return "-";
  const w = size.width * PT2MM, h = size.height * PT2MM;
  const [a, b] = [Math.min(w, h), Math.max(w, h)];
  const name = PAPER_SIZES.find(([, x, y]) => Math.abs(a - x) < 2 && Math.abs(b - y) < 2)?.[0];
  const dir = h >= w ? t("纵向") : t("横向");
  return t("{w} × {h} 毫米（{name}{dir}）", { w: Math.round(w), h: Math.round(h), name: name ? `${name}${t("，")}` : "", dir });
}

/** PDF 日期 D:YYYYMMDDHHmmSS+08'00' → 本地时间文字 */
function pdfDate(s) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s || "");
  if (!m) return s || "-";
  const [, Y, Mo = "01", D = "01", H = "00", Mi = "00", S = "00", z, oh = "00", om = "00"] = m;
  const iso = `${Y}-${Mo}-${D}T${H}:${Mi}:${S}${!z ? "" : /z/i.test(z) ? "Z" : `${z}${oh}:${om}`}`;
  const d = new Date(iso);
  if (Number.isNaN(+d)) return s;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 104857600 ? 0 : 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 文件开头 1KB 里有 /Linearized ⇒ 线性化（快速 Web 查看） */
function linearized(bytes) {
  if (!bytes?.length) return false;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return /\/Linearized\s/.test(head);
}

function identityText(paperKey) {
  if (/^arxiv:/.test(paperKey)) {
    const m = /^arxiv:(.+?)(?:v(\d+))?$/.exec(paperKey);
    return `arXiv ${m[1]}${m[2] ? ` v${m[2]}` : ""}`;
  }
  if (/^doi:/.test(paperKey)) return `DOI ${paperKey.slice(4)}`;
  if (/^file:sha256:/.test(paperKey)) return t("按文件内容识别（这份 PDF 没有文件编号；内容一改就认不出了）");
  if (/^file:/.test(paperKey)) return t("按 PDF 文件编号识别（在别的软件里加标注保存后也认得出）");
  return paperKey || "-";
}

export default function DocProps({ doc, url, localName, paperKey, annCount, onClose }) {
  const [p, setP] = useState(null);
  useEffect(() => {
    let alive = true;
    doc?.props?.().then(r => { if (alive) setP(r); }).catch(() => { if (alive) setP({}); });
    return () => { alive = false; };
  }, [doc]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const isFile = /^file:/i.test(url || "");
  let where = url || "-";
  if (isFile) { try { where = decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, "$1"); } catch { /* 原样显示 */ } }
  // 在线的（arXiv 的网址末尾没有 .pdf）补上扩展名，和浏览器下载时的文件名一样
  const fileName = localName || (() => { try { const n = decodeURIComponent(new URL(url).pathname.split("/").pop()); return n ? (/\.pdf$/i.test(n) ? n : `${n}.pdf`) : "-"; } catch { return "-"; } })();
  const v = (s) => (s ? s : "-");
  const groups = [
    [[t("文件名"), fileName], [t("文件大小"), doc?.bytes ? sizeText(doc.bytes.byteLength) : "-"], [t("位置"), where]],
    [[t("标题"), v(p?.Title)], [t("作者"), v(p?.Author)], [t("主题"), v(p?.Subject)], [t("关键字"), v(p?.Keywords)],
     [t("创建时间"), p?.CreationDate ? pdfDate(p.CreationDate) : "-"], [t("修改时间"), p?.ModDate ? pdfDate(p.ModDate) : "-"],
     [t("应用"), v(p?.Creator)]],
    [[t("PDF 制作工具"), v(p?.Producer)], [t("PDF 版本"), v(p?.version)], [t("页数"), doc ? String(doc.numPages) : "-"],
     [t("页面尺寸"), pageSizeText(doc?.pages?.[0]?.size)], [t("快速 Web 查看"), linearized(doc?.bytes) ? t("是") : t("否")]],
    [[t("识别为"), identityText(paperKey)], [t("我的标注"), t("{n} 条", { n: annCount })]],
  ];

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-4 animate-fade-in font-sans"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[480px] max-h-[90vh] flex flex-col overflow-hidden rounded-xl bg-[#323639]
                      border border-[#ffffff26] shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
        <div className="relative h-12 shrink-0 flex items-center justify-center border-b border-[#00000040]">
          <span className="text-[14.5px] text-[#fff] font-bold">{t("文档属性")}</span>
          <button onClick={onClose} title={t("关闭（Esc）")}
            className="absolute right-2 w-8 h-8 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[#c8c8c8] hover:bg-[#ffffff1a]">
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar px-5 py-1">
          {groups.map((g, i) => (
            <div key={i} className={`py-2.5 ${i ? "border-t border-[#ffffff14]" : ""}`}>
              {i === 3 && <div className="text-[11.5px] text-[#7ec8e3] font-bold pb-1">{t("本插件")}</div>}
              {g.map(([k, val]) => (
                <div key={k} className="flex gap-3 py-[5px] text-[13px] leading-snug">
                  <span className="w-[96px] shrink-0 text-[#9a9a9a]">{k}</span>
                  <span className={`min-w-0 break-all select-text ${val === "-" ? "text-[#7a7a7a]" : "text-[#e6e6e6]"}`}>{val}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
