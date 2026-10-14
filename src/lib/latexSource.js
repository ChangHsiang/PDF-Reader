/**
 * 公式「复制 LaTeX」：从 arXiv 拿论文的 LaTeX 源码，算出每个带编号公式的编号 → 源码。
 *
 * PDF 里没有 LaTeX，只有排好版的字形；但 arXiv 公开了绝大多数论文的源码
 * （`/e-print/<id>`，302 到 `/src/<id>`，通常是 gzip 过的 tar，也可能是单个 gzip 过的 .tex，
 * 只交了 PDF 的就没有源码）。
 *
 * 步骤：解压 → 找主文件（有 \documentclass 的）→ 把 \input / \include 内联 →
 * 去注释 → 展开作者自定义的宏（很多人用 \be / \ee 代替 \begin{equation}，不展开就认不出公式环境；
 * 展开后复制出去的公式在别处也能直接编译）→ 按 LaTeX 的规则给公式编号。
 *
 * 编号规则覆盖：equation / align / eqnarray / gather / flalign / alignat（多行环境每行一个号）、
 * multline（整体一个号）、带 * 的不编号、\nonumber / \notag、\tag{…}、subequations（1a, 1b）、
 * \numberwithin{equation}{section}（2.1）、附录（revtex 的 A1 和 amsart 风格的 A.1 都登记）。
 */

const cache = new Map();

/** arXiv 号 → Map<编号, { latex, env }>；没有源码返回 null */
export function equationsFor(arxivId) {
  if (!cache.has(arxivId)) {
    const job = (async () => {
      const files = await fetchSource(arxivId);
      if (!files) return null;
      const doc = assemble(files);
      if (!doc) return null;
      return numberEquations(doc);
    })();
    job.catch(() => cache.delete(arxivId));
    cache.set(arxivId, job);
  }
  return cache.get(arxivId);
}

/* ── 1. 下载 + 解包 ─────────────────────────────────────────────────── */

/** 源码包有多大（HEAD 请求，不下载）。拿不到返回 null。
    后台预取前先看一眼：有的源码包连图一起打包，几十 MB，不能悄悄就下了 */
export async function sourceSize(id) {
  try {
    const r = await fetch(`https://arxiv.org/e-print/${id}`, { method: "HEAD" });
    const n = Number(r.headers.get("content-length"));
    return r.ok && n > 0 ? n : null;
  } catch { return null; }
}

async function fetchSource(id) {
  const r = await fetch(`https://arxiv.org/e-print/${id}`);
  if (!r.ok) throw new Error(`arXiv 返回 ${r.status}`);
  let bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 8));
  if (head.startsWith("%PDF")) return null;                 // 只交了 PDF，没有源码
  const files = new Map();
  if (new TextDecoder("latin1").decode(bytes.slice(257, 262)) === "ustar") {
    untar(bytes, files);
  } else {
    files.set("main.tex", decodeText(bytes));
  }
  return files.size ? files : null;
}

const decodeText = (b) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch { return new TextDecoder("latin1").decode(b); }      // 老论文常见 latin1
};

