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
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-real-"));
const dbPath = path.join(dir, "probe.db");

async function main() {
  const { safeStorage } = require("electron");
  const Database = require("D:/ai盯播工具/app/node_modules/better-sqlite3");

  const avail = safeStorage.isEncryptionAvailable();
  console.log("[1] isEncryptionAvailable() =", avail);

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
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
