/**
 * 只读探针：在真实 dist/main 入口的同款初始化顺序下验证 safeStorage 的最终取值。
 *
 * ⚠️ 不加载真实业务入口 index.js（它会抢单实例锁、开真实库、开真实窗口），
 * 这里只复刻「ready 之后」这一时序点，并刻意指向临时 userData。
 *
 * 不修改任何业务源码；不写用户真实库 %APPDATA%\ai-live-monitor；
 * 不打印任何真实密钥值（只用假占位串）。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const electron = require("electron");
const { app } = electron;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dpapi-realorder-"));
app.setPath("userData", tmpUserData);

console.log("=== PROBE dpapi-realorder ===");
console.log("复刻 src/main/index.ts 的时序：所有凭证调用都发生在 whenReady 回调内");

function read() {
  try {
    return String(electron.safeStorage.isEncryptionAvailable());
  } catch (e) {
    return "THREW:" + (e && e.message);
  }
}
console.log("ready 之前（不应有业务代码在此调用）->", read());

app.whenReady().then(() => {
  console.log("ready 之后，模拟 index.ts:73 进入回调");

  // index.ts 在 ready 回调里第一件事是开库；credentialStore 全部经由 ipc 调用，
  // 一定晚于这里，所以这里取值即为生产环境的最坏情况。
  console.log("ready 回调内 ->", read());

  const { Store } = require("D:/ai盯播工具/app/dist/main/main/storage/store.js");
  const cred = require("D:/ai盯播工具/app/dist/main/main/security/credentialStore.js");
  const dbPath = path.join(tmpUserData, "probe-realorder.db");
  const store = new Store(dbPath);
  const FAKE = "probe-fake-not-a-real-key";

  console.log("index.ts 开库之后 ->", read());
  console.log("storageMode()            =", cred.storageMode());
  console.log("credentialStorageAvailable =", cred.credentialStorageAvailable());

  // 生产路径：ipc.ts credential.set handler 的等价调用
  console.log("setCredential ->", cred.setCredential(store, "TENCENT_ASR_SECRET_KEY", FAKE));
  console.log("storageMode() 写入后     =", cred.storageMode());
  console.log("isPlaintextCredential    =", cred.isPlaintextCredential(store, "TENCENT_ASR_SECRET_KEY"));
  console.log("hasCredential            =", cred.hasCredential(store, "TENCENT_ASR_SECRET_KEY"));
  console.log("getCredential 往返一致   =", cred.getCredential(store, "TENCENT_ASR_SECRET_KEY") === FAKE);
  const raw = store.getSetting("credential_store_v1");
  console.log("落库含明文原值（应为 false）= ", raw.includes(FAKE));

  cred.clearCredentials(store);
  store.close();
  console.log("=== DONE ===");
  app.exit(0);
});
