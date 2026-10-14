import { useEffect, useState } from "react";
import { readSession } from "./session";

/** 当前登录态，登录 / 退出 / 刷新时自动更新（storage 变化在所有扩展页面间广播）。
    单独一个文件：session.js 也被 background 用，别把 React 带进 service worker */
export function useSession() {
  const [session, setSession] = useState(undefined);   // undefined = 还没读到
  useEffect(() => {
    let alive = true;
    readSession().then(s => { if (alive) setSession(s); });
    const onChange = (changes, area) => {
      if (area === "local" && "auth" in changes) setSession(changes.auth.newValue || null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => { alive = false; chrome.storage.onChanged.removeListener(onChange); };
  }, []);
  return session;
}
