import { describe, it, expect } from "vitest";
import { computeMetrics } from "../src/main/analysis/metrics";
import type { TranscriptSegment } from "../src/shared/contracts";

/**
 * metrics 时间基契约（2026-10-15 定，见 docs/metrics-timebase.md）。
 *
 * `computeMetrics` 里混用两条时间轴：
 * - **墙钟**：`windowEndMs - windowStartMs`、`transcript_segments.startMs`
 * - **音频轴**：`speech_intervals`（`PcmResamplerSlicer.nextStartMs`，按样本数累加）
 *
 * 音频轴在「同一份音频被送两遍」时跑到墙钟前面（实测 1.27~1.69 倍），
 * 本文件钉住「哪些字段失真、失真成什么样」。
 *
 * ⚠️ 最重要的实测结论：**失真不是简单乘一个系数**。
 * 窗口是墙钟、区间是音频轴，越界的讲话会被整段裁掉，
 * 所以 `speechMs` 可能涨也可能跌，极端情形直接归零。
 *
 * 零额度：全部用构造输入，不跑真实采集。
 */

const RATIO = 1.69;

function seg(id: string, startMs: number, endMs: number, text: string): TranscriptSegment {
  return {
    id, sessionId: "s1", connectionId: "c1", sourceSeq: 0,
    startMs, endMs, text, isFinal: true, createdAt: new Date().toISOString(),
  };
}

/** 把音频轴（区间与片段）按 ratio 放大，墙钟窗口保持不变。 */
function drift(
  segments: TranscriptSegment[],
  intervals: Array<{ startMs: number; endMs: number }>,
  ratio: number,
): { segments: TranscriptSegment[]; intervals: Array<{ startMs: number; endMs: number }> } {
  return {
    segments: segments.map((s) => seg(s.id, s.startMs * ratio, s.endMs * ratio, s.text)),
    intervals: intervals.map((iv) => ({ startMs: iv.startMs * ratio, endMs: iv.endMs * ratio })),
  };
}

const WALL_END = 60000;
const TEXT = "一二三四五六七八九十"; // 10 汉字

describe("时间基：安全的字段在漂移时完全不变", () => {
  const intervals = [{ startMs: 5000, endMs: 20000 }, { startMs: 40000, endMs: 55000 }];
  const segments = [
    seg("a", 5000, 12000, TEXT), seg("b", 12000, 20000, TEXT),
    seg("c", 40000, 47000, TEXT), seg("d", 47000, 55000, TEXT),
  ];

  it("totalMs 是墙钟，不受音频轴漂移影响", () => {
    const base = computeMetrics(segments, intervals, 0, WALL_END);
    const d = drift(segments, intervals, RATIO);
    const drifted = computeMetrics(d.segments, d.intervals, 0, WALL_END);
    expect(base.totalMs).toBe(60000);
    expect(drifted.totalMs).toBe(60000);
  });

  it("charsPerTotalMinute 分母是墙钟，不受影响", () => {
    const base = computeMetrics(segments, intervals, 0, WALL_END);
    const d = drift(segments, intervals, RATIO);
    const drifted = computeMetrics(d.segments, d.intervals, 0, WALL_END);
    // 字数 40、窗口 60 秒 → 40/1 分钟 = 40
    expect(base.charsPerTotalMinute).toBe(40);
    expect(drifted.charsPerTotalMinute).toBe(40);
  });

  it("字数统计无时间基，不受影响", () => {
    const base = computeMetrics(segments, intervals, 0, WALL_END);
    const d = drift(segments, intervals, RATIO);
    const drifted = computeMetrics(d.segments, d.intervals, 0, WALL_END);
    expect(drifted.chineseChars).toBe(base.chineseChars);
    expect(drifted.englishWords).toBe(base.englishWords);
  });

  it("paceChanges 用墙钟锚的片段时间戳，不受影响", () => {
    // 前 5 秒 30 字、后 5 秒 5 字 → 桶间变化 ≥50% 触发 paceChanges。
    // 漂移后片段时间戳被放大，桶号整体右移，但**相邻桶的比值不变**。
    const paceSegments = [
      seg("p1", 0, 4000, "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"),
      seg("p2", 5000, 9000, "一二三四五"),
    ];
    const base = computeMetrics(paceSegments, intervals, 0, 20000);
    const d = drift(paceSegments, intervals, RATIO);
    const drifted = computeMetrics(d.segments, d.intervals, 0, 20000);
    expect(base.paceChanges.length).toBeGreaterThan(0);
    // 桶号变了（锚在放大后的时间戳上），但「检测到语速突变」这个结论不变
    expect(drifted.paceChanges.length).toBe(base.paceChanges.length);
    expect(drifted.paceChanges[0].delta).toBeCloseTo(base.paceChanges[0].delta, 6);
  });
});

