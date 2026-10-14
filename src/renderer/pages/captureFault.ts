/**
 * 采集故障 ↔ 无声告警 的 UI 分流判据。
 *
 * 抽成独立模块的原因：这条互斥规则要在两处生效（定时器抑制 + 渲染抑制），
 * 逻辑内联时两处容易改歪，而且没法被测试真正守住——
 * 测试如果自己抄一份判据，改坏真代码它照样通过。
 */

/** 连续无声多久后报警（与 MonitorPage 的 SILENCE_WARN_MS 一致）。 */
export const SILENCE_WARN_MS = 5000;

/** 只有这些会话状态下"没声音"才值得报警：采集在跑、本该有声音。 */
export const LISTENING_STATES = ["capturing", "reconnecting", "analyzing"] as const;

export function isListeningState(sessionState: string): boolean {
  return (LISTENING_STATES as readonly string[]).includes(sessionState);
}

export interface SilenceWarningInput {
  sessionState: string;
  /** 距最后一次"听到声音"的毫秒数 */
  quietForMs: number;
  /** 是否已判定为设备级故障 */
  deviceFault: boolean;
}

/**
 * 是否显示"连续无声"告警。
 *
 * 设备故障优先：设备坏了"没声音"是必然结果，此时提示"检查音量/是否静音"
 * 会把用户引向错误方向（该换设备，不是该调音量）。
 * 无人值守下这个误判代价很高——整场没录到却被当成正常静音忽略。
 */
export function shouldWarnSilence(input: SilenceWarningInput): boolean {
  if (!isListeningState(input.sessionState)) return false;
  if (input.deviceFault) return false;
  return input.quietForMs >= SILENCE_WARN_MS;
}
