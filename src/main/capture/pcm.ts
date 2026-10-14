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
  /** 因单包体积超过上限而被拒绝的包数（与 overflowCount 分开计数）。 */
  rejectedCount = 0;

  constructor(
    private maxBytes: number = MAX_QUEUE_BYTES,
    private onOverflow?: (count: number) => void,
    private onReject?: (count: number) => void,
  ) {}

  push(packet: AudioPacket): boolean {
    // 单包就超过上限：旧的实现是先 shift 掉一包再把这个超大包塞进去，
    // 结果 totalBytes 仍然远超 maxBytes，上限形同虚设（实测：上限 1000B、
    // 推 5000B 包后 totalBytes=5000）。这里改为直接拒绝并计数，不破坏上限。
    if (packet.pcm.byteLength > this.maxBytes) {
      this.rejectedCount++;
      this.onReject?.(this.rejectedCount);
      return false;
    }
    // 满了丢最旧，腾出空间。要连续丢弃直到放得下，否则一次 push 仍可能越过上限。
    while (this.totalBytes + packet.pcm.byteLength > this.maxBytes && this.queue.length > 0) {
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

  /** 当前占用字节数。用于断言「上限在任何输入下都不被突破」。 */
  get bytes(): number {
    return this.totalBytes;
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

  /** Emit the remaining samples when capture pauses or ends. */
  flush(): AudioPacket | null {
    if (!this.buffered) return null;
    const pcm = this.ringBuffer.slice(0, this.buffered);
    const durationMs = this.buffered * 1000 / SAMPLE_RATE;
    const packet = { pcm: pcm.buffer, startMs: this.nextStartMs, durationMs };
    this.nextStartMs += durationMs;
    this.buffered = 0;
    return packet;
  }

  /** input: mono-mixed Float32 samples at sourceRate */
  push(input: Float32Array, sourceRate: number, inputStartMs: number): AudioPacket[] {
    const packets: AudioPacket[] = [];
    const ratio = sourceRate / SAMPLE_RATE;
    // 输出样本数 = 输入样本数 / 采样率比（44100→16k 时 4096 入 → 1486 出）。
    // 历史 bug：循环按 input.length 迭代，等于把流升采样并补零——每个 push 产出
    // ratio 倍于真实时长的音频（44.1k 设备上音频时钟快 2.76 倍），包时间戳跑到
    // 会话时钟前面 → 主进程按墙上时钟排水时队列疯狂溢出、旧包（该发的）被丢 →
    // ASR 收不到东西。2026-10-14 用户实测：14 秒会话队列溢出 17 次、0 条转写。
    const outCount = Math.floor(input.length / ratio);
    for (let i = 0; i < outCount; i++) {
      const srcIdx = Math.floor(i * ratio);
      const nextIdx = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = srcIdx; j < nextIdx; j++) sum += input[j];
      const avg = nextIdx > srcIdx ? sum / (nextIdx - srcIdx) : 0;
      const s = Math.max(-1, Math.min(1, avg));
      this.ringBuffer[this.buffered++] = Math.round(s * 32767);
      // 成包。放在循环内逐样本检查，保证 buffered 永远 < PACKET_SAMPLES+1，
      // 不会溢出环形缓冲（1 秒容量）；while 兼容极端大包一次连产多包。
      while (this.buffered >= PACKET_SAMPLES) {
        const out = this.ringBuffer.slice(0, PACKET_SAMPLES);
        packets.push({
          pcm: out.buffer.slice(0),
          startMs: this.nextStartMs,
          durationMs: PACKET_MS,
        });
        this.nextStartMs += PACKET_MS;
        // 保留残余样本：把不满一包的 [PACKET_SAMPLES, buffered) 挪到缓冲区开头，
        // 下次 push 接着用。历史 bug：这里直接 buffered=0，每成一次包丢一份残余
        // （48k 设备每次丢 ~895/3200 ≈ 22%），直播监管场景下字幕会周期性缺片。
        this.ringBuffer.copyWithin(0, PACKET_SAMPLES, this.buffered);
        this.buffered -= PACKET_SAMPLES;
      }
    }
    return packets;
  }
}