describe("时间基：失真的字段（实测方向，不是推理）", () => {
  it("场景 A：讲话集中在中段 —— speechMs 反而下降（被窗口裁掉）", () => {
    const intervals = [{ startMs: 5000, endMs: 20000 }, { startMs: 40000, endMs: 55000 }];
    const segments = [
      seg("a", 5000, 12000, TEXT), seg("b", 12000, 20000, TEXT),
      seg("c", 40000, 47000, TEXT), seg("d", 47000, 55000, TEXT),
    ];
    const base = computeMetrics(segments, intervals, 0, WALL_END);
    const d = drift(segments, intervals, RATIO);
    const drifted = computeMetrics(d.segments, d.intervals, 0, WALL_END);

    expect(base.speechMs).toBe(30000);
    // 音频轴放大 1.69 倍后：第二段 [67600,92950] 整个越出 60000 窗口被裁，
    // 只剩第一段 [8450,33800] → 25350。**比原来更少。**
    expect(drifted.speechMs).toBe(25350);
    expect(drifted.speechMs).toBeLessThan(base.speechMs);
    // 反向：静默变多
    expect(drifted.silenceMs).toBeGreaterThan(base.silenceMs);
    // 语速被高估（字数没变、分母变小）
    expect(drifted.charsPerSpeechMinute).toBeGreaterThan(base.charsPerSpeechMinute);
    // 最长静默被拉长
    expect(drifted.longestSilenceMs).toBeGreaterThan(base.longestSilenceMs);
  });

  it("场景 B：讲话均匀铺满窗口 —— speechMs 上涨但没有 1.69 倍", () => {
    const ivs: Array<{ startMs: number; endMs: number }> = [];
    for (let t = 0; t < 60000; t += 10000) ivs.push({ startMs: t, endMs: t + 5000 });
    const segments = ivs.map((iv, i) => seg(`s${i}`, iv.startMs, iv.endMs, TEXT));
    const base = computeMetrics(segments, ivs, 0, WALL_END);
    const d = drift(segments, ivs, RATIO);
    const drifted = computeMetrics(d.segments, d.intervals, 0, WALL_END);

    expect(base.speechMs).toBe(30000);
    expect(drifted.speechMs).toBeGreaterThan(base.speechMs);
    // 关键：不是 1.69 倍（那只在窗口也跟着放大时才成立）
    expect(drifted.speechMs / base.speechMs).toBeLessThan(RATIO);
    expect(drifted.charsPerTotalMinute).toBe(base.charsPerTotalMinute);
  });

  it("场景 C（最危险）：讲话在窗口尾部 —— 全部被裁，语速报 0", () => {
    const intervals = [{ startMs: 45000, endMs: 55000 }];
    const segments = [seg("a", 45000, 55000, TEXT)];
    const base = computeMetrics(segments, intervals, 0, WALL_END);
    const d = drift(segments, intervals, RATIO);
    const drifted = computeMetrics(d.segments, d.intervals, 0, WALL_END);

    expect(base.speechMs).toBe(10000);
    expect(base.charsPerSpeechMinute).toBeGreaterThan(0);
    // 漂移后整段越出窗口：
    expect(drifted.speechMs).toBe(0);
    expect(drifted.charsPerSpeechMinute).toBe(0);
    // 「整场都是静默」这个结论是漂移造出来的，不是事实
    expect(drifted.longestSilenceMs).toBe(60000);
  });

  it("场景 D（隔离裁剪）：窗口也随音频轴放大时，speechMs 才正好是 1.69 倍", () => {
    // 这个场景不是真实链路（真实窗口是墙钟），保留它是为了钉住：
    // 「1.69 倍」这个数是纯缩放场景的量，不能直接套到真实窗口上。
    const intervals = [{ startMs: 5000, endMs: 20000 }, { startMs: 40000, endMs: 55000 }];
    const segments = [
      seg("a", 5000, 12000, TEXT), seg("b", 12000, 20000, TEXT),
      seg("c", 40000, 47000, TEXT), seg("d", 47000, 55000, TEXT),
    ];
    const d = drift(segments, intervals, RATIO);
    const scaled = computeMetrics(d.segments, d.intervals, 0, WALL_END * RATIO);
    const base = computeMetrics(segments, intervals, 0, WALL_END);
    expect(scaled.speechMs / base.speechMs).toBeCloseTo(RATIO, 6);
  });
});

