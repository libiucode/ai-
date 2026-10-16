/**
 * 只读探针：排除「非交互会话 / 服务账户 / DPAPI 被策略禁用」等候选，
 * 并做一次「假窗口（不申请单实例锁、不碰真实 userData）」下的端到端调用链复现。
 *
 * 不修改任何业务源码；不写用户真实库 %APPDATA%\ai-live-monitor；
 * 不打印任何真实密钥值（只用假占位串）。
 *
 * 用法：
 *   $env:ELECTRON_RUN_AS_NODE = $null
 *   & "...\electron.exe" "...\probe-dpapi-context.js" --no-sandbox
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const electron = require("electron");
const { app } = electron;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "dpapi-ctx-userdata-"));
app.setPath("userData", tmpUserData);

const results = [];
function rec(name, value) {
  results.push({ name, value });
  console.log(`  ${name} = ${value}`);
}

console.log("=== PROBE dpapi-context ===");
console.log("--- 环境/会话上下文（用于排除「非交互会话 / 服务账户」候选）---");
rec("process.platform", process.platform);
rec("resourcePath", process.resourcesPath);
rec("userData(override)", tmpUserData);
rec("app.getPath('appData')", app.getPath("appData"));

function safeBool(fn) {
  try {
    return String(fn());
  } catch (e) {
    return "THREW:" + (e && e.message);
  }
}

app.whenReady().then(async () => {
  console.log("--- app ready 之后的 safeStorage 事实 ---");
  rec("isEncryptionAvailable", safeBool(() => electron.safeStorage.isEncryptionAvailable()));

  // 加密一次并观察密文形态（密文本身不是密钥，但仍只打印长度与前缀特征）
  let cipherInfo = "n/a";
  try {
    const buf = electron.safeStorage.encryptString("probe-fake-placeholder");
    // Windows DPAPI blob 以固定头 01 00 00 00 D0 8C 9D DF ... 开头
    cipherInfo = `len=${buf.length} head=${buf.subarray(0, 8).toString("hex")}`;
  } catch (e) {
    cipherInfo = "THREW:" + (e && e.message);
  }
  rec("encryptString(blob)", cipherInfo);

  // 二次调用的一致性（是否稳定，而非偶发 false）
  const repeats = [];
  for (let i = 0; i < 3; i++) {
    repeats.push(safeBool(() => electron.safeStorage.isEncryptionAvailable()));
  }
  rec("isEncryptionAvailable x3", repeats.join(","));

  // ---------- 端到端：走真实编译产物（dist），但 store 用临时 db ----------
  console.log("--- 端到端：真实 credentialStore（dist）+ 临时 db ---");
  try {
    const { Store } = require("D:/ai盯播工具/app/dist/main/main/storage/store.js");
    const cred = require("D:/ai盯播工具/app/dist/main/main/security/credentialStore.js");
    const dbPath = path.join(tmpUserData, "probe-context.db");
    const store = new Store(dbPath);
    const FAKE = "probe-fake-not-a-real-key";

    rec("storageMode()", cred.storageMode());
    rec("credentialStorageAvailable()", cred.credentialStorageAvailable());
    cred.setCredential(store, "LLM_API_KEY", FAKE);
    const got = cred.getCredential(store, "LLM_API_KEY");
    rec("roundtrip ok", String(got === FAKE));
    rec("isPlaintextCredential()", String(cred.isPlaintextCredential(store, "LLM_API_KEY")));
    const raw = store.getSetting("credential_store_v1");
    rec("落库是否含明文原值", String(raw.includes(FAKE)));
    rec("落库内容前缀", raw.slice(0, 16) + "...");
    cred.clearCredentials(store);
    store.close();
  } catch (e) {
    rec("端到端 THREW", e && e.message);
  }

  // 用隐藏窗口让 Electron 完整初始化（不 loadFile，不碰渲染层资源）
  try {
    const win = new electron.BrowserWindow({ show: false });
    await new Promise((r) => setTimeout(r, 300));
    rec("有窗口时 isEncryptionAvailable", safeBool(() => electron.safeStorage.isEncryptionAvailable()));
    win.destroy();
  } catch (e) {
    rec("BrowserWindow THREW", e && e.message);
  }

  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    console.log("[cleanup] 临时 userData 已删除（未触碰真实库）");
  } catch (e) {
    console.log("[cleanup] 失败:", e && e.message);
  }
  console.log("=== DONE ===");
  app.exit(0);
});
