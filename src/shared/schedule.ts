import type { ScheduleConfig } from "./contracts";

/**
 * 计算下一次自动开始时间（纯函数，无副作用，主进程与渲染层共用）。
 *
 * 之所以放在 shared：主进程接调度时要算同一个东西，
 * 两边各写一份必然会漂移（历史上"暂停恢复"就因为两边状态机不同步出过事故）。
 *
 * 语义：
 * - startTime/endTime 为本地时间 "HH:mm"；
 * - endTime <= startTime 表示跨天（例如 20:00 → 02:00，次日结束）；
 * - weekdays 空数组视为每天；否则只在指定的星期几触发（0=周日）；
 * - 星期判定依据「开始那一刻」所在的星期几。
 *
 * 返回 null 表示：未启用，或配置非法（时间格式错）——调用方据此不显示倒计时。
 */
export function nextScheduledStart(
  schedule: ScheduleConfig | undefined | null,
  now: Date,
): Date | null {
  if (!schedule || !schedule.enabled) return null;

  const start = parseHhMm(schedule.startTime);
  if (!start) return null;

  const { hour, minute } = start;
  const days = schedule.weekdays && schedule.weekdays.length > 0
    ? [...new Set(schedule.weekdays)].sort((a, b) => a - b)
    : [0, 1, 2, 3, 4, 5, 6];

  // 从今天开始往后找 8 天（覆盖本周全部星期，必然命中）
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);

    if (days.includes(candidate.getDay()) && candidate.getTime() > now.getTime()) {
      return candidate;
    }
  }
  return null;
}

/** 判定给定时刻是否处于「已排期应该正在监听」的时间窗内（用于结束判定）。 */
export function isWithinScheduleWindow(
  schedule: ScheduleConfig | undefined | null,
  at: Date,
): boolean {
  if (!schedule || !schedule.enabled) return false;
  const start = parseHhMm(schedule.startTime);
  const end = parseHhMm(schedule.endTime);
  if (!start || !end) return false;

  const days = schedule.weekdays && schedule.weekdays.length > 0
    ? [...new Set(schedule.weekdays)]
    : [0, 1, 2, 3, 4, 5, 6];

  const minutesNow = at.getHours() * 60 + at.getMinutes();
  const minutesStart = start.hour * 60 + start.minute;
  const minutesEnd = end.hour * 60 + end.minute;
  const today = at.getDay();

  if (minutesEnd > minutesStart) {
    // 同日窗口
    return days.includes(today) && minutesNow >= minutesStart && minutesNow < minutesEnd;
  }
  // 跨天窗口：例如 20:00→02:00。今天 20:00 之后，或昨天排期后延续到今天的 02:00 之前。
  if (minutesNow >= minutesStart) {
    return days.includes(today);
  }
  if (minutesNow < minutesEnd) {
    const yesterday = (today + 6) % 7;
    return days.includes(yesterday);
  }
  return false;
}

function parseHhMm(value: string): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * 给定时刻所处的排期窗口的**结束时刻**（本地时间）。
 *
 * 只在 `isWithinScheduleWindow(schedule, now)` 为 true 时有意义——窗口外返回 null，
 * 调用方据此不做「到点结束」。这样设计是为了让「预约结束」只作用于
 * **在窗口内启动的会话**：用户在窗口外手动开的临时监听不会被它掐断。
 *
 * 跨天窗口（如 20:00→02:00）要分两段判断：
 * - now 在 start 之后（当天 21:00）→ 结束在**次日** end
 * - now 在 end 之前（次日 01:00）→ 结束在**当天** end
 */
export function scheduledEndAt(
  schedule: ScheduleConfig | undefined | null,
  now: Date,
): Date | null {
  if (!isWithinScheduleWindow(schedule, now)) return null;
  const start = parseHhMm(schedule!.startTime);
  const end = parseHhMm(schedule!.endTime);
  if (!start || !end) return null;

  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const minutesStart = start.hour * 60 + start.minute;
  const minutesEnd = end.hour * 60 + end.minute;

  const at = new Date(now);
  // 跨天窗口且已过 start（还没跨过午夜）→ 结束在次日
  const nextDay = minutesEnd <= minutesStart && minutesNow >= minutesStart;
  at.setDate(now.getDate() + (nextDay ? 1 : 0));
  at.setHours(end.hour, end.minute, 0, 0);
  return at;
}

/** 人类可读的倒计时，例如「2 小时 15 分后」。 */
export function formatCountdown(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "即将开始";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days} 天 ${hours} 小时后`;
  if (hours > 0) return `${hours} 小时 ${mins} 分后`;
  if (mins > 0) return `${mins} 分钟后`;
  return "不到 1 分钟";
}

/** 星期标签。 */
export const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
