import { useState } from "react";
import { MonitorPage } from "./pages/MonitorPage";
import { FrameworkPage } from "./pages/FrameworkPage";
import { SettingsPage } from "./pages/SettingsPage";
import { HistoryPage } from "./pages/HistoryPage";

type Tab = "monitor" | "framework" | "settings" | "history";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "monitor", label: "实时监控" },
  { key: "framework", label: "话术配置" },
  { key: "settings", label: "分析设置" },
  { key: "history", label: "历史与报告" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("monitor");
  const [monitorResetKey, setMonitorResetKey] = useState(0);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">AI 盯播工具</div>
            <div className="brand-sub">直播话术实时质检</div>
          </div>
        </div>
        <div className="nav-list">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`nav-item${tab === t.key ? " active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              <span className="nav-dot" />
              {t.label}
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          MVP · 本地运行
          <br />
          数据不出本机
        </div>
      </nav>
      <main className="content">
        <div className="content-inner stack">
          {tab === "monitor" ? (
            <MonitorPage key={monitorResetKey} onOpenHistory={() => { setMonitorResetKey((k) => k + 1); setTab("history"); }} />
          ) : tab === "framework" ? (
            <FrameworkPage />
          ) : tab === "settings" ? (
            <SettingsPage />
          ) : (
            <HistoryPage />
          )}
        </div>
      </main>
    </div>
  );
}
