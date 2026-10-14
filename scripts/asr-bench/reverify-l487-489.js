/**
 * 复核 L487-489 三行会话的内容实质（只读，零额度）。
 *
 * 背景：文档 §6.3.2 那张表用「片段文本是否命中 live-scripts.txt 特征」判 TTS，
 * 但特征串匹配会漏判（识别偏差导致不命中），所以「TTS=0 → 纯直播」不可靠。
 * 本脚本按【内容实质】重判：打印全部片段原文，人眼可判。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const fs = require("node:fs");

const db = new Database("C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", { readonly: true });

// live-scripts.txt 的特征（第一版判据，已知会漏判）
const scriptLines = fs.readFileSync("D:\\ai盯播工具\\app\\scripts\\asr-bench\\live-scripts.txt", "utf8")
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const markers = scriptLines.map((l) => l.replace(/[，。！？、：；\s]/g, "").slice(0, 10)).filter((s) => s.length >= 6);
function hitByFeature(t) {
  const c = String(t || "").replace(/[，。！？、：；\s]/g, "");
  if (c.length < 6) return false;
  return markers.some((m) => c.includes(m));
}

// 更强的判据：TTS 口播的语义特征（商品/直播话术词）
const TTS_STRONG = /无理由退换货|运费险|直播间|链接|下单|优惠券|库存|宝宝|姐妹|家人们|回购|面霜|精华|面膜|护肤|拍下|发顺丰|假一赔|品牌专场|公屏|色号|空瓶|升级版|上链接|手慢/;
// 真实电视/影视内容的语义特征
const TV_STRONG = /长安|将军|丞相|母亲|保重|宪兵|王昌龄|送别|闺怨|江宁|盛唐|丹参|胰岛素|血糖|糖尿病|化糖肽/;

const targets = [
  ["b217299a", "L487"],
  ["5970a6d6", "L488"],
  ["d61e4b32", "L489"],
];

for (const [prefix, lineRef] of targets) {
  const s = db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions WHERE id LIKE ? LIMIT 1").get(prefix + "%");
  if (!s) { console.log(`${prefix}: 不存在`); continue; }
  const segs = db.prepare("SELECT source_seq,start_ms,end_ms,text FROM transcript_segments WHERE session_id=? AND is_final=1 ORDER BY start_ms").all(s.id);
  const si = db.prepare("SELECT MAX(end_ms) m, COUNT(*) n FROM speech_intervals WHERE session_id=?").get(s.id);

  console.log("=".repeat(96));
  console.log(`[${prefix}] 文档 ${lineRef}  ← 需判定`);
  console.log("=".repeat(96));
  console.log(`会话时长 ${s.ended_at_iso ? ((new Date(s.ended_at_iso).getTime()-new Date(s.started_at_iso).getTime())/1000).toFixed(0)+"s" : "?"}  |  VAD区间 ${si.n} 个，最远 ${(si.m/1000).toFixed(0)}s  |  稳态片段 ${segs.length} 条`);

  if (!segs.length) {
    console.log("  （无稳态片段，无法从文本判定）\n");
    continue;
  }

  let featHits = 0, ttsStrong = 0, tvStrong = 0;
  console.log(`\n  全部 ${segs.length} 条片段原文：`);
  for (const x of segs) {
    const f = hitByFeature(x.text), t = TTS_STRONG.test(x.text), v = TV_STRONG.test(x.text);
    if (f) featHits++;
    if (t) ttsStrong++;
    if (v) tvStrong++;
    console.log(`    seq=${x.source_seq} [${(x.start_ms/1000).toFixed(1)}s] feat=${f?"Y":"n"} tts=${t?"Y":"n"} tv=${v?"Y":"n"}`);
    console.log(`      ${x.text.slice(0, 88)}`);
  }
  console.log(`\n  统计：特征命中 ${featHits}/${segs.length}  TTS语义 ${ttsStrong}/${segs.length}  电视语义 ${tvStrong}/${segs.length}`);
  let verdict;
  if (ttsStrong > 0 && tvStrong === 0) verdict = "★ 带货 TTS（非直播）";
  else if (tvStrong > 0 && ttsStrong === 0) verdict = "真实电视/影视内容";
  else if (ttsStrong > 0 && tvStrong > 0) verdict = "混合（两种内容都有）";
  else verdict = "无法从语义特征判定（需人眼）";
  console.log(`  按内容实质判定：${verdict}`);
  console.log("");
}
db.close();
