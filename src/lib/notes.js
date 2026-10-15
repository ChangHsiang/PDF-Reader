import { splitPaperKey } from "./pdfAnchor";
import { rest, restRows } from "./session";

/**
 * 笔记 / 标注：**本地优先 + 登录后同步**。
 *
 * 本地存在 chrome.storage.local，一篇论文（去掉版本号）一个键：
 *   `paper:arxiv:2301.12345` → {
 *     notes: { [paper_key 带版本]: { paper_key, title, url, visibility, remote_id, remote_uid, dirty, updated_at } },
 *     anns:  [ { id, paper_key, account, sync, deleted?, page, rects, quote, prefix, suffix,
 *                color, body, kind, tags, source_annotation_id, source_user_id, created_at, updated_at } ]
 *   }
 * 按 base 合在一起放：打开 v2 时 v1 上的标注也要一起拿出来（跨版本重锚，见 pdfAnchor），一次读完。
 *
 * **标注 id 本地生成（UUID），上云时原样当主键用**：于是本地和云端是同一个 id，
 * 同步只是 upsert，不需要维护一张「本地 id ↔ 远端 id」的映射表。
 *
 * `account`：null = 没登录时写的、还没上过云；uid = 已经属于这个账号。
 * - 没登录：本地所有标注都显示（这台设备就是你的）
 * - 登录了：只显示 null + 自己的；null 的那些在下一次同步时被这个账号「认领」上传
 *   这样同一台机器换个账号登录，不会把上一个人的笔记推到新账号里去
 *
 * `sync`：'dirty' 本地改过没上云 / 'synced' 和云端一致。删除已上云的标注留一个
 * `deleted: true` 的墓碑，等同步把云端那行删掉之后再真删；没上过云的直接删。
 */

const PREFIX = "paper:";
export const baseOf = (paperKey) => splitPaperKey(paperKey).base;
/** 本地文件的笔记（file:…，见 lib/localPdf）。认出是 arXiv 论文的本地文件用的是 arxiv: 的 key，不算 */
export const isLocalKey = (key) => /^file:/.test(key || "");
const skey = (base) => PREFIX + base;
const now = () => new Date().toISOString();
const empty = () => ({ notes: {}, anns: [] });

async function load(base) {
  const k = skey(base);
  const { [k]: d } = await chrome.storage.local.get(k);
  return d ? { notes: d.notes || {}, anns: d.anns || [] } : empty();
}

/* 同一页面里的读-改-写排队，免得两次连续写互相覆盖（比如连点两个高亮） */
const queues = new Map();
function mutate(base, fn) {
  const prev = queues.get(base) || Promise.resolve();
  const job = prev.then(async () => {
    const d = await load(base);
    const before = JSON.stringify(d);
    const out = await fn(d);
    /* 什么都没改就别写：每次写都会触发 storage.onChanged → 阅读器重读、重画高亮层。
       同步时「拉一遍发现和本地一样」是最常见的情况，以前每次都白写一遍 */
    if (JSON.stringify(d) === before) return out;
    // 空了就把整个键删掉，「我的笔记」列表里不留空壳
    if (!d.anns.length && !Object.values(d.notes).some(n => n.remote_id || n.dirty)) await chrome.storage.local.remove(skey(base));
    else await chrome.storage.local.set({ [skey(base)]: d });
    return out;
  });
  queues.set(base, job.catch(() => {}));
  return job;
}

const visibleTo = (uid) => (a) => !a.deleted && (!uid || a.account == null || a.account === uid);

/** 这篇论文（所有版本）里我能看到的标注 + 当前版本的笔记元信息 */
export async function loadMine(paperKey, uid) {
  const d = await load(baseOf(paperKey));
  return {
    note: d.notes[paperKey] || null,
    annotations: d.anns.filter(visibleTo(uid)),
    pending: d.anns.filter(a => a.sync !== "synced" && (!uid || a.account == null || a.account === uid)).length,
  };
}

