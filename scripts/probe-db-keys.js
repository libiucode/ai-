// 只读探测（不提交）：打印 settings 键名与值长度，绝不输出密钥内容。
const Database = require("better-sqlite3");
const DB = "C:/Users/libiu/AppData/Roaming/ai-live-monitor/live-monitor.db";
const db = new Database(DB, { readonly: true, fileMustExist: true });
const rows = db.prepare("SELECT key, length(value) AS len FROM settings").all();
console.log(JSON.stringify(rows));
let asr = null;
try {
  const r = db.prepare("SELECT value FROM settings WHERE key='asr_config'").get();
  if (r) {
    const c = JSON.parse(r.value);
    asr = { provider: c.provider, appIdDigits: String(c.appId || "").length, secretIdTail: String(c.secretId || "").slice(-4), secretKeyLen: String(c.secretKey || "").length, engine: c.engineModelType };
  }
} catch (e) { asr = "ERR " + e.message; }
console.log("asr_config shape: " + JSON.stringify(asr));
db.close();
