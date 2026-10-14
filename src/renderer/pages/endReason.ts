import type { SessionEndReason } from "../../shared/contracts";

/**
 * 结束原因的中文文案（历史页「会话信息 → 结束方式」用）。
 *
 * 抽成独立模块而不是写在组件里，是为了让测试能守住它——
 * 测试若自己复刻一份文案表，改坏真代码照样通过，等于假安全。
 *
 * `unknown` 不是契约取值：用来表示老记录（end_reason 为 null，无法追溯）。
 * 那种情况必须如实说"未记录"，不能猜一个原因。
 */
export const END_REASON_LABEL: Record<SessionEndReason | "unknown", string> = {
  user: "手动结束",
  "schedule-window-end": "排期到点自动结束",
  "process-restart": "上次进程异常退出，启动时收尾",
  "no-audio-timeout": "长时间无音频自动结束",
  unknown: "未记录（早期会话）",
};

/**
 * 把可空的 endReason 转成展示文案。
 *
 * 注意用 `||` 而不是 `??`：`??` 只兜 null/undefined，**空串会漏过去**，
 * 界面就会显示成「结束方式：」后面一片空白——比显示"未记录"更像故障。
 * 数据库里老记录是 NULL（`??` 能兜），但从 IPC/JSON 过来的空串同样要兜住。
 */
export function formatEndReason(reason: SessionEndReason | null | undefined): string {
  return END_REASON_LABEL[reason || "unknown"] ?? END_REASON_LABEL.unknown;
}
