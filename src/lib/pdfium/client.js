/**
 * 主线程这边和 PDFium Worker（src/pdfium/worker.js）说话的薄壳：每个请求一个 id，回来按 id 兑现 Promise。
 */
export function createPdfium() {
  const worker = new Worker(new URL("../../pdfium/worker.js", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  const call = (op, args, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer);
  });
  return {
    open: (docId, buffer) => call("open", { docId, buffer }, [buffer]),
    render: (docId, pageIndex, scale, rect, annots = true) => call("render", { docId, pageIndex, scale, rect, annots }),
    renderRect: (docId, pageIndex, scale, rect, annots = true) => call("renderRect", { docId, pageIndex, scale, rect, annots }),
    props: (docId) => call("props", { docId }),
    outline: (docId) => call("outline", { docId }),
    links: (docId, pageIndex) => call("links", { docId, pageIndex }),
    text: (docId, pageIndex) => call("text", { docId, pageIndex }),
    namedDests: (docId, prefix) => call("namedDests", { docId, prefix }),
    identify: (docId) => call("identify", { docId }),
    stripNamed: (docId, names) => call("stripNamed", { docId, names }),
    exportAnnotated: (bytes, items) => call("exportAnnotated", { bytes, items }, [bytes]),
    close: (docId) => call("close", { docId }),
    mem: () => call("mem"),
    terminate: () => worker.terminate(),
  };
}

/** 整个页面共用一个 PDFium Worker（阅读器、认本地文件都用它；wasm 只加载一次） */
let shared = null;
export const sharedPdfium = () => (shared ||= createPdfium());
