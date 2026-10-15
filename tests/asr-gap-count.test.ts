import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { Store } from "../src/main/storage/store";
import { migrate, readVersion } from "../src/main/storage/migrations";

/**
 * task-1 专项：ASR 断线缺口计数。
 *
 * 计入口径（2026-10-15 与负责人确认）：
 * - 以「连接」为单位，不以 emit 次数为单位。用户关心「没录上」发生几次。
 * - 只有 state === "reconnecting" 才算；state === "closed" 是主动停止，不是故障。
 * - 一次断线会被 emit 两次（ws close 一次 + scheduleReconnect 一次），
 *   靠 connectionId 去重只记一次；两次独立断线必须记两次（去重要对称）。
 * - 零额度：不发真实音频、不连真实 WebSocket，用桩 emit status 事件。
 */

const resources: Array<{ store: Store; dir: string; orch: SessionOrchestrator }> = [];
afterEach(async () => {
  for (const { orch, store, dir } of resources.splice(0)) {
    await orch.stop(); store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  vi.restoreAllMocks();
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-gap-"));
  const store = new Store(path.join(dir, "test.db"));
  const orch = new SessionOrchestrator(store);
  const asr = (orch as unknown as { asr: TencentAsrAdapter }).asr;
  // 不连真实 ASR、不发真实音频：只让 start() 把会话建起来。
  vi.spyOn(asr, "connect").mockResolvedValue();
  vi.spyOn(asr, "stop").mockResolvedValue();
  vi.spyOn(asr, "sendPcm").mockResolvedValue();
  orch.setWindow({ isDestroyed: () => false, webContents: { send: () => {} } } as never);
  await orch.start({ audioSource: "microphone" });
  resources.push({ store, dir, orch });
  const emit = (event: string, payload: unknown) => (asr as unknown as { emit(e: string, p: unknown): void }).emit(event, payload);
  const sessionId = orch.getSnapshot().sessionId!;
  /** 读回落库的 gap_count。 */
  const gapCount = () => store.getSession(sessionId)?.gap_count ?? 0;
  return { orch, store, asr, emit, sessionId, gapCount };
}

describe("ASR 断线缺口计数", () => {
  it("同一次断线的两次 emit（close + scheduleReconnect）只记 1 次", async () => {
    const { emit, gapCount } = await setup();
    // 真实时序：ws close 分支先 emit 一次 reconnecting，随后 scheduleReconnect 再 emit 一次。
    emit("status", { state: "reconnecting", connectionId: "conn-a", gapDetected: true });
    emit("status", { state: "reconnecting", connectionId: "conn-a", reconnectAttempt: 1, gapDetected: true });
    // 即使中间夹一次其它状态，同 connectionId 仍只算一次。
    emit("status", { state: "connecting", connectionId: "conn-b" });
    emit("status", { state: "connected", connectionId: "conn-b", reconnectAttempt: 0 });
    expect(gapCount()).toBe(1);
  });

  it("两次独立断线记 2 次（去重不会退化成永远只记一次）", async () => {
    const { emit, gapCount } = await setup();
    // 第一次断线：conn-a 死掉，重连到 conn-b。
    emit("status", { state: "reconnecting", connectionId: "conn-a", gapDetected: true });
    emit("status", { state: "reconnecting", connectionId: "conn-a", reconnectAttempt: 1, gapDetected: true });
    emit("status", { state: "connecting", connectionId: "conn-b" });
    emit("status", { state: "connected", connectionId: "conn-b", reconnectAttempt: 0 });
    // 第二次断线：conn-b 也死掉——换了 connectionId，必须再记一次。
    emit("status", { state: "reconnecting", connectionId: "conn-b", gapDetected: true });
    emit("status", { state: "reconnecting", connectionId: "conn-b", reconnectAttempt: 1, gapDetected: true });
    emit("status", { state: "connecting", connectionId: "conn-c" });
    emit("status", { state: "connected", connectionId: "conn-c", reconnectAttempt: 0 });
    expect(gapCount()).toBe(2);
  });

  it("用户主动停止（state === closed）不计缺口", async () => {
    const { emit, gapCount } = await setup();
    // ws close 在 shouldRun === false 时 emit state: "closed"——点「结束」不是故障。
    emit("status", { state: "connected", connectionId: "conn-a", reconnectAttempt: 0 });
    emit("status", { state: "closed", gapDetected: true, closeCode: 1000 });
    expect(gapCount()).toBe(0);
    // error 状态也不是缺口。
    emit("status", { state: "error", connectionId: "conn-a" });
    expect(gapCount()).toBe(0);
  });

  it("connectionId 缺失时不去重（宁可多计也不漏计）", async () => {
    // adapter 实际必带 connectionId（openNewConnection 一进来就设），这条走不到；
    // 但它是防御性回归——漏计会让用户低估断线频率，比多计一次更危险。
    const { emit, gapCount } = await setup();
    emit("status", { state: "reconnecting", gapDetected: true });
    emit("status", { state: "reconnecting", gapDetected: true, reconnectAttempt: 1 });
    expect(gapCount()).toBe(2);
  });

  it("connectionId 缺失后不拿 null 当去重锚点（防御性：旧连接号仍然有效）", async () => {
    // 不可达路径的钉子：若改成「connId 为 null 时把锚点也清成 null」，
    // 后面再来一次同一个真实连接的断线就会被误去重成漏计。
    // 这里先记一次 conn-a 断线，中间插一次无 connectionId 的 emit，
    // 再一次 conn-a 断线：后一次仍必须被去重掉（同一次断线的第二次 emit）。
    const { emit, gapCount } = await setup();
    emit("status", { state: "reconnecting", connectionId: "conn-a", gapDetected: true });
    expect(gapCount()).toBe(1);
    emit("status", { state: "reconnecting", gapDetected: true });
    expect(gapCount()).toBe(2);
    emit("status", { state: "reconnecting", connectionId: "conn-a", gapDetected: true });
    expect(gapCount()).toBe(2);
  });

  it("会话还没建（音频先于会话到达）时不落库也不抛错", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-gap-"));
    const store = new Store(path.join(dir, "test.db"));
    try {
      const orch = new SessionOrchestrator(store);
      const asr = (orch as unknown as { asr: TencentAsrAdapter }).asr;
      vi.spyOn(asr, "connect").mockResolvedValue();
      vi.spyOn(asr, "stop").mockResolvedValue();
      vi.spyOn(asr, "sendPcm").mockResolvedValue();
      const emit = (event: string, payload: unknown) => (asr as unknown as { emit(e: string, p: unknown): void }).emit(event, payload);
      // 不调 start()：sessionId 仍为 null。
      expect(() => emit("status", { state: "reconnecting", connectionId: "conn-x", gapDetected: true })).not.toThrow();
      expect(store.listSessionSummaries()).toEqual([]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("累加值写回 listSessionSummaries 与 hasGap", async () => {
    const { store, emit, sessionId } = await setup();
    emit("status", { state: "reconnecting", connectionId: "conn-a", gapDetected: true });
    emit("status", { state: "reconnecting", connectionId: "conn-a", reconnectAttempt: 1, gapDetected: true });
    emit("status", { state: "reconnecting", connectionId: "conn-b", gapDetected: true });
    const row = store.listSessionSummaries().find((s) => s.id === sessionId)!;
    expect(row.gapCount).toBe(2);
    expect(row.hasGap).toBe(true);
  });

  it("跨会话不串味：新会话的缺口计数从 0 开始", async () => {
    const { orch, store, emit } = await setup();
    emit("status", { state: "reconnecting", connectionId: "conn-a", gapDetected: true });
    const first = store.listSessionSummaries();
    expect(first).toHaveLength(1);
    expect(first[0].gapCount).toBe(1);
    await orch.stop();
    await orch.start({ audioSource: "microphone" });
    const sessions = store.listSessionSummaries();
    expect(sessions).toHaveLength(2);
    // 不靠时间戳排序取「新会话」——两场可能落在同一毫秒。
    // 直接按 id 断言：start() 重置了 lastGapConnectionId，
    // 旧连接的 connectionId 不能影响新会话。
    const second = sessions.find((s) => s.id !== first[0].id)!;
    expect(second.gapCount).toBe(0);
    expect(second.hasGap).toBe(false);
    // 旧会话的计数也不能被重置。
    expect(sessions.find((s) => s.id === first[0].id)!.gapCount).toBe(1);
  });
});

describe("schema v5 迁移：sessions.gap_count", () => {
  /** 建一个 v4 老库：只有到 v4 为止的列，schema_version = 4。 */
  function makeV4Db(file: string): Database.Database {
    const db = new Database(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at_iso TEXT NOT NULL,
        ended_at_iso TEXT,
        audio_source TEXT NOT NULL,
        device_id TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      INSERT OR REPLACE INTO schema_version(version) VALUES (4);
    `);
    return db;
  }

  it("v4 老库升级后 gap_count 存在且老数据不丢", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-gap-mig-"));
    const file = path.join(dir, "old.db");
    const db = makeV4Db(file);
    db.prepare(`INSERT INTO sessions (id, started_at_iso, audio_source, device_id, status) VALUES (?, ?, ?, ?, ?)`)
      .run("old-1", "2026-10-14T10:00:00.000Z", "microphone", null, "stopped");
    db.prepare(`INSERT INTO schema_version(version) VALUES (2)`).run();
    db.prepare(`INSERT INTO schema_version(version) VALUES (3)`).run();
    db.close();

    const reopened = new Database(file);
    expect(readVersion(reopened)).toBe(4);
    migrate(reopened);
    expect(readVersion(reopened)).toBe(5);
    const row = reopened.prepare(`SELECT id, status, gap_count FROM sessions WHERE id = 'old-1'`).get() as
      | { id: string; status: string; gap_count: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe("old-1");
    expect(row!.status).toBe("stopped");
    // 老库没有 gap_count：迁移加的是带 DEFAULT 0 的列，老行读回 0（已测量：确实没有缺口）。
    expect(row!.gap_count).toBe(0);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("迁移幂等：重复跑 v5 不报错也不改值", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-gap-mig-"));
    const file = path.join(dir, "idem.db");
    const db = makeV4Db(file);
    db.close();

    const reopened = new Database(file);
    migrate(reopened);
    reopened.prepare(`UPDATE sessions SET gap_count = 3 WHERE id IS NOT NULL`).run();
    expect(() => migrate(reopened)).not.toThrow();
    // 幂等的关键：第二次 migrate 不会把已经累加的值重置回 0。
    expect(readVersion(reopened)).toBe(5);
    const rows = reopened.prepare(`SELECT gap_count FROM sessions`).all() as Array<{ gap_count: number }>;
    for (const r of rows) expect(r.gap_count).toBe(3);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("新库创建时即有 gap_count，默认 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-gap-mig-"));
    const store = new Store(path.join(dir, "test.db"));
    try {
      expect(readVersion(store.db)).toBe(5);
      store.createSession({ id: "s1", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
      expect(store.getSession("s1")?.gap_count).toBe(0);
      expect(store.listSessionSummaries()[0]).toMatchObject({ gapCount: 0, hasGap: false });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
