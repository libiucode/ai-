import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage/store";
import { buildReportSummary } from "../src/main/report/reportBuilder";
import type { Framework } from "../src/shared/contracts";

/** 报告必须用「本会话实际使用的框架」，不能无脑取列表第一个。 */
describe("报告的话术框架绑定", () => {
  let store: Store;
  let dir: string;

  const frameworkA: Framework = {
    id: "fw-a", name: "商品A话术", productFacts: "A", updatedAt: "2026-10-15T00:00:00.000Z",
    steps: [{ id: "a-open", frameworkId: "fw-a", name: "开场白", priority: 2, maxWaitMs: 120000 }],
    rules: [],
  };
  const frameworkB: Framework = {
    id: "fw-b", name: "商品B话术", productFacts: "B", updatedAt: "2026-10-15T00:00:00.000Z",
    steps: [{ id: "b-open", frameworkId: "fw-b", name: "商品B开场", priority: 2, maxWaitMs: 120000 }],
    rules: [],
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-bind-"));
    store = new Store(path.join(dir, "t.db"));
    store.saveFramework(frameworkA);
    store.saveFramework(frameworkB);
  });

  afterEach(() => {
    store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function session(id: string, frameworkId: string | null) {
    store.createSession({ id, startedAtIso: "2026-10-15T00:00:00Z", audioSource: "microphone", deviceId: null, frameworkId });
    store.insertSegment({
      id: `${id}-seg`, sessionId: id, connectionId: id, sourceSeq: 0,
      startMs: 0, endMs: 5000, text: "大家好欢迎来到直播间", isFinal: true, createdAt: "2026-10-15T00:00:05Z",
    });
  }

  it("用会话绑定的框架，而不是列表第一个", () => {
    session("s-bound", "fw-b");
    const report = buildReportSummary(store, "s-bound")!;
    expect(report.script).not.toBeNull();
    // 关键：必须用商品B，不能被 frameworkA 抢先
    expect(report.script!.frameworkName).toBe("商品B话术");
    expect(report.script!.frameworkSource).toBe("session-bound");
    expect(report.script!.frameworkFallbackReason).toBeNull();
    expect(report.script!.steps.map((s) => s.name)).toEqual(["商品B开场"]);
  });

  it("framework_id 为 null 的老会话：回退默认框架但明确标注", () => {
    session("s-old", null);
    const report = buildReportSummary(store, "s-old")!;
    expect(report.script).not.toBeNull();
    // 老会话仍有覆盖信息（不因为缺 framework_id 就整块丢失）
    expect(report.script!.frameworkName).toBe("商品A话术");
    // 但必须标明这是回退，不许假装准确
    expect(report.script!.frameworkSource).toBe("fallback-unrecorded");
    expect(report.script!.frameworkFallbackReason).toContain("未记录");
  });

  it("framework_id 指向的框架已被删除：不崩、不静默错", () => {
    session("s-deleted", "fw-gone");
    const report = buildReportSummary(store, "s-deleted")!;
    expect(report.script).not.toBeNull();
    // 不崩，但必须用最醒目的降级标记——此时结论可能完全不对
    expect(report.script!.frameworkSource).toBe("fallback-deleted");
    expect(report.script!.frameworkFallbackReason).toContain("已被删除");
    expect(report.script!.frameworkFallbackReason).toContain("可能不准确");
  });

  it("一个框架都没有时 script 为 null（不虚构数据）", () => {
    const bare = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fw-none-")), "t.db"));
    bare.createSession({ id: "s-none", startedAtIso: "2026-10-15T00:00:00Z", audioSource: "microphone", deviceId: null, frameworkId: null });
    const report = buildReportSummary(bare, "s-none")!;
    expect(report.script).toBeNull();
    bare.close?.();
  });
});
