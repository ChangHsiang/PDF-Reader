import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSettings, setSettings, PAPERS } from "../lib/settings";
import { viaCustom, LANGS } from "../lib/translate";
import { useUpdate, openTab, openExtensionsPage } from "../lib/update";
import { exportBackup, importBackup, currentStats } from "../lib/backup";
import { GOOGLE_CLIENT_ID } from "../lib/config";
import OpenPdfToggles from "./OpenPdfToggles";
import { DeleteButton } from "./PdfNotes";
import { t, rememberLang } from "../lib/i18n";

/**
 * 阅读器顶栏「设置」：阅读 + 翻译两组。
 * 自定义翻译接口：任何兼容 OpenAI chat/completions 的服务都行。保存时向浏览器申请访问那个网站的权限
 * （manifest 里是 optional_host_permissions，用到哪个才申请哪个，不在安装时就要「所有网站」）。
 */

const TABS = [["read", t("阅读")], ["trans", t("翻译")], ["sync", t("同步")], ["data", t("数据")], ["about", t("版本")]];

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
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".rh-dd-menu, .rh-restore-dlg")) { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** 申请访问自定义接口所在网站的权限。必须在点击事件里调（浏览器要求用户手势） */
  const grant = async () => {
    let origin;
    try { origin = new URL(api.baseUrl.trim()).origin; } catch { throw new Error(t("接口地址不是一个有效的网址")); }
    const ok = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!ok) throw new Error(t("没有授权访问这个网站，插件调不了这个接口"));
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

  const [tab, setTab] = useState(() => {
    try { const v = localStorage.getItem("rh_settings_tab"); if (TABS.some(x => x[0] === v)) return v; } catch { /* 读不了就默认 */ }
    return "read";
  });
  const pickTab = (k) => { setTab(k); try { localStorage.setItem("rh_settings_tab", k); } catch { /* 存不了不要紧 */ } };
  const upd = useUpdate();

  const field = "w-full h-8 px-2.5 rounded-md bg-[#00000059] border border-[#ffffff33] text-[12.5px] text-[#fff] font-sans " +
                "outline-none placeholder:text-[#ffffff4d] focus:border-[#ffffff80]";
  const btn = "h-8 px-3.5 rounded-full text-[12.5px] font-sans border-none cursor-pointer whitespace-nowrap";

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-4 animate-fade-in font-sans"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      {/* 标题栏固定在上面，只有下面的内容滚动 */}
      <div className="w-full max-w-[680px] h-[min(560px,90vh)] flex flex-col overflow-hidden rounded-xl bg-[#323639]
                      border border-[#ffffff26] shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
        <div className="relative h-12 shrink-0 flex items-center justify-center border-b border-[#00000040]">
          <span className="text-[14.5px] text-[#fff] font-bold">{t("设置")}</span>
          <button onClick={onClose} title={t("关闭（Esc）")}
            className="absolute right-2 w-8 h-8 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[#c8c8c8] hover:bg-[#ffffff1a]">
            ✕
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
        {/* 左栏导航，右栏只放当前这一项（一长条往下滚太长了）。记住上次看的是哪一项 */}
        <nav className="w-[132px] shrink-0 p-2 border-r border-[#00000040] flex flex-col gap-0.5">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => pickTab(k)}
              className={`relative h-8 px-3 rounded-md text-left text-[13px] border-none cursor-pointer
                ${tab === k ? "bg-[#7ec8e31f] text-[#7ec8e3] font-bold" : "bg-transparent text-[#d0d0d0] hover:bg-[#ffffff12]"}`}>
              {label}
              {k === "about" && upd.show && <span className="absolute top-1/2 -translate-y-1/2 right-2.5 w-2 h-2 rounded-full bg-[#ff5c5c]" />}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto thin-scrollbar px-5 py-2">
          <div className="text-[14px] text-[#fff] font-bold pt-2 pb-1">{TABS.find(x => x[0] === tab)?.[1]}</div>
          {tab === "read" && (<>
          {/* 界面语言：改了整页刷新（文案在各模块加载时就定了，不做热切换） */}
          <Row title={t("界面语言")}>
            <Dropdown value={s.lang || "auto"} onChange={v => { rememberLang(v); setSettings({ lang: v }).then(() => location.reload()); }}
              options={[["auto", t("跟随浏览器")], ["zh", "中文"], ["en", "English"]]} />   {/* i18n-ignore：语言用自己的名字 */}
          </Row>
          <OpenPdfToggles Switch={Switch} />
          <div className="py-2.5">
            <div className="text-[13px] text-[#f2f2f2]">{t("页面颜色")}</div>
            <div className="text-[11.5px] text-[#9a9a9a] leading-snug mt-0.5 mb-2">{t("把白底换成护眼色")}</div>
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
          <Row title={t("公式旁显示「复制 LaTeX」按钮")} desc={t("仅 arXiv 论文")}>
            <Switch on={s.eqCopy} onClick={() => setSettings({ eqCopy: !s.eqCopy })} />
          </Row>
          <Row title={t("标出所有链接")} desc={t("所有链接加上蓝色下划线")}>
            <Switch on={s.showLinks} onClick={() => setSettings({ showLinks: !s.showLinks })} />
          </Row>

          </>)}
          {tab === "trans" && (<>
          <Row title={t("选中文字后直接翻译")} desc={t("选中后直接弹出译文")}>
            <Switch on={s.autoTranslate} onClick={() => setSettings({ autoTranslate: !s.autoTranslate })} />
          </Row>
          <Row title={t("译成")}>
            <Dropdown value={s.translateTarget} onChange={v => setSettings({ translateTarget: v })}
              options={LANGS.map(l => [l.code, l.label])} />
          </Row>
          <div className="pb-2">
            <Row title={t("翻译服务")}>
              <Dropdown value={s.translateEngine} onChange={v => setSettings({ translateEngine: v })}
                options={[["google", t("Google 翻译")], ["bing", t("必应翻译")], ["custom", t("自定义 API")]]} />
            </Row>
            <div className="text-[11.5px] text-[#9a9a9a] leading-snug -mt-1">
              {s.translateEngine === "google" && t("Google 翻译的公开接口，不用配置。")}
              {s.translateEngine === "bing" && t("必应翻译的网页接口，不用配置。")}
              {s.translateEngine === "custom" && t("兼容 OpenAI 格式的服务（DeepSeek、通义、Kimi 等），Key 只存在本机。")}
            </div>
          </div>

          {s.translateEngine === "custom" && (
            <div className="flex flex-col gap-2 pb-3">
              <label className="text-[12px] text-[#c8c8c8]">{t("接口地址")}
                <input className={`${field} mt-1`} placeholder="https://api.deepseek.com/v1"
                  value={api.baseUrl} onChange={e => setApi({ ...api, baseUrl: e.target.value })} />
              </label>
              <label className="text-[12px] text-[#c8c8c8]">API Key
                <input className={`${field} mt-1`} type="password" placeholder="sk-…" autoComplete="off"
                  value={api.apiKey} onChange={e => setApi({ ...api, apiKey: e.target.value })} />
              </label>
              <label className="text-[12px] text-[#c8c8c8]">{t("模型")}
                <input className={`${field} mt-1`} placeholder="deepseek-chat"
                  value={api.model} onChange={e => setApi({ ...api, model: e.target.value })} />
              </label>
              <div className="flex items-center gap-2 mt-1">
                <span className="flex-1" />
                <button onClick={runTest} disabled={test === "busy"}
                  className={`${btn} text-[#c8c8c8] bg-transparent border border-[#ffffff33] hover:bg-[#ffffff1a] disabled:opacity-50`}
                  style={{ border: "1px solid #ffffff33" }}>
                  {test === "busy" ? t("测试中…") : t("测试")}
                </button>
                <button onClick={saveApi} className={`${btn} font-bold text-[#10232c] bg-[#7ec8e3] hover:bg-[#9ad5ea]`}>
                  {saved ? t("✓ 已保存") : t("保存")}
                </button>
              </div>
              {test && test !== "busy" && (
                <div className={`text-[12px] leading-relaxed rounded-md px-2.5 py-2 ${test.ok ? "text-[#7ee3a0] bg-[#7ee3a014]" : "text-[#ff9a9a] bg-[#ff9a9a14]"}`}>
                  {test.ok ? t("可以用：{msg}", { msg: test.msg }) : test.msg}
                </div>
              )}
            </div>
          )}

          </>)}
          {tab === "sync" && (<>
          <Row title={t("在线论文的笔记")} desc={t("自动：改完就同步；手动：点顶栏的同步按钮")}>
            <Dropdown value={s.syncArxiv || "auto"} onChange={v => setSettings({ syncArxiv: v })}
              options={[["auto", t("自动同步")], ["manual", t("手动同步")]]} />
          </Row>
          <Row title={t("本地文件的笔记")} desc={t("默认手动；只同步笔记，不传 PDF")}>
            <Dropdown value={s.syncLocal || "manual"} onChange={v => setSettings({ syncLocal: v })}
              options={[["auto", t("自动同步")], ["manual", t("手动同步")]]} />
          </Row>

          </>)}
          {tab === "data" && (<>
          <DataSection btn={btn} />

          </>)}
          {tab === "about" && (<>
          <VersionSection btn={btn} />
          </>)}
        </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 设置 → 版本：当前版本、检查更新；有新版本时给下载 / 更新说明 / 忽略此版本，以及升级步骤 */
function VersionSection({ btn }) {
  const u = useUpdate();
  const ghost = `${btn} text-[#c8c8c8] bg-transparent hover:bg-[#ffffff1a]`;
  const date = u.latest?.publishedAt ? new Date(u.latest.publishedAt).toLocaleDateString() : "";
  return (
    <div className="flex flex-col gap-2 pb-3 text-[12.5px] text-[#c8c8c8]">
      <div className="flex items-center gap-2">
        <span className="flex-1">
          {t("当前版本")} <b className="text-[#fff]">v{u.current}</b>
          {u.checking ? <span className="ml-2 text-[#9a9a9a]">{t("正在检查…")}</span>
            : u.error ? <span className="ml-2 text-[#ff9a9a]">{t("检查失败：{err}", { err: u.error })}</span>
            : u.latest && !u.hasNew ? <span className="ml-2 text-[#7ee3a0]">{t("已是最新")}</span> : null}
        </span>
        <button onClick={u.check} disabled={u.checking} className={`${ghost} disabled:opacity-50`} style={{ border: "1px solid #ffffff33" }}>{t("检查更新")}</button>
      </div>
      {u.hasNew && (
        <div className="rounded-md bg-[#7ec8e314] border border-[#7ec8e340] px-3 py-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[#fff] font-bold">
              {t("有新版本 v{v}", { v: u.latest.version })}
              {date && <span className="ml-2 font-normal text-[11.5px] text-[#9a9a9a]">{date}</span>}
              {u.ignored === u.latest.version && <span className="ml-2 font-normal text-[11.5px] text-[#9a9a9a]">{t("（已忽略）")}</span>}
            </span>
          </div>
          {u.latest.notes && (
            <div className="max-h-[140px] overflow-y-auto thin-scrollbar whitespace-pre-wrap text-[12px] leading-relaxed text-[#c8c8c8]">
              {/* 更新说明是 Markdown：标题的 # 去掉、列表的 - 换成圆点、**粗体** 和 `代码` 的记号去掉，纯文字显示 */}
              {u.latest.notes.replace(/\r/g, "").replace(/^#+\s*/gm, "").replace(/^(\s*)[-*]\s+/gm, "$1• ")
                .replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1")}
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={() => openTab(u.latest.zip)} className={`${btn} font-bold text-[#10232c] bg-[#7ec8e3] hover:bg-[#9ad5ea]`}>{t("下载")}</button>
            <button onClick={() => openTab(u.latest.url)} className={ghost} style={{ border: "1px solid #ffffff33" }}>{t("更新说明")}</button>
            <span className="flex-1" />
            {u.ignored === u.latest.version
              ? <button onClick={u.unignore} className={ghost}>{t("取消忽略")}</button>
              : <button onClick={u.ignore} className={ghost}>{t("忽略此版本")}</button>}
          </div>
          <div className="text-[11.5px] leading-relaxed text-[#9a9a9a]">
            {t("升级：解压后覆盖原来的文件夹，再到")}
            <button onClick={openExtensionsPage} className="mx-1 p-0 bg-transparent border-none cursor-pointer text-[#7ec8e3] underline text-[11.5px]">{t("扩展管理页")}</button>
            {t("点刷新。")}<b className="text-[#ffb36b] font-bold">{t("不要点「移除」")}</b>{t("，会删掉所有笔记。")}
          </div>
        </div>
      )}
    </div>
  );
}

/** 设置 → 数据：本机存了多少、导出备份 / 导入备份（lib/backup）。提醒一句「移除插件会删掉笔记」 */
function DataSection({ btn }) {
  const [st, setSt] = useState(null);
  const [msg, setMsg] = useState(null);         // { ok, text }
  const fileRef = useRef(null);
  const refresh = () => currentStats().then(setSt).catch(() => {});
  useEffect(() => { refresh(); }, []);
  const ghost = `${btn} text-[#c8c8c8] bg-transparent hover:bg-[#ffffff1a]`;
  const doExport = async () => {
    try { const s = await exportBackup(); setMsg({ ok: true, text: t("已导出：{p} 篇论文、{a} 条标注（文件在浏览器的下载文件夹里）", { p: s.papers, a: s.anns }) }); }
    catch (e) { setMsg({ ok: false, text: t("导出失败：{err}", { err: e.message }) }); }
  };
  const doImport = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try { await importBackup(f); await refresh(); setMsg({ ok: true, text: t("已导入（和现有的笔记合并，同一条留较新的）") }); }
    catch (err) { setMsg({ ok: false, text: err.message }); }
  };
  return (
    <div className="flex flex-col gap-2 pb-3 text-[12.5px] text-[#c8c8c8]">
      <div className="flex items-center gap-2">
        <span className="flex-1">
          {t("本机存着")} <b className="text-[#fff]">{st ? t("{p} 篇论文、{a} 条标注", { p: st.papers, a: st.anns }) : "…"}</b>
        </span>
        <button onClick={doExport} className={ghost} style={{ border: "1px solid #ffffff33" }}>{t("导出备份")}</button>
        <button onClick={() => fileRef.current?.click()} className={ghost} style={{ border: "1px solid #ffffff33" }}>{t("导入备份")}</button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={doImport} />
      </div>
      <div className="text-[11.5px] leading-relaxed text-[#9a9a9a]">
        {t("笔记存在这个浏览器里，")}<b className="text-[#ffb36b] font-bold">{t("「移除」插件会全部删掉")}</b>{t("。重装、换电脑前先导出备份。")}
      </div>
      {msg && (
        <div className={`text-[12px] leading-relaxed rounded-md px-2.5 py-2 ${msg.ok ? "text-[#7ee3a0] bg-[#7ee3a014]" : "text-[#ff9a9a] bg-[#ff9a9a14]"}`}>
          {msg.text}
        </div>
      )}
      {GOOGLE_CLIENT_ID && <DriveBackup btn={btn} onRestored={refresh} />}
    </div>
  );
}

/**
 * 设置 → 数据 → 备份到 Google 云端硬盘（lib/gdrive，活都在 background 里干）。
 * 状态在 chrome.storage.local 的 gdrive 键里，这里只读它、发消息
 */
function DriveBackup({ btn, onRestored }) {
  const [g, setG] = useState(null);
  const [busy, setBusy] = useState("");          // "" | connect | backup | list | <备份 id>
  const [msg, setMsg] = useState(null);
  const [items, setItems] = useState(null);       // 云端的备份（快照）列表
  const [pick, setPick] = useState(null);         // 点了「恢复」的那份：弹窗里选替换 / 合并
  useEffect(() => {
    chrome.storage.local.get("gdrive").then(r => setG(r.gdrive || null));
    const fn = (c, area) => { if (area === "local" && "gdrive" in c) setG(c.gdrive.newValue || null); };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);
  const send = (type, extra) => chrome.runtime.sendMessage({ type, ...extra });
  const ghost = `${btn} text-[#c8c8c8] bg-transparent hover:bg-[#ffffff1a] disabled:opacity-50`;
  const small = "h-7 px-2.5 rounded-full text-[11.5px] font-sans border cursor-pointer whitespace-nowrap bg-transparent disabled:opacity-50";
  /* 后台没回话（r 是 undefined）多半是插件更新后后台还是旧的、不认识这个消息：提示去扩展管理页点刷新。
     以前直接读 r.items 抛错，列表就一直停在「正在读取…」（踩过） */
  const fail = (r) => {
    if (r === undefined || r === null) { setMsg({ ok: false, text: t("插件后台没有响应：请到扩展管理页点一下这个插件的刷新按钮") }); return true; }
    if (r.error || r.ok === false) { setMsg({ ok: false, text: r.error || t("失败了") }); return true; }
    return false;
  };
  const loadList = async () => {
    const r = await send("gdrive:list").catch((e) => ({ ok: false, error: e.message }));
    if (fail(r)) { setItems([]); return; }
    setItems(r.items || []);
  };
  const connected = !!g?.email && !g?.needAuth;
  useEffect(() => { if (connected && items === null) loadList(); }, [connected]);   // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setBusy("connect"); setMsg(null);
    const r = await send("gdrive:connect").catch((e) => ({ error: e.message }));
    setBusy("");
    if (fail(r)) return;
    setItems(r.items || []);
    if (r.items?.length) setMsg({ ok: true, text: t("云端有 {n} 份备份，可以在下面选一份恢复", { n: r.items.length }) });
    else send("gdrive:backup");                     // 云端还没有：先备份一份
  };
  const backup = async () => {
    setBusy("backup"); setMsg(null);
    const r = await send("gdrive:backup", { manual: true }).catch((e) => ({ error: e.message }));
    setBusy("");
    if (fail(r)) return;
    setMsg({ ok: true, text: t("已备份：{p} 篇论文、{a} 条标注", { p: r.papers, a: r.anns }) });
    loadList();
  };
  const restore = async (id, mode) => {
    setPick(null); setBusy(id); setMsg(null);
    const r = await send("gdrive:restore", { id, mode }).catch((e) => ({ error: e.message }));
    setBusy("");
    if (fail(r)) return;
    setMsg({ ok: true, text: mode === "replace"
      ? t("已替换成这份备份：现在共 {p} 篇论文、{a} 条标注", { p: r.papers, a: r.anns })
      : t("已合并（同一条留较新的）：现在共 {p} 篇论文、{a} 条标注", { p: r.papers, a: r.anns }) });
    onRestored?.();
  };
  const remove = async (id) => {
    setBusy(id);
    const r = await send("gdrive:delete", { id }).catch((e) => ({ error: e.message }));
    setBusy("");
    if (!fail(r)) setItems(list => (list || []).filter(x => x.id !== id));
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
  const box = "rounded-md border border-[#ffffff1f] bg-[#ffffff08] px-3 py-2.5 flex flex-col gap-2 mt-1";
  if (!g?.email) {
    return (
      <div className={box}>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[#e6e6e6]">{t("备份到 Google 云端硬盘")}</span>
          <button onClick={connect} disabled={!!busy} className={ghost} style={{ border: "1px solid #ffffff33" }}>
            {busy === "connect" ? t("连接中…") : t("连接 Google 账号")}
          </button>
        </div>
        <div className="text-[11.5px] leading-relaxed text-[#9a9a9a]">
          {t("自动备份到你的云端硬盘，换电脑后连上同一账号就能恢复。插件只能访问它自己建的备份文件。")}
        </div>
        {msg && <div className={`text-[12px] ${msg.ok ? "text-[#7ee3a0]" : "text-[#ff9a9a]"}`}>{msg.text}</div>}
      </div>
    );
  }
  return (
    <div className={box}>
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[#e6e6e6]">{t("备份到 Google 云端硬盘")} · <span className="text-[#9a9a9a]">{g.email}</span></span>
        {/* 断开（云端的备份不会删，重新连接就回来）：同删除，点两下 */}
        <UnlinkButton onConfirm={() => { send("gdrive:disconnect"); setItems(null); }} />
      </div>
      {g.needAuth ? (
        <div className="flex items-center gap-2 text-[12px] text-[#ffb36b]">
          <span className="flex-1">{t("Google 授权过期了，自动备份暂停")}</span>
          <button onClick={connect} disabled={!!busy} className={ghost} style={{ border: "1px solid #ffffff33" }}>{t("重新连接")}</button>
        </div>
      ) : (
        <div className="text-[12px] text-[#9a9a9a]">
          {g.lastBackup ? <>{t("上次备份")} {when(g.lastBackup)}{g.lastStats ? t("（{p} 篇、{a} 条）", { p: g.lastStats.papers, a: g.lastStats.anns }) : ""}</> : t("还没有备份过")}
          {g.lastError && <span className="text-[#ff9a9a]"> · {t("上次失败：{err}", { err: g.lastError })}</span>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1 flex items-center gap-2">
          <Switch on={g.auto !== false} onClick={() => send("gdrive:auto", { on: g.auto === false })} />
          <span className="text-[12px]">{t("自动备份（一天一份）")}</span>
        </span>
        <button onClick={backup} disabled={!!busy || g.needAuth} className={ghost} style={{ border: "1px solid #ffffff33" }}>
          {busy === "backup" ? t("备份中…") : t("立即备份")}</button>
      </div>
      {msg && <div className={`text-[12px] leading-relaxed ${msg.ok ? "text-[#7ee3a0]" : "text-[#ff9a9a]"}`}>{msg.text}</div>}

      {pick && <RestoreDialog item={pick} when={when} onCancel={() => setPick(null)} onRestore={(mode) => restore(pick.id, mode)} />}
      {connected && (
        <div className="border-t border-[#ffffff14] pt-2 mt-0.5">
          <div className="text-[11.5px] text-[#9a9a9a] mb-1">{t("云端的备份（只留最近 10 份）")}</div>
          {items === null ? <div className="text-[12px] text-[#8a8a8a] py-1">{t("正在读取…")}</div>
            : !items.length ? <div className="text-[12px] text-[#8a8a8a] py-1">{t("还没有备份")}</div>
            : items.map(f => (
              <div key={f.id} className="py-1.5 border-b border-[#ffffff0d] last:border-b-0">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0 text-[12.5px] text-[#e6e6e6]">
                    {when(f.time)}
                    {f.mine && <span className="ml-1.5 text-[10.5px] px-1.5 py-px rounded bg-[#7ec8e31f] text-[#7ec8e3]">{t("这台电脑")}</span>}
                    <span className="ml-2 text-[11.5px] text-[#8a8a8a]">{t("{p} 篇 · {a} 条", { p: f.papers, a: f.anns })}</span>
                  </div>
                  <button onClick={() => setPick(f)} disabled={!!busy}
                    className={`${small} text-[#c8c8c8] border-[#ffffff33] hover:bg-[#ffffff1a]`}>{busy === f.id ? "…" : t("恢复")}</button>
                  {/* 垃圾桶，同别处的删除：点两下（DeleteButton） */}
                  <DeleteButton onConfirm={() => remove(f.id)} title={t("删除这份备份")} size={28} icon={15} round />
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * 从一份云端备份恢复：选「合并」（默认，不删本机任何东西）或「替换」（本机变成这份，本机独有的会删掉 → 要点两下）。
 * 叠在设置弹窗上面；Esc / 点外面 / 取消 关掉（设置弹窗的 Esc 认 .rh-restore-dlg，不会连带关掉设置）
 */
function RestoreDialog({ item, when, onCancel, onRestore }) {
  const [mode, setMode] = useState("merge");
  const [armed, setArmed] = useState(false);
  useEffect(() => { setArmed(false); }, [mode]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const go = () => {
    if (mode === "replace" && !armed) { setArmed(true); return; }
    onRestore(mode);
  };
  const opts = [
    ["merge", t("合并"), t("把备份里的笔记补进来；同一条两边都有时留较新的。本机的笔记不会删。")],
    ["replace", t("替换"), t("本机变得和这份备份一模一样：本机有、备份里没有的笔记会被删除。")],
  ];
  return createPortal(
    <div className="rh-restore-dlg fixed inset-0 z-[220] bg-black/50 flex items-center justify-center p-4 animate-fade-in font-sans"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-full max-w-[400px] rounded-xl bg-[#323639] border border-[#ffffff26] shadow-[0_16px_48px_rgba(0,0,0,0.5)] p-5">
        <div className="text-[14.5px] text-[#fff] font-bold">{t("从这份备份恢复")}</div>
        <div className="text-[12px] text-[#9a9a9a] mt-1">
          {when(item.time)}{item.mine ? t("（这台电脑）") : ""} · {t("{p} 篇论文、{a} 条标注", { p: item.papers, a: item.anns })}
        </div>
        <div className="flex flex-col gap-2 mt-4">
          {opts.map(([k, label, desc]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`text-left rounded-lg px-3 py-2.5 border cursor-pointer bg-transparent
                ${mode === k ? "border-[#7ec8e3] bg-[#7ec8e314]" : "border-[#ffffff26] hover:bg-[#ffffff0d]"}`}>
              <div className="flex items-center gap-2">
                <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${mode === k ? "border-[#7ec8e3] bg-[#7ec8e3] shadow-[inset_0_0_0_2px_#323639]" : "border-[#ffffff59]"}`} />
                <span className="text-[13px] text-[#f2f2f2] font-bold">{label}</span>
                {k === "merge" && <span className="text-[11px] text-[#9a9a9a]">{t("推荐")}</span>}
              </div>
              <div className={`text-[12px] leading-relaxed mt-1 pl-[22px] ${k === "replace" ? "text-[#ffb36b]" : "text-[#9a9a9a]"}`}>{desc}</div>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel}
            className="h-8 px-4 rounded-full text-[12.5px] text-[#c8c8c8] bg-transparent border border-[#ffffff33] cursor-pointer hover:bg-[#ffffff1a]">{t("取消")}</button>
          <button onClick={go}
            className={`h-8 px-4 rounded-full text-[12.5px] font-bold border-none cursor-pointer
              ${armed ? "text-[#fff] bg-[#d93025] hover:bg-[#b3261e]" : "text-[#10232c] bg-[#7ec8e3] hover:bg-[#9ad5ea]"}`}>
            {mode === "replace" ? (armed ? t("再点一下替换") : t("替换")) : t("合并")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 「断开」：链子图标，点两下（同 PdfNotes 的 DeleteButton：第一下变红、链子两半拉开，3 秒内再点才断开） */
function UnlinkButton({ onConfirm }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const disarmIn = (ms) => { clearTimeout(timer.current); timer.current = setTimeout(() => setArmed(false), ms); };
  const click = () => {
    if (armed) { clearTimeout(timer.current); setArmed(false); onConfirm(); return; }
    setArmed(true);
    disarmIn(3000);
  };
  const label = armed ? t("再点一下断开") : t("断开 Google 账号");
  return (
    <button onClick={click} onMouseLeave={() => { if (armed) disarmIn(800); }} onMouseEnter={() => { if (armed) disarmIn(3000); }}
      title={label} aria-label={label}
      className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center border-none cursor-pointer transition-colors
        ${armed ? "rh-armed bg-[#d93025] text-[#fff] hover:bg-[#b3261e]" : "bg-transparent text-[#c0c0c0] hover:text-[#ff8a8a] hover:bg-[#ff8a8a1f]"}`}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: "visible" }}>
        <path className="rh-link-l" d="M9 17H7a5 5 0 0 1 0-10h2" />
        <path className="rh-link-r" d="M15 7h2a5 5 0 0 1 0 10h-2" />
        <line className="rh-link-mid" x1="8" y1="12" x2="16" y2="12" />
      </svg>
    </button>
  );
}
