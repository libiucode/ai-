// 只读核算 ASR 与 LLM 用量，供用户与云控制台对账。
const path = require("node:path");
const Database = require("better-sqlite3");
const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true, fileMustExist: true });

const rows = db.prepare("SELECT id, started_at_iso AS a, ended_at_iso AS b, status, audio_source FROM sessions").all();
let totalSec = 0;
let openSec = 0;
console.log("=== 逐个会话（ASR 连接时长 = 计费依据） ===");
for (const r of rows) {
  const end = r.b ? new Date(r.b) : new Date();
  const d = (end - new Date(r.a)) / 1000;
  if (d <= 0 || d > 86400 * 2) continue;
  if (r.b) totalSec += d; else openSec += d;
  console.log(`${r.id.slice(0,8)} ${d.toFixed(0).padStart(6)}s ${r.status.padEnd(8)} ${r.audio_source}`);
}
console.log(`\n已结束会话合计: ${totalSec.toFixed(0)} 秒 = ${(totalSec/3600).toFixed(3)} 小时`);
console.log(`未结束(活跃)会话: ${openSec.toFixed(0)} 秒 —— 这部分仍在计费！`);
console.log(`\n按腾讯云实时ASR 3.20元/音频小时: ${((totalSec+openSec)/3600*3.2).toFixed(2)} 元`);

const runs = db.prepare("SELECT status, COUNT(*) AS c FROM analysis_runs GROUP BY status").all();
let total = 0;
for (const r of runs) total += r.c;
console.log(`\n=== LLM 分析运行次数: ${total} ===`);
for (const r of runs) console.log(`  ${r.status}: ${r.c}`);
console.log(`估算 tokens: ${(total*4810/1000000).toFixed(3)} M`);
db.close();
