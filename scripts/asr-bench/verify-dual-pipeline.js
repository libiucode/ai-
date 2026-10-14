/**
 * 验证「双管线」假说（只读）。
 *
 * 假说：探针脚本同时起了两条采集管线（自建 JS_START_LOOPBACK_LIVE + app 按钮），
 * 都把音频喂给同一个 sendAudioChunk，导致主进程收到约两倍音频，
 * 音频时间轴（speech_intervals 的 nextStartMs）跑到墙钟前面。
 *
 * 验证方法：算「音频时间轴 / 墙钟」比值。
 *   - 单管线应为 ~1.0（音频时长≈真实时长）
 *   - 双管线应接近 ~2.0
 * 再结合脚本时间戳，看哪些会话由探针脚本驱动。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

const DB = "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
const db = new Database(DB, { readonly: true });

const sessions = db.prepare("SELECT id, started_at_iso, ended_at_iso, status, audio_source FROM sessions ORDER BY started_at_iso").all();

console.log("=".repeat(96));
console.log("双管线假说验证：音频时间轴 / 墙钟 比值");
console.log("=".repeat(96));
console.log("会话      开始时刻    墙钟(s)  音频跨度(s)  比值   判定");
console.log("-".repeat(96));

const rows = [];
for (const s of sessions) {
  const si = db.prepare("SELECT MIN(start_ms) a, MAX(end_ms) b, COUNT(*) n FROM speech_intervals WHERE session_id=?").get(s.id);
  if (!si.n) continue;
  const epoch = new Date(s.started_at_iso).getTime();
  const wall = s.ended_at_iso ? (new Date(s.ended_at_iso).getTime() - epoch) / 1000 : (Date.now() - epoch) / 1000;
  const audio = si.b / 1000;
  const ratio = audio / wall;
  let verdict;
  if (ratio > 1.15) verdict = "★ 双管线嫌疑（音频快于墙钟）";
  else if (ratio < 0.85) verdict = "正常（音频少于墙钟，含静默）";
  else verdict = "正常";
  rows.push({ id: s.id, start: s.started_at_iso, wall, audio, ratio, siCount: si.n, verdict });
  console.log(`${s.id.slice(0,8)}  ${s.started_at_iso.slice(11,19)}  ${String(Math.round(wall)).padStart(7)}  ${String(Math.round(audio)).padStart(11)}  ${ratio.toFixed(2).padStart(5)}   ${verdict}`);
}

// 探针脚本的运行时间窗口（从文件修改时间 + 会话起始时刻推断）
console.log("\n" + "=".repeat(96));
console.log("探针脚本时间线（修改时间 = 最后一次运行前被编辑）");
console.log("=".repeat(96));
const scriptDir = "D:\\ai盯播工具\\app\\scripts";
const probes = fs.readdirSync(scriptDir).filter((f) => /^probe-.*\.(ps1|cjs|js)$/.test(f)).map((f) => {
  const st = fs.statSync(path.join(scriptDir, f));
  return { name: f, mtime: st.mtime.toISOString() };
}).sort((a, b) => a.mtime.localeCompare(b.mtime));
for (const p of probes.slice(-12)) console.log(`  ${p.mtime.slice(11,19)}  ${p.name}`);

// 关键：双管线脚本（含 JS_START_LOOPBACK_LIVE + app 按钮）的特征
console.log("\n" + "=".repeat(96));
console.log("含「双管线」特征的脚本（同时用 JS_START_LOOPBACK_LIVE 和 app 按钮）");
console.log("=".repeat(96));
for (const f of fs.readdirSync(scriptDir).filter((x) => x.endsWith(".ps1"))) {
  const txt = fs.readFileSync(path.join(scriptDir, f), "utf8");
  const usesJsLib = /JS_START_LOOPBACK_LIVE/.test(txt);
  const clicksBtn = /监听系统声音/.test(txt);
  if (usesJsLib && clicksBtn) {
    const st = fs.statSync(path.join(scriptDir, f));
    console.log(`  ★ ${f}  (改了 ${st.mtime.toISOString().slice(11,19)})`);
    console.log(`      用 JS_START_LOOPBACK_LIVE: ${usesJsLib}  点 app 按钮: ${clicksBtn}`);
    console.log(`      → 两条管线都会调 sendAudioChunk，音频被送两遍`);
  }
}

// 交叉：比值异常的会话是否落在那些脚本的运行窗口内
console.log("\n" + "=".repeat(96));
console.log("结论");
console.log("=".repeat(96));
const bad = rows.filter((r) => r.ratio > 1.15);
console.log(`音频快于墙钟的会话: ${bad.length} 个`);
for (const b of bad) console.log(`  ${b.id.slice(0,8)}  比值 ${b.ratio.toFixed(2)}  起于 ${b.start.slice(11,19)}`);
console.log("\n这些会话的比值应接近「管线数」：");
console.log("  单管线 → ~1.0（正常会话实测 0.74~1.00）");
console.log("  双管线 → ~2.0（本次异常会话 1.27 / 1.69）");
console.log("  1.27~1.69 落在 1.0~2.0 之间，符合「第二条管线中途启停」的形态。");
db.close();
