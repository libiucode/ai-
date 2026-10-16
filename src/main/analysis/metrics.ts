import type { TranscriptSegment } from "../../shared/contracts";

/**
 * 一个分析窗口的客观指标。
 *
 * ⚠️ **时间基契约（见 docs/metrics-timebase.md，2026-10-16 起带标定）**
 *
 * 本结构里**混用了两条不同的时间轴**，漂移时表现完全不同：
 *
 * | 字段 | 时间基 | 音频轴漂移时 |
 * |---|---|---|
 * | `totalMs` | **墙钟**（`windowEndMs - windowStartMs`） | ✅ 不受影响 |
 * | `chineseChars` / `englishWords` | 无时间基（纯计数） | ✅ 不受影响 |
 * | `speechMs` | **音频轴**（`speech_intervals`） | ⚠️ 失真（见下） |
 * | `silenceMs` | 音频轴（= `totalMs - speechMs`） | ⚠️ 失真，且**方向相反** |
 * | `charsPerSpeechMinute` | 字数 / 音频轴的分母 | ⚠️ 失真 |
 * | `charsPerTotalMinute` | 字数 / **墙钟**分母 | ✅ 不受影响 |
 * | `longestSilenceMs` | **音频轴** | ⚠️ 失真 |
 * | `paceChanges` | **墙钟锚**（`transcript_segments`） | ✅ 不受影响 |
 *
 * 音频轴 = `PcmResamplerSlicer.nextStartMs`，**本地按样本数累加**，
 * 因此它在会话起止、暂停期间不前进，也会在「同一份音频被送两遍」时跑到前面。
 *
 * ## 标定（2026-10-16 引入）
 *
 * 失真**不是单向的**：只读查用户库实测 10 场有区间的会话，
 * 8 场比值 < 1（最低 0.044 = 音频轴严重落后），2 场 > 1（最高 1.692）。
 * 所以「乘一个固定系数」的假设不成立，任何精确断言都必须先标定。
 *
 * `computeMetrics` 接受可选的 `audioClockRatio`（会话级：音频轴跨度 / 墙钟跨度）：
 * - **缺省 / 传 1** → 行为与标定引入前**逐字节一致**（既有测试与历史会话走这条路）。
 * - **传实际比值** → 音频轴区间先按 `1/ratio` 缩放到墙钟，再裁剪。
 *
 * ⚠️ **即便标定后也只能当估计值**：真实漂移是「成段双份」而非全局均匀缩放，
 * 用整场比值做的线性校正仍有残差。见 `metrics-timebase.md §4` 的边界说明。
 */
export interface WindowMetrics {
  /** 墙钟：分析窗口覆盖的总时长。音频轴漂移时不受影响。 */
  totalMs: number;
  /**
   * 音频轴（已按 audioClockRatio 标定时为标定后值）：窗口内有效讲话时长。
   * ⚠️ 未标定（ratio 缺省/为 1）时失真；标定后仍有残差，不得当精确值。
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

/**
 * 把音频轴区间标定到墙钟。
 *
 * `ratio` = 音频轴跨度 / 墙钟跨度（会话级，落库在 `sessions.audio_clock_ratio`）。
 * - ratio > 1（音频轴跑快了，如双管线 1.692）→ 需要**缩小**
 * - ratio < 1（音频轴落后了，如 0.044）→ 需要**放大**
 * 两者都是乘 `1/ratio`。
 *
 * 非法值（0 / 负数 / NaN / Infinity）一律按 1 处理，绝不产出 NaN——
 * 一个 NaN 会让整份报告的数字变成「NaN」，比失真更难发现。
 */
function calibrateIntervals(
  intervals: Array<{ startMs: number; endMs: number }>,
  ratio: number,
): Array<{ startMs: number; endMs: number }> {
  const safe = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  if (safe === 1) return intervals;
  const k = 1 / safe;
  // 以「音频轴原点」为基准缩放：区间本身就锚在会话起点（startMs 从 0 累加）。
  // 不减去 min(startMs)，因为不减才是「从会话开始缩放」，与 ratio 的定义
  // （整场音频轴跨度 / 整场墙钟跨度）一致。
  return intervals.map((iv) => ({ startMs: iv.startMs * k, endMs: iv.endMs * k }));
}

export function computeMetrics(
  segments: TranscriptSegment[],
  speechIntervals: Array<{ startMs: number; endMs: number }>,
  windowStartMs: number,
  windowEndMs: number,
  audioClockRatio?: number,
): WindowMetrics {
  const totalMs = Math.max(0, windowEndMs - windowStartMs);
  // 窗口裁剪：截断到墙钟窗口。
  // ⚠️ 这里是两条时间轴的交汇点——`speech_intervals` 是音频轴、
  // 窗口边界是墙钟。故裁剪前必须先标定（audioClockRatio 缺省时是恒等变换）。
  const intervals = calibrateIntervals(speechIntervals, audioClockRatio ?? 1)
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
