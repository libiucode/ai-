import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/main/storage/store";
import { migrate, readVersion, CURRENT_SCHEMA_VERSION } from "../src/main/storage/migrations";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";

/**
 * 语速时间基标定（v6 迁移 + 会话级 ratio）回归测试。
 *
 * 背景：`speech_intervals` 存的是音频轴（按样本累加），而 `computeMetrics`
 * 拿墙钟窗口去裁剪它 —— 两条轴混用导致 speechMs / charsPerSpeechMinute /
 * longestSilenceMs 失真。修法是「写入端不动 + 读取端用会话级 ratio 标定」。
 *
 * 为什么必须会话级：实时链路查 60s 子窗口、报告链路查全会话，
 * 用窗口跨度算因子会让**同一场会话给出两种语速**。
 */

const resources: Array<{ store: Store; dir: string; orch?: SessionOrchestrator }> = [];
afterEach(async () => {
  for (const { orch, store, dir } of resources.splice(0)) {
    if (orch) await orch.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function tempDir(tag: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  return dir;
}

function makeV5Db(file: string): Database.Database {
  return new Database(file);
}

describe("schema v6 迁移：timebase + audio_clock_ratio", () => {
  it("新库即有 speech_intervals.timebase 与 sessions.audio_clock_ratio", () => {
    const dir = tempDir("tb-mig");
    const store = new Store(path.join(dir, "new.db"));
    resources.push({ store, dir });
    expect(readVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);

    const cols = store.db.prepare(`PRAGMA table_info(speech_intervals)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("timebase");
    const scols = store.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    expect(scols.map((c) => c.name)).toContain("audio_clock_ratio");
  });

  it("历史行的 timebase 默认为 'audio'（既有 8968 条确实是音频轴，标注正确）", () => {
    const dir = tempDir("tb-mig");
    const store = new Store(path.join(dir, "x.db"));
    resources.push({ store, dir });
    store.createSession({ id: "s1", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
    store.insertSpeechInterval({ id: "iv1", sessionId: "s1", startMs: 0, endMs: 1000 });
    const row = store.db.prepare(`SELECT timebase FROM speech_intervals WHERE id='iv1'`).get() as { timebase: string };
    expect(row.timebase).toBe("audio");
  });

  it("老会话的 audio_clock_ratio 为 NULL —— 表示「未标定」，不得假装修好", () => {
    const dir = tempDir("tb-mig");
    const store = new Store(path.join(dir, "y.db"));
    resources.push({ store, dir });
    store.createSession({ id: "old", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
    expect(store.getSessionAudioClockRatio("old")).toBeNull();
  });

  it("v5 老库升级到 v6 后老数据不丢", () => {
    const dir = tempDir("tb-upgrade");
    const file = path.join(dir, "old.db");
    const db = makeV5Db(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, started_at_iso TEXT NOT NULL, ended_at_iso TEXT,
        audio_source TEXT NOT NULL, device_id TEXT, status TEXT NOT NULL DEFAULT 'active',
        framework_id TEXT, speaker_id TEXT, speaker_name TEXT, end_reason TEXT, gap_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS speech_intervals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL
      );
      INSERT OR REPLACE INTO schema_version(version) VALUES (5);
    `);
    db.prepare(`INSERT INTO sessions (id, started_at_iso, audio_source, status, gap_count) VALUES ('keep','2026-10-14T10:00:00Z','microphone','stopped',3)`).run();
    db.prepare(`INSERT INTO speech_intervals (id, session_id, start_ms, end_ms) VALUES ('iv-keep','keep',0,5000)`).run();
    db.close();

    const reopened = new Database(file);
    migrate(reopened);
    expect(readVersion(reopened)).toBe(CURRENT_SCHEMA_VERSION);
    // 老数据必须原样保留
    const s = reopened.prepare(`SELECT id, gap_count, audio_clock_ratio FROM sessions WHERE id='keep'`).get() as { id: string; gap_count: number; audio_clock_ratio: number | null };
    expect(s.id).toBe("keep");
    expect(s.gap_count).toBe(3);
    expect(s.audio_clock_ratio).toBeNull();
    const iv = reopened.prepare(`SELECT start_ms, end_ms, timebase FROM speech_intervals WHERE id='iv-keep'`).get() as { start_ms: number; end_ms: number; timebase: string };
    expect(iv.start_ms).toBe(0);
    expect(iv.end_ms).toBe(5000);
    expect(iv.timebase).toBe("audio");
    // 迁移幂等
    expect(() => migrate(reopened)).not.toThrow();
    reopened.close();
  });
});

describe("会话级标定因子的读写", () => {
  it("set 后能读回；非法值拒绝写入并保持 NULL", () => {
    const dir = tempDir("ratio");
    const store = new Store(path.join(dir, "r.db"));
    resources.push({ store, dir });
    store.createSession({ id: "s", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });

    expect(store.setSessionAudioClockRatio("s", 1.692)).toBe(true);
    expect(store.getSessionAudioClockRatio("s")).toBeCloseTo(1.692, 6);

    for (const bad of [0, -1, NaN, Infinity]) {
      const dir2 = tempDir("ratio-bad");
      const s2 = new Store(path.join(dir2, "b.db"));
      s2.createSession({ id: "b", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
      expect(s2.setSessionAudioClockRatio("b", bad), String(bad)).toBe(false);
      expect(s2.getSessionAudioClockRatio("b"), String(bad)).toBeNull();
      s2.close();
      fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("不存在的会话返回 null，不抛错", () => {
    const dir = tempDir("ratio-none");
    const store = new Store(path.join(dir, "n.db"));
    resources.push({ store, dir });
    expect(store.setSessionAudioClockRatio("nope", 1.5)).toBe(false);
    expect(store.getSessionAudioClockRatio("nope")).toBeNull();
  });
});

describe("报告侧：标定状态必须如实标注", () => {
  it("未标定的会话：报告标注 uncalibrated，且 HTML 明确警示可能失真", async () => {
    const dir = tempDir("report-uncal");
    const store = new Store(path.join(dir, "r.db"));
    resources.push({ store, dir });
    store.createSession({ id: "old-sess", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
    store.insertSegment({ id: "s1", sessionId: "old-sess", connectionId: "c", sourceSeq: 0, startMs: 0, endMs: 5000, text: "测试文本", isFinal: true, createdAt: new Date().toISOString() });
    store.insertSpeechInterval({ id: "i1", sessionId: "old-sess", startMs: 0, endMs: 5000 });
    store.updateSessionStatus("old-sess", "stopped", new Date().toISOString(), "user");

    const { buildReportSummary, buildHtmlReport } = await import("../src/main/report/reportBuilder");
    const report = buildReportSummary(store, "old-sess");
    expect(report).not.toBeNull();
    // 老会话没有 audio_clock_ratio → 必须标 uncalibrated，不能默认说可信
    expect(report!.metrics.calibration).toBe("uncalibrated");

    const html = buildHtmlReport(report!);
    expect(html).toContain("未标定");
    expect(html).toContain("可能失真");
  });

  it("已标定的会话：报告标注 calibrated", async () => {
    const dir = tempDir("report-cal");
    const store = new Store(path.join(dir, "c.db"));
    resources.push({ store, dir });
    store.createSession({ id: "new-sess", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
    store.insertSegment({ id: "s1", sessionId: "new-sess", connectionId: "c", sourceSeq: 0, startMs: 0, endMs: 5000, text: "测试文本", isFinal: true, createdAt: new Date().toISOString() });
    store.insertSpeechInterval({ id: "i1", sessionId: "new-sess", startMs: 0, endMs: 5000 });
    store.setSessionAudioClockRatio("new-sess", 1.1);
    store.updateSessionStatus("new-sess", "stopped", new Date().toISOString(), "user");

    const { buildReportSummary, buildHtmlReport } = await import("../src/main/report/reportBuilder");
    const report = buildReportSummary(store, "new-sess");
    expect(report!.metrics.calibration).toBe("calibrated");
    const html = buildHtmlReport(report!);
    expect(html).toContain("已按音频钟标定");
    expect(html).not.toContain("可能失真");
  });

  it("标定会真实影响报告里的语速（不只是标注）", async () => {
    const dir = tempDir("report-effect");
    const store = new Store(path.join(dir, "e.db"));
    resources.push({ store, dir });
    // 构造「音频轴偏慢」：区间跨度 10000，墙钟跨度靠 endMs 撑到 60000
    store.createSession({ id: "s", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
    store.insertSegment({ id: "s1", sessionId: "s", connectionId: "c", sourceSeq: 0, startMs: 0, endMs: 60000, text: "一二三四五六七八九十", isFinal: true, createdAt: new Date().toISOString() });
    store.insertSpeechInterval({ id: "i1", sessionId: "s", startMs: 0, endMs: 10000 });
    store.updateSessionStatus("s", "stopped", new Date().toISOString(), "user");

    const { buildReportSummary } = await import("../src/main/report/reportBuilder");
    const uncal = buildReportSummary(store, "s");
    // ratio = 0.5 → 区间被放大 2 倍 → speechMs 从 10000 变 20000
    store.setSessionAudioClockRatio("s", 0.5);
    const cal = buildReportSummary(store, "s");
    expect(uncal!.metrics.speechMs).toBe(10000);
    expect(cal!.metrics.speechMs).toBe(20000);
    // 语速分母变大 → 数值变小
    expect(cal!.metrics.charsPerSpeechMinute).toBeLessThan(uncal!.metrics.charsPerSpeechMinute);
    // 安全字段不受影响
    expect(cal!.metrics.charsPerTotalMinute).toBe(uncal!.metrics.charsPerTotalMinute);
  });
});

describe("会话结束时自动落库标定因子（端到端）", () => {
  it("会话足够长时 stop() 后写入 ratio，且等于「音频轴跨度 / 墙钟」", async () => {
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "");
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "");
    vi.spyOn(TencentAsrAdapter.prototype, "connect").mockResolvedValue();
    vi.spyOn(TencentAsrAdapter.prototype, "stop").mockResolvedValue();
    vi.spyOn(TencentAsrAdapter.prototype, "sendPcm").mockResolvedValue();

    const dir = tempDir("ratio-e2e");
    const store = new Store(path.join(dir, "e.db"));
    store.saveFramework({ id: "fw", name: "t", productFacts: "", updatedAt: new Date().toISOString(), steps: [], rules: [] });
    const orch = new SessionOrchestrator(store);
    orch.setWindow({ isDestroyed: () => false, webContents: { send: () => {} } } as never);
    resources.push({ store, dir, orch });

    await orch.start({ audioSource: "microphone" });
    const sid = orch.getSnapshot().sessionId!;
    store.insertSpeechInterval({ id: "a", sessionId: sid, startMs: 0, endMs: 30000 });
    store.insertSpeechInterval({ id: "b", sessionId: sid, startMs: 40000, endMs: 60000 });

    // 标定门槛是 30 秒（MIN_CALIBRATION_SPAN_MS）：测试里的会话墙钟只有毫秒级，
    // 因此需要把 nowMs() 推进到门槛之上，才能验证「写入了正确的值」。
    (orch as unknown as { sessionStartEpoch: number }).sessionStartEpoch = Date.now() - 60000;

    await orch.stop();

    const ratio = store.getSessionAudioClockRatio(sid);
    expect(ratio).not.toBeNull();
    // 音频轴跨度 60000 / 墙钟约 60000 → 接近 1（允许调度抖动）
    expect(ratio!).toBeGreaterThan(0.8);
    expect(ratio!).toBeLessThan(1.2);
  });

  it("没有区间时 ratio 保持 NULL（不写猜测值）", async () => {
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "");
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "");
    vi.spyOn(TencentAsrAdapter.prototype, "connect").mockResolvedValue();
    vi.spyOn(TencentAsrAdapter.prototype, "stop").mockResolvedValue();
    vi.spyOn(TencentAsrAdapter.prototype, "sendPcm").mockResolvedValue();

    const dir = tempDir("ratio-empty");
    const store = new Store(path.join(dir, "z.db"));
    const orch = new SessionOrchestrator(store);
    orch.setWindow({ isDestroyed: () => false, webContents: { send: () => {} } } as never);
    resources.push({ store, dir, orch });

    await orch.start({ audioSource: "microphone" });
    const sid = orch.getSnapshot().sessionId!;
    await orch.stop();
    expect(store.getSessionAudioClockRatio(sid)).toBeNull();
  });

  it("极短会话不标定（2026-10-17 实测：11 秒会话算出 ratio=0.018 会放大语速 55 倍）", async () => {
    // 真实事故：一次 11 秒的会话，音频轴跨 0.2 秒 → ratio=0.018。
    // 拿它去标定等于把语速放大 55 倍，是「制造失真」而非「修正失真」。
    // 门槛是 30 秒（见 orchestrator 的 MIN_CALIBRATION_SPAN_MS）。
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "");
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "");
    vi.spyOn(TencentAsrAdapter.prototype, "connect").mockResolvedValue();
    vi.spyOn(TencentAsrAdapter.prototype, "stop").mockResolvedValue();
    vi.spyOn(TencentAsrAdapter.prototype, "sendPcm").mockResolvedValue();

    const dir = tempDir("ratio-short");
    const store = new Store(path.join(dir, "s.db"));
    const orch = new SessionOrchestrator(store);
    orch.setWindow({ isDestroyed: () => false, webContents: { send: () => {} } } as never);
    resources.push({ store, dir, orch });

    await orch.start({ audioSource: "microphone" });
    const sid = orch.getSnapshot().sessionId!;
    // 只有 200ms 区间（模拟短会话里的零星人声）
    store.insertSpeechInterval({ id: "a", sessionId: sid, startMs: 2200, endMs: 2400 });
    // 测试里会话实际只有毫秒级，远小于 30 秒门槛
    await orch.stop();

    expect(store.getSessionAudioClockRatio(sid)).toBeNull();
  });
});
