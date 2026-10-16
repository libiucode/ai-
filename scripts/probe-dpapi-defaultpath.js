/**
 * 只读探针：在「不覆盖 userData」的情况下跑，观察真实默认 userData 路径下的
 * isEncryptionAvailable() 行为，并做两次启动对比（同一路径第二次启动）。
 *
 * 目的：验证候选「Electron 需要 setPath('userData') 或 ready 之后才有效」。
 * 不修改任何业务源码；不写用户真实库 %APPDATA%\ai-live-monitor；
 * 不打印任何真实密钥值（只用假占位串）。
 *
 * 用法：
 *   $env:ELECTRON_RUN_AS_NODE = $null
 *   & "...\electron.exe" "...\probe-dpapi-defaultpath.js" --no-sandbox
 */
const electron = require("electron");
const { app } = electron;

console.log("=== PROBE dpapi-defaultpath ===");
console.log("app.isPackaged     =", app.isPackaged);
console.log("app.getName()      =", app.getName());
console.log("userData (default) =", app.getPath("userData"));
console.log("appData            =", app.getPath("appData"));
console.log("hasSingleLock      =", app.hasSingleInstanceLock());

function p(label) {
  let v = "THREW";
  try {
    v = electron.safeStorage.isEncryptionAvailable();
  } catch (e) {
    v = "THREW:" + (e && e.message);
  }
  console.log(`[${label}] isEncryptionAvailable()=${v} | ready=${app.isReady()}`);
  return v;
}

p("pre-ready");

app.whenReady().then(() => {
  p("post-ready");

  // 加密一次，看 blob 形态（密文不是密钥；仅打印长度 + 头 8 字节）
  try {
    const buf = electron.safeStorage.encryptString("probe-fake-placeholder");
    console.log(`[blob] len=${buf.length} head=${buf.subarray(0, 8).toString("hex")}`);
  } catch (e) {
    console.log("[blob] THREW:", e && e.message);
  }

  setTimeout(() => {
    p("post-ready+timeout");
    console.log("=== DONE ===");
    app.exit(0);
  }, 0);
});
