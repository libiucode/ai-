#!/usr/bin/env node
/**
 * 设备故障 UI 分流验收（真实路径版）。
 *
 * 不用"直接改 React state"这种假验证——而是让采集侧的真实健康检查真的触发：
 *   1. 桩掉 getDisplayMedia，返回一条**真实**音轨（AudioContext destination 产出）
 *   2. 点「监听系统声音」→ 真实走 wireStream + 真实健康检查定时器
 *   3. 停掉音轨 → readyState 变 "ended" → 采集侧 L1 判据命中 → 调 onDeviceLost
 *   4. 断言 UI：故障提示出现 / 无声告警不同屏 / 下拉高亮 / 会话转为已暂停
 *
 * 用法： npm run verify:device-fault
 */
if (process.type !== "browser") {
  if (!process.versions.electron) { console.error("[device-fault] 请用 electron 运行"); process.exit(1); }
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
  "session.start": { sessionId: "devfault-test-1234", error: null },
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
  await win.loadFile(path.join(ASAR, "dist/renderer/index.html"));
  await sleep(1800);
  const ev = async (expr) => win.webContents.executeJavaScript(expr, true);

  // ---- 注入真实音轨 + 桩掉 getDisplayMedia ----
  await ev(`
    (() => {
      window.__testTrack = null;
      const realGetDisplayMedia = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async () => {
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        // 真实音轨（不是 mock 对象），readyState 由 Chromium 维护
        const track = dest.stream.getAudioTracks()[0];
        window.__testTrack = track;
        window.__testCtx = ctx;
        return dest.stream;
      };
      return true;
    })()
  `);

  // ---- 点「监听系统声音」，走真实采集路径 ----
  await ev(`Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("监听系统声音"))?.click()`);
  await sleep(2500);

  console.log("[A] 采集已建立（真实音轨）");
  console.log("    TRACK_STATE=", await ev(`window.__testTrack?.readyState ?? "none"`));
  console.log("    SESSION_STATE_BADGE=", JSON.stringify(await ev(`document.querySelector(".state-badge")?.textContent.trim() ?? null`)));
  console.log("    FAULT_BEFORE=", await ev(`document.body.innerText.includes("音频设备已失效")`));

  // ---- 停掉音轨，模拟"设备被拔/被切走" ----
  await ev(`window.__testTrack?.stop(); true`);
  console.log("[B] 已停止音轨（模拟设备消失）");
  console.log("    TRACK_STATE=", await ev(`window.__testTrack?.readyState ?? "none"`));

  // 健康检查 2 秒一轮，留足时间
  await sleep(6000);

  const faultShown = await ev(`document.body.innerText.includes("音频设备已失效")`);
  const silenceShown = await ev(`document.body.innerText.includes("没有检测到输入声音")`);
  const callout = await ev(`document.querySelector(".callout-danger")?.innerText ?? ""`);
  const selectFault = await ev(`!!document.querySelector(".select-fault")`);
  const badge = await ev(`document.querySelector(".state-badge")?.textContent.trim() ?? null`);
  const buttons = await ev(`Array.from(document.querySelectorAll("button")).map(b=>b.textContent.trim())`);
  const faultCode = await ev(`(document.body.innerText.match(/\\[CAPTURE_DEVICE_LOST\\]/) || [null])[0]`);

  console.log("[C] 断言（设备故障 UI 分流）");
  console.log("    FAULT_CALLOUT_SHOWN=", faultShown);
  console.log("    FAULT_CODE_SHOWN=", JSON.stringify(faultCode));
  console.log("    SILENCE_WARNING_SHOWN=", silenceShown, "(应为 false：设备故障优先，抑制无声告警)");
  console.log("    DEVICE_SELECT_HIGHLIGHTED=", selectFault);
  console.log("    SESSION_BADGE=", JSON.stringify(badge), "(应为 已暂停：会话保留不中断)");
  console.log("    BUTTONS=", JSON.stringify(buttons));
  console.log("    CALLOUT_TEXT=", JSON.stringify(callout.slice(0, 260)));
  console.log("    MENTIONS_RESELECT=", callout.includes("重新选择设备"));
  console.log("    WRONGLY_MENTIONS_VOLUME=", /音量过低|麦克风是否被静音/.test(callout), "(应为 false：那是内容静音的说法)");

  console.log("DONE");
  app.exit(0);
}).catch((e) => { console.log("FAILED:", e.message); console.log(e.stack); app.exit(1); });
