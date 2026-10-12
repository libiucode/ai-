import { describe, it, expect } from "vitest";
import { computeMetrics, normalizedSimilarity, detectSpeechIntervals } from "../src/main/analysis/metrics";
import { WindowScheduler, segmentsInWindow } from "../src/main/analysis/windowScheduler";
import { matchRules, ScriptLoopState } from "../src/main/analysis/ruleEngine";
import type { TranscriptSegment } from "../src/shared/contracts";

function seg(id: string, startMs: number, endMs: number, text: string): TranscriptSegment {
  return {
    id,
    sessionId: "s1",
    connectionId: "c1",
    sourceSeq: 0,
    startMs,
    endMs,
    text,
    isFinal: true,
    createdAt: new Date().toISOString(),
  };
}

describe("客观指标", () => {
  it("字数与语速", () => {
    const m = computeMetrics(
      [seg("a", 0, 5000, "大家好欢迎"), seg("b", 10000, 12000, "hello world today")],
      [{ startMs: 0, endMs: 12000 }],
      0,
      60000,
    );
    expect(m.chineseChars).toBe(5);
    expect(m.englishWords).toBe(3);
    expect(m.silenceMs).toBe(48000);
  });

  it("相似度重复检测", () => {
    expect(normalizedSimilarity("这个产品效果很好", "这个产品效果很好")).toBe(1);
    expect(normalizedSimilarity("abc", "xyz")).toBeLessThan(0.5);
  });

  it("VAD", () => {
    const pcm = new Int16Array(1600).fill(3000);
    const silence = new Int16Array(1600);
    const intervals = detectSpeechIntervals([
      { startMs: 0, durationMs: 100, pcm: silence.buffer.slice(0) },
      { startMs: 100, durationMs: 200, pcm: pcm.buffer.slice(0) },
      { startMs: 300, durationMs: 100, pcm: silence.buffer.slice(0) },
    ]);
    expect(intervals.length).toBe(1);
    expect(intervals[0].startMs).toBe(100);
  });
});

describe("滑动窗口调度", () => {
  it("不重叠时逐窗运行，重叠时仅保留最新等待任务", async () => {
    const runs: string[] = [];
    let resolveFirst: (() => void) | null = null;
    const scheduler = new WindowScheduler(60000, 300000, {
      getNow: () => 0,
      getWindow: async (s, e) => {
        runs.push(`${s}-${e}`);
        if (runs.length === 1) {
          await new Promise<void>((r) => (resolveFirst = r));
        }
      },
    });
    scheduler.enqueue(0, 300000);
    scheduler.enqueue(60000, 360000);
    scheduler.enqueue(120000, 420000);
    resolveFirst!();
    await new Promise((r) => setTimeout(r, 10));
    expect(runs.length).toBe(2); // first + only newest waiting
  });

  it("跨边界片段被纳入", () => {
    const segs = [seg("x", 250000, 320000, "跨边界")];
    expect(segmentsInWindow(segs, 300000, 600000).length).toBe(1);
  });
});

describe("规则引擎", () => {
  it("命中绝对化用语", () => {
    const hits = matchRules("这个产品百分之百有效，保证所有人满意", { framework: null, productFacts: "" });
    expect(hits.some((h) => h.matchedText === "百分之百")).toBe(true);
    expect(hits.some((h) => h.matchedText === "保证")).toBe(true);
  });

  it("话术循环只在触发词时推进", () => {
    const st = new ScriptLoopState();
    expect(st.feed("今天天气不错", 0)).toBeNull();
    expect(st.feed("欢迎新来的朋友们", 100)).toBe("opening");
    expect(st.feed("随便聊聊", 200)).toBeNull();
    expect(st.feed("点击小黄车下单", 300)).toBe("cta");
    st.reset(0);
    expect(st.current).toBe("idle");
  });
});
