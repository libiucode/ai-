// 只读：审计所有「非主库」的 live-monitor.db（各成员的验收实例各自用了独立 userData 目录）。
// 背景：腾讯云控制台显示实时语音识别 1.1042 小时，而主库 18 会话墙钟合计仅 0.7926 小时，
// 差 0.3116 小时（1122 秒）必须有出处。这些实例的 ASR 调用同样计费到同一个腾讯云账号，
// 但不写进主库——这是最可能的差额来源，必须查清而不是猜。
const path = require("node:path");
const fs = require("node:fs");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

/** 递归找 live-monitor.db */
function findDbs(root, out = [], depth = 0) {
  if (depth > 5) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", "release", "release-verify"].includes(e.name)) continue;
      findDbs(p, out, depth + 1);
    } else if (e.name === "live-monitor.db") {
      out.push(p);
    }
  }
  return out;
}

const roots = [
  path.join(__dirname, ".."),
  path.join(process.env.APPDATA, "ai-live-monitor"),
  process.env.TEMP,
  path.join(process.env.LOCALAPPDATA, "Temp"),
];
const dbs = [...new Set(roots.flatMap((r) => findDbs(r)))];
console.log(`找到 ${dbs.length} 个 live-monitor.db\n`);

let grandWall = 0;
let grandAudio = 0;
let grandSessions = 0;
const allSessions = [];

for (const dbPath of dbs) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const cols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
    const sessions = db.prepare("SELECT id, started_at_iso, ended_at_iso, status FROM sessions").all();
    let wall = 0;
    let audio = 0;
    for (const s of sessions) {
      const w = s.ended_at_iso ? (new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000 : null;
      if (w) wall += w;
      const iv = db.prepare("SELECT MAX(end_ms) AS m FROM speech_intervals WHERE session_id = ?").get(s.id);
      audio += (iv.m ?? 0) / 1000;
      allSessions.push({ db: dbPath, short: s.id.slice(0, 8), id: s.id, start: s.started_at_iso, wall: w, audio: (iv.m ?? 0) / 1000 });
    }
    grandWall += wall;
    grandAudio += audio;
    grandSessions += sessions.length;
    console.log(`【${dbPath}】`);
    console.log(`  会话 ${sessions.length} 个 | 墙钟合计 ${wall.toFixed(0)}s = ${(wall / 3600).toFixed(4)}h | 音频合计 ${audio.toFixed(0)}s = ${(audio / 3600).toFixed(4)}h`);
    console.log(`  schema 列: ${cols.join(", ")}`);
    console.log("");
  } catch (e) {
    console.log(`【${dbPath}】读取失败: ${e.message}\n`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

console.log("=".repeat(70));
console.log(`全部库合计: ${grandSessions} 会话 | 墙钟 ${grandWall.toFixed(0)}s = ${(grandWall / 3600).toFixed(4)}h | 音频 ${grandAudio.toFixed(0)}s = ${(grandAudio / 3600).toFixed(4)}h`);
console.log(`控制台显示: 1.1042h = ${(1.1042 * 3600).toFixed(0)}s`);
console.log(`差额（控制台 - 全库墙钟）: ${((1.1042 * 3600) - grandWall).toFixed(0)}s = ${(1.1042 - grandWall / 3600).toFixed(4)}h`);

// 找成员报过但主库没有的会话
console.log("\n=== 成员报过、但需确认在哪个库的会话 ===");
for (const want of ["f941151f", "ae6d96d7", "b54b7436", "9a416211", "87375fb3", "190ba540"]) {
  const hits = allSessions.filter((s) => s.short === want);
  if (hits.length) {
    for (const h of hits) console.log(`  ${want}: 在 ${h.db} | 墙钟 ${h.wall ? h.wall.toFixed(0) + "s" : "未结束"} | 音频 ${h.audio.toFixed(0)}s`);
  } else {
    console.log(`  ${want}: 所有库中均未找到`);
  }
}
