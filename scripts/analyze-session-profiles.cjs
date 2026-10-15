// 只读：给每个会话做「音源画像」——用于判断哪些会话是干净样本、哪些被污染。
// 输出 JSON 到 evidence/session-profiles.json，供各线引用时查。
// 零 ASR 额度、不采音、不写库。
//
// 用法: electron.exe scripts/analyze-session-profiles.cjs
const path = require("node:path");
const fs = require("node:fs");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true });

const sessions = db.prepare(
  `SELECT id, started_at_iso, ended_at_iso, status, audio_source,
          (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id) AS segs
   FROM sessions s ORDER BY started_at_iso DESC`
).all();

const out = [];
for (const s of sessions) {
  const iv = db.prepare(
    "SELECT start_ms AS s, end_ms AS e FROM speech_intervals WHERE session_id = ? ORDER BY start_ms"
  ).all(s.id);
  const segs = db.prepare(
    "SELECT start_ms, end_ms, text FROM transcript_segments WHERE session_id = ? ORDER BY start_ms"
  ).all(s.id);

  const gaps = [];
  for (let i = 1; i < iv.length; i++) {
    const g = iv[i].s - iv[i - 1].e;
    if (g > 0) gaps.push({ gap: g, from: iv[i - 1].e, to: iv[i].s });
  }
  const maxGap = gaps.length ? Math.max(...gaps.map((x) => x.gap)) : 0;
  const maxGapAt = gaps.length ? gaps.reduce((a, b) => (b.gap > a.gap ? b : a)) : null;
  const lastEnd = iv.length ? iv[iv.length - 1].e : (segs.length ? segs[segs.length - 1].end_ms : 0);

  // 相邻片段之间的巨大空洞 = 音源切换的指纹
  const segJumps = [];
  for (let i = 1; i < segs.length; i++) {
    const j = segs[i].start_ms - segs[i - 1].end_ms;
    if (j >= 30000) segJumps.push({ jumpMs: j, fromMs: segs[i - 1].end_ms, toMs: segs[i].start_ms });
  }

  out.push({
    id: s.id,
    start: s.started_at_iso,
    status: s.status,
    audioSource: s.audio_source,
    segments: segs.length,
    intervals: iv.length,
    lastEndMs: lastEnd,
    maxGapMs: maxGap,
    maxGapFrom: maxGapAt ? maxGapAt.from : null,
    maxGapTo: maxGapAt ? maxGapAt.to : null,
    contentJumps: segJumps,
    headTexts: segs.slice(0, 2).map((t) => ({ at: t.start_ms, text: String(t.text).slice(0, 70) })),
    tailTexts: segs.length > 2 ? segs.slice(-2).map((t) => ({ at: t.start_ms, text: String(t.text).slice(0, 70) })) : [],
  });
}

console.log("=== 会话音源画像 ===");
for (const p of out) {
  console.log(
    `\n${p.id.slice(0, 8)} | ${p.start} | ${p.status} | ${p.audioSource}\n` +
    `  片段${p.segments} 区间${p.intervals} 覆盖${(p.lastEndMs / 1000).toFixed(0)}s  最大空隙${(p.maxGapMs / 1000).toFixed(1)}s` +
    (p.maxGapFrom != null ? ` @${(p.maxGapFrom / 1000).toFixed(1)}s->${(p.maxGapTo / 1000).toFixed(1)}s` : "")
  );
  for (const h of p.headTexts) console.log(`  头[${(h.at / 1000).toFixed(0)}s] ${h.text}`);
  for (const t of p.tailTexts) console.log(`  尾[${(t.at / 1000).toFixed(0)}s] ${t.text}`);
  for (const j of p.contentJumps) console.log(`  ! 内容跳变 ${(j.jumpMs / 1000).toFixed(0)}s: ${(j.fromMs / 1000).toFixed(0)}s -> ${(j.toMs / 1000).toFixed(0)}s`);
}

const outPath = path.join(__dirname, "..", "evidence", "session-profiles.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), sessions: out }, null, 2), "utf8");
console.log(`\nwritten: ${outPath}`);
db.close();
