#!/usr/bin/env node
/**
 * 设备选择持久化：产物级探针（零额度，桩主进程 + 桩设备列表，不连 ASR/LLM）。
 *
 * 四条路径逐一验证：
 *   1. 保存     —— 用户选一个设备 → 落库 app_settings.audioDeviceId
 *   2. 读回     —— 重新挂载 → 下拉框选中上次的设备
 *   3. 失效回落 —— 库里存的 id 不在当前设备列表 → 回落到默认 + 出现提示
 *   4. 清除     —— 用户选「默认麦克风」→ 库里值被清成 null
 *
 * 为什么用产物级探针而不是只靠单测：单测覆盖判据，但覆盖不到
 * 「读回时序」这类实现细节（例如挂载时设备列表还没到）。这和之前
 * endReason 空串 bug 是同一个教训——实现者想不到的输入，只有产物能暴露。
 *
 * 用法：
 *   npm run verify:device-mem probe <scenario>
 *   scenario = saved | restored | fallback | cleared
 */
if (process.type !== "browser") {
  if (!process.versions.electron) { console.error("[device-mem] 请用 electron 运行"); process.exit(1); }
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", __filename, ...process.argv.slice(2)], { stdio: "inherit", env });
  child.on("exit", (c) => process.exit(c ?? 1));
  return;
}

const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
app.commandLine.appendSwitch("disable-gpu");

const ASAR = path.join(__dirname, "..", "release-verify", "win-unpacked", "resources", "app.asar");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scenario = process.argv[2] || "restored";

// 桩：内存里的 settings，模拟 SQLite 的 app_settings
let storedSettings = {
  windowIntervalSec: 60,
  windowSizeSec: 300,
  audioDeviceId: null,
};
// 桩：设备列表。fallback 场景故意不含 "mic-gone"
const DEVICES = scenario === "fallback"
  ? [{ id: "mic-1", label: "麦克风 1", kind: "microphone", isDefault: true }]
  : [
      { id: "mic-1", label: "麦克风 1", kind: "microphone", isDefault: false },
      { id: "mic-2", label: "VB-CABLE", kind: "microphone", isDefault: false },
    ];
if (scenario === "restored" || scenario === "saved") storedSettings.audioDeviceId = "mic-2";
if (scenario === "fallback") storedSettings.audioDeviceId = "mic-gone";

const stubs = {
  "framework.list": () => [],
  "framework.save": () => true,
  "settings.get": () => JSON.parse(JSON.stringify(storedSettings)),
  "settings.save": (_e, s) => { storedSettings = { ...storedSettings, ...s }; return true; },
  "settings.getAsrStatus": () => ({ configured: false, source: "environment" }),
  "settings.getLlmStatus": () => ({ configured: false, source: "environment" }),
  "session.list": () => ({ sessions: [], error: null }),
  "session.detail": () => ({ session: null, segments: [], issues: [], error: null }),
  "session.delete": () => true,
  "report.generate": () => null,
  "report.export": () => "",
  "asr.testConnection": () => ({ ok: false, error: null }),
  "llm.testConnection": () => ({ ok: false, error: null }),
};
for (const [ch, val] of Object.entries(stubs)) ipcMain.handle(ch, val);

