import { useState } from "react";
import { MonitorPage } from "./pages/MonitorPage";
import { FrameworkPage } from "./pages/FrameworkPage";
import { SettingsPage } from "./pages/SettingsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { tokens } from "./ui/basics";

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
    <div style={{ minHeight: "100vh", background: tokens.bg, color: tokens.text, fontFamily: '"Microsoft YaHei", system-ui, sans-serif' }}>
      <nav
        style={{
          display: "flex",
          gap: 4,
          padding: "8px 20px",
          background: tokens.panel,
          borderBottom: `1px solid ${tokens.border}`,
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ fontWeight: 700, marginRight: 24, fontSize: 15 }}>AI 盯播工具</div>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "6px 14px",
              fontSize: 13,
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              background: tab === t.key ? tokens.accentSoft : "transparent",
              color: tab === t.key ? tokens.accent : tokens.textDim,
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 12, color: tokens.textDim, alignSelf: "center" }}>
          MVP · 本地运行 · 数据不出本机
        </div>
      </nav>
      <main style={{ padding: "16px 0 40px" }}>
        {tab === "monitor" ? (
          <MonitorPage key={monitorResetKey} onOpenHistory={() => { setMonitorResetKey((k) => k + 1); setTab("history"); }} />
        ) : tab === "framework" ? (
          <FrameworkPage />
        ) : tab === "settings" ? (
          <SettingsPage />
        ) : (
          <HistoryPage />
        )}
      </main>
    </div>
  );
}
