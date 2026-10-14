import type { TranscriptSegment } from "../../shared/contracts";

export interface WindowSchedulerDeps {
  getNow: () => number;
  getWindow: (startMs: number, endMs: number) => Promise<void>;
  onSkipped?: (reason: string) => void;
  onError?: (error: unknown) => void;
}

/** One running analysis and one waiting snapshot, coalesced to the latest boundary. */
export class WindowScheduler {
  private running = false;
  private waiting: { startMs: number; endMs: number } | null = null;
  private nextBoundary = 0;
  private disposed = false;
  private skippedCountInternal = 0;

  constructor(
    private intervalMs: number,
    private windowMs: number,
    private deps: WindowSchedulerDeps,
  ) {
    if (![30000, 60000, 120000].includes(intervalMs)) throw new Error("interval must be 30/60/120s");
    if (![180000, 300000, 600000].includes(windowMs)) throw new Error("window must be 3/5/10min");
  }

  get skippedCount(): number { return this.skippedCountInternal; }

  start(nowMs: number) { this.nextBoundary = nowMs + this.intervalMs; }

  tick(nowMs: number) {
    if (this.disposed) return;
    while (nowMs >= this.nextBoundary) {
      const endMs = this.nextBoundary;
      this.nextBoundary += this.intervalMs;
      this.enqueue(Math.max(0, endMs - this.windowMs), endMs);
    }
  }

  enqueue(startMs: number, endMs: number) {
    if (this.disposed) return;
    if (this.running) {
      // Filling the waiting slot is not a skip; only replacing it loses a window.
      if (this.waiting) {
        this.skippedCountInternal++;
        this.deps.onSkipped?.("replaced-by-newer-window");
      }
      this.waiting = { startMs, endMs };
      return;
    }
    void this.run({ startMs, endMs });
  }

  private async run(win: { startMs: number; endMs: number }) {
    this.running = true;
    try {
      await this.deps.getWindow(win.startMs, win.endMs);
    } catch (error) {
      this.deps.onError?.(error);
    } finally {
      this.running = false;
      const next = this.waiting;
      this.waiting = null;
      if (next && !this.disposed) void this.run(next);
    }
  }

  dispose() { this.disposed = true; this.waiting = null; }
}

export function segmentsInWindow(segments: TranscriptSegment[], startMs: number, endMs: number): TranscriptSegment[] {
  return segments.filter((s) => s.endMs > startMs && s.startMs < endMs && s.isFinal);
}
