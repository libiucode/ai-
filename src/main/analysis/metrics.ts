import type { TranscriptSegment } from "../../shared/contracts";

/**
 * 一个分析窗口的客观指标。
 *
 * ⚠️ **时间基契约（2026-10-15 定，见 docs/metrics-timebase.md）**
 *
 * 本结构里**混用了两条不同的时间轴**，漂移时表现完全不同：
 *
 * | 字段 | 时间基 | 音频轴漂移时 |
 * |---|---|---|
 * | `totalMs` | **墙钟**（`windowEndMs - windowStartMs`） | ✅ 不受影响 |
 * | `chineseChars` / `englishWords` | 无时间基（纯计数） | ✅ 不受影响 |
 * | `speechMs` | **音频轴**（`speech_intervals`） | ⚠️ 失真 |
 * | `silenceMs` | 音频轴（= `totalMs - speechMs`） | ⚠️ 失真，且**方向相反** |
 * | `charsPerSpeechMinute` | 字数 / 音频轴的分母 | ⚠️ 失真 |
 * | `charsPerTotalMinute` | 字数 / **墙钟**分母 | ✅ 不受影响 |
 * | `longestSilenceMs` | **音频轴** | ⚠️ 失真 |
 * | `paceChanges` | **墙钟锚**（`transcript_segments`） | ✅ 不受影响 |
 *
 * 音频轴 = `PcmResamplerSlicer.nextStartMs`，**本地按样本数累加**，
 * 在「同一份音频被送两遍」这类异常下会跑到墙钟前面（实测 1.27~1.69 倍，
 * 见 `docs/audio-clock-anomaly.md`）。
 *
 * **不要把 `speechMs` / `longestSilenceMs` 当作精确值对外呈现**——
 * 它们是「在音频轴可信的前提下」的估计。
 */
export interface WindowMetrics {
  /** 墙钟：分析窗口覆盖的总时长。音频轴漂移时不受影响。 */
  totalMs: number;
  /**
   * 音频轴：窗口内有效讲话时长。
   * ⚠️ 失真风险：`speech_intervals` 时间戳来自本地样本数累加，
   * 异常时会被放大；且窗口按墙钟裁剪，超出部分被截掉——
   * 所以漂移时它**不是简单乘一个系数**（实测可涨可跌，见文档 §3）。
   */
  speechMs: number;
  /** 音频轴：`totalMs - speechMs`。与 `speechMs` 反向失真。 */
  silenceMs: number;
  chineseChars: number;
  englishWords: number;
  /** ⚠️ 失真：分母是音频轴的 `speechMs`。 */
  charsPerSpeechMinute: number;
  /** 安全：分母是墙钟的 `totalMs`。 */
  charsPerTotalMinute: number;
  /** 安全：分桶用 `transcript_segments.startMs`（墙钟锚）。 */
  paceChanges: Array<{ fromMs: number; toMs: number; delta: number }>;
  /** ⚠️ 失真：基于音频轴的 `speech_intervals` 间隙。 */
  longestSilenceMs: number;
  maxRepeatSimilarity: number;
  repeatCandidate: { text: string; count: number } | null;
}

const SEGMENT_SLICE_MS = 5000; // bucket for pace measurement