/** 订阅某篇论文本地数据的变化（别的标签页、同步写回都会触发） */
export function watchPaper(paperKey, cb) {
  const k = skey(baseOf(paperKey));
  const fn = (changes, area) => { if (area === "local" && k in changes) cb(); };
  chrome.storage.onChanged.addListener(fn);
  return () => chrome.storage.onChanged.removeListener(fn);
}

function touchNote(d, paperKey, meta = {}) {
  const n = d.notes[paperKey] || { paper_key: paperKey, visibility: "private", remote_id: null, remote_uid: null };
  if (meta.title) n.title = meta.title;
  if (meta.url) n.url = meta.url;
  n.updated_at = now();
  d.notes[paperKey] = n;
  return n;
}

export function addAnnotation(paperKey, meta, fields) {
  const row = {
    id: crypto.randomUUID(), paper_key: paperKey, account: null, sync: "dirty",
    page: fields.page, rects: fields.rects ?? null, quote: fields.quote ?? null,
    prefix: fields.prefix ?? null, suffix: fields.suffix ?? null,
    color: fields.color || "yellow", body: fields.body ?? null,
    kind: fields.kind || "highlight", tags: fields.tags || [],
    style: fields.style || null,      // 区域框的线型 / 粗细：只存本地，云端没有这一列
    source_annotation_id: fields.source?.id || null, source_user_id: fields.source?.user_id || null,
    created_at: now(), updated_at: now(),
  };
  return mutate(baseOf(paperKey), (d) => {
    touchNote(d, paperKey, meta);
    d.anns.push(row);
    return row;
  });
}

/**
 * 导入 PDF 文件里自带的标注（lib/importPdf 转好的 items：[{ key（指纹）, nm（注释名）, ann }]）。
 * 导入过的指纹记在这篇的笔记上（imported），再打开不重复导入，删掉的也不会再冒回来；
 * nm 正好是本地已有的笔记 id（我们自己导出的文件）也跳过。新笔记一律用新 id（文件可能是别人发来的，
 * 拿注释名当 id 会和别人同步上去的那条撞主键）。返回导入了几条
 */
export function importAnnotations(paperKey, meta, items) {
  if (!items.length) return Promise.resolve(0);
  return mutate(baseOf(paperKey), (d) => {
    const ids = new Set(d.anns.map(a => a.id));
    const note = d.notes[paperKey];
    const done = new Set(note?.imported || []);
    let added = 0;
    const fresh = [];
    for (const { key, nm, ann } of items) {
      if (done.has(key)) continue;
      done.add(key);
      if (nm && ids.has(nm)) continue;
      fresh.push({
        id: crypto.randomUUID(), paper_key: paperKey, account: null, sync: "dirty",
        rects: null, quote: null, prefix: null, suffix: null, body: null, tags: [], style: null,
        source_annotation_id: null, source_user_id: null, ...ann,
      });
      added++;
    }
    if (!fresh.length && done.size === (note?.imported || []).length) return 0;
    const n = touchNote(d, paperKey, meta);
    n.imported = [...done].slice(-5000);
    d.anns.push(...fresh);
    return added;
  });
}

export function updateAnnotation(paperKey, id, patch) {
  return mutate(baseOf(paperKey), (d) => {
    const a = d.anns.find(x => x.id === id);
    if (!a) return null;
    Object.assign(a, patch, { sync: "dirty", updated_at: now() });
    return a;
  });
}

export function deleteAnnotation(paperKey, id) {
  return mutate(baseOf(paperKey), (d) => {
    const i = d.anns.findIndex(x => x.id === id);
    if (i < 0) return false;
    const a = d.anns[i];
    if (a.account) Object.assign(a, { deleted: true, sync: "dirty", updated_at: now() });   // 云端还有，留墓碑
    else d.anns.splice(i, 1);
    return true;
  });
}

export function setVisibility(paperKey, meta, visibility) {
  return mutate(baseOf(paperKey), (d) => {
    const n = touchNote(d, paperKey, meta);
    n.visibility = visibility;
    n.dirty = true;
    return n;
  });
}

