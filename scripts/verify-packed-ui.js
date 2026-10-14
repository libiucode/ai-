#!/usr/bin/env node
/**
 * 打包产物 UI 自检（第二版）：四页 + 定时监听区块 + 契约改名后的导出按钮。
 * 加载 win-unpacked 里真实的 renderer + preload，不加载 dev 源码。
 * 只验 UI 结构与文案；ASR/LLM 因无凭证不工作属预期，不在此断言。
 *
 * 用法： npm run verify:packed-ui
 */
if (process.type !== "browser") {
  if (!process.versions.electron) {
    console.error("[packed-ui] 请用 electron 运行，不要直接 node");
    process.exit(1);
  }
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", __filename], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 1));
  return;
}

const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
app.commandLine.appendSwitch("disable-gpu");

const UNPACKED = path.join(__dirname, "..", "release-verify", "win-unpacked");
const ASAR = path.join(UNPACKED, "resources", "app.asar");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 桩：形状与真实契约一致，用来验证 UI 能正确渲染排期区
const stubs = {
  "framework.list": [{ id: "fw-1", name: "默认话术框架", steps: [], rules: [], productFacts: "", updatedAt: "" }],
  "framework.save": true,
  "settings.get": {
    windowIntervalSec: 60,
    windowSizeSec: 300,
    schedule: {
      enabled: true, startTime: "20:00", endTime: "23:00",
      weekdays: [1, 3], audioSource: "systemLoopback", frameworkId: "fw-1",
    },
  },
  "settings.save": true,
  "settings.getAsrStatus": { configured: false, appId: "", source: "environment" },
  "settings.getLlmStatus": { configured: false, baseUrl: "", model: "", source: "environment" },
  "session.list": {
    sessions: [{
      id: "11112222-3333-4444-5555-666677778888",
      startedAtIso: new Date(Date.now() - 3600e3).toISOString(),
      endedAtIso: new Date().toISOString(),
      audioSource: "systemLoopback",
      status: "stopped",
      finalSegmentCount: 12,
      issueCount: 2,
      hasGap: false,
    }],
    error: null,
  },
  "session.detail": { session: null, segments: [], issues: [], error: null },
  "session.delete": true,
  "report.generate": null,
  "report.export": "",
  "asr.testConnection": { ok: false, error: { code: "NO_ENV", message: "无凭证（预期）", retryable: false } },
  "llm.testConnection": { ok: false, error: { code: "NO_ENV", message: "无凭证（预期）", retryable: false } },
};
for (const [ch, val] of Object.entries(stubs)) ipcMain.handle(ch, () => val);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 950, show: false,
    webPreferences: {
      preload: path.join(ASAR, "dist/main/preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ASAR, "dist/renderer/index.html"));
  await sleep(1800);
  const ev = async (expr) => win.webContents.executeJavaScript(expr, true);

  console.log("[1] 预加载与导航");
  console.log("    PRELOAD_API=", await ev(`typeof window.appApi`));
  console.log("    NAV_COUNT=", await ev(`document.querySelectorAll("nav button").length`));
  console.log("    TABS=", JSON.stringify(await ev(`Array.from(document.querySelectorAll("nav button")).map(b=>b.textContent.trim())`)));

  console.log("[2] 设置页 · 定时监听区块");
  await ev(`document.querySelectorAll("nav button")[2].click()`); await sleep(1700);
  console.log("    PANEL_TITLES=", JSON.stringify(await ev(`Array.from(document.querySelectorAll(".panel-title")).map(e=>e.textContent.trim())`)));
  console.log("    HAS_SCHEDULE_PANEL=", await ev(`document.body.innerText.includes("定时监听")`));
  console.log("    UNWIRED_NOTICE=", await ev(`document.body.innerText.includes("该功能尚未接通")`));
  console.log("    TIME_INPUTS=", await ev(`document.querySelectorAll('input[type="time"]').length`));
  console.log("    WEEKDAY_BUTTONS=", JSON.stringify(await ev(`Array.from(document.querySelectorAll("button")).map(b=>b.textContent.trim()).filter(t=>["周日","周一","周二","周三","周四","周五","周六"].includes(t))`)));
  console.log("    NEXT_START=", JSON.stringify(await ev(`(document.body.innerText.match(/下次自动开始：[^\\n]*/) || [null])[0]`)));
  console.log("    ENABLED_CHECKBOX=", await ev(`document.querySelector('input[type="checkbox"]')?.checked ?? null`));
  console.log("    PASSWORD_INPUTS=", await ev(`Array.from(document.querySelectorAll("input")).filter(i=>i.type==="password").length`));

  console.log("[3] 监控页 · 排期提示与面板");
  await ev(`document.querySelectorAll("nav button")[0].click()`); await sleep(1500);
  console.log("    NEXT_CHIP=", JSON.stringify(await ev(`Array.from(document.querySelectorAll(".chip")).map(e=>e.innerText.replace(/\\n/g," ")).filter(t=>t.includes("下次自动开始"))`)));
  console.log("    UNWIRED_NOTICE=", await ev(`document.body.innerText.includes("自动开始尚未接通")`));
  console.log("    METER=", await ev(`!!document.querySelector(".meter")`));
  console.log("    TRANSCRIPT=", await ev(`!!document.querySelector(".transcript")`));

  console.log("[4] 历史页 · 打开会话 + 导出按钮（契约改名后）");
  await ev(`document.querySelectorAll("nav button")[3].click()`); await sleep(1400);
  // 点开桩会话，导出按钮才会渲染
  await ev(`document.querySelectorAll(".session-item")[0]?.click()`); await sleep(1500);
  console.log("    EXPORT_BUTTONS=", JSON.stringify(await ev(`Array.from(document.querySelectorAll("button")).map(b=>b.textContent.trim()).filter(t=>t.includes("导出"))`)));
  console.log("    VIEW_BAR=", JSON.stringify(await ev(`(document.querySelector(".view-bar")?.innerText ?? "").replace(/\\n/g," ").trim()`)));

  console.log("DONE");
  app.exit(0);
}).catch((e) => { console.log("FAILED:", e.message); app.exit(1); });
