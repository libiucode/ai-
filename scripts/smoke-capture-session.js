#!/usr/bin/env node
// Real React buttons + capture wiring + IPC + session state, with local media
// streams replacing hardware. No credentials or live user database are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const root = process.env.ASR_SMOKE_APP_ROOT || path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-session-smoke-"));
app.setPath("userData", dir);
app.disableHardwareAcceleration();
const { Store } = require(path.join(root, "dist/main/main/storage/store.js"));
const { SessionOrchestrator } = require(path.join(root, "dist/main/main/analysis/orchestrator.js"));
const { registerIpc } = require(path.join(root, "dist/main/main/ipc.js"));
let orch, store, win;
const timer = setTimeout(() => { console.error("[session-smoke] FAIL timeout"); app.exit(1); }, 20000);
async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for " + predicate);
}
async function click(text, twice = false) {
  await win.webContents.executeJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(text)});
    if (!button) throw new Error('Missing button');
    button.click(); ${twice ? "button.click();" : ""}
  })()`);
}
app.whenReady().then(async () => {
  store = new Store(path.join(dir, "test.db"));
  orch = new SessionOrchestrator(store);
  registerIpc(store, orch);
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, "dist/main/preload/index.js"), contextIsolation: true,
    sandbox: false, backgroundThrottling: false,
  } });
  orch.setWindow(win);
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(root, "dist/renderer/index.html"));
  await waitFor("!!document.querySelector('.state-badge')");
  await win.webContents.executeJavaScript(`(() => {
    window.__media = { loopback: 0, mic: 0, tracks: [], contexts: [] };
    const stream = () => {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      window.__media.contexts.push(ctx);
      window.__media.tracks.push(...dest.stream.getAudioTracks());
      return dest.stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__media.loopback++;
      await new Promise(r => setTimeout(r, 100));
      return stream();
    };
    navigator.mediaDevices.getUserMedia = async () => {
      window.__media.mic++;
      return stream();
    };
  })()`);
  await click("监听系统声音", true);
  await waitFor("document.querySelector('.state-badge').textContent === '监听中'");
  assert.equal(orch.getSnapshot().audio.source, "systemLoopback");
  await click("暂停");
  await waitFor("document.querySelector('.state-badge').textContent === '已暂停'");
  await click("继续");
  await waitFor("document.querySelector('.state-badge').textContent === '监听中'");
  const counts = await win.webContents.executeJavaScript("({ loopback: window.__media.loopback, mic: window.__media.mic })");
  assert.deepEqual(counts, { loopback: 2, mic: 0 });
  console.log("[session-smoke] PASS double start opens one capture; pause/resume preserves system loopback");
  await click("结束");
  await waitFor("document.querySelector('.state-badge').textContent === '已完成'");
  assert.equal(orch.sessionIsActive, false);
  assert.equal(await win.webContents.executeJavaScript("window.__media.tracks.every(t => t.readyState === 'ended')"), true);

  // A rejected start must stop the already-opened capture stream.
  ipcMain.removeHandler("session.start");
  ipcMain.handle("session.start", () => ({ sessionId: "", error: { code: "TEST_REJECTION", message: "start rejected", retryable: false } }));
  await click("开始麦克风监听");
  await waitFor("document.querySelector('.state-badge').textContent === '错误'");
  await waitFor("window.__media.tracks.every(t => t.readyState === 'ended')");
  assert.deepEqual(errors, []);
  console.log("[session-smoke] PASS ending and failed starts release capture tracks; no renderer errors");
  await win.webContents.executeJavaScript("Promise.all(window.__media.contexts.map(ctx => ctx.close()))");
  store.close(); clearTimeout(timer); app.exit(0);
}).catch(async error => {
  console.error("[session-smoke] FAIL", error);
  if (orch) await orch.stop().catch(() => {});
  if (store) store.close();
  clearTimeout(timer); app.exit(1);
});