/**
 * 把别人的一条标注收进我的笔记 = **复制一行**并记住来源（同网站：原作者改了删了，
 * 我这份不跟着变；溯源指到**最初**那条，不连成一条链）。标签是个人归类用的，不复制。
 */
/** 整份笔记分享时，这一条不分享（二级）/ 重新分享 */
export const setShareExcluded = (paperKey, id, excluded) => updateAnnotation(paperKey, id, { share_excluded: !!excluded });

/* 「他人」里自己隐藏掉的别人的标注（只影响自己看到的，不影响对方）。存一组 id，最多留 5000 个 */
const HIDDEN_KEY = "others_hidden";
export async function loadHiddenOthers() {
  const { [HIDDEN_KEY]: ids } = await chrome.storage.local.get(HIDDEN_KEY);
  return new Set(ids || []);
}
export async function setHiddenOther(id, hidden) {
  const s = await loadHiddenOthers();
  if (hidden) s.add(id); else s.delete(id);
  await chrome.storage.local.set({ [HIDDEN_KEY]: [...s].slice(-5000) });
  return s;
}

export function copyAnnotation(paperKey, meta, ann) {
  return addAnnotation(paperKey, meta, {
    page: ann.page, rects: ann.rects, quote: ann.quote, prefix: ann.prefix, suffix: ann.suffix,
    color: ann.color, body: ann.body, kind: ann.kind || "highlight", style: ann.style || null,
    source: { id: ann.source_annotation_id || ann.id, user_id: ann.source_user_id || ann.user_id },
  });
}

export const copiedSourceIds = (mine) => new Set(mine.map(a => a.source_annotation_id).filter(Boolean));

/* ── 同步 ──────────────────────────────────────────────────────────── */

const NOTE_COLS = "id,user_id,paper_key,paper_title,paper_url,visibility,updated_at";
const ANN_COLS = "id,note_id,user_id,page,rects,quote,prefix,suffix,color,body,kind,tags," +
                 "source_annotation_id,source_user_id,created_at,updated_at";
const SYNC_FIELDS = ["page", "rects", "quote", "prefix", "suffix", "color", "body", "kind", "tags",
                     "source_annotation_id", "source_user_id", "created_at", "updated_at"];

const likeBase = (base) => `paper_key=like.${encodeURIComponent(base)}*`;
/* like 'arxiv:0704.0001*' 理论上也会匹配到更长的号，按 base 再筛一遍 */
const sameBase = (base) => (n) => baseOf(n.paper_key) === base;

/* 云端有没有 style 列（网站迁移 0040）。null = 还不知道；没跑时带这一列的读写会 400（列不存在），
   退回不带它的再来一次并记住 —— 不能因为少跑一个迁移，整个同步就断了 */
let remoteHasStyle = null;
/* 网站数据库还不认的标注类型：ink（迁移 0041 放开）、text（0042 放开）、note（0043 放开）。没跑对应迁移时插入会撞
   kind 的 CHECK（23514）—— 记住这个类型，本次会话它先只留在本机，别的标注照常同步；同步状态里说清楚是为什么 */
const blockedKinds = new Set();
const NEW_KINDS = { ink: ["手写笔迹", "0041"], text: ["文本框", "0042"], note: ["附注", "0043"] };
const kindNotReady = (k) => `${NEW_KINDS[k][0]}暂存本机（网站数据库还没跑迁移 ${NEW_KINDS[k][1]}）`;
const isCheckViolation = (res) => res.clone().json().then(e => e?.code === "23514").catch(() => false);
/* 云端有没有 share_excluded 列（网站迁移 0044：整份分享时去掉某几条）。和 style 一样：没跑时退回不带它，
   「不分享这条」先只记在本地 */
