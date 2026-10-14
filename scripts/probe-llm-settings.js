// 只读探测（不提交）：只看 llm 配置形态（不含 key）。
const Database = require("better-sqlite3");
const db = new Database("C:/Users/libiu/AppData/Roaming/ai-live-monitor/live-monitor.db", { readonly: true, fileMustExist: true });
const raw = db.prepare("SELECT value FROM settings WHERE key='app_settings'").get();
const key = db.prepare("SELECT value FROM settings WHERE key='llm_api_key'").get();
db.close();
if (!raw) { console.log("NO app_settings"); process.exit(0); }
const s = JSON.parse(raw.value);
const llm = s.llm || {};
console.log(JSON.stringify({
  windowIntervalSec: s.windowIntervalSec,
  windowSizeSec: s.windowSizeSec,
  llm: {
    base_url: llm.base_url || null,
    model: llm.model || null,
    api_key_present: "api_key" in llm,
    request_timeout_ms: llm.request_timeout_ms,
    budget_limit: llm.budget_limit,
  },
  llm_api_key_len: key ? String(key.value).length : 0,
  llm_api_key_looks_real: key ? String(key.value).length >= 20 : false,
  has_asr: !!s.asr,
}));
