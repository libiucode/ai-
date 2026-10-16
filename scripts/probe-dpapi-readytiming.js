/**
 * 只读探针：只测「app 何时 ready + ready 前后 isEncryptionAvailable」，
 * 并带硬超时，避免无窗口 Electron 常驻不退出。
 *
 * 用途：对比 --no-sandbox 与不带该参数时，ready 是否都能到达、
 * safeStorage 是否都能变 true。
 *
 * 不修改任何业务源码；不写用户真实库；不打印任何真实密钥值。
 */
const electron = require("electron");
const { app } = electron;

const t0 = Date.now();
const stamp = () => `+${Date.now() - t0}ms`;

console.log("=== PROBE dpapi-readytiming ===");
console.log("argv          =", JSON.stringify(process.argv.slice(2).filter((a) => a !== ".")));
console.log("isPackaged    =", app.isPackaged);
console.log("hasSingleLock =", app.hasSingleInstanceLock());

function p(label) {
  let v = "THREW";
  try {
    v = electron.safeStorage.isEncryptionAvailable();
  } catch (e) {
    v = "THREW:" + (e && e.message);
  }
  console.log(`[${stamp()}] [${label}] isEncryptionAvailable()=${v} | ready=${app.isReady()}`);
}

p("pre-ready");

// 硬超时：10s 还没 ready 就判定 ready 不可达
const guard = setTimeout(() => {
  console.log(`[${stamp()}] [GUARD] 10s 内 app 未 ready —— 判定 ready 不可达`);
  console.log("=== DONE(guard) ===");
  app.exit(2);
}, 10000);
guard.unref?.();

app.on("ready", () => {
  clearTimeout(guard);
  console.log(`[${stamp()}] [EVENT] app ready 事件触发`);
  p("ready-event");
});

app.whenReady().then(() => {
  p("whenReady");
  setTimeout(() => {
    p("whenReady+timeout0");
    console.log("=== DONE ===");
    app.exit(0);
  }, 0);
});
