#!/usr/bin/env node
/**
 * 历史页「结束方式」展示验收（零额度：加载产物 asar + 桩主进程，不连 ASR/LLM）。
 *
 * 验：report.session.endReason 的四种取值 + null（老记录）都能显示成人话。
 * 用法： npm run verify:end-reason
 */
if (process.type !== "browser") {
  if (!process.versions.electron) { console.error("[end-reason] 请用 electron 运行"); process.exit(1); }
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

const ASAR = path.join(__dirname, "..", "release-verify", "win-unpacked", "resources", "app.asar");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 当前被测的 endReason 由命令行决定，默认 user
let currentEndReason = process.argv[2] === "probe" ? process.argv[3] : "user";
const isProbe = process.argv[2] === "probe";

function reportFor(endReason) {
  return {
    session: {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      startedAtIso: new Date(Date.now() - 3600e3).toISOString(),
      endedAtIso: new Date().toISOString(),
      audioSource: "systemLoopback",
      listenedMs: 3600e3,
      endReason,
    },
    asr: { connectionCount: null, disconnectCount: null, gapCount: null },
    issues: { total: 0, bySeverity: {}, byType: {}, confirmed: 0, needsReview: 0 },
    issueTimeline: [],
    metrics: {
      speechMs: 0, silenceMs: 0, chineseChars: 0, englishWords: 0,
      charsPerSpeechMinute: 0, charsPerTotalMinute: 0, longestSilenceMs: 0,
    },
    llm: { requestCount: null, failedCount: null, estimatedTokens: 0 },
    analysisRuns: { total: 0, success: 0, failed: 0 },
    script: null,
    generatedAtIso: new Date().toISOString(),
  };
}

const session = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  startedAtIso: new Date(Date.now() - 3600e3).toISOString(),
  endedAtIso: new Date().toISOString(),
  audioSource: "systemLoopback",
  status: "stopped",
  finalSegmentCount: 5,
  issueCount: 0,
  hasGap: false,
};

const stubs = {
  "framework.list": [],
  "framework.save": true,
  "settings.get": { windowIntervalSec: 60, windowSizeSec: 300 },
  "settings.save": true,
  "settings.getAsrStatus": { configured: false, source: "environment" },
  "settings.getLlmStatus": { configured: false, source: "environment" },
  "session.list": { sessions: [session], error: null },
  "session.detail": { session: null, segments: [], issues: [], error: null },
  "session.delete": true,
  "report.export": "",
  "asr.testConnection": { ok: false, error: null },
  "llm.testConnection": { ok: false, error: null },
};
for (const [ch, val] of Object.entries(stubs)) ipcMain.handle(ch, () => val);
ipcMain.handle("report.generate", () => reportFor(currentEndReason));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 950, show: false,
    webPreferences: {
      preload: path.join(ASAR, "dist/main/preload/index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(ASAR, "dist/renderer/index.html"));
  await sleep(1500);
  const ev = async (expr) => win.webContents.executeJavaScript(expr, true);

  if (isProbe) {
    // 单次探针：渲染一个 endReason，打印结果
    await ev(`document.querySelectorAll("nav button")[3].click()`);
    await sleep(1200);
    await ev(`document.querySelectorAll(".session-item")[0]?.click()`);
    await sleep(1600);
    await ev(`Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="报告")?.click()`);
    await sleep(1200);
    const row = await ev(`
      (() => {
        const kvs = Array.from(document.querySelectorAll(".kv"));
        const hit = kvs.find(e => e.innerText.includes("结束方式"));
        return hit ? hit.innerText.replace(/\\n/g, " ").trim() : null;
      })()
    `);
    console.log(`PROBE ${JSON.stringify(currentEndReason)} => ${JSON.stringify(row)}`);
    app.exit(0);
    return;
  }

  // 默认：跑一遍四种取值 + null
  for (const r of ["user", "schedule-window-end", "process-restart", "no-audio-timeout", null]) {
    currentEndReason = r;
    const win2 = win;
    await win2.webContents.executeJavaScript(`location.reload()`).catch(() => {});
    await sleep(1800);
    await win2.webContents.executeJavaScript(`document.querySelectorAll("nav button")[3].click()`);
    await sleep(1200);
    await win2.webContents.executeJavaScript(`document.querySelectorAll(".session-item")[0]?.click()`);
    await sleep(1600);
    await win2.webContents.executeJavaScript(`Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="报告")?.click()`);
    await sleep(1200);
    const row = await win2.webContents.executeJavaScript(`
      (() => {
        const kvs = Array.from(document.querySelectorAll(".kv"));
        const hit = kvs.find(e => e.innerText.includes("结束方式"));
        return hit ? hit.innerText.replace(/\\n/g, " ").trim() : null;
      })()
    `);
    console.log(`  endReason=${JSON.stringify(r)} => ${JSON.stringify(row)}`);
  }

  console.log("DONE");
  app.exit(0);
}).catch((e) => { console.log("FAILED:", e.message); app.exit(1); });
