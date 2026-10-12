import type { AudioStatus } from "../../shared/contracts";

export interface AudioPacket {
  /** 16kHz 16-bit mono PCM */
  pcm: ArrayBuffer;
  /** session-relative ms of packet start */
  startMs: number;
  durationMs: number;
}

export type PacketHandler = (packet: AudioPacket) => void;
export type StatusHandler = (status: AudioStatus) => void;
export type WarningHandler = (message: string) => void;

export interface AudioSourceDriver {
  start(): Promise<void>;
  stop(): Promise<void>;
  onPacket(h: PacketHandler): void;
  onStatus(h: StatusHandler): void;
  onWarning(h: WarningHandler): void;
}

const MAX_QUEUE_BYTES = 16000 * 2 * 10; // 10s of 16kHz 16bit mono

export class BoundedPacketQueue {
  private queue: AudioPacket[] = [];
  private totalBytes = 0;
  overflowCount = 0;

  constructor(
    private maxBytes: number = MAX_QUEUE_BYTES,
    private onOverflow?: (count: number) => void,
  ) {}

  push(packet: AudioPacket): boolean {
    if (this.totalBytes + packet.pcm.byteLength > this.maxBytes) {
      // drop oldest
      const dropped = this.queue.shift();
      if (dropped) this.totalBytes -= dropped.pcm.byteLength;
      this.overflowCount++;
      this.onOverflow?.(this.overflowCount);
    }
    this.queue.push(packet);
    this.totalBytes += packet.pcm.byteLength;
    return true;
  }

  drain(): AudioPacket[] {
    const out = this.queue;
    this.queue = [];
    this.totalBytes = 0;
    return out;
  }

  get size(): number {
    return this.queue.length;
  }
}

export const SAMPLE_RATE = 16000;
export const PACKET_MS = 200;
export const PACKET_SAMPLES = (SAMPLE_RATE * PACKET_MS) / 1000; // 3200 samples

/**
 * Resamples Float32 input (any source rate, possibly stereo-interleaved frames
 * delivered as mono-mixed) to 16kHz Int16 mono and slices into ~200ms packets.
 */
export class PcmResamplerSlicer {
  private ringBuffer: Int16Array;
  private buffered = 0;
  private nextStartMs = 0;

  constructor() {
    // allow up to 1 second of backlog before forced flush
    this.ringBuffer = new Int16Array(SAMPLE_RATE);
  }

  reset(startMs: number) {
    this.buffered = 0;
    this.nextStartMs = startMs;
  }

  /** input: mono-mixed Float32 samples at sourceRate */
  push(input: Float32Array, sourceRate: number, inputStartMs: number): AudioPacket[] {
    const packets: AudioPacket[] = [];
    const ratio = sourceRate / SAMPLE_RATE;
    let i = 0;
    while (i < input.length) {
      const srcIdx = Math.floor(i * ratio);
      const nextIdx = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = srcIdx; j < nextIdx; j++) sum += input[j];
      const avg = nextIdx > srcIdx ? sum / (nextIdx - srcIdx) : 0;
      const s = Math.max(-1, Math.min(1, avg));
      this.ringBuffer[this.buffered++] = Math.round(s * 32767);
      i++;
      if (this.buffered >= PACKET_SAMPLES) {
        const out = this.ringBuffer.slice(0, PACKET_SAMPLES);
        packets.push({
          pcm: out.buffer.slice(0),
          startMs: this.nextStartMs,
          durationMs: PACKET_MS,
        });
        this.nextStartMs += PACKET_MS;
        this.buffered = 0;
      }
    }
    return packets;
  }
}
