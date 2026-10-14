// 演示用 LLM 联调（不提交）：用本机已配置的 OpenAI 兼容端点跑一次最小请求。
// Base URL 从数据库读，密钥从环境变量 DSH_SECRET_<NAME> 之外不会打印。
const Database = require("better-sqlite3");
const db = new Database("C:/Users/libiu/AppData/Roaming/ai-live-monitor/live-monitor.db", { readonly: true, fileMustExist: true });
const raw = db.prepare("SELECT value FROM settings WHERE key='app_settings'").get();
db.close();
const s = JSON.parse(raw.value);
const base = (s.llm.base_url || "").replace(/\/$/, "");
const model = s.llm.model;

(async () => {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是直播质检助手。只输出 JSON。" },
          { role: "user", content: '返回 {"ok":true,"note":"联调成功"}' },
        ],
        max_tokens: 64,
        temperature: 0,
      }),
    });
    const text = await res.text();
    console.log(`HTTP ${res.status} in ${Date.now() - started}ms`);
    console.log(text.slice(0, 400));
  } catch (e) {
    console.log("ERR " + e.message + " after " + (Date.now() - started) + "ms");
  }
})();
