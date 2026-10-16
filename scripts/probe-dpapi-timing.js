/**
 * 只读探针：验证 safeStorage.isEncryptionAvailable() 的调用时机依赖。
 *
 * 不改任何业务源码；不申请单实例锁；不写用户真实库；
 * userData 强制指到临时目录，避免碰 %APPDATA%\ai-live-monitor。
 * 不打印任何真实密钥值（只用假占位串）。
 *
 * 用法：
 *   $env:ELECTRON_RUN_AS_NODE = $null
 *   & "...\electron.exe" "...\probe-dpapi-timing.js" [--no-sandbox]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const electron = require("electron");
const { app } = electron;

// 把 userData 指到临时目录（必须在 app ready 之前，越早越好）
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dpapi-probe-userdata-"));
try {
  app.setPath("userData", tmpUserData);
} catch (e) {
  console.log("[warn] setPath(userData) 失败:", e && e.message);
}

const ARGV = process.argv.slice(2).filter((a) => a !== ".");
console.log("=== PROBE dpapi-timing ===");
console.log("electron      =", process.versions.electron);
console.log("chrome        =", process.versions.chrome);
console.log("node          =", process.versions.node);
console.log("argv          =", JSON.stringify(ARGV));
console.log("userData      =", tmpUserData);
console.log("app.isPackaged=", app.isPackaged);
console.log("hasSingleLock =", app.hasSingleInstanceLock());

// 用 try/catch 包住每一次调用，某些时机下可能直接抛错
function probe(label) {
  let avail = "THREW";
  let err = "";
  try {
    avail = electron.safeStorage.isEncryptionAvailable();
  } catch (e) {
    err = e && e.message;
  }
  let backend = "";
  try {
    // getSelectedStorageBackend 仅 Linux 有意义，但调用不应抛错（这里只为观测）
    backend = typeof electron.safeStorage.getSelectedStorageBackend === "function"
      ? electron.safeStorage.getSelectedStorageBackend()
      : "(n/a)";
  } catch (e) {
    backend = "THREW:" + (e && e.message);
  }
  console.log(
    `[${label}] isEncryptionAvailable()=${avail}` +
      (err ? ` err=${err}` : "") +
      ` | ready=${app.isReady()} | selectedBackend=${backend}`
  );
  return avail;
}

// ---------- 阶段 A：require 之后立刻（app ready 之前） ----------
probe("A-pre-ready-immediate");

// ---------- 阶段 B：setImmediate / nextTick 之后，仍未 ready ----------
setImmediate(() => {
  probe("B-pre-ready-setImmediate");
  process.nextTick(() => probe("B2-pre-ready-nextTick"));
});

// ---------- 阶段 C：app ready 之后 ----------
app.whenReady().then(() => {
  probe("C-ready");

  // ---------- 阶段 D：ready 之后再加一轮（微/宏任务更靠后） ----------
  setTimeout(() => {
    probe("D-ready+setTimeout0");

    // ---------- 阶段 E：真实加解密往返（只加密，不解出明文打印） ----------
    try {
      const FAKE = "probe-fake-placeholder-not-a-real-key";
      const enc = electron.safeStorage.encryptString(FAKE);
      const dec = electron.safeStorage.decryptString(enc);
      console.log(
        `[E-roundtrip] encryptString ok=true len=${enc.length} decryptMatches=${dec === FAKE}`
      );
    } catch (e) {
      console.log("[E-roundtrip] THREW:", e && e.message);
    }

    // 清理临时 userData，不碰真实目录
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
      console.log("[cleanup] 临时 userData 已删除");
    } catch (e) {
      console.log("[cleanup] 失败:", e && e.message);
    }
    console.log("=== DONE ===");
    app.exit(0);
  }, 0);
});
