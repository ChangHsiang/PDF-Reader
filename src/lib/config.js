export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
/** 构建时有没有配 Supabase（.env.local）。开源出去别人自己构建、不填的话就是 false：
    笔记照常存本机，只是没有登录同步和论文评论 —— 界面上要说清楚是「没配置」，别说成网络问题 */
export const HAS_BACKEND = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
/** 网站本体：注册、个人主页、论文页都跳过去 */
export const SITE_URL = "https://researchhub-xi.vercel.app";

export const profileUrl = (u) => (u?.username ? `${SITE_URL}/@${u.username}` : null);
/** 站内论文页：`arxiv:2608.19166v1` → `/paper/arxiv/2608.19166v1` */
export const sitePaperUrl = (paperKey) => {
  const m = /^arxiv:(.+)$/.exec(paperKey || "");
  return m ? `${SITE_URL}/paper/arxiv/${m[1]}` : null;
};

export const anonHeaders = () => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
});
