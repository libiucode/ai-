// Read public model settings only; never select any credential column or value.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
if (!fs.existsSync(dbPath)) {
  console.log(JSON.stringify({ configured: false, reason: "userData database not found" }));
  process.exit(0);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const row = db.prepare("SELECT json_extract(value, '$.llm.base_url') AS baseUrl, json_extract(value, '$.llm.model') AS model FROM settings WHERE key = 'app_settings' AND json_valid(value)").get();
  console.log(JSON.stringify({ baseUrl: row?.baseUrl ?? null, model: row?.model ?? null }));
} finally {
  db.close();
}