export function countChineseChars(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

export function countEnglishWords(text: string): number {
  return (text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? []).length;
}

export function normalizedSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[\s，。！？、,.!?]/g, "").toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x.length || !y.length) return 0;
  // Levenshtein-based similarity
  const prev = new Array(y.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

export function computeMetrics(
  segments: TranscriptSegment[],
  speechIntervals: Array<{ startMs: number; endMs: number }>,
  windowStartMs: number,
  windowEndMs: number,
): WindowMetrics {
  const totalMs = Math.max(0, windowEndMs - windowStartMs);
  // 窗口裁剪：截断到墙钟窗口。
  // ⚠️ 这里是两条时间轴的交汇点——`speech_intervals` 是音频轴、
  // 窗口边界是墙钟。音频轴漂移时，越出窗口尾部的讲话区间会被**整段裁掉**，
  // 所以 `speechMs` 不是随漂移单调放大（实测可涨可跌，见文档 §3）。
  const intervals = speechIntervals
    .map((iv) => ({ startMs: Math.max(iv.startMs, windowStartMs), endMs: Math.min(iv.endMs, windowEndMs) }))
    .filter((iv) => Number.isFinite(iv.startMs) && Number.isFinite(iv.endMs) && iv.endMs > iv.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: typeof intervals = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.startMs - last.endMs < 200) last.endMs = Math.max(last.endMs, iv.endMs);
    else merged.push({ ...iv });
  }
  const speechMs = merged.reduce((sum, iv) => sum + iv.endMs - iv.startMs, 0);

  let chineseChars = 0;
  let englishWords = 0;
  for (const seg of segments) {
    chineseChars += countChineseChars(seg.text);
    englishWords += countEnglishWords(seg.text);
  }

  const speechMinutes = speechMs / 60000;
  const totalMinutes = totalMs / 60000;

  // pace 分桶用 `transcript_segments.startMs`：它锚在墙钟
  // （= `asrAudioStartMs` + 服务端相对时间），不是音频轴。
  // 音频轴漂移时本字段不受影响——这是本函数里少数「安全」的口径之一。
  const buckets = new Map<number, number>();
  for (const seg of segments) {
    const b = Math.floor(seg.startMs / SEGMENT_SLICE_MS) * SEGMENT_SLICE_MS;
    buckets.set(b, (buckets.get(b) ?? 0) + countChineseChars(seg.text));
  }
  const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const paceChanges: Array<{ fromMs: number; toMs: number; delta: number }> = [];
  let prevRate: number | null = null;
  for (const [b, chars] of sortedBuckets) {
    const rate = chars / (SEGMENT_SLICE_MS / 60000);
    if (prevRate !== null && prevRate > 0) {
      const delta = (rate - prevRate) / prevRate;
      if (Math.abs(delta) >= 0.5) {
        paceChanges.push({ fromMs: b - SEGMENT_SLICE_MS, toMs: b, delta });
      }
    }
    prevRate = rate;
  }

  // 静默间隙：在裁剪后的 VAD 并集上算。
  // ⚠️ 全部基于音频轴的 `merged`，而游标起点是墙钟 `windowStartMs`、
  // 终点是墙钟 `windowEndMs`——又一处两轴交汇。
  // 实测：讲话被推出窗口尾部时，尾部整段变成「静默」，
  // `longestSilenceMs` 会被**显著拉长**（极端情形直接等于整个窗口）。
  let longestSilenceMs = 0;
  let cursorMs = windowStartMs;
  for (const iv of merged) {
    longestSilenceMs = Math.max(longestSilenceMs, iv.startMs - cursorMs);
    cursorMs = iv.endMs;
  }
  longestSilenceMs = Math.max(longestSilenceMs, windowEndMs - cursorMs);

  // repetition: max pairwise similarity among final segments
  let maxRepeatSimilarity = 0;
  let repeatCandidate: { text: string; count: number } | null = null;
  const counts = new Map<string, number>();
  for (let i = 0; i < segments.length; i++) {
    counts.set(segments[i].text, (counts.get(segments[i].text) ?? 0) + 1);
    for (let j = i + 1; j < segments.length; j++) {
      const sim = normalizedSimilarity(segments[i].text, segments[j].text);
      if (sim > maxRepeatSimilarity) maxRepeatSimilarity = sim;
    }
  }
  for (const [text, count] of counts) {
    if (count >= 3 && text.length >= 6) {
      if (!repeatCandidate || count > repeatCandidate.count) {
        repeatCandidate = { text, count };
      }
    }
  }

  return {
    totalMs,
    speechMs,
    silenceMs: totalMs - speechMs,
    chineseChars,
    englishWords,
    charsPerSpeechMinute: speechMinutes > 0 ? (chineseChars + englishWords) / speechMinutes : 0,
    charsPerTotalMinute: totalMinutes > 0 ? (chineseChars + englishWords) / totalMinutes : 0,
    paceChanges,
    longestSilenceMs,
    maxRepeatSimilarity,
    repeatCandidate,
  };
}

/** Simple energy-based VAD over Int16 PCM samples. */
export function detectSpeechIntervals(
  packets: Array<{ startMs: number; durationMs: number; pcm: ArrayBuffer }>,
  threshold = 500,
): Array<{ startMs: number; endMs: number }> {
  const intervals: Array<{ startMs: number; endMs: number }> = [];
  let open: { startMs: number; endMs: number } | null = null;
  for (const p of packets) {
    const samples = new Int16Array(p.pcm);
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += Math.abs(samples[i]);
    const avg = samples.length ? energy / samples.length : 0;
    if (avg > threshold) {
      if (!open) open = { startMs: p.startMs, endMs: p.startMs + p.durationMs };
      else open.endMs = p.startMs + p.durationMs;
    } else if (open) {
      intervals.push(open);
      open = null;
    }
  }
  if (open) intervals.push(open);
  // merge intervals separated by < 200ms
  const merged: typeof intervals = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.startMs - last.endMs < 200) last.endMs = iv.endMs;
    else merged.push({ ...iv });
  }
  return merged;
}