describe("契约回归：失真字段不得被当作精确值（钉住已知行为）", () => {
  it("speechMs 与 silenceMs 恒等于 totalMs（两者反向，和为窗口长）", () => {
    const intervals = [{ startMs: 0, endMs: 30000 }];
    const segments = [seg("a", 0, 30000, TEXT)];
    const m = computeMetrics(segments, intervals, 0, 60000);
    expect(m.speechMs + m.silenceMs).toBe(m.totalMs);
  });

  it("无漂移时（ratio=1）失真字段与安全字段都保持基线值", () => {
    const intervals = [{ startMs: 5000, endMs: 20000 }];
    const segments = [seg("a", 5000, 20000, TEXT)];
    const base = computeMetrics(segments, intervals, 0, 60000);
    const same = drift(segments, intervals, 1);
    const m = computeMetrics(same.segments, same.intervals, 0, 60000);
    expect(m.speechMs).toBe(base.speechMs);
    expect(m.longestSilenceMs).toBe(base.longestSilenceMs);
    expect(m.charsPerSpeechMinute).toBe(base.charsPerSpeechMinute);
  });
});

/**
 * 标定（2026-10-16 引入）：会话级 audioClockRatio 把音频轴区间缩放到墙钟。
 *
 * 上面「失真的字段」那组用例钉的是**未标定**行为（ratio 缺省 = 1），
 * 它们同时是 docs/metrics-timebase.md 的实测证据，必须保留可复现。
 * 下面这组钉的是**标定后**的行为。
 */
