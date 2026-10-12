import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const rootEl = document.getElementById("root")!;

if (!window.appApi) {
  // 预加载脚本缺失/失败（如 dist/main/preload 未随构建产出）时给出可见错误，
  // 而不是白屏——阶段5 要求所有异常状态必须可见
  rootEl.innerHTML =
    '<div style="padding:24px;font-family:\'Microsoft YaHei\',system-ui,sans-serif;color:#b91c1c;line-height:1.7">' +
    "<b>预加载脚本加载失败（window.appApi 不存在）。</b><br>" +
    "请确认 dist/main/preload/index.js 已随构建产出（tsconfig.main.json 的 include 需包含 src/preload），" +
    "并查看启动终端中的 Electron 报错。" +
    "</div>";
} else {
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
