import type { TranscriptSegment } from "../../shared/contracts";

export interface WindowSchedulerDeps {
  getNow: () => number; // session-relative ms
  getWindow: (startMs: number, endMs: number) => Promise<void>;
  onSkipped?: (reason: string) => void;
}

/**
 * Sliding window scheduler. At most one analysis running and one waiting.
 * Never blocks callers: tick() only enqueues.
 */
export class WindowScheduler {
  private running = false;
  private waiting: { startMs: number; endMs: number } | null = null;
  private nextBoundary = 0;
  private disposed = false;

  constructor(
    private intervalMs: number,
    private windowMs: number,
    private deps: WindowSchedulerDeps,
  ) {
    if (![30000, 60000, 120000].includes(intervalMs)) {
      throw new Error("interval must be 30/60/120s");
    }
    if (![180000, 300000, 600000].includes(windowMs)) {
      throw new Error("window must be 3/5/10min");
    }
  }

  start(nowMs: number) {
    this.nextBoundary = nowMs + this.intervalMs;
  }

  /** Called periodically (e.g. every second) from a lightweight timer. */
  tick(nowMs: number) {
    if (this.disposed) return;
    while (nowMs >= this.nextBoundary) {
      const endMs = this.nextBoundary;
      const startMs = Math.max(0, endMs - this.windowMs);
      this.nextBoundary += this.intervalMs;
      this.enqueue(startMs, endMs);
    }
  }

  enqueue(startMs: number, endMs: number) {
    if (this.running) {
      // replace waiting task with newest
      this.waiting = { startMs, endMs };
      this.deps.onSkipped?.("replaced-by-newer-window");
      return;
    }
    void this.run({ startMs, endMs });
  }

  private async run(win: { startMs: number; endMs: number }) {
    this.running = true;
    try {
      await this.deps.getWindow(win.startMs, win.endMs);
    } finally {
      this.running = false;
      const next = this.waiting;
      this.waiting = null;
      if (next && !this.disposed) void this.run(next);
    }
  }

  dispose() {
    this.disposed = true;
    this.waiting = null;
  }
}

/** Segments that overlap the window (handles cross-boundary segments). */
export function segmentsInWindow(
  segments: TranscriptSegment[],
  startMs: number,
  endMs: number,
): TranscriptSegment[] {
  return segments.filter(
    (s) => s.endMs > startMs && s.startMs < endMs && s.isFinal,
  );
}
