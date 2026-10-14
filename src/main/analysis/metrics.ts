import type { TranscriptSegment } from "../../shared/contracts";

export interface WindowMetrics {
  totalMs: number;
  speechMs: number;
  silenceMs: number;
  chineseChars: number;
  englishWords: number;
  charsPerSpeechMinute: number;
  charsPerTotalMinute: number;
  paceChanges: Array<{ fromMs: number; toMs: number; delta: number }>;
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

  // pace per bucket
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

  // silence gaps in the clipped union of VAD intervals
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