let remoteHasExcl = null;
const annCols = () => ANN_COLS + (remoteHasStyle === false ? "" : ",style") + (remoteHasExcl === false ? "" : ",share_excluded");
/** 云端缺列：先当作缺新的那列（share_excluded），还缺再去掉 style；都去掉了还缺就返回 false */
const dropMissingCol = () => {
  if (remoteHasExcl !== false) { remoteHasExcl = false; return true; }
  if (remoteHasStyle !== false) { remoteHasStyle = false; return true; }
  return false;
};
const isMissingCol = (res) => res.clone().json().then(e => e?.code === "PGRST204" || e?.code === "42703").catch(() => false);

/** 读标注：带上 style / share_excluded 列；列不存在就去掉再读 */
async function readAnnRows(query, auth) {
  let res = await rest(`paper_annotations?${query}&select=${annCols()}`, { auth });
  while (res?.status === 400 && await isMissingCol(res) && dropMissingCol()) {
    res = await rest(`paper_annotations?${query}&select=${annCols()}`, { auth });
  }
  if (res?.ok) { if (remoteHasStyle === null) remoteHasStyle = true; if (remoteHasExcl === null) remoteHasExcl = true; }
  return readJson(res);
}

async function readJson(res) {
  if (!res || !res.ok) return null;
  const d = await res.json().catch(() => null);
  return Array.isArray(d) ? d : null;
}

/**
 * 一篇论文双向同步：先拉云端（网站上做的笔记也要进来），合并，再把本地改动推上去。
 * 返回 `{ ok, error? }`。失败不抛：阅读不能被同步连累，UI 上显示一个「未同步」就够了。
 */
