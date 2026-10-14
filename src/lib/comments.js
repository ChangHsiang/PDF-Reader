import { rest, restRows } from "./session";

/**
 * 论文评论（同网站：和帖子评论是同一张 `comments` 表，锚点是 `paper_key`，见 0029）。
 * 评论没有本地版本 —— 它本来就是给别人看的，离线写了也没意义。
 *
 * 读失败静默（看论文不该被评论连累），写失败返回 null 让 UI 说出来。
 */

const EMBED =
  "*,profiles!user_id(id,name,username,avatar,avatar_url)," +
  "reply_to_profile:profiles!reply_to_user_id(id,name,username)";

async function rows(res) {
  if (!res || !res.ok) return null;
  const d = await res.json().catch(() => null);
  return Array.isArray(d) ? d : null;
}

/** 全部评论（含楼中楼），时间升序；登录了顺带标出自己点过赞的 */
export async function fetchComments(paperKey, uid) {
  if (!paperKey) return [];
  const list = await rows(await rest(
    `comments?paper_key=eq.${encodeURIComponent(paperKey)}&select=${EMBED}&order=created_at.asc&limit=500`));
  if (!list) return null;
  if (uid && list.length) {
    const ids = list.map(c => c.id).join(",");
    const liked = await rows(await rest(`comment_likes?user_id=eq.${uid}&comment_id=in.(${ids})&select=comment_id`));
    if (liked) {
      const set = new Set(liked.map(l => l.comment_id));
      list.forEach(c => { c.liked = set.has(c.id); });
    }
  }
  return list;
}

/** 一篇论文的评论数（给 arXiv 摘要页上的小条用） */
export async function countComments(paperKey) {
  const res = await rest(`comments?paper_key=eq.${encodeURIComponent(paperKey)}&select=id&limit=1000`);
  const list = await rows(res);
  return list ? list.length : null;
}

export async function addComment(paperKey, { content, parentId = null, replyToUserId = null, me }) {
  if (!paperKey || !content?.trim() || !me) return null;
  const r = await restRows("comments", {
    method: "POST", auth: true,
    body: { paper_key: paperKey, post_id: null, user_id: me.id, content: content.trim(),
            parent_id: parentId, reply_to_user_id: replyToUserId },
  });
  const row = r?.[0];
  if (!row) return null;
  return {
    ...row,
    profiles: { id: me.id, name: me.name, username: me.username, avatar_url: me.avatar_url },
    reply_to_profile: null,
  };
}

/** RLS 只放开 `auth.uid() = user_id`，删别人的会「成功删 0 行」，所以看返回数组 */
export async function deleteComment(id) {
  const r = await restRows(`comments?id=eq.${id}`, { method: "DELETE", auth: true });
  return !!r?.length;
}

export async function toggleLike(commentId, uid, liked) {
  const res = liked
    ? await rest(`comment_likes?user_id=eq.${uid}&comment_id=eq.${commentId}`, { method: "DELETE", auth: true })
    : await rest("comment_likes", { method: "POST", auth: true, body: { user_id: uid, comment_id: commentId } });
  return !!res?.ok;
}

/* ── 通知（同网站 lib/notifications + lib/mentions，精简版） ───────────── */

const TYPE_TO_PREF = { reply: "reply", comment: "comment", like_comment: "like" };

async function notify({ actorId, recipientId, type, commentId, paperKey }) {
  if (!actorId || !recipientId || actorId === recipientId) return;
  // 接收者关掉了这类通知就不写（profiles 公开可读）
  const p = await rows(await rest(`profiles?id=eq.${recipientId}&select=prefs`));
  const key = TYPE_TO_PREF[type];
  if (key && p?.[0]?.prefs?.notif?.[key] === false) return;
  await rest("notifications", {
    method: "POST", auth: true, prefer: "return=minimal",
    body: { user_id: recipientId, actor_id: actorId, type, post_id: null, comment_id: commentId, paper_key: paperKey },
  });
}

export const notifyReply = (o) => notify({ ...o, type: "reply" });

const MENTION_RE = /@([A-Za-z0-9_]{2,30})/g;
export async function notifyMentions({ text, actorId, commentId, paperKey, excludeIds = [] }) {
  const names = [...new Set([...(text || "").matchAll(MENTION_RE)].map(m => m[1]))];
  if (!names.length) return;
  const list = await rows(await rest(
    `profiles?username=in.(${names.map(u => `"${u}"`).join(",")})&select=id,username`));
  const exclude = new Set([actorId, ...excludeIds]);
  (list || []).forEach(p => {
    if (!exclude.has(p.id)) notify({ actorId, recipientId: p.id, type: "mention", commentId, paperKey });
  });
}
