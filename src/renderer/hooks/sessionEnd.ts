/**
 * 会话结束的收敛判据。
 *
 * 背景（复核发现的真缺陷）：排期到点自动结束时，主进程会真的 stop()——
 * 断 ASR、落库 stopped、发 app.error(SESSION_AUTO_ENDED) 与 capture.status(idle)，
 * 但渲染层过去**没有任何订阅去改状态机**（setUiState("completed") 只在手点结束的
 * stopSession 里出现）。后果是：会话已停、界面仍显示「监听中」、采集句柄还在喂音频。
 *
 * 这段判据把「收到什么信号该收敛到什么状态」抽出来，让测试能守住，
 * 而不是散落在 hook 的事件回调里靠人记。
 */

export type UiSessionState =
  | "idle"
  | "starting"
  | "capturing"
  | "paused"
  | "reconnecting"
  | "analyzing"
  | "stopping"
  | "completed"
  | "error";

/** 视为「会话正在跑」的状态：这些状态下收到结束信号必须收敛。 */
export const CAPTURING_STATES: readonly UiSessionState[] = [
  "starting",
  "capturing",
  "analyzing",
  "reconnecting",
];

/**
 * 采集回到 idle 时，状态机该去哪。
 *
 * 采集 idle 只有一条来源：主进程 stop()。所以只要界面还在"跑"的状态，
 * 就说明会话已结束而界面没跟上 —— 必须落到 completed。
 * 其他情况保持原状态（idle→idle、completed→completed 都不动）。
 */
export function nextStateOnCaptureIdle(current: UiSessionState): UiSessionState {
  return CAPTURING_STATES.includes(current) ? "completed" : current;
}

/**
 * 收到 app.error(SESSION_AUTO_ENDED) 时，状态机该去哪。
 *
 * 与手点结束走同一个终态 completed —— 两条路径必须收敛到一致，
 * 否则"自动结束"和"手动结束"会呈现不同界面（历史上暂停/恢复就吃过这个亏）。
 */
export function nextStateOnAutoEnded(current: UiSessionState): UiSessionState {
  return current === "completed" ? current : "completed";
}

/** 该错误码是否表示会话被自动结束。 */
export const AUTO_ENDED_CODE = "SESSION_AUTO_ENDED";

export function isAutoEndedError(code: string): boolean {
  return code === AUTO_ENDED_CODE;
}

/**
 * 会话是否已终结 —— 用来决定"要不要停掉采集句柄"。
 * 漏掉这一步，音频会继续从渲染层流向已结束的会话（被丢弃但仍在采），
 * 电平条照跳、界面看起来还在录。
 */
export function shouldStopCapture(state: UiSessionState): boolean {
  return state === "completed" || state === "idle";
}
