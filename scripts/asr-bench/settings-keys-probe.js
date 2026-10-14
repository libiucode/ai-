/**
 * 只读探测：确认本机库里旧密钥配置是否还在（绝不输出密钥明文，只出长度与尾 4 位）。
 * 用法：electron.exe scripts/asr-bench/settings-keys-probe.js <dbPath>
 */
const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const dbPath = rawArgs[0] || "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const out = {};
out.keys = db.prepare("SELECT key, length(value) AS len FROM settings").all();
const readKey = (k) => {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(k);
    return r ? r.value : null;
  } catch { return null; }
};

const asrRaw = readKey("asr_config");
out.asr_config = { present: !!asrRaw, valueLen: asrRaw ? asrRaw.length : 0 };
if (asrRaw) {
  try {
    const c = JSON.parse(asrRaw);
    out.asr_config.fields = Object.keys(c);
    out.asr_config.appId = String(c.appId || "");
    out.asr_config.engineModelType = c.engineModelType ?? null;
    out.asr_config.secretIdLen = String(c.secretId || "").length;
    out.asr_config.secretIdTail4 = String(c.secretId || "").slice(-4);
    out.asr_config.secretKeyLen = String(c.secretKey || "").length;
    out.asr_config.secretKeyTail4 = String(c.secretKey || "").slice(-4);
  } catch (e) {
    out.asr_config.parseError = e.message;
  }
}

const llmRaw = readKey("llm_api_key");
out.llm_api_key = { present: !!llmRaw, valueLen: llmRaw ? llmRaw.length : 0, tail4: llmRaw ? llmRaw.slice(-4) : null };

const appRaw = readKey("app_settings");
out.app_settings = { present: !!appRaw, valueLen: appRaw ? appRaw.length : 0 };
if (appRaw) {
  try {
    const s = JSON.parse(appRaw);
    out.app_settings.topLevelKeys = Object.keys(s);
    // 只报结构性信息，不打印内容
    out.app_settings.hasAsrBlock = !!s.asr;
    out.app_settings.hasLlmBlock = !!s.llm;
    if (s.llm) out.app_settings.llmKeys = Object.keys(s.llm);
  } catch (e) { out.app_settings.parseError = e.message; }
}

console.log("===SETTINGS_KEYS_PROBE===");
console.log(JSON.stringify(out, null, 2));
db.close();
process.exit(0);
