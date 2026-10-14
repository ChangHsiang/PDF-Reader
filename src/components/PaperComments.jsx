import { useEffect, useRef, useState } from "react";
import { HAS_BACKEND } from "../lib/config";
import { Avatar, UserLink, TimeText, MathText } from "./bits";
import {
  fetchComments, addComment, deleteComment, toggleLike, notifyReply, notifyMentions,
} from "../lib/comments";

/**
 * 论文评论区（阅读器右侧栏）。数据和网站是同一张表，网站上看到的就是这里的。
 *
 * 照网站 PaperComments 精简：楼中楼只有一层、回复恒按时间升序（那是一段对话）；
 * 没有置顶（论文没有作者）。举报、@ 补全、翻译这些要网站那一整套组件，
 * 这里不搬 —— 需要时从底部链接去网站论文页。
 *
 * 读失败静默；**写失败必须说出来**（「我点了发送」是明确的动作，什么都不发生只会让人以为坏了）。
 */
export default function PaperComments({ paperKey, me, onLogin, sitePaperUrl, onCount }) {
  const [comments, setComments] = useState(null);     // null = 加载中；false = 读失败
  const [sort, setSort] = useState("newest");
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);  // { rootId, targetId, replyToUserId, replyToName, replyToUsername }
  const [replyText, setReplyText] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);
  const [err, setErr] = useState("");
  const uid = me?.id;

  const load = () => {
    if (!paperKey) return () => {};
    let alive = true;
    fetchComments(paperKey, uid).then(rows => { if (alive) setComments(rows ?? false); });
    return () => { alive = false; };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [paperKey, uid]);

  useEffect(() => { if (Array.isArray(comments)) onCount?.(comments.length); }, [comments, onCount]);

  const submit = async () => {
    if (!me) return onLogin();
    if (!text.trim() || posting) return;
    setPosting(true); setErr("");
    const row = await addComment(paperKey, { content: text, me });
    setPosting(false);
    if (!row) { setErr("发送失败了，稍后再试试"); return; }
    setComments(prev => [...(prev || []), row]);
    setText("");
    notifyMentions({ text: row.content, actorId: me.id, commentId: row.id, paperKey });
  };

  const submitReply = async () => {
    if (!me) return onLogin();
    if (!replyText.trim() || posting || !replyingTo) return;
    setPosting(true); setErr("");
    const row = await addComment(paperKey, {
      content: replyText, parentId: replyingTo.rootId, replyToUserId: replyingTo.replyToUserId, me,
    });
    setPosting(false);
    if (!row) { setErr("发送失败了，稍后再试试"); return; }
    row.reply_to_profile = { id: replyingTo.replyToUserId, name: replyingTo.replyToName,
                             username: replyingTo.replyToUsername };
    setComments(prev => [...(prev || []), row]);
    setReplyText(""); setReplyingTo(null);
    notifyReply({ actorId: me.id, recipientId: replyingTo.replyToUserId, commentId: row.id, paperKey });
    notifyMentions({ text: row.content, actorId: me.id, commentId: row.id, paperKey,
                     excludeIds: [replyingTo.replyToUserId] });
  };

  const doDelete = async () => {
    const id = confirmDel;
    setConfirmDel(null);
    if (!id) return;
    if (await deleteComment(id)) {
      // 子回复靠 parent_id 的 ON DELETE CASCADE 连带删掉，本地也照着去掉
      setComments(prev => (prev || []).filter(c => c.id !== id && c.parent_id !== id));
    } else setErr("删除失败了");
  };

  const like = async (c) => {
    if (!me) return onLogin();
    const next = !c.liked;
    setComments(prev => prev.map(x => x.id === c.id
      ? { ...x, liked: next, likes_count: Math.max(0, (x.likes_count || 0) + (next ? 1 : -1)) } : x));
    if (!(await toggleLike(c.id, me.id, c.liked))) {
      // 失败就撤回乐观更新
      setComments(prev => prev.map(x => x.id === c.id ? { ...x, liked: c.liked, likes_count: c.likes_count } : x));
    }
  };

  const startReply = (c, root) => {
    if (!me) return onLogin();
    setReplyingTo({
      rootId: root ? root.id : c.id,          // 楼中楼只有一层：回复挂在根评论下
      targetId: c.id,                          // 但输入框挂在被回复的那一条下面
      replyToUserId: c.user_id,
      replyToName: c.profiles?.name || "用户",
      replyToUsername: c.profiles?.username,
    });
    setReplyText("");
  };

  const list = Array.isArray(comments) ? comments : [];
  const roots = list.filter(c => !c.parent_id).sort((a, b) => (sort === "newest"
    ? new Date(b.created_at) - new Date(a.created_at)
    : new Date(a.created_at) - new Date(b.created_at)));
  const repliesOf = (rootId) => list.filter(c => c.parent_id === rootId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const item = (c, { isReply, root }) => (
    <div className="group flex gap-2 -mx-1.5 px-1.5 py-1.5 rounded-md hover:bg-[#ffffff0d]">
      <UserLink user={c.profiles} className="shrink-0 self-start">
        <Avatar name={c.profiles?.name || "用户"} size={isReply ? 22 : 26} url={c.profiles?.avatar_url} />
      </UserLink>
      <div className="flex-1 min-w-0">
        <div className="text-[11.5px] mb-0.5 flex items-center gap-1 flex-wrap leading-tight">
          <UserLink user={c.profiles} className="text-[#7ec8e3] font-semibold hover:underline">
            {c.profiles?.name || "用户"}
          </UserLink>
          {isReply && c.reply_to_profile?.name && (
            <>
              <span className="text-[#8a8a8a]">回复</span>
              <UserLink user={c.reply_to_profile} className="text-[#7ec8e3] hover:underline">
                @{c.reply_to_profile.name}
              </UserLink>
            </>
          )}
        </div>
        <div className="text-[12.5px] leading-relaxed text-[#e6e6e6] whitespace-pre-line break-words">
          <MathText text={c.content} />
        </div>
        <div className="flex items-center gap-3 mt-1 text-[11px]">
          <TimeText ts={c.created_at} className="text-[#8a8a8a]" />
          <button onClick={() => like(c)}
            className={`inline-flex items-center gap-1 bg-transparent border-none cursor-pointer p-0
              ${c.liked ? "text-[#ff7a90]" : "text-[#8a8a8a] hover:text-[#ff7a90]"}`}>
            <svg viewBox="0 0 24 24" className="w-[12px] h-[12px]" fill={c.liked ? "currentColor" : "none"}
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
            {(c.likes_count || 0) > 0 && <span className="tabular-nums">{c.likes_count}</span>}
          </button>
          <button onClick={() => startReply(c, root)}
            className="text-[#8a8a8a] bg-transparent border-none cursor-pointer p-0 hover:text-[#7ec8e3]">回复</button>
          {uid === c.user_id && (
            <button onClick={() => setConfirmDel(c.id)}
              className="hidden group-hover:inline text-[#8a8a8a] bg-transparent border-none cursor-pointer p-0 hover:text-[#ff9a9a]">
              删除
            </button>
          )}
        </div>
      </div>
    </div>
  );

  const replyBoxFor = (id) => (replyingTo?.targetId === id ? (
    <div className="ml-7 mt-1.5">
      <Box value={replyText} onChange={setReplyText} onSubmit={submitReply} onCancel={() => setReplyingTo(null)}
        placeholder={`回复 @${replyingTo.replyToName}…`} label="回复" busy={posting} autoFocus />
    </div>
  ) : null);

  return (
    <div className="flex flex-col h-full min-h-0 font-sans">
      <div className="shrink-0 px-3 pt-3 pb-3 border-b border-[#00000040]">
        {me ? (
          <Box value={text} onChange={setText} onSubmit={submit}
            placeholder="说说你对这篇论文的看法…" label="评论" busy={posting} />
        ) : (
          <button onClick={onLogin}
            className="w-full text-left text-[12.5px] text-[#b8b8b8] rounded-lg bg-[#00000040] border border-[#ffffff26]
                       px-3 py-2 cursor-pointer hover:border-[#ffffff59]">
            登录 ResearchHub 后参与讨论
          </button>
        )}
        {err && <div className="mt-2 text-[11.5px] text-[#ff9a9a]">{err}</div>}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain thin-scrollbar px-3 py-2">
        {comments === null ? (
          <div className="text-[#9a9a9a] text-[12px] text-center py-4">加载中…</div>
        ) : comments === false ? (
          <div className="text-[#9a9a9a] text-[12px] text-center py-4 leading-relaxed">
            {HAS_BACKEND ? (
              <>
                评论加载不出来（网络或服务器问题）。
                <button onClick={() => { setComments(null); load(); }}
                  className="text-[#7ec8e3] bg-transparent border-none cursor-pointer underline p-0 ml-1">重试</button>
              </>
            ) : "这个版本构建时没有配置评论服务（.env.local 里的 Supabase），评论用不了；笔记标注不受影响，存在本机。"}
          </div>
        ) : (
          <>
            {roots.length > 0 && (
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11.5px] text-[#c8c8c8] font-semibold">{roots.length} 条评论</span>
                <button onClick={() => setSort(s => (s === "newest" ? "oldest" : "newest"))}
                  className="px-1.5 py-0.5 rounded text-[11px] text-[#b8b8b8] bg-transparent border-none cursor-pointer hover:bg-[#ffffff14]">
                  {sort === "newest" ? "↓ 最新" : "↑ 最早"}
                </button>
              </div>
            )}
            {roots.length === 0 && (
              <div className="text-[#9a9a9a] text-[12px] text-center py-4">还没有人评论这篇论文，来说第一句吧</div>
            )}
            {roots.map(root => (
              <div key={root.id} className="pb-2 mb-2 border-b border-[#ffffff14] last:border-b-0">
                {item(root, { isReply: false, root: null })}
                {replyBoxFor(root.id)}
                {repliesOf(root.id).map(r => (
                  <div key={r.id} className="ml-7">
                    {item(r, { isReply: true, root })}
                    {replyBoxFor(r.id)}
                  </div>
                ))}
                {/* 被回复的那条已经被删了 → 框别弄丢，兜底挂在整串末尾 */}
                {replyingTo?.rootId === root.id && !list.some(c => c.id === replyingTo.targetId)
                  && replyBoxFor(replyingTo.targetId)}
              </div>
            ))}
          </>
        )}
        {sitePaperUrl && (
          <a href={sitePaperUrl} target="_blank" rel="noopener noreferrer"
            className="block text-center text-[11px] text-[#8a8a8a] hover:text-[#7ec8e3] no-underline py-3">
            在 ResearchHub 论文页查看站内讨论 ↗
          </a>
        )}
      </div>

      {confirmDel && (
        <div className="absolute inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in"
          onClick={e => { if (e.target === e.currentTarget) setConfirmDel(null); }}>
          <div className="w-full max-w-[300px] rounded-xl bg-[#323639] border border-[#ffffff26] p-4">
            <div className="text-[13.5px] text-[#fff] font-bold mb-1.5">删除这条评论？</div>
            <div className="text-[12px] text-[#b8b8b8] leading-relaxed mb-3">底下的回复会跟着一起删掉，删除后无法恢复。</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDel(null)}
                className="h-8 px-3 rounded-full text-[12.5px] text-[#c8c8c8] bg-transparent border border-[#ffffff33] cursor-pointer hover:bg-[#ffffff1a]">取消</button>
              <button onClick={doDelete}
                className="h-8 px-4 rounded-full text-[12.5px] text-[#fff] bg-[#c0392b] border-none cursor-pointer hover:bg-[#a93226]">删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 输入框：Ctrl/⌘+Enter 发送，Esc 取消 */
function Box({ value, onChange, onSubmit, onCancel, placeholder, label, busy, autoFocus }) {
  const ref = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <div>
      <textarea ref={ref} value={value} rows={value ? 3 : 2} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
          if (e.key === "Escape") onCancel?.();
        }}
        className="w-full resize-none rounded-lg bg-[#00000059] border border-[#ffffff33] px-2.5 py-2
                   text-[12.5px] text-[#fff] outline-none placeholder:text-[#ffffff59] focus:border-[#ffffff80]" />
      <div className="flex items-center justify-end gap-2 mt-1.5">
        <span className="flex-1 text-[10.5px] text-[#6f6f6f]">Ctrl+Enter 发送</span>
        {onCancel && (
          <button onClick={onCancel}
            className="h-7 px-3 rounded-full text-[12px] text-[#c8c8c8] bg-transparent border border-[#ffffff33] cursor-pointer hover:bg-[#ffffff1a]">
            取消
          </button>
        )}
        <button onClick={onSubmit} disabled={busy || !value.trim()}
          className="h-7 px-3.5 rounded-full text-[12px] font-bold text-[#10232c] bg-[#7ec8e3] border-none cursor-pointer
                     hover:bg-[#9ad5ea] disabled:opacity-40 disabled:cursor-default">
          {busy ? "发送中…" : label}
        </button>
      </div>
    </div>
  );
}

