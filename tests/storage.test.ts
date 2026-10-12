import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/main/storage/store";
import type { Issue, TranscriptSegment } from "../src/shared/contracts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let store: Store;
const seg = (id: string, text: string): TranscriptSegment => ({
  id,
  sessionId: "s1",
  connectionId: "c1",
  sourceSeq: 0,
  startMs: 0,
  endMs: 1000,
  text,
  isFinal: true,
  createdAt: new Date().toISOString(),
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-"));
  store = new Store(path.join(dir, "test.db"));
  store.createSession({ id: "s1", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
});

describe("SQLite 存储", () => {
  it("稳态片段唯一约束去重", () => {
    const s = seg("t1", "hello");
    store.insertSegment(s);
    expect(store.insertSegment({ ...s, id: "t2" })).toBe(false);
    expect(store.querySegments({ sessionId: "s1", finalOnly: true }).length).toBe(1);
  });

  it("会话结束后数据可恢复", () => {
    store.insertSegment(seg("t1", "数据"));
    store.updateSessionStatus("s1", "stopped", new Date().toISOString());
    expect(store.getSession("s1")?.status).toBe("stopped");
    expect(store.querySegments({ sessionId: "s1", finalOnly: true })[0].text).toBe("数据");
  });

  it("按时间范围过滤", () => {
    const a = seg("a", "x"); a.sourceSeq = 1; a.startMs = 0; a.endMs = 5000;
    const b = seg("b", "y"); b.sourceSeq = 2; b.startMs = 10000; b.endMs = 15000;
    store.insertSegment(a);
    store.insertSegment(b);
    const inRange = store.querySegments({ sessionId: "s1", startMs: 5000, endMs: 20000, finalOnly: true });
    expect(inRange.map((s) => s.id)).toEqual(["b"]);
  });

  it("三个重叠窗口相同问题只产生一条持续记录", () => {
    store.insertSegment(seg("e1", "百分之百有效"));
    const baseIssue = (runId: string, id: string): Issue => ({
      id,
      sessionId: "s1",
      analysisRunId: runId,
      type: "absolutization",
      severity: "warning",
      startMs: 0,
      endMs: 1000,
      segmentIds: ["e1"],
      quote: "百分之百",
      basis: "绝对化用语",
      recommendation: "改为客观描述",
      suggestedScript: null,
      confidence: 0.9,
      needsReview: true,
      status: "open",
    });
    const r1 = store.upsertIssue(baseIssue("r1", "i1"), "absolutization||百分之百");
    const r2 = store.upsertIssue(baseIssue("r2", "i2"), "absolutization||百分之百");
    const r3 = store.upsertIssue(baseIssue("r3", "i3"), "absolutization||百分之百");
    expect(r1).toBe("created");
    expect(r2).toBe("updated");
    expect(r3).toBe("updated");
    const issues = store.listIssues("s1");
    expect(issues.length).toBe(1);
    expect(issues[0].occurrence_count).toBe(3);
    expect(issues[0].first_seen_ms).toBe(0);
  });

  it("settings 读写", () => {
    store.setSetting("k", JSON.stringify({ a: 1 }));
    expect(JSON.parse(store.getSetting("k")!)).toEqual({ a: 1 });
  });
});
