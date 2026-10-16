/**
 * 凭证存储真机实测（一次性验证脚本，不改业务数据）。
 *
 * 目的：mock 测试只能证明「逻辑分支正确」，不能证明「在本机真实 Electron 下
 * safeStorage 的实际行为」。本脚本用真实 Electron 跑，验证：
 *   1. 本机 isEncryptionAvailable() 的真实返回值
 *   2. 真实写入→读取往返是否一致（加密通道）
 *   3. 加密不可用时的降级明文路径是否真的可写、可读、可识别
 *   4. 明文是否真的能带前缀落库、且不与密文混淆
 *
 * ⚠️ 只操作临时数据库，不碰 %APPDATA% 下的用户真实库。
 * ⚠️ 不打印任何密钥值（用的是明显假的占位串）。
 *
 * ⚠️⚠️ 必须在 app.whenReady() 之后再读 safeStorage（2026-10-16 修正）
 *
 * 本脚本初版在 `require("electron")` 之后**立即**调用 isEncryptionAvailable()，
 * 得到 false，并据此得出「本机 DPAPI 不可用、客户也配不了密钥」的结论——
 * **那个结论是错的**。
 *
 * 实测（scripts/probe-dpapi-window.js）：
 *     [+   1ms] 首条语句       -> false  ready=false
 *     [+  41ms] 忙等 40ms 内调用 204166 次，最后一次 -> false  ready=false
 *     [+ 102ms] ready 之后     -> true   ready=true
 * 40ms 内 20 万次调用无一例外 false，唯一跳变点是 app ready。
 * 即：**在 ready 之前取值恒为 false，与 DPAPI 是否可用无关**。
 *
 * 生产代码路径不受影响：src/main/index.ts 在 whenReady 内建库，
 * ipc.ts 的凭证 handler 必然晚于 ready。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-real-"));
const dbPath = path.join(dir, "probe.db");

async function main() {
  const { safeStorage, app } = require("electron");

  // 关键：等 ready。这里等待的是「真实应用所处的阶段」，
  // 不是为了让测试通过而绕过问题——生产代码确实在这个阶段之后才读写凭证。
  await app.whenReady();
  console.log("[0] app ready =", app.isReady());

  const Database = require("D:/ai盯播工具/app/node_modules/better-sqlite3");

  const avail = safeStorage.isEncryptionAvailable();
  console.log("[1] isEncryptionAvailable() =", avail);
  console.log("[1b] 若为 true，说明本机 DPAPI 正常（初版脚本报 false 是取值时机错误）");

  // 用真实 Store + 真实 credentialStore 模块（编译产物）
  const { Store } = require("D:/ai盯播工具/app/dist/main/main/storage/store.js");
  const cred = require("D:/ai盯播工具/app/dist/main/main/security/credentialStore.js");

  const store = new Store(dbPath);
  const FAKE = "fixture-not-a-real-key-12345";

  console.log("[2] storageMode() =", cred.storageMode());
  const okSet = cred.setCredential(store, "LLM_API_KEY", FAKE);
  console.log("[3] setCredential ok =", okSet);

  const got = cred.getCredential(store, "LLM_API_KEY");
  console.log("[4] 往返一致 =", got === FAKE, "| 读到长度 =", got.length);
  console.log("[5] hasCredential =", cred.hasCredential(store, "LLM_API_KEY"));
  console.log("[6] isPlaintext  =", cred.isPlaintextCredential(store, "LLM_API_KEY"));

  const raw = store.getSetting("credential_store_v1");
  console.log("[7] 落库内容是否含明文原值 =", raw.includes(FAKE));
  console.log("[7b] 落库格式 =", raw.slice(0, 24) + "...");

  // 清除
  cred.clearCredentials(store);
  console.log("[8] 清除后 hasCredential =", cred.hasCredential(store, "LLM_API_KEY"));

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("[9] 临时库已清理，未触碰用户真实库");
  app.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