app.whenReady().then(async () => {
  // 关键：preload 的 listAudioDevices 直接调 navigator.mediaDevices.enumerateDevices()，
  // 而 preload 在文档创建时就持有该引用——页面级 patch 拦不到
  // （与 sendAudioChunk 拦不到是同一机制，见 docs 里的教训）。
  // 所以这里**不加载真 preload**，改用桩 preload：它模拟同样的 contextBridge 暴露面，
  // 但 enumerateDevices 返回我们的桩设备。这样测的是渲染层逻辑，不是 preload 本身
  // （preload 的行为由 tests/build-config 与 smoke 覆盖）。
  const fs = require("node:fs");
  const os = require("node:os");
  const stubPreload = path.join(os.tmpdir(), `device-mem-preload-${process.pid}.js`);
  fs.writeFileSync(stubPreload, `
    const { contextBridge, ipcRenderer } = require("electron");
    const DEVICES = ${JSON.stringify(DEVICES)};
    contextBridge.exposeInMainWorld("appApi", {
      startSession: (c) => ipcRenderer.invoke("session.start", c),
      pauseSession: () => ipcRenderer.invoke("session.pause"),
      resumeSession: () => ipcRenderer.invoke("session.resume"),
      stopSession: () => ipcRenderer.invoke("session.stop"),
      listAudioDevices: async () => DEVICES,
      // selectAudioDevice 的桩已删除：captureSelectDevice 三层死通道已被清掉，
      // 设备选择改走 settingsSave（app_settings.audioDeviceId）。留着这个桩会误导。
      subscribeEvents: () => () => {},
      listFrameworks: () => ipcRenderer.invoke("framework.list"),
      saveFramework: (f) => ipcRenderer.invoke("framework.save", f),
      getSettings: () => ipcRenderer.invoke("settings.get"),
      saveSettings: (s) => ipcRenderer.invoke("settings.save", s),
      exportReport: (id, f) => ipcRenderer.invoke("report.export", id, f),
      listSessions: () => ipcRenderer.invoke("session.list"),
      getSessionDetail: (id) => ipcRenderer.invoke("session.detail", id),
      deleteSession: (id) => ipcRenderer.invoke("session.delete", id),
      testAsrConnection: (c) => ipcRenderer.invoke("asr.testConnection", c),
      testLlmConnection: (c) => ipcRenderer.invoke("llm.testConnection", c),
      generateReport: (id, f) => ipcRenderer.invoke("report.generate", id, f),
      getAsrStatus: () => ipcRenderer.invoke("settings.getAsrStatus"),
      getLlmStatus: () => ipcRenderer.invoke("settings.getLlmStatus"),
      sendAudioChunk: () => {},
    });
  `);

  const win = new BrowserWindow({
    width: 1280, height: 950, show: false,
    webPreferences: {
      preload: stubPreload,
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  await win.loadFile(path.join(ASAR, "dist/renderer/index.html"));
  await sleep(1600);
  const ev = async (expr) => win.webContents.executeJavaScript(expr, true);

  // 触发一次设备列表刷新（点回监控页，让 effect 重跑）
  await ev(`document.querySelectorAll("nav button")[0].click()`);
  await sleep(1800);

  // 诊断：设备列表到底有没有拿到（区分"读回逻辑错" vs "桩没生效"）
  const diag = await ev(`
    (() => {
      const sel = document.querySelector("select.input.select");
      return {
        hasSelect: !!sel,
        optionCount: sel ? sel.options.length : 0,
        optionValues: sel ? Array.from(sel.options).map(o => o.value) : [],
        restoreLog: window.__deviceRestoreLog ?? null,
        restoreErr: window.__deviceRestoreErr ?? null,
        effectRunCount: window.__devEffectRun ?? 0,
        selectValue: sel ? sel.value : null,
      };
    })()
  `);
  console.log(`DIAG=${JSON.stringify(diag)}`);

  // 诊断2 只在 saved 场景跑（验证 value 绑定通路）。
  // fallback/restored 场景绝不能跑：手动 change 会触发 onSelectDevice，
  // 把 deviceFallbackNotice 清掉，污染被测状态（我自己踩过这个坑）。
  if (scenario === "saved") {
    const diag2 = await ev(`
      (async () => {
        const sel = document.querySelector("select.input.select");
        if (!sel) return "no-select";
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
        return { valueAfterManualChange: sel.value, text: sel.options[sel.selectedIndex]?.text };
      })()
    `);
    console.log(`DIAG2=${JSON.stringify(diag2)}`);
  }

  const readState = async () => {
    const selected = await ev(`
      (() => {
        const sel = document.querySelector("select.input.select");
        if (!sel) return null;
        return { value: sel.value, text: sel.options[sel.selectedIndex]?.text ?? null };
      })()
    `);
    const notice = await ev(`
      (() => {
        const c = Array.from(document.querySelectorAll(".callout-warn")).find(e => e.innerText.includes("已不可用"));
        return c ? c.innerText.trim() : null;
      })()
    `);
    // 诊断：把页面上所有 warn callout 都列出来，避免"文案不匹配"造成误判
    const allWarns = await ev(`
      Array.from(document.querySelectorAll(".callout-warn")).map(e => e.innerText.trim().slice(0, 60))
    `);
    return { selected, notice, allWarns };
  };

  let out;
  if (scenario === "saved") {
    // 用户主动选一个设备 → 落库（验证"保存"）
    await ev(`
      (() => {
        const sel = document.querySelector("select.input.select");
        if (!sel) return "no-select";
        sel.value = "mic-2";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return "changed";
      })()
    `);
    await sleep(1200);
    const afterPick = { storedAfterPick: storedSettings.audioDeviceId, ...(await readState()) };
    // 再选「默认麦克风」→ 应清成 null（验证"清除"）
    await ev(`
      (() => {
        const sel = document.querySelector("select.input.select");
        if (!sel) return "no-select";
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return "changed";
      })()
    `);
    await sleep(1200);
    const afterClear = { storedAfterClear: storedSettings.audioDeviceId, ...(await readState()) };
    out = { afterPick, afterClear };
  } else {
    out = await readState();
  }

  console.log(`SCENARIO=${scenario}`);
  console.log(`STORED_DEVICE_ID=${JSON.stringify(storedSettings.audioDeviceId)}`);
  console.log(`RESULT=${JSON.stringify(out)}`);
  console.log("DONE");
  app.exit(0);
}).catch((e) => { console.log("FAILED:", e.message); app.exit(1); });