describe("音频钟标定：audioClockRatio 让失真字段回到墙钟口径", () => {
  it("缺省不传 ratio 时，行为与标定引入前逐字节一致（历史会话/既有调用方）", () => {
    const intervals = [{ startMs: 5000, endMs: 20000 }, { startMs: 40000, endMs: 55000 }];
    const segments = [
      seg("a", 5000, 12000, TEXT), seg("b", 12000, 20000, TEXT),
      seg("c", 40000, 47000, TEXT), seg("d", 47000, 55000, TEXT),
    ];
    const omitted = computeMetrics(segments, intervals, 0, WALL_END);
    const explicitOne = computeMetrics(segments, intervals, 0, WALL_END, 1);
    expect(omitted).toEqual(explicitOne);
  });

  it("场景 A 标定后：讲话不再被裁掉，speechMs 回到 30000", () => {
    const intervals = [{ startMs: 5000, endMs: 20000 }, { startMs: 40000, endMs: 55000 }];
    const segments = [
      seg("a", 5000, 12000, TEXT), seg("b", 12000, 20000, TEXT),
      seg("c", 40000, 47000, TEXT), seg("d", 47000, 55000, TEXT),
    ];
    const d = drift(segments, intervals, RATIO);
    // 未标定：25350（第二段被窗口裁掉）
    expect(computeMetrics(d.segments, d.intervals, 0, WALL_END).speechMs).toBe(25350);
    // 标定后：把音频轴区间除回 RATIO，应恢复为真实的 30000
    const calibrated = computeMetrics(d.segments, d.intervals, 0, WALL_END, RATIO);
    expect(calibrated.speechMs).toBe(30000);
    // 与未漂移基线一致 —— 这才是「修好了」的判据
    const base = computeMetrics(segments, intervals, 0, WALL_END);
    expect(calibrated.speechMs).toBe(base.speechMs);
    expect(calibrated.longestSilenceMs).toBe(base.longestSilenceMs);
    expect(calibrated.charsPerSpeechMinute).toBeCloseTo(base.charsPerSpeechMinute, 6);
  });

  it("场景 C（最危险）标定后：不再报「整场静默 / 语速 0」", () => {
    const intervals = [{ startMs: 45000, endMs: 55000 }];
    const segments = [seg("a", 45000, 55000, TEXT)];
    const d = drift(segments, intervals, RATIO);
    // 未标定：整段被推出窗口 → 语速 0、最长静默 = 整个窗口（都是漂移造的假事实）
    expect(computeMetrics(d.segments, d.intervals, 0, WALL_END).speechMs).toBe(0);
    // 标定后：恢复为真实的 10000ms
    const calibrated = computeMetrics(d.segments, d.intervals, 0, WALL_END, RATIO);
    expect(calibrated.speechMs).toBe(10000);
    expect(calibrated.charsPerSpeechMinute).toBeGreaterThan(0);
    expect(calibrated.longestSilenceMs).toBeLessThan(WALL_END);
  });

  it("ratio < 1（音频轴落后，实测 8/10 场属此类）会放大区间", () => {
    // 9df419b4 实测比值 0.044 是最极端的一类；此处用 0.5 便于断言。
    const intervals = [{ startMs: 0, endMs: 10000 }];
    const segments = [seg("a", 0, 10000, TEXT)];
    const m = computeMetrics(segments, intervals, 0, 60000, 0.5);
    // 10000 / 0.5 = 20000
    expect(m.speechMs).toBe(20000);
  });

  it("ratio 非法（0 / 负数 / NaN / Infinity）一律按 1 处理，绝不产出 NaN", () => {
    const intervals = [{ startMs: 0, endMs: 10000 }];
    const segments = [seg("a", 0, 10000, TEXT)];
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      const m = computeMetrics(segments, intervals, 0, 60000, bad);
      expect(Number.isNaN(m.speechMs), String(bad)).toBe(false);
      expect(m.speechMs, String(bad)).toBe(10000);
      expect(Number.isFinite(m.charsPerSpeechMinute), String(bad)).toBe(true);
    }
  });

  it("标定不会改变本来就安全的字段", () => {
    const intervals = [{ startMs: 5000, endMs: 20000 }, { startMs: 40000, endMs: 55000 }];
    const segments = [
      seg("a", 5000, 12000, TEXT), seg("b", 12000, 20000, TEXT),
      seg("c", 40000, 47000, TEXT), seg("d", 47000, 55000, TEXT),
    ];
    const d = drift(segments, intervals, RATIO);
    const uncal = computeMetrics(d.segments, d.intervals, 0, WALL_END);
    const cal = computeMetrics(d.segments, d.intervals, 0, WALL_END, RATIO);
    // totalMs / 字数 / 总时语速 / paceChanges 是墙钟锚，标定前后必须一致
    expect(cal.totalMs).toBe(uncal.totalMs);
    expect(cal.chineseChars).toBe(uncal.chineseChars);
    expect(cal.charsPerTotalMinute).toBe(uncal.charsPerTotalMinute);
    expect(cal.paceChanges).toEqual(uncal.paceChanges);
  });
});
