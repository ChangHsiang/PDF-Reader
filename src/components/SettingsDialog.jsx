import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSettings, setSettings, PAPERS } from "../lib/settings";
import { viaCustom, LANGS } from "../lib/translate";

/**
 * 阅读器顶栏「设置」：阅读 + 翻译两组。
 * 自定义翻译接口：任何兼容 OpenAI chat/completions 的服务都行。保存时向浏览器申请访问那个网站的权限
 * （manifest 里是 optional_host_permissions，用到哪个才申请哪个，不在安装时就要「所有网站」）。
 */

const Switch = ({ on, onClick }) => (
  <button onClick={onClick} role="switch" aria-checked={on}
    className={`relative w-9 h-5 rounded-full border-none cursor-pointer transition-colors shrink-0 ${on ? "bg-[#7ec8e3]" : "bg-[#ffffff33]"}`}>
    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-[#fff] transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
  </button>
);

/**
 * 下拉选择（自己画的，和阅读器的深色界面一致）。菜单挂到 body 上用 fixed 定位：
 * 设置框本身能滚动（overflow），菜单放在里面会被裁掉。点外面 / Esc 收起
 */
function Dropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(null);           // null | 按钮的位置
  const btnRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!e.target.closest?.(".rh-dd-menu") && !btnRef.current?.contains(e.target)) setOpen(null); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(null); } };
    const onScroll = (e) => { if (!e.target.closest?.(".rh-dd-menu")) setOpen(null); };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);
  const cur = options.find(o => o[0] === value) || options[0];
  const toggle = () => {
    if (open) { setOpen(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    const h = Math.min(options.length * 30 + 8, 320);
    // 下面放不下就往上开
    setOpen({ left: r.left, width: Math.max(r.width, 170), top: r.bottom + h + 4 > window.innerHeight ? r.top - h - 4 : r.bottom + 4, h });
  };
  return (
    <>
      <button ref={btnRef} onClick={toggle}
        className={`h-8 min-w-[170px] pl-3 pr-2 rounded-md flex items-center gap-2 text-[12.5px] font-sans cursor-pointer
          bg-[#00000059] text-[#f2f2f2] hover:border-[#ffffff66] ${open ? "border-[#ffffff80]" : "border-[#ffffff33]"}`}
        style={{ borderWidth: 1, borderStyle: "solid" }}>
        <span className="flex-1 text-left whitespace-nowrap">{cur[1]}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" className={`shrink-0 text-[#b8b8b8] transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && createPortal(
        <div className="rh-dd-menu fixed z-[210] rounded-lg bg-[#3b3f42] border border-[#ffffff26] shadow-[0_8px_24px_rgba(0,0,0,0.45)]
                        p-1 overflow-y-auto thin-scrollbar font-sans"
          style={{ left: open.left, top: open.top, width: open.width, maxHeight: open.h }}>
          {options.map(([v, label]) => (
            <button key={v} onClick={() => { onChange(v); setOpen(null); }}
              className={`w-full h-[30px] px-2.5 rounded-md flex items-center gap-2 text-[12.5px] text-left border-none cursor-pointer
                ${v === value ? "bg-[#ffffff1f] text-[#fff]" : "bg-transparent text-[#d8d8d8] hover:bg-[#ffffff14]"}`}>
              <span className="w-3 shrink-0 text-[#7ec8e3]">{v === value ? "✓" : ""}</span>
              <span className="whitespace-nowrap">{label}</span>
            </button>
          ))}
        </div>,
        document.body)}
    </>
  );
}

const Row = ({ title, desc, children }) => (
  <div className="flex items-center gap-3 py-2.5">
    <div className="flex-1 min-w-0">
      <div className="text-[13px] text-[#f2f2f2]">{title}</div>
      {desc && <div className="text-[11.5px] text-[#9a9a9a] leading-snug mt-0.5">{desc}</div>}
    </div>
    {children}
  </div>
);

