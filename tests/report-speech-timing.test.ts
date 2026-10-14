import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage/store";
import { buildReportSummary, buildHtmlReport } from "../src/main/report/reportBuilder";

describe("真实存储时段到报告语速", () => {
  it("返回camelCase时段，双语分子除以讲话/全时段两个不同分母", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-speech-"));
    const store = new Store(path.join(dir, "test.db"));
    try {
      store.createSession({ id: "s1", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
      store.insertSegment({
        id: "t1", sessionId: "s1", connectionId: "c1", sourceSeq: 1,
        startMs: 0, endMs: 120000, text: "你好世界 hello world",
        isFinal: true, createdAt: new Date().toISOString(),
      });
      store.insertSpeechInterval({ id: "v1", sessionId: "s1", startMs: 0, endMs: 60000 });
      store.insertAnalysisRun({ id: "run1", sessionId: "s1", windowId: "window1", status: "success", startedAt: new Date().toISOString() });
      expect(store.querySpeechIntervals("s1", 0, 120000)).toEqual([
        { id: "v1", sessionId: "s1", startMs: 0, endMs: 60000 },
      ]);
      const report = buildReportSummary(store, "s1")!;
      expect(report.metrics.speechMs).toBe(60000);
      expect(report.metrics.silenceMs).toBe(60000);
      expect(report.metrics.chineseChars).toBe(4);
      expect(report.metrics.englishWords).toBe(2);
      expect(report.metrics.charsPerSpeechMinute).toBe(6);
      expect(report.metrics.charsPerTotalMinute).toBe(3);
      expect(report.analysisRuns.total).toBe(1);
      expect(report.asr).toEqual({ connectionCount: null, disconnectCount: null, gapCount: null });
      expect(report.llm.requestCount).toBeNull();
      expect(report.llm.failedCount).toBeNull();
      const html = buildHtmlReport(report);
      expect(html).toContain("6 字词/分");
      expect(html).toContain("3 字词/分");
      expect(html).not.toContain("NaN");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