export async function syncPaper(base, uid) {
  if (!uid) return { ok: false, error: "未登录" };

  /* ① 拉 */
  const notes = await readJson(await rest(`paper_notes?user_id=eq.${uid}&${likeBase(base)}&select=${NOTE_COLS}`, { auth: true }));
  if (!notes) return { ok: false, error: "连不上服务器" };
  const myNotes = notes.filter(sameBase(base));
  let remoteAnns = [];
  if (myNotes.length) {
    const ids = myNotes.map(n => `"${n.id}"`).join(",");
    remoteAnns = await readAnnRows(`note_id=in.(${ids})`, true);
    if (!remoteAnns) return { ok: false, error: "读取云端标注失败" };
  }
  const keyOfNote = Object.fromEntries(myNotes.map(n => [n.id, n.paper_key]));
  const remoteNoteByKey = Object.fromEntries(myNotes.map(n => [n.paper_key, n]));

  /* ② 合并：云端有本地没有 → 加；本地是 synced → 以云端为准；本地 dirty → 留着待推；
        本地 synced 但云端没了 → 在别处删掉了，本地也删 */
  await mutate(base, (d) => {
    const remoteIds = new Set(remoteAnns.map(r => r.id));
    d.anns = d.anns.filter(a => !(a.account === uid && a.sync === "synced" && !remoteIds.has(a.id)));
    for (const r of remoteAnns) {
      const local = d.anns.find(a => a.id === r.id);
      const row = { ...r, paper_key: keyOfNote[r.note_id], account: uid, sync: "synced",
                    kind: r.kind || "highlight", tags: r.tags || [] };
      delete row.note_id; delete row.user_id;
      if (!local) d.anns.push(row);
      else if (local.sync === "synced") {
        /* 云端还没有样式、本地有（0040 之前同步上去的框，样式只存在本地）：保留本地的、标成待推，
           下面那一轮就把样式补上云端。不这么做的话这一拉就把本地样式抹成空的了 */
        const keepStyle = remoteHasStyle === true && r.style == null && local.style;
        Object.assign(local, row);
        if (keepStyle) { local.style = keepStyle; local.sync = "dirty"; local.updated_at = new Date().toISOString(); }
      }
    }
    for (const n of myNotes) {
      const ln = d.notes[n.paper_key] || { paper_key: n.paper_key };
      ln.remote_id = n.id; ln.remote_uid = uid;
      ln.title ||= n.paper_title; ln.url ||= n.paper_url;
      if (!ln.dirty) ln.visibility = n.visibility;
      ln.updated_at ||= n.updated_at;
      d.notes[n.paper_key] = ln;
    }
  });

  /* ③ 推 */
  const d = await load(base);
  let error = null;

  const ensureRemoteNote = async (paperKey) => {
    if (remoteNoteByKey[paperKey]) return remoteNoteByKey[paperKey].id;
    const ln = d.notes[paperKey] || {};
    const rows = await restRows("paper_notes", {
      method: "POST", auth: true,
      body: { user_id: uid, paper_key: paperKey, paper_title: ln.title || null, paper_url: ln.url || null,
              visibility: ln.visibility || "private" },
    });
    let n = rows?.[0];
    // 建不出来多半是撞了 UNIQUE(user_id, paper_key)：其实早就有了，再读一次
    if (!n) {
      const again = await readJson(await rest(
        `paper_notes?user_id=eq.${uid}&paper_key=eq.${encodeURIComponent(paperKey)}&select=${NOTE_COLS}`, { auth: true }));
      n = again?.[0];
    }
    if (n) remoteNoteByKey[paperKey] = n;
    return n?.id || null;
  };

  /* **成批推、最后一次性写回本地**。以前一条标注一个请求、成功一条写一次本地 ——
     画笔一笔一条，一口气画了上百笔第一次同步就是上百个串行请求，外加上百次本地写入，
     每次写入都会触发阅读器重读、重画高亮层。现在：删除一个请求一批、新增 / 修改按笔记一个请求一批，
     整批失败（某一条撞了约束）才退回逐条，找出是哪一条 */
  const mineDirty = d.anns.filter(a => a.sync !== "synced" && (!a.account || a.account === uid));
  const syncedAt = new Map();                // id → 推上去时的 updated_at（推的过程中又被改了就不标 synced）
  const deletedIds = new Set();
  const CHUNK = 150;

  const toDelete = mineDirty.filter(a => a.deleted);
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const ids = toDelete.slice(i, i + CHUNK).map(a => a.id);
    const res = await rest(`paper_annotations?id=in.(${ids.join(",")})`, { method: "DELETE", auth: true });
    if (res?.ok) ids.forEach(id => deletedIds.add(id));
    else error = "有删除没能同步";
  }

  const rowOf = (a, noteId) => {
    const row = { id: a.id, note_id: noteId, user_id: uid };
    SYNC_FIELDS.forEach(f => { row[f] = a[f] ?? null; });
    row.tags = a.tags || [];
    if (remoteHasStyle !== false) row.style = a.style ?? null;
    if (remoteHasExcl !== false) row.share_excluded = !!a.share_excluded;
    return row;
  };
  const upsert = (rows) => rest("paper_annotations?on_conflict=id", {
    method: "POST", auth: true, body: rows, prefer: "resolution=merge-duplicates,return=representation",
  });
  /** 推一批；列不存在（0044 / 0040 没跑）就去掉那一列重来：「不分享」标记 / 样式先只留在本地；返回 Response */
  const pushBatch = async (anns, noteOf) => {
    let res = await upsert(anns.map(a => rowOf(a, noteOf(a))));
    while (res?.status === 400 && await isMissingCol(res) && dropMissingCol()) {
      res = await upsert(anns.map(a => rowOf(a, noteOf(a))));
    }
    return res;
  };

  const toPush = [];
  for (const a of mineDirty) {
    if (a.deleted) continue;
    if (blockedKinds.has(a.kind)) { error = kindNotReady(a.kind); continue; }
    toPush.push(a);
  }
  const noteIds = {};
  for (const k of new Set(toPush.map(a => a.paper_key))) noteIds[k] = await ensureRemoteNote(k);
  const ready = toPush.filter(a => noteIds[a.paper_key]);
  if (ready.length < toPush.length) error = "建立云端笔记失败";
  const noteOf = (a) => noteIds[a.paper_key];

  for (let i = 0; i < ready.length; i += CHUNK) {
    const batch = ready.slice(i, i + CHUNK);
    const res = await pushBatch(batch, noteOf);
    const rows = await readJson(res);
    if (rows && rows.length === batch.length) { batch.forEach(a => syncedAt.set(a.id, a.updated_at)); continue; }
    // 整批没过：逐条再推一遍，认出是哪条（多半是网站还不认的新类型撞了 CHECK）
    for (const a of batch) {
      if (blockedKinds.has(a.kind)) { error = kindNotReady(a.kind); continue; }
      const r1 = await pushBatch([a], noteOf);
      if (NEW_KINDS[a.kind] && r1?.status === 400 && await isCheckViolation(r1)) {
        blockedKinds.add(a.kind);
        error = kindNotReady(a.kind);
        continue;
      }
      if ((await readJson(r1))?.length) syncedAt.set(a.id, a.updated_at);
      else error = "有标注没能上传";
    }
  }

  if (syncedAt.size || deletedIds.size) {
    await mutate(base, (x) => {
      x.anns = x.anns.filter(y => !(y.deleted && deletedIds.has(y.id)));
      for (const cur of x.anns) {
        // 推的过程中用户又改了这一条 ⇒ updated_at 变了，那就还是 dirty，下次再推
        if (syncedAt.has(cur.id) && cur.updated_at === syncedAt.get(cur.id)) { cur.sync = "synced"; cur.account = uid; }
      }
    });
  }

  for (const [paperKey, ln] of Object.entries(d.notes)) {
    if (!ln.dirty) continue;
    const id = await ensureRemoteNote(paperKey);
    const rows = id && await restRows(`paper_notes?id=eq.${id}`, {
      method: "PATCH", auth: true, body: { visibility: ln.visibility, updated_at: now() },
    });
    if (rows?.length) {
      await mutate(base, (x) => {
        const n = x.notes[paperKey];
        if (n) { n.dirty = false; n.remote_id = id; n.remote_uid = uid; }
      });
    } else error = "公开 / 私有设置没能同步";
  }
  if (Object.keys(remoteNoteByKey).length) {
    await mutate(base, (x) => {
      for (const [k, n] of Object.entries(remoteNoteByKey)) {
        if (x.notes[k]) { x.notes[k].remote_id = n.id; x.notes[k].remote_uid = uid; }
      }
    });
  }
  return error ? { ok: false, error } : { ok: true };
}

