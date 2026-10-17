/** 查现场：刚才那场直播会话到底发生了什么（只读）。 */
const D = require("D:/ai盯播工具/app/node_modules/better-sqlite3");

async function main() {
  const { app } = require("electron");
  await app.whenReady();
  const db = new D(process.env.APPDATA + "/ai-live-monitor/live-monitor.db", { readonly: true });

  console.log("=== 最近 5 场会话 ===");
  for (const r of db.prepare(
    "select id,started_at_iso,ended_at_iso,audio_source,status,end_reason,gap_count,audio_clock_ratio from sessions order by started_at_iso desc limit 5",
  ).all()) {
    const st = new Date(r.started_at_iso);
    const en = r.ended_at_iso ? new Date(r.ended_at_iso) : null;
    console.log(
      `  ${r.id.slice(0, 8)} ${r.started_at_iso.slice(11, 19)} ${r.audio_source.padEnd(14)} ${r.status.padEnd(8)} end=${(r.end_reason || "-").padEnd(20)} 时长=${en ? ((en - st) / 1000).toFixed(0) + "s" : "进行中"} gap=${r.gap_count} ratio=${r.audio_clock_ratio ?? "NULL"}`,
    );
  }

  console.log("\n=== 各会话的转写/分析/问题 ===");
  for (const r of db.prepare("select id from sessions order by started_at_iso desc limit 5").all()) {
    const segs = db.prepare("select start_ms,end_ms,text from transcript_segments where session_id=? order by start_ms").all(r.id);
    const vad = db.prepare("select count(*) c from speech_intervals where session_id=?").get(r.id).c;
    const runs = db.prepare("select count(*) c from analysis_runs where session_id=?").get(r.id).c;
    const iss = db.prepare("select count(*) c from issues where session_id=?").get(r.id).c;
    console.log(`\n  [${r.id.slice(0, 8)}] 转写 ${segs.length} / VAD ${vad} / 分析 ${runs} / 问题 ${iss}`);
    segs.slice(0, 12).forEach((s) => console.log(`      [${(s.start_ms / 1000).toFixed(1)}-${(s.end_ms / 1000).toFixed(1)}s] ${s.text.slice(0, 60)}`));
  }

  db.close();
  app.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