export default function SettingsDialog({ onClose }) {
  const s = useSettings();
  const [api, setApi] = useState(s.customApi);
  const [test, setTest] = useState(null);         // null | "busy" | { ok, msg }
  const [saved, setSaved] = useState(false);
  useEffect(() => { setApi(s.customApi); }, [s.customApi]);

  useEffect(() => {
    // 下拉菜单开着时 Esc 只收起菜单（菜单自己处理）
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".rh-dd-menu")) { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** 申请访问自定义接口所在网站的权限。必须在点击事件里调（浏览器要求用户手势） */
  const grant = async () => {
    let origin;
    try { origin = new URL(api.baseUrl.trim()).origin; } catch { throw new Error("接口地址不是一个有效的网址"); }
    const ok = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!ok) throw new Error("没有授权访问这个网站，插件调不了这个接口");
  };

  const saveApi = async () => {
    try {
      await grant();
      await setSettings({ customApi: { baseUrl: api.baseUrl.trim(), apiKey: api.apiKey.trim(), model: api.model.trim() } });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) { setTest({ ok: false, msg: e.message }); }
  };

  const runTest = async () => {
    setTest("busy");
    try {
      await grant();
      const r = await viaCustom("Primordial black holes could have formed in the early universe.", "zh",
        { baseUrl: api.baseUrl.trim(), apiKey: api.apiKey.trim(), model: api.model.trim() });
      setTest({ ok: true, msg: r.text });
    } catch (e) { setTest({ ok: false, msg: e.message }); }
  };

  const field = "w-full h-8 px-2.5 rounded-md bg-[#00000059] border border-[#ffffff33] text-[12.5px] text-[#fff] font-sans " +
                "outline-none placeholder:text-[#ffffff4d] focus:border-[#ffffff80]";
  const btn = "h-8 px-3.5 rounded-full text-[12.5px] font-sans border-none cursor-pointer whitespace-nowrap";

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-4 animate-fade-in font-sans"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[480px] max-h-[90vh] overflow-y-auto thin-scrollbar rounded-xl bg-[#323639]
                      border border-[#ffffff26] shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
        <div className="relative h-12 flex items-center justify-center border-b border-[#00000040]">
          <span className="text-[14.5px] text-[#fff] font-bold">设置</span>
          <button onClick={onClose} title="关闭（Esc）"
            className="absolute right-2 w-8 h-8 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[#c8c8c8] hover:bg-[#ffffff1a]">
            ✕
          </button>
        </div>

        <div className="px-5 py-2">
          <div className="text-[11.5px] text-[#7ec8e3] font-bold pt-2">阅读</div>
          <Row title="打开 arXiv PDF 时用笔记阅读器" desc="关掉后 arXiv 的 PDF 用浏览器自带的阅读器打开">
            <Switch on={s.intercept} onClick={() => setSettings({ intercept: !s.intercept })} />
          </Row>
          <div className="py-2.5">
            <div className="text-[13px] text-[#f2f2f2]">页面颜色</div>
            <div className="text-[11.5px] text-[#9a9a9a] leading-snug mt-0.5 mb-2">护眼：把 PDF 的白底换成别的颜色，文字和标注不受影响。夜间模式下图片的颜色会反过来</div>
            <div className="flex gap-2">
              {PAPERS.map(p => (
                <button key={p.key} onClick={() => setSettings({ paper: p.key })} title={p.label}
                  className="flex flex-col items-center gap-1 bg-transparent border-none cursor-pointer p-0 group">
                  <span className="w-9 h-9 rounded-md flex items-center justify-center text-[13px] font-serif"
                    style={{ background: p.swatch, color: p.key === "dark" ? "#d8d8d8" : "#222",
                             boxShadow: (s.paper || "white") === p.key ? "0 0 0 2px #323639, 0 0 0 4px #7ec8e3" : "inset 0 0 0 1px #ffffff33" }}>
                    Aa
                  </span>
                  <span className={`text-[11px] ${(s.paper || "white") === p.key ? "text-[#fff]" : "text-[#9a9a9a] group-hover:text-[#d0d0d0]"}`}>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
          <Row title="公式旁显示「复制 LaTeX」按钮" desc="带编号的公式左边一颗小按钮，复制的是 arXiv 源码里的 LaTeX（作者自定义的宏已展开）">
            <Switch on={s.eqCopy} onClick={() => setSettings({ eqCopy: !s.eqCopy })} />
          </Row>
          <Row title="标出所有链接" desc="有的论文只给文献引用上色，公式 / 图 / 章节的引用看不出是链接。打开后所有链接下面画一道淡色虚线">
            <Switch on={s.showLinks} onClick={() => setSettings({ showLinks: !s.showLinks })} />
          </Row>

          <div className="text-[11.5px] text-[#7ec8e3] font-bold pt-3 border-t border-[#ffffff14] mt-1">翻译</div>
          <Row title="选中文字后直接翻译" desc="不用再点工具条上的「翻译」，选完就在下面弹出译文">
            <Switch on={s.autoTranslate} onClick={() => setSettings({ autoTranslate: !s.autoTranslate })} />
          </Row>
          <Row title="译成">
            <Dropdown value={s.translateTarget} onChange={v => setSettings({ translateTarget: v })}
              options={LANGS.map(l => [l.code, l.label])} />
          </Row>
          <div className="pb-2">
            <Row title="翻译服务">
              <Dropdown value={s.translateEngine} onChange={v => setSettings({ translateEngine: v })}
                options={[["google", "Google 翻译"], ["bing", "必应翻译"], ["custom", "自定义 API"]]} />
            </Row>
            <div className="text-[11.5px] text-[#9a9a9a] leading-snug -mt-1">
              {s.translateEngine === "google" && "Google 翻译的公开接口，不用配置。"}
              {s.translateEngine === "bing" && "必应翻译的网页接口，不用配置。"}
              {s.translateEngine === "custom" && "兼容 OpenAI 接口格式的服务都可以：DeepSeek、OpenAI、通义千问、Kimi、本地部署的模型等。Key 只保存在这台电脑的浏览器里。"}
            </div>
          </div>

          {s.translateEngine === "custom" && (
            <div className="flex flex-col gap-2 pb-3">
              <label className="text-[12px] text-[#c8c8c8]">接口地址
                <input className={`${field} mt-1`} placeholder="https://api.deepseek.com/v1"
                  value={api.baseUrl} onChange={e => setApi({ ...api, baseUrl: e.target.value })} />
              </label>
              <label className="text-[12px] text-[#c8c8c8]">API Key
                <input className={`${field} mt-1`} type="password" placeholder="sk-…" autoComplete="off"
                  value={api.apiKey} onChange={e => setApi({ ...api, apiKey: e.target.value })} />
              </label>
              <label className="text-[12px] text-[#c8c8c8]">模型
                <input className={`${field} mt-1`} placeholder="deepseek-chat"
                  value={api.model} onChange={e => setApi({ ...api, model: e.target.value })} />
              </label>
              <div className="flex items-center gap-2 mt-1">
                <span className="flex-1" />
                <button onClick={runTest} disabled={test === "busy"}
                  className={`${btn} text-[#c8c8c8] bg-transparent border border-[#ffffff33] hover:bg-[#ffffff1a] disabled:opacity-50`}
                  style={{ border: "1px solid #ffffff33" }}>
                  {test === "busy" ? "测试中…" : "测试"}
                </button>
                <button onClick={saveApi} className={`${btn} font-bold text-[#10232c] bg-[#7ec8e3] hover:bg-[#9ad5ea]`}>
                  {saved ? "✓ 已保存" : "保存"}
                </button>
              </div>
              {test && test !== "busy" && (
                <div className={`text-[12px] leading-relaxed rounded-md px-2.5 py-2 ${test.ok ? "text-[#7ee3a0] bg-[#7ee3a014]" : "text-[#ff9a9a] bg-[#ff9a9a14]"}`}>
                  {test.ok ? `可以用：${test.msg}` : test.msg}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
