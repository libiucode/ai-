#!/usr/bin/env node
// Real adapter -> orchestrator -> preload IPC -> React -> SQLite regression.
// Build first, then: electron --no-sandbox --disable-gpu scripts/smoke-asr-transcript.js
// ASR_SMOKE_APP_ROOT can also verify a packaged/deployed resources/app.asar.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const root = process.env.ASR_SMOKE_APP_ROOT || path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-transcript-smoke-"));
app.setPath("userData", dir);
app.disableHardwareAcceleration();

const { Store } = require(path.join(root, "dist/main/main/storage/store.js"));
const { SessionOrchestrator } = require(path.join(root, "dist/main/main/analysis/orchestrator.js"));
let store;
let orch;
let win;
const timeout = setTimeout(() => {
  console.error("[asr-smoke] FAIL: timed out");
  app.exit(1);
}, 20000);

async function probe() {
  return win.webContents.executeJavaScript(`({
    partials: Array.from(document.querySelectorAll('.seg-partial .seg-text')).map(e => e.textContent),
    finals: Array.from(document.querySelectorAll('.seg-row:not(.seg-partial) .seg-text')).map(e => e.textContent),
    mounted: !!document.querySelector('.transcript'),
  })`);
}

async function waitFor(expected) {
  const deadline = Date.now() + 4000;
  let actual;
  do {
    actual = await probe();
    if (Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value))) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.fail(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function send(index, sliceType, text) {
  orch.asr.handleMessage(JSON.stringify({
    code: 0, voice_id: "smoke-voice",
    result: { index, slice_type: sliceType, voice_text_str: text, start_time: index * 3000, end_time: index * 3000 + 2000 },
  }));
}

app.whenReady().then(async () => {
  store = new Store(path.join(dir, "test.db"));
  orch = new SessionOrchestrator(store);
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "dist/main/preload/index.js"),
      contextIsolation: true, sandbox: false, backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });
  await win.loadFile(path.join(root, "dist/renderer/index.html"));
  await waitFor({ mounted: true });
  // Flush the mount effect so event subscriptions exist before emitting frames.
  await new Promise(resolve => setTimeout(resolve, 100));
  orch.setWindow(win);
  await orch.start({ audioSource: "microphone" });
  orch.asr.connectionId = "smoke-connection";

  send(0, 0, "实时");
  await waitFor({ partials: ["实时"], finals: [] });
  send(0, 1, "实时语音识别");
  await waitFor({ partials: ["实时语音识别"], finals: [] });
  assert.equal(store.querySegments({ sessionId: orch.getSnapshot().sessionId }).length, 0);
  console.log("[asr-smoke] PASS partial revisions replace the same row; no partial persisted");

  send(0, 2, "实时语音识别");
  await waitFor({ partials: [], finals: ["实时语音识别"] });
  send(0, 2, "实时语音识别");
  send(0, 1, "迟到的更新");
  send(1, 2, "欢迎来到直播间");
  await waitFor({ partials: [], finals: ["实时语音识别", "欢迎来到直播间"] });
  const segments = store.querySegments({ sessionId: orch.getSnapshot().sessionId });
  assert.deepEqual(segments.map(s => [s.sourceSeq, s.text]), [[0, "实时语音识别"], [1, "欢迎来到直播间"]]);
  assert.equal(orch.getSnapshot().finalCount, 2);
  assert.deepEqual(errors, []);
  console.log("[asr-smoke] PASS final subtitles render and persist exactly once, including the next sentence");
  send(2, 1, "连接中断前未定稿");
  await waitFor({ partials: ["连接中断前未定稿"] });
  orch.asr.emit("status", { state: "reconnecting" });
  await waitFor({ partials: [], finals: ["实时语音识别", "欢迎来到直播间"] });
  console.log("[asr-smoke] PASS reconnect clears abandoned partial subtitles and preserves finals");
  console.log("[asr-smoke] PASS no renderer console errors");
  await orch.stop();
  store.close();
  clearTimeout(timeout);
  app.exit(0);
}).catch(async error => {
  console.error("[asr-smoke] FAIL", error);
  if (orch) await orch.stop().catch(() => {});
  if (store) store.close();
  clearTimeout(timeout);
  app.exit(1);
});
