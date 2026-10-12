import { describe, it, expect } from "vitest";
import { extractJson, verifyIssues, LlmClient } from "../src/main/analysis/llmClient";
import type { TranscriptSegment } from "../src/shared/contracts";

const seg = (id: string, text: string): TranscriptSegment => ({
  id,
  sessionId: "s",
  connectionId: "c",
  sourceSeq: 1,
  startMs: 0,
  endMs: 1000,
  text,
  isFinal: true,
  createdAt: new Date().toISOString(),
});

describe("LLM 输出处理", () => {
  it("从 markdown 代码块提取 JSON", () => {
    const obj = extractJson('```json\n{"issues":[]}\n```');
    expect(obj).toEqual({ issues: [] });
  });

  it("verifyIssues 拒绝不存在的 segmentId 和不连续 quote", () => {
    const segments = [seg("s1", "这个产品效果特别好")];
    const bad = verifyIssues(
      {
        issues: [
          {
            type: "absolutization",
            severity: "warning",
            segmentIds: ["s1", "nope"],
            quote: "效果特别好",
            basis: "x",
            recommendation: "y",
            confidence: 0.9,
            needsReview: true,
          },
          {
            type: "absolutization",
            severity: "warning",
            segmentIds: ["s1"],
            quote: "不存在的原话",
            basis: "x",
            recommendation: "y",
            confidence: 0.9,
            needsReview: true,
          },
        ],
      },
      segments,
    );
    expect(bad.issues.length).toBe(0);
    const good = verifyIssues(
      {
        issues: [
          {
            type: "absolutization",
            severity: "warning",
            segmentIds: ["s1"],
            quote: "效果特别好",
            basis: "绝对化表述",
            recommendation: "改为客观数据",
            confidence: 0.9,
            needsReview: true,
          },
        ],
      },
      segments,
    );
    expect(good.issues.length).toBe(1);
  });

  it("未配置时抛错", async () => {
    const client = new LlmClient();
    await expect(
      client.analyze({
        windowStartMs: 0,
        windowEndMs: 1,
        segments: [],
        rulesSummary: "",
        productFacts: "",
        previousSummary: "",
        metrics: {
          totalMs: 0, speechMs: 0, silenceMs: 0, chineseChars: 0, englishWords: 0,
          charsPerSpeechMinute: 0, charsPerTotalMinute: 0, paceChanges: [],
          longestSilenceMs: 0, maxRepeatSimilarity: 0, repeatCandidate: null,
        },
      }),
    ).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
  });
});
