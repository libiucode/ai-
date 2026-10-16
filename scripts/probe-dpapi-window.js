/**
 * 只读探针：确定 ready 的下界。刻意不 setPath、不 require 任何业务模块，
 * 把「pre-ready 观察」压到最早，看是否存在任何 ready 之前的时刻返回 true。
 *
 * 不修改任何业务源码；不写用户真实库；不打印任何真实密钥值。
 */
const t0 = Date.now();
const electron = require("electron");
const { app } = electron;

const stamp = () => `+${String(Date.now() - t0).padStart(4)}ms`;

function read() {
  try {
    return String(electron.safeStorage.isEncryptionAvailable());
  } catch (e) {
    return "THREW:" + (e && e.message);
  }
}

console.log("=== PROBE dpapi-window ===");
console.log(`[${stamp()}] 首条语句 -> ${read()} ready=${app.isReady()}`);

// 同步忙等一小段，确认 ready 之前不是「早晚会变 true」
const spinUntil = Date.now() + 40;
let n = 0;
while (Date.now() < spinUntil) {
  read();
  n++;
}
console.log(`[${stamp()}] 忙等 40ms 内调用了 ${n} 次，最后一次 -> ${read()} ready=${app.isReady()}`);

app.whenReady().then(() => {
  console.log(`[${stamp()}] ready 之后 -> ${read()} ready=${app.isReady()}`);
  console.log("=== DONE ===");
  app.exit(0);
});
