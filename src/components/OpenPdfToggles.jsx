import { useEffect, useState } from "react";
import { useSettings, setSettings } from "../lib/settings";

/**
 * 「在线 PDF / 本地 PDF 用笔记阅读器」两个开关（设置 → 阅读，和插件图标弹出的菜单共用）。
 * - 在线：arXiv 不用额外权限；其他网站的 PDF 要「访问所有网站」的可选权限（background 按响应头认 PDF，没权限时那个事件根本不触发）。
 *   打开开关时顺手申请；没给就只接管 arXiv，说明里给一个「授权其他网站」
 * - 本地：要在扩展详情里打开「允许访问文件网址」，没开时说明里提示
 * 权限申请必须在点击里**同步**发起（先 await 别的会丢掉用户手势），所以先 request 再写设置
 */
const ALL_SITES = { origins: ["https://*/*", "http://*/*"] };

export default function OpenPdfToggles({ Switch, compact = false }) {
  const s = useSettings();
  const [allSites, setAllSites] = useState(true);
  const [fileAccess, setFileAccess] = useState(true);
  useEffect(() => {
    const check = () => chrome.permissions.contains(ALL_SITES).then(setAllSites).catch(() => {});
    check();
    chrome.extension?.isAllowedFileSchemeAccess?.(setFileAccess);
    chrome.permissions.onAdded.addListener(check);
    chrome.permissions.onRemoved.addListener(check);
    return () => { chrome.permissions.onAdded.removeListener(check); chrome.permissions.onRemoved.removeListener(check); };
  }, []);

  const grant = () => chrome.permissions.request(ALL_SITES).catch(() => false);
  const toggleOnline = () => {
    if (!s.interceptOnline && !allSites) grant();
    setSettings({ interceptOnline: !s.interceptOnline });
  };
  const openExt = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  const link = "p-0 bg-transparent border-none cursor-pointer text-[#7ec8e3] underline text-[11.5px] font-sans";

  const onlineHint = !s.interceptOnline ? null : allSites ? "arXiv 和其他网站的 PDF" : (
    <>只接管 arXiv · <button onClick={grant} className={link}>授权其他网站</button></>
  );
  const localHint = !s.interceptLocal || fileAccess ? null : (
    <>要在<button onClick={openExt} className={`${link} mx-0.5`}>扩展详情</button>里打开「允许访问文件网址」</>
  );
  const row = (title, hint, on, onClick) => (
    <div className={`flex items-center gap-3 ${compact ? "py-1" : "py-2.5"}`}>
      <div className="flex-1 min-w-0">
        <div className={compact ? "text-[12.5px]" : "text-[13px] text-[#f2f2f2]"}>{title}</div>
        {hint && <div className="text-[11.5px] text-[#9a9a9a] leading-snug mt-0.5">{hint}</div>}
      </div>
      <Switch on={on} onClick={onClick} />
    </div>
  );
  return (
    <>
      {row("在线 PDF 用笔记阅读器", onlineHint, s.interceptOnline, toggleOnline)}
      {row("本地 PDF 用笔记阅读器", localHint, s.interceptLocal, () => setSettings({ interceptLocal: !s.interceptLocal }))}
    </>
  );
}
