import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, readVersion, CURRENT_SCHEMA_VERSION } from "../src/main/storage/migrations";
import { Store } from "../src/main/storage/store";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
}

/** 造一个 v1 老库：只有基线建表语句，没有 framework_id / speaker_id / speaker_name。 */
function createV1Database(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at_iso TEXT NOT NULL,
  ended_at_iso TEXT,
  audio_source TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO schema_version(version) VALUES (1);
INSERT INTO sessions (id, started_at_iso, ended_at_iso, audio_source, device_id, status)
  VALUES ('old-1', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 'systemLoopback', NULL, 'stopped');
  `);
  db.close();
}

describe("schema 迁移", () => {
  it("老库(v1)升级到最新版本，且原有数据不丢", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "v1.db");
    createV1Database(dbPath);

    const db = new Database(dbPath);
    expect(readVersion(db)).toBe(1);
    migrate(db);

    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    // 老记录仍在，新列为 null
    const row = db.prepare("SELECT * FROM sessions WHERE id = 'old-1'").get() as Record<string, unknown>;
    expect(row.id).toBe("old-1");
    expect(row.status).toBe("stopped");
    expect(row.framework_id).toBeNull();
    expect(row.speaker_id).toBeNull();
    expect(row.speaker_name).toBeNull();
    // v4 新列：老库没有 end_reason，读出来是 null（不是 undefined）
    expect(row.end_reason).toBeNull();

    // 四个新列确实存在
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("framework_id");
    expect(cols).toContain("speaker_id");
    expect(cols).toContain("speaker_name");
    expect(cols).toContain("end_reason");
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("迁移可重复执行（幂等），不会因重复加列报错", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "twice.db");
    createV1Database(dbPath);
    const db = new Database(dbPath);
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(readVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("全新空库直接建到最新版本", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "fresh.db"));
    expect(readVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Store 在 v1 老库上可直接使用（模拟用户升级后打开旧数据）", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "upgrade.db");
    createV1Database(dbPath);

    const store = new Store(dbPath);
    const summaries = store.listSessionSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].id).toBe("old-1");
    expect(summaries[0].frameworkId).toBeNull();
    expect(summaries[0].speakerName).toBeNull();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("会话新增字段读写", () => {
  it("createSession 写入 frameworkId / speakerId / speakerName 并可读回", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "w.db"));
    store.createSession({
      id: "s-1",
      startedAtIso: new Date().toISOString(),
      audioSource: "systemLoopback",
      deviceId: null,
      frameworkId: "fw-abc",
      speakerId: "spk-001",
      speakerName: "小王",
    });
    const row = store.getSession("s-1")!;
    expect(row.framework_id).toBe("fw-abc");
    expect(row.speaker_id).toBe("spk-001");
    expect(row.speaker_name).toBe("小王");
    const sum = store.listSessionSummaries()[0];
    expect(sum.frameworkId).toBe("fw-abc");
    expect(sum.speakerId).toBe("spk-001");
    expect(sum.speakerName).toBe("小王");
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("updateSessionFramework 切换框架后落库（历史导出要用切换后的值）", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "sw.db"));
    store.createSession({
      id: "s-2",
      startedAtIso: new Date().toISOString(),
      audioSource: "systemLoopback",
      deviceId: null,
      frameworkId: "fw-old",
    });
    expect(store.updateSessionFramework("s-2", "fw-new")).toBe(true);
    expect(store.getSession("s-2")!.framework_id).toBe("fw-new");
    // 不存在的会话返回 false，不静默成功
    expect(store.updateSessionFramework("nope", "fw-x")).toBe(false);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("closeStaleSessions 收尾残留会话并保留数据（启动清理）", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "stale.db"));
    const now = new Date().toISOString();
    store.createSession({ id: "live-1", startedAtIso: now, audioSource: "systemLoopback", deviceId: null });
    store.createSession({ id: "live-2", startedAtIso: now, audioSource: "microphone", deviceId: null });
    store.updateSessionStatus("live-2", "paused");

    const closed = store.closeStaleSessions("process-restart", now);
    expect(closed).toBe(2);
    expect(store.getSession("live-1")!.status).toBe("stopped");
    expect(store.getSession("live-2")!.status).toBe("stopped");
    // 会话记录本身保留，不是删除
    expect(store.listSessionSummaries().length).toBe(2);
    // 清理动作可追溯
    expect(store.getSetting("last_stale_close_reason")).toContain("process-restart");
    // 结束原因写进会话本身：只看 status='stopped' 无法区分「崩溃残留收尾」与「用户手点结束」
    expect(store.getSession("live-1")!.end_reason).toBe("process-restart");
    expect(store.listSessionSummaries().every((s) => s.endReason === "process-restart")).toBe(true);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("updateSessionStatus 写结束原因，且不覆盖已有原因", () => {
    const dir = tempDir();
    const store = new Store(path.join(dir, "reason.db"));
    const now = new Date().toISOString();
    store.createSession({ id: "r-1", startedAtIso: now, audioSource: "microphone", deviceId: null });
    store.updateSessionStatus("r-1", "stopped", now, "schedule-window-end");
    expect(store.getSession("r-1")!.end_reason).toBe("schedule-window-end");

    // COALESCE 语义：后续调用不传原因时保留旧值，不会被 null 抹掉
    store.updateSessionStatus("r-1", "stopped", now);
    expect(store.getSession("r-1")!.end_reason).toBe("schedule-window-end");

    // 用户手点结束的会话：end_reason 为 null，代表「无自动结束原因」
    store.createSession({ id: "r-2", startedAtIso: now, audioSource: "microphone", deviceId: null });
    store.updateSessionStatus("r-2", "stopped", now, "user");
    expect(store.getSession("r-2")!.end_reason).toBe("user");
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