/** 最小的 tar 解析：只要 .tex / .sty / .def / .cls 之类的文本，图片跳过 */
function untar(buf, files) {
  const str = (a, b) => new TextDecoder("latin1").decode(buf.slice(a, b)).replace(/\0[\s\S]*$/, "");
  let off = 0, longName = null;
  while (off + 512 <= buf.length) {
    const name0 = str(off, off + 100);
    if (!name0) break;                                        // 两个全零块 = 结束
    const size = parseInt(str(off + 124, off + 136).trim() || "0", 8) || 0;
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = str(off + 345, off + 500);
    const dataStart = off + 512;
    const data = buf.slice(dataStart, dataStart + size);
    if (type === "L") longName = new TextDecoder("latin1").decode(data).replace(/\0[\s\S]*$/, "");
    else {
      const name = longName || (prefix ? `${prefix}/${name0}` : name0);
      longName = null;
      if ((type === "0" || type === "\0") && /\.(tex|sty|def|cls|ltx|bbl)$/i.test(name)) files.set(name.replace(/^\.\//, ""), decodeText(data));
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
}

/* ── 2. 拼成一份完整文档 ─────────────────────────────────────────────── */

const stripComments = (t) => t.replace(/(^|[^\\])%.*$/gm, "$1");

function assemble(files) {
  const texs = [...files.entries()].filter(([n]) => /\.(tex|ltx)$/i.test(n));
  const mains = texs.filter(([, t]) => /\\documentclass/.test(t) && /\\begin\s*\{document\}/.test(t));
  const pick = (mains.length ? mains : texs).sort((a, b) => b[1].length - a[1].length)[0];
  if (!pick) return null;
  const find = (name) => {
    const n = name.trim().replace(/^\.\//, "");
    for (const cand of [n, `${n}.tex`]) {
      if (files.has(cand)) return files.get(cand);
      const hit = [...files.keys()].find(k => k.endsWith(`/${cand}`));
      if (hit) return files.get(hit);
    }
    return null;
  };
  const inline = (text, depth) => stripComments(text).replace(/\\(?:input|include)\s*\{([^}]+)\}|\\input\s+([^\s{}\\]+)/g, (m, a, b) => {
    const sub = depth < 6 ? find(a || b) : null;
    return sub ? inline(sub, depth + 1) : "";
  });
  return inline(pick[1], 0);
}

/* ── 3. 宏展开 ─────────────────────────────────────────────────────── */

/** 从 i 处读一个 {…} 组（i 指向 `{`），返回 [内容, 结束位置后一位]；不是 { 就读一个记号 */
function readArg(s, i) {
  while (s[i] === " " || s[i] === "\n" || s[i] === "\t") i++;
  if (s[i] === "{") {
    let d = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s[j] === "{") d++;
      else if (s[j] === "}" && --d === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === "\\") {
    const m = /^\\([a-zA-Z@]+|.)/.exec(s.slice(i));
    return [m[0], i + m[0].length];
  }
  return [s[i] ?? "", i + 1];
}

function parseMacros(doc) {
  const macros = new Map();
  const re = /\\(?:re|provide)?newcommand\*?\s*(\{\\[a-zA-Z@]+\}|\\[a-zA-Z@]+)|\\def\s*(\\[a-zA-Z@]+)((?:#\d)*)/g;
  let m;
  while ((m = re.exec(doc))) {
    let i = re.lastIndex, name, nargs = 0, def = null;
    if (m[1]) {
      name = m[1].replace(/[{}\\\s]/g, "");
      const n = /^\s*\[(\d)\]/.exec(doc.slice(i));
      if (n) { nargs = +n[1]; i += n[0].length; }
      const opt = /^\s*\[([^\]]*)\]/.exec(doc.slice(i));
      if (opt && nargs) { def = opt[1]; i += opt[0].length; }
    } else {
      name = m[2].slice(1);
      nargs = (m[3].match(/#/g) || []).length;
    }
    while (doc[i] === " " || doc[i] === "\n") i++;
    if (doc[i] !== "{") continue;
    const [body, end] = readArg(doc, i);
    re.lastIndex = end;
    macros.set(name, { nargs, def, body });
  }
  return macros;
}

/** 展开宏；同一处最多展开 8 层，防递归定义把页面卡死 */
function expand(text, macros, depth = 0) {
  if (!macros.size || depth > 8) return text;
  let out = "", i = 0, changed = false;
  while (i < text.length) {
    if (text[i] === "\\") {
      const m = /^\\([a-zA-Z@]+)/.exec(text.slice(i));
      if (m && macros.has(m[1])) {
        const mac = macros.get(m[1]);
        let j = i + m[0].length;
        const args = [];
        let k = 0;
        if (mac.def !== null && mac.nargs) {
          const opt = /^\s*\[([^\]]*)\]/.exec(text.slice(j));
          if (opt) { args.push(opt[1]); j += opt[0].length; } else args.push(mac.def);
          k = 1;
        }
        for (; k < mac.nargs; k++) { const [a, e] = readArg(text, j); args.push(a); j = e; }
        out += mac.body.replace(/#(\d)/g, (_, n) => args[n - 1] ?? "");
        if (!mac.nargs && /^[a-zA-Z]/.test(text[j] || "") && /[a-zA-Z]$/.test(mac.body)) out += " ";
        i = j;
        changed = true;
        continue;
      }
      if (m) { out += m[0]; i += m[0].length; continue; }
      out += text.slice(i, i + 2); i += 2; continue;
    }
    out += text[i++];
  }
  return changed ? expand(out, macros, depth + 1) : out;
}

/* ── 4. 编号 ───────────────────────────────────────────────────────── */

const MULTI = new Set(["align", "eqnarray", "gather", "flalign", "alignat", "xalignat"]);
const SINGLE = new Set(["equation", "multline", "dmath"]);

/** 按顶层 `\\` 拆行（嵌套环境、花括号里的不拆） */
function splitLines(body) {
  const lines = [];
  let depth = 0, envDepth = 0, cur = "";
  for (let i = 0; i < body.length; i++) {
    const rest = body.slice(i, i + 7);
    if (rest.startsWith("\\begin")) envDepth++;
    if (rest.startsWith("\\end")) envDepth--;
    if (body[i] === "\\" && body[i + 1] === "\\" && depth === 0 && envDepth === 0) {
      lines.push(cur); cur = "";
      i++;
      const opt = /^\s*\[[^\]]*\]/.exec(body.slice(i + 1));   // \\[2pt]
      if (opt) i += opt[0].length;
      continue;
    }
    if (body[i] === "\\") { cur += body[i] + (body[i + 1] ?? ""); i++; continue; }
    if (body[i] === "{") depth++;
    if (body[i] === "}") depth--;
    cur += body[i];
  }
  lines.push(cur);
  return lines.filter((l, k) => k < lines.length - 1 || l.trim());
}

/** 顶层的 & 去掉（对齐符号单独拿出来没意义，粘到别处还会报错）；矩阵 / cases 里的保留 */
function dropAlign(s) {
  let out = "", depth = 0, env = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("\\begin", i)) env++;
    if (s.startsWith("\\end", i)) env--;
    if (s[i] === "\\") { out += s[i] + (s[i + 1] ?? ""); i++; continue; }
    if (s[i] === "{") depth++;
    if (s[i] === "}") depth--;
    if (s[i] === "&" && depth === 0 && env === 0) continue;
    out += s[i];
  }
  return out;
}

/** eqnarray 的一行 `a &=& b` → aligned 用的 `a &= b`（三栏变两栏） */
function eqnarrayToAligned(line) {
  return line.replace(/&\s*([^&]*?)\s*&/, "&$1 ");
}

const tagOf = (s) => /\\tag\*?\s*\{([^}]*)\}/.exec(s)?.[1]?.trim() || null;
const noNum = (s) => /\\(nonumber|notag)\b/.test(s);
function clean(s) {
  return s
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .replace(/\\(nonumber|notag)\b/g, "")
    .replace(/\\tag\*?\s*\{[^}]*\}/g, "")
    .replace(/\\begin\s*\{split\}/g, "\\begin{aligned}").replace(/\\end\s*\{split\}/g, "\\end{aligned}")
    // 句末的逗号句号和空白；\right. / \bigl. 这类定界符的点要留着
    .replace(/(\\[,;:!]|\\quad|\\qquad|~|\s|[,;]|(?<!\\(?:right|left|[bB]igg?[lr]?))\.)+$/g, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n")
    .trim();
}

function numberEquations(doc) {
  const body = (/\\begin\s*\{document\}([\s\S]*)\\end\s*\{document\}/.exec(doc)?.[1]) ?? doc;
  const macros = parseMacros(doc);
  const text = expand(body, macros);
  const withinSection = /\\numberwithin\s*\{equation\}\s*\{section\}/.test(doc) ||
    /\\renewcommand\s*\{?\\theequation\}?\s*\{\s*\\thesection\.?\\arabic\{equation\}/.test(doc);

  const map = new Map();
  let eq = 0, sec = 0, appendix = false, sub = null;   // sub = { parent, n }
  const secLabel = () => (appendix ? String.fromCharCode(64 + sec) : String(sec));
  const put = (labels, latex, env) => {
    for (const l of labels) if (!map.has(l)) map.set(l, { latex, env });
  };
  const nextLabels = () => {
    if (sub) { sub.n++; const p = sub.parent; const L = String.fromCharCode(96 + sub.n); return p.map(x => `${x}${L}`); }
    eq++;
    if (withinSection && sec) return [`${secLabel()}.${eq}`];
    if (appendix && sec) return [`${secLabel()}${eq}`, `${secLabel()}.${eq}`, String(eq)];   // revtex: A1；amsart: A.1
    return [String(eq)];
  };

  const re = /\\(section|appendix)\b\*?|\\begin\s*\{(subequations)\}|\\end\s*\{(subequations)\}|\\begin\s*\{([a-zA-Z]+)(\*?)\}/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] === "appendix") { appendix = true; sec = 0; if (!withinSection) eq = 0; continue; }
    if (m[1] === "section") {
      if (text[m.index + m[0].length - 1] === "*") continue;      // \section* 不计数
      sec++;
      if (withinSection || appendix) eq = 0;
      continue;
    }
    if (m[2]) { eq++; sub = { parent: (withinSection && sec) ? [`${secLabel()}.${eq}`] : (appendix && sec) ? [`${secLabel()}${eq}`] : [String(eq)], n: 0 }; continue; }
    if (m[3]) { sub = null; continue; }
    const env = m[4], star = m[5] === "*";
    if (!MULTI.has(env) && !SINGLE.has(env)) continue;
    const start = re.lastIndex;
    const endRe = new RegExp(`\\\\end\\s*\\{${env}\\*?\\}`, "g");
    endRe.lastIndex = start;
    const em = endRe.exec(text);
    if (!em) continue;
    let content = text.slice(start, em.index);
    if (env === "alignat" || env === "xalignat") content = content.replace(/^\s*\{\d+\}/, "");
    re.lastIndex = em.index + em[0].length;
    if (star) continue;
    if (SINGLE.has(env)) {
      const tag = tagOf(content);
      if (tag) { put([tag], clean(content), env); continue; }
      if (noNum(content)) continue;
      put(nextLabels(), clean(content), env);
      continue;
    }
    /* 一个编号管的是「上一个编号之后、到它为止」的那几行：\nonumber 的行通常是同一个式子的前半截
       （例：第一行 ds² = … \nonumber，第二行 = … 才带编号）。只复制带编号的那一行会丢掉左边。
       最后一个编号后面还剩的不编号行，归到最后一组 */
    const groups = [];
    let pending = [];
    for (const line of splitLines(content)) {
      pending.push(line);
      if (noNum(line) && !tagOf(line)) continue;
      groups.push({ lines: pending, tag: tagOf(line) });
      pending = [];
    }
    if (pending.length && groups.length) groups[groups.length - 1].lines.push(...pending);
    for (const g of groups) {
      const rows = g.lines.map(l => clean(env === "eqnarray" ? eqnarrayToAligned(l) : l)).filter(Boolean);
      const latex = rows.length <= 1
        ? clean(dropAlign(g.lines.find(l => l.trim()) || ""))
        : `\\begin{aligned}\n${rows.join(" \\\\\n")}\n\\end{aligned}`;
      put(g.tag ? [g.tag] : nextLabels(), latex, env);
    }
  }
  return map;
}

/** PDF 里的编号文字 "(2.1)" / "( A3 )" → "2.1" / "A3" */
export const normLabel = (s) => String(s || "").replace(/^\(\s*|\s*\)$/g, "").replace(/\s+/g, "");

// 测试用
export const _internal = { numberEquations, parseMacros, expand, splitLines, assemble };
