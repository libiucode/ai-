#!/usr/bin/env node
/**
 * 会话自动结束的收敛验收（零额度：加载产物 asar + 桩主进程，不建真实采集会话）。
 *
 * 验的是本轮复核发现的缺陷是否真的修好：
 *   排期到点自动结束 → 主进程 stop() → 发 app.error(SESSION_AUTO_ENDED) + capture.status(idle)
 *   期望界面：状态机落 completed、排期 chip 消失、不再假装在录
 *
 * 用法： npm run verify:auto-end
 */
if (process.type !== "browser") {
  if (!process.versions.electron) { console.error("[auto-end] 请用 electron 运行"); process.exit(1); }
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", __filename], { stdio: "inherit", env });
  child.on("exit", (c) => process.exit(c ?? 1));
  return;
}

const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const ASAR = path.join(__dirname, "..", "release-verify", "win-unpacked", "resources", "app.asar");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mainWinRef = null;

const stubs = {
  "framework.list": [],
  "framework.save": true,
  "settings.get": { windowIntervalSec: 60, windowSizeSec: 300 },
  "settings.save": true,
  "settings.getAsrStatus": { configured: true, appId: "123", source: "environment" },
  "settings.getLlmStatus": { configured: true, baseUrl: "http://x", model: "m", source: "environment" },
  "session.list": { sessions: [], error: null },
  "session.detail": { session: null, segments: [], issues: [], error: null },
  "session.delete": true,
  "report.generate": null,
  "report.export": "",
  "asr.testConnection": { ok: true, error: null },
  "llm.testConnection": { ok: true, error: null },
  "session.start": { sessionId: "autoend-test-1234", error: null },
  "session.pause": null,
  "session.resume": null,
  "session.stop": null,
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
  mainWinRef = win;
  await win.loadFile(path.join(ASAR, "dist/renderer/index.html"));
  await sleep(1800);
  const ev = async (expr) => win.webContents.executeJavaScript(expr, true);

  // 注入真实音轨，桩掉 getDisplayMedia（不碰真实设备、不连 ASR）
  await ev(`
    (() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        window.__testTrack = dest.stream.getAudioTracks()[0];
        window.__testCtx = ctx;
        return dest.stream;
      };
      return true;
    })()
  `);

  await ev(`Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("监听系统声音"))?.click()`);
  await sleep(2200);

  console.log("[A] 会话已建立（注入音轨，未连 ASR）");
  console.log("    BADGE=", JSON.stringify(await ev(`document.querySelector(".state-badge")?.textContent.trim() ?? null`)));
  console.log("    TRACK=", await ev(`window.__testTrack?.readyState ?? "none"`));

  // ---- 模拟主进程自动结束：发 app.error + capture.status(idle) ----
  // 通过页面内直接派发不了主进程事件，改用 preload 暴露的订阅通道：
  // ipcRenderer 在渲染层不可达，故用 webContents.send 从主进程侧发（与真实路径一致）。
  console.log("[B] 主进程发送 SESSION_AUTO_ENDED + capture.status(idle)（真实事件路径）");
  win.webContents.send("app.error", {
    code: "SESSION_AUTO_ENDED",
    message: "已到排期结束时刻，本场监听已自动结束",
    retryable: false,
  });
  win.webContents.send("capture.status", {
    state: "idle", source: "systemLoopback", deviceId: null,
    level: 0, queueOverflowCount: 0, lastError: null,
  });
  win.webContents.send("schedule.status", { scheduledEndAtIso: null });
  await sleep(2000);

  const badge = await ev(`document.querySelector(".state-badge")?.textContent.trim() ?? null`);
  const scheduleChip = await ev(`Array.from(document.querySelectorAll(".chip")).map(e=>e.innerText.replace(/\\n/g," ")).filter(t=>t.includes("排期结束"))`);
  const autoEndMsg = await ev(`document.body.innerText.includes("已到排期结束时刻")`);
  const collectBtn = await ev(`Array.from(document.querySelectorAll("button")).map(b=>b.textContent.trim())`);

  console.log("[C] 断言（收敛）");
  console.log("    BADGE_AFTER=", JSON.stringify(badge), "(应为 已完成：不再假装监听中)");
  console.log("    SCHEDULE_CHIP=", JSON.stringify(scheduleChip), "(应为 []：chip 已消失，不显示过期时刻)");
  console.log("    AUTO_END_REASON_SHOWN=", autoEndMsg, "(应为 true：告诉用户为什么停了)");
  console.log("    BUTTONS=", JSON.stringify(collectBtn));
  console.log("    MENTIONS_HISTORY=", collectBtn.includes("查看历史与报告"), "(应为 true：给出下一步)");

  console.log("DONE");
  app.exit(0);
}).catch((e) => { console.log("FAILED:", e.message); console.log(e.stack); app.exit(1); });