/** 本地所有有改动的论文都推一遍，再把云端「我的笔记」里本地没有的论文拉下来 */
export async function syncAll(uid) {
  if (!uid) return { ok: false, error: "未登录" };
  const bases = new Set((await listLibrary()).map(p => p.base));
  const remote = await readJson(await rest(
    `paper_notes?user_id=eq.${uid}&select=paper_key&order=updated_at.desc&limit=200`, { auth: true }));
  if (!remote) return { ok: false, error: "连不上服务器" };
  remote.forEach(n => bases.add(baseOf(n.paper_key)));
  let error = null;
  for (const b of bases) {
    const r = await syncPaper(b, uid);
    if (!r.ok) error = r.error;
  }
  return error ? { ok: false, error } : { ok: true };
}

/** 「我的笔记」列表：本地所有论文，最近改过的在前 */
export async function listLibrary(uid) {
  const all = await chrome.storage.local.get(null);
  const out = [];
  for (const [k, d] of Object.entries(all)) {
    if (!k.startsWith(PREFIX)) continue;
    const anns = (d.anns || []).filter(visibleTo(uid));
    const notes = Object.values(d.notes || {});
    if (!anns.length && !notes.length) continue;
    const latest = notes.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    const updated = [...anns.map(a => a.updated_at), latest?.updated_at].filter(Boolean).sort().pop();
    out.push({
      base: k.slice(PREFIX.length),
      paperKey: latest?.paper_key || k.slice(PREFIX.length),
      title: notes.find(n => n.title)?.title || null,
      url: notes.find(n => n.url)?.url || null,
      count: anns.length,
      pending: (d.anns || []).filter(a => a.sync !== "synced" && (!uid || a.account == null || a.account === uid)).length,
      updated,
    });
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/* ── 别人公开的笔记（只读，不落本地） ─────────────────────────────────── */

/**
 * 返回 `[{ note, author, annotations }]`，只含 public 的（unlisted 不进列表，同网站）。
 * 没登录也能看：RLS 对非 private 的行是放开的。
 */
export async function fetchOthers(paperKey, uid) {
  const base = baseOf(paperKey);
  const notes = (await readJson(await rest(
    `paper_notes?${likeBase(base)}&visibility=eq.public&select=${NOTE_COLS}&order=updated_at.desc&limit=50`,
    { auth: "optional" })) || []).filter(sameBase(base)).filter(n => n.user_id !== uid);
  if (!notes.length) return [];
  const ids = notes.map(n => `"${n.id}"`).join(",");
  const anns = await readAnnRows(`note_id=in.(${ids})&order=page.asc,created_at.asc`, "optional") || [];
  const keyOf = Object.fromEntries(notes.map(n => [n.id, n.paper_key]));
  const byNote = new Map();
  anns.forEach(a => {
    a.paper_key = keyOf[a.note_id];
    a.kind ||= "highlight";
    a.tags ||= [];
    const l = byNote.get(a.note_id) || [];
    l.push(a);
    byNote.set(a.note_id, l);
  });
  const uids = [...new Set(notes.map(n => n.user_id))].map(x => `"${x}"`).join(",");
  const people = await readJson(await rest(`profiles?id=in.(${uids})&select=id,name,username,avatar_url`)) || [];
  const authors = Object.fromEntries(people.map(p => [p.id, p]));
  return notes
    .map(n => ({ note: n, author: authors[n.user_id] || null, annotations: byNote.get(n.id) || [] }))
    .filter(o => o.annotations.length > 0);
}

/* ── 导出 ──────────────────────────────────────────────────────────── */

/** 规范化标签：去掉开头的 #、首尾空白，去重，数量 / 长度封顶（和 0031 的 CHECK 对齐） */
export function normTags(list) {
  const out = [];
  for (const raw of list || []) {
    const t = String(raw).replace(/^#+/, "").trim().slice(0, 30);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

/** 导出成 Markdown：按页分组、原文用 `>`，批注跟在下面；从别人那儿拿来的必须带署名 */
export function exportMarkdown({ paperTitle, paperUrl, paperKey, annotations, authorNames = {} }) {
  const lines = [`# ${paperTitle || paperKey}`];
  if (paperUrl) lines.push(`\n<${paperUrl}>`);
  lines.push("");
  const byPage = new Map();
  annotations.forEach(a => {
    const l = byPage.get(a.page) || [];
    l.push(a);
    byPage.set(a.page, l);
  });
  [...byPage.keys()].sort((a, b) => a - b).forEach(page => {
    lines.push(`\n## 第 ${page} 页\n`);
    byPage.get(page)
      .sort((x, y) => (x.rects?.[0]?.y ?? -1) - (y.rects?.[0]?.y ?? -1))
      .forEach(a => {
        if (a.kind === "ink") {
          lines.push("> *[手写笔迹]*\n");
        } else if (a.kind === "note") {
          lines.push("> *[附注]*\n");
        } else if (a.kind === "area") {
          const q = a.quote ? ` ${a.quote.replace(/\n+/g, " ").slice(0, 200)}` : "";
          lines.push(`> *[区域选取：图 / 表 / 公式]*${q}\n`);
        } else if (a.quote) {
          lines.push(`> ${a.quote.replace(/\n+/g, " ")}\n`);
        }
        if (a.body) lines.push(`${a.body}\n`);
        if (a.kind === "note") (a.style?.replies || []).forEach(r => lines.push(`- **${r.name}**：${r.text}\n`));
        if (a.tags?.length) lines.push(`${a.tags.map(t => `#${t.replace(/\s+/g, "_")}`).join(" ")}\n`);
        if (a.source_user_id) {
          const who = authorNames[a.source_user_id];
          lines.push(`*—— 来自 ${who ? `@${who}` : "他人笔记"}*\n`);
        }
      });
  });
  return lines.join("\n");
}
