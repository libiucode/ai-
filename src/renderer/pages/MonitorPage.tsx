import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { Issue, ScheduleConfig, TranscriptSegment } from "../../shared/contracts";
import { PHASE_LABEL } from "../../shared/contracts";
import { formatCountdown, nextScheduledStart } from "../../shared/schedule";
import {
  Badge,
  Button,
  CAPTURE_STATE_LABEL,
  ASR_STATE_LABEL,
  Panel,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  TYPE_LABEL,
  formatClock,
  tokens,
} from "../ui/basics";
import { PRIORITY_LABEL } from "./frameworkSchema";
import { SILENCE_WARN_MS, shouldWarnSilence } from "./captureFault";
import { resolveStoredDevice, toStoredDeviceId } from "./deviceSelection";
import { useMonitorState } from "../hooks/useMonitorState";
import { startLoopbackCapture, startMicCapture, type CaptureHandle } from "../capture/audioCapture";

interface DeviceOption {
  id: string;
  label: string;
  isDefault: boolean;
}

/**
 * 无声警告阈值。
 * level 是采集侧每帧样本的平均绝对值：室内底噪约 0.001–0.003，正常人声 0.02 以上。
 * 0.005 作为"算有声音"的门槛，留了底噪裕量又不至于漏掉小声说话。
 */
const SILENCE_LEVEL_THRESHOLD = 0.005;

export function MonitorPage({ onOpenHistory }: { onOpenHistory: () => void }) {
  const mon = useMonitorState();
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  const actionInFlight = useRef(false);
  const [actionPending, setActionPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  /** 连续无声警告状态。见 silenceTick() 注释。 */
  const [silenceWarning, setSilenceWarning] = useState(false);
  const lastLoudRef = useRef<number>(0);
  /**
   * 设备级故障（轨道结束 / 被静音超时 / 设备从列表消失）。
   * 与"内容静音"是两码事：这里是"采不到了"，该换设备，不是该查音量。
   * 设备故障期间抑制无声告警——两条矛盾提示同屏会让用户懵，
   * 而无人值守下最容易发生的误判就是"以为只是没人说话"。
   */
  const [deviceFault, setDeviceFault] = useState<{ code: string; reason: string } | null>(null);
  /** 读回的设备 id 已失效时的回落提示（用户主动选过后清除）。 */
  const [deviceFallbackNotice, setDeviceFallbackNotice] = useState<string | null>(null);
  /** 是否已做过一次「读回 + 核对」。防止设备列表变化时反复核对。 */
  const deviceRestored = useRef(false);

  // 1s heartbeat for countdown + duration display
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  /**
   * 无声检测。电平回调 onLevel 每音频帧（约 85ms）触发一次，
   * 这里用 1s 定时器比较"最后一次听到声音"到现在的间隔。
   * 判据统一走 captureFault.shouldWarnSilence()，与渲染层的抑制条件共用一份，
   * 避免两处各写一份后改歪（该函数有单测守着）。
   */
  useEffect(() => {
    const id = setInterval(() => {
      const isQuiet = shouldWarnSilence({
        sessionState: mon.sessionState,
        quietForMs: Date.now() - lastLoudRef.current,
        deviceFault: deviceFault !== null,
      });
      if (isQuiet !== silenceWarning) setSilenceWarning(isQuiet);
    }, 1000);
    return () => clearInterval(id);
  }, [mon.sessionState, silenceWarning, deviceFault]);

  /** 电平回调：记录最后一次"有声"时刻；声音一恢复立刻解除警告。 */
  const handleLevel = useCallback((l: number) => {
    setLevel(l);
    if (l >= SILENCE_LEVEL_THRESHOLD) {
      lastLoudRef.current = Date.now();
      setSilenceWarning((w) => (w ? false : w));
    }
  }, []);

  // refresh device list when idle and after permission grant
  useEffect(() => {
    if (mon.sessionState === "idle" || mon.sessionState === "error" || mon.sessionState === "completed") {
      window.appApi
        .listAudioDevices()
        .then((ds) => setDevices(ds.map((d) => ({ id: d.id, label: d.label, isDefault: d.isDefault }))))
        .catch(() => setDevices([]));
    }
  }, [mon.sessionState]);

  /**
   * 读回上次选择的设备（持久化在 app_settings.audioDeviceId）。
   *
   * **必须等设备列表枚举完成后再核对**：挂载时 listAudioDevices() 是异步的，
   * 若此时就读回，devices 为空 → 判据保守走默认 → 用户存的设备被静默丢掉。
   * 所以这里等 devices.length > 0 才做核对（id 失效要明确告知）。
   *
   * 只核对一次：之后用户改选项走 onSelectDevice，不再重复核对。
   * 若设备列表一直是空的（没授权麦克风），不核对也不报回落——避免误报。
   */
  useEffect(() => {
    if (deviceRestored.current) return;      // 已核对过
    if (devices.length === 0) return;        // 列表还没到，等
    deviceRestored.current = true;

    window.appApi
      .getSettings()
      .then((s) => {
        const resolved = resolveStoredDevice(s.audioDeviceId, devices);
        setDeviceId(resolved.deviceId);
        setDeviceFallbackNotice(resolved.fellBack ? resolved.fallbackReason : null);
      })
      .catch(() => { /* 读不到就用默认，不打扰用户 */ });
  }, [devices]);

  /**
   * 用户改设备选项：立即更新本地 state + 落库。
   *
   * 落库走既有的 settingsSave（公开配置通道），**不引入新的 IPC 通道**——
   * captureSelectDevice 是主进程的空实现，改它要动 src/main/ipc.ts，
   * 那是别人的范围；设备 id 是公开配置而非密钥，放 app_settings 语义一致。
   */
  async function onSelectDevice(id: string | null) {
    const next = toStoredDeviceId(id);
    setDeviceId(next);
    setDeviceFallbackNotice(null); // 用户主动选过，回落提示就该消失
    try {
      const current = await window.appApi.getSettings();
      await window.appApi.saveSettings({ ...current, audioDeviceId: next });
    } catch {
      // 存不上不阻塞本次选择（本地 state 已生效），下一场仍可用
    }
  }

  useEffect(() => () => captureRef.current?.stop(), []);

  /**
   * 会话结束（手点或自动）时必须真的停掉采集句柄。
   *
   * 自动结束（排期到点）与手点结束在这一点上必须一致：主进程 stop() 会断 ASR、
   * 落库 stopped，但**渲染层的 ScriptProcessor 不会自己停**——不显式 stop，
   * 音频仍会继续发往主进程（被丢弃），电平条继续跳动，界面看起来还在录。
   * 这正是"绝不能让界面假装还在工作"要防的情况。
   */
  useEffect(() => {
    const ended = mon.sessionState === "completed" || mon.sessionState === "idle";
    if (ended && captureRef.current) {
      captureRef.current.stop();
      captureRef.current = null;
      setLevel(0);
      setSilenceWarning(false);
    }
  }, [mon.sessionState]);

  const active = ["starting", "capturing", "reconnecting", "analyzing"].includes(mon.sessionState);

  /**
   * 排期信息：只在空闲态显示"下次自动开始"。
   * 监听中显示它没有意义，反而会让人以为当前会话是自动开的（实际是手点的）。
   */
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null);
  useEffect(() => {
    window.appApi
      .getSettings()
      .then((s) => setSchedule(s.schedule ?? null))
      .catch(() => setSchedule(null));
  }, [mon.sessionState]);
  const nextStart = nextScheduledStart(schedule, new Date(now));

  const sessionElapsedMs = useMemo(() => {
    if (!mon.sessionStartedAt) return 0;
    return active || mon.sessionState === "paused" ? now - new Date(mon.sessionStartedAt).getTime() : 0;
  }, [mon.sessionStartedAt, now, active, mon.sessionState]);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [mon.finals, mon.partials]);

  async function performAction(action: () => Promise<void>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionPending(true);
    try {
      await action();
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : "操作失败，请重试");
    } finally {
      actionInFlight.current = false;
      setActionPending(false);
    }
  }

  async function doStart(source: "microphone" | "systemLoopback") {
    setCaptureError(null);
    setDeviceFault(null);
    lastLoudRef.current = Date.now();
    let result;
    if (source === "microphone") {
      result = await startMicCapture(deviceId, handleLevel, handleCaptureEnded, handleDeviceLost);
    } else {
      result = await startLoopbackCapture(handleLevel, handleCaptureEnded, handleDeviceLost);
    }
    if (!result.ok) {
      setCaptureError(result.error.message);
      return;
    }
    captureRef.current = result.handle;
    const started = await mon.startSession({
      audioSource: source,
      deviceId: source === "microphone" ? deviceId : null,
    });
    if (!started) {
      captureRef.current?.stop();
      captureRef.current = null;
      setLevel(0);
    }
  }

  /**
   * 设备级故障（轨道结束 / 被静音超时 / 设备从列表消失）。
   *
   * 与 handleCaptureEnded 的区别——这里**不结束会话**。
   * 无人值守场景下直接结束意味着这一场的转写与报告就此断档，
   * 用户回到电脑前只看到"已结束"，不知道中途发生过什么。
   * 保留会话后，用户重选设备 → 点「继续」即可接回同一场，数据不断档。
   *
   * 代价是这期间不会有新字幕（采不到音），所以提示必须足够显著，
   * 绝不能让界面看起来"还在正常录"。
   */
  function handleDeviceLost(reason: string) {
    setDeviceFault({ code: "CAPTURE_DEVICE_LOST", reason });
    setSilenceWarning(false);
    // 采集已不可用：停掉句柄并清零电平，避免电平条继续显示旧值骗人
    captureRef.current?.stop();
    captureRef.current = null;
    setLevel(0);
    // 暂停会话：主进程侧 resume() 只在 paused 下生效，
    // 这样用户重选设备后能接回同一场，而不是被迫另开新会话。
    void mon.pauseSession();
  }

  // 采集轨道静默死亡（设备拔出/被独占/音频服务重启导致哈希变化）：
  // 弹出可操作错误并结束会话——而不是让界面假装还在采。
  async function handleCaptureEnded() {
    setCaptureError(
      "音频设备已失效（被拔出、被其他程序独占，或音频服务重启）。" +
      "请在音源下拉里重新选择设备后再开始监听。",
    );
    captureRef.current?.stop();
    captureRef.current = null;
    setLevel(0);
    await mon.stopSession();
  }

  async function doStop() {
    captureRef.current?.stop();
    captureRef.current = null;
    setLevel(0);
    setSilenceWarning(false);
    setDeviceFault(null);
    await mon.stopSession();
  }

  // 暂停 = 真停：先停渲染层采集（否则 ScriptProcessor 继续跑、电平条说谎、
  // 音频包继续发给主进程被丢弃、ASR 被饿死报 4008），再通知主进程。
  async function doPause() {
    captureRef.current?.stop();
    captureRef.current = null;
    setLevel(0);
    setSilenceWarning(false);
    setDeviceFault(null);
    await mon.pauseSession();
  }

  // 恢复 = 真重开：先重启采集（设备可能已在暂停期间失效），再通知主进程重连 ASR。
  async function doResume() {
    setCaptureError(null);
    setDeviceFault(null);
    lastLoudRef.current = Date.now();
    setSilenceWarning(false);
    const cap = mon.audio?.source === "systemLoopback"
      ? await startLoopbackCapture(handleLevel, handleCaptureEnded, handleDeviceLost)
      : await startMicCapture(deviceId, handleLevel, handleCaptureEnded, handleDeviceLost);
    if (!cap.ok) {
      // 采集起不来就别恢复会话——让用户看到原因（设备失效/被占用）
      setCaptureError(cap.error.message);
      return;
    }
    captureRef.current = cap.handle;
    await mon.resumeSession();
  }

  const audio = mon.audio;
  const asr = mon.asr;
  const lastFinalAgo = mon.lastFinalAt ? now - mon.lastFinalAt : null;
  const analysisCountdownSec = active ? 0 : 0; // scheduler boundary not exposed; show last status instead
  const scriptStatus = mon.script;
  const overdueStepNames = scriptStatus?.steps.filter((s) => s.overdue).map((s) => s.name) ?? [];

  const stateTone = {
    idle: "dim",
    starting: "info",
    capturing: "ok",
    paused: "warn",
    reconnecting: "warn",
    analyzing: "info",
    stopping: "warn",
    completed: "dim",
    error: "danger",
  } as const;
  const STATE_LABEL: Record<string, string> = {
    idle: "未开始",
    starting: "启动中",
    capturing: "监听中",
    paused: "已暂停",
    reconnecting: "重连中",
    analyzing: "分析中",
    stopping: "停止中",
    completed: "已完成",
    error: "错误",
  };

  return (
    <div className="stack">
      {/* ---- 顶部状态区 ---- */}
      <section className="hero">
        <div className="status-head">
          <Badge tone={stateTone[mon.sessionState]} className="state-badge" pulse={mon.sessionState === "capturing" || mon.sessionState === "analyzing"}>
            {STATE_LABEL[mon.sessionState]}
          </Badge>
          <div className="status-meta">
            <span>会话 <b>{mon.sessionId ? mon.sessionId.slice(0, 8) : "—"}</b></span>
            {mon.sessionStartedAt ? <span>开始于 <b>{new Date(mon.sessionStartedAt).toLocaleTimeString()}</b></span> : null}
            <span>音源 <b>{captureRef.current?.sourceLabel ?? (audio?.source === "microphone" ? "麦克风" : audio?.source === "systemLoopback" ? "系统声音" : "—")}</b></span>
          </div>
          <div className="status-actions">
            {/*
              设备选择下拉：正常空闲态显示；**设备故障态也要显示**——
              故障后会话转为 paused，若沿用 "!active && state!=='paused'" 的条件，
              下拉会被一并藏起来，而故障提示恰恰在说"在下方音源下拉里重新选择设备"，
              等于让用户去找一个不存在的控件。所以故障态单独放行。
            */}
            {(!active && mon.sessionState !== "paused") || deviceFault ? (
              <>
                <select
                  className={`input select${deviceFault ? " select-fault" : ""}`}
                  value={deviceId ?? ""}
                  onChange={(e) => void onSelectDevice(e.target.value || null)}
                  disabled={active || actionPending}
                >
                  <option value="">默认麦克风</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
                {/* 故障态下已有「重选设备后继续」，不再重复给"开始"按钮 */}
                {!deviceFault ? (
                  <>
                    <Button variant="primary" disabled={actionPending} onClick={() => performAction(() => doStart("microphone"))}>开始麦克风监听</Button>
                    <Button disabled={actionPending} onClick={() => performAction(() => doStart("systemLoopback"))}>监听系统声音</Button>
                  </>
                ) : null}
              </>
            ) : null}
            {/* 设备故障后：会话已是 paused，主按钮变成「重选设备后继续」 */}
            {mon.sessionState === "paused" ? (
              <Button variant="primary" disabled={actionPending} onClick={() => performAction(doResume)}>
                {deviceFault ? "重选设备后继续" : "继续"}
              </Button>
            ) : null}
            {active ? <Button disabled={actionPending} onClick={() => performAction(doPause)}>暂停</Button> : null}
            {active || mon.sessionState === "paused" ? (
              <Button variant="danger" disabled={actionPending} onClick={() => performAction(doStop)}>结束</Button>
            ) : null}
            {mon.sessionState === "completed" ? (
              <Button variant="primary" onClick={onOpenHistory}>查看历史与报告</Button>
            ) : null}
          </div>
        </div>

        {/*
          设备级故障提示：与"无声告警"刻意区分——这里绝不说"检查音量/是否静音"
          （那是内容静音的说法，会把用户引向错误的排查方向）。
          用 danger 色（无声告警是 warn 色），因为"采不到了"比"暂时没人说话"严重得多。
        */}
        {deviceFault ? (
          <div className="callout callout-danger">
            <b>[{deviceFault.code}] 音频设备已失效，当前录不到声音。</b>
            <div style={{ marginTop: 4 }}>{deviceFault.reason}</div>
            <div style={{ marginTop: 4 }}>
              处理方式：在下方音源下拉里<b>重新选择设备</b>，然后点「重选设备后继续」接回本场监听。
              本次会话不会中断，重选设备前的转写与问题都会保留。
            </div>
          </div>
        ) : null}

        <div className="meter-row">
          <span className="meter-label">电平</span>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${Math.min(100, level * 400)}%` }} />
          </div>
        </div>

        <div className="status-chips">
          <span className="chip"><span className="chip-k">采集</span>{audio ? CAPTURE_STATE_LABEL[audio.state] : "未启动"}</span>
          <span className="chip"><span className="chip-k">ASR</span>{asr ? ASR_STATE_LABEL[asr.state] : "未连接"}{asr && asr.reconnectAttempt > 0 ? `（第 ${asr.reconnectAttempt} 次）` : ""}</span>
          <span className="chip"><span className="chip-k">最后稳态</span>{lastFinalAgo !== null ? `${Math.round(lastFinalAgo / 1000)} 秒前` : "—"}</span>
          {audio && audio.queueOverflowCount > 0 ? (
            <span className="chip chip-warn"><span className="chip-k">队列溢出</span>{audio.queueOverflowCount} 次</span>
          ) : null}
          {/* 只在未开始时显示排期：会话进行中显示会让人误以为当前是自动开的 */}
          {nextStart && !active && mon.sessionState !== "paused" ? (
            <span className="chip">
              <span className="chip-k">下次自动开始</span>
              {nextStart.toLocaleString()}（{formatCountdown(nextStart, new Date(now))}）
            </span>
          ) : null}
          {/*
            本场的排期结束时刻：与「下次自动开始」相反，这条只在会话进行中出现。
            必须显示，否则用户看到会话自己停了会以为是故障——自动结束的可见性
            是这套机制能否被信任的前提。

            暂停态只显示静态时刻、不显示倒计时：主进程的 checkScheduledEnd 只在
            active 时被调用，暂停期间根本不会到点结束。此时显示"30 分钟后结束"
            等于承诺一件暂停期间不会发生的事。
          */}
          {mon.scheduleStatus?.scheduledEndAtIso && (active || mon.sessionState === "paused") ? (
            <span className="chip">
              <span className="chip-k">排期结束</span>
              {new Date(mon.scheduleStatus.scheduledEndAtIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {mon.sessionState === "paused"
                ? <span className="chip-k">（暂停期间不计入）</span>
                : `（${formatCountdown(new Date(mon.scheduleStatus.scheduledEndAtIso), new Date(now))}）`}
            </span>
          ) : null}
        </div>

        {/* 排期能力现状：两项能力状态不同，必须并列写清，不能把"未"和"已"塞进同一句 */}
        {schedule?.enabled && !active && mon.sessionState !== "paused" ? (
          <div className="callout callout-warn">
            <b>定时监听能力现状：</b>
            <div style={{ marginTop: 4 }}>
              到点自动开始 —— <b>未接通</b>（系统声音采集需当次手动授权，程序无法自行触发）
            </div>
            <div>
              到点自动结束 —— <b>已接通</b>（在排期时段内开始的会话，会在结束时刻自动收尾并说明原因）
            </div>
            <div style={{ marginTop: 4 }}>因此目前请手动点「监听系统声音」开始。</div>
          </div>
        ) : null}

        {captureError ? <div className="callout callout-danger">{captureError}</div> : null}
        {/*
          读回的设备 id 已失效时的回落提示。
          与"无声告警"区分：这里说的是"你上次选的设备没了"，不是"没人说话"。
          warn 色（不是 danger）——因为已经安全回落到默认设备，不影响本次监听，
          但用户需要知道，否则下次开播可能又采到默认设备而不自知。
        */}
        {deviceFallbackNotice ? (
          <div className="callout callout-warn">⚠ {deviceFallbackNotice}</div>
        ) : null}
        {/*
          无声告警：刻意排除 deviceFault —— 设备已判故障时"没声音"是必然结果，
          再提示"检查音量/是否静音"会把用户引向错误方向（该换设备，不是该调音量）。
          定时器里已抑制，这里再拦一次作为渲染层双保险。
        */}
        {silenceWarning && !deviceFault ? (
          <div className="callout callout-warn">
            ⚠ 已连续 {SILENCE_WARN_MS / 1000} 秒没有检测到输入声音。
            若采集源本身正常，请检查：麦克风是否被静音或音量过低、播放设备是否在正常出声。
            声音恢复后此提示会自动消失。
          </div>
        ) : null}
        {mon.hasTranscriptGap ? (
          <div className="callout callout-warn">
            ⚠ ASR 曾断线重连，断线期间存在转写缺口，缺口内没有字幕数据。
          </div>
        ) : null}
        {mon.errors.length > 0 ? (
          <div className="err-line">
            {mon.errors.slice(0, 3).map((e, i) => (
              <div key={i}>[{e.code}] {e.message}</div>
            ))}
          </div>
        ) : null}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, alignItems: "start" }}>
        {/* ---- 转写区 ---- */}
        <Panel title="实时字幕">
          <div style={{ fontSize: 12, color: tokens.textDim, marginBottom: 6 }}>
            临时字幕为识别中间结果（灰色斜体），不落库；稳态字幕为已定稿内容。
          </div>
          <div ref={transcriptRef} className="transcript">
            {mon.finals.length === 0 && mon.partials.length === 0 ? (
              <div className="empty">暂无字幕。开始监听并说话后，这里会显示识别结果。</div>
            ) : null}
            {mon.finals.map((seg) => (
              <div key={seg.id} id={`seg-${seg.id}`} className="seg-row">
                <span className="seg-time">{formatClock(seg.startMs)}</span>
                <span className="seg-text">{seg.text}</span>
                <span className="seg-seq">稳态 #{seg.sourceSeq}</span>
              </div>
            ))}
            {mon.partials.map((p) => (
              <div key={p.key} className="seg-row seg-partial">
                <span className="seg-mark">…</span>
                <span className="seg-text">{p.text}</span>
                <span className="seg-seq">临时</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* ---- 指标区 ---- */}
        <Panel title="指标">
          <div className="metrics-grid">
            <Metric label="监听时长" value={formatClock(sessionElapsedMs)} />
            <Metric label="稳态片段数" value={String(mon.finals.length)} />
            <Metric label="问题数（本次）" value={String(mon.issues.length)} />
            <Metric
              label="最近分析"
              value={mon.analysis?.lastRunStatus ? String(mon.analysis.lastRunStatus) : "—"}
              hint={mon.analysis?.queued ? "有窗口在排队" : undefined}
            />
            <Metric
              label="有效讲话 / 静音"
              value={
                audio
                  ? `${Math.round((sessionElapsedMs * 0) + (mon.finals.length > 0 ? 1 : 0) * 0) || "—"}`
                  : "—"
              }
              hint="精确值见分析窗口与报告"
            />
            <Metric label="分析倒计时" value={analysisCountdownSec ? `${analysisCountdownSec}s` : "按间隔触发"} />
          </div>
        </Panel>
      </div>

      {/* ---- 话术步骤覆盖 ---- */}
      <Panel title="话术步骤覆盖">
        {!scriptStatus || scriptStatus.steps.length === 0 ? (
          <div className="empty">
            尚未开始监听，或未配置话术步骤。开始监听后，这里会实时显示当前话术阶段、停留时长与步骤超时提醒（步骤在「话术配置」中维护）。
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <Badge tone={scriptStatus.phase === "idle" ? "dim" : "info"}>
                {PHASE_LABEL[scriptStatus.phase] ?? scriptStatus.phase}
              </Badge>
              <span style={{ fontSize: 13, color: tokens.textDim }}>
                {scriptStatus.phase === "idle"
                  ? "尚未识别到话术阶段（开场白、产品介绍、成交引导等关键词会触发阶段跟踪）"
                  : `本阶段已停留 ${formatClock(scriptStatus.phaseElapsedMs)}`}
              </span>
              {scriptStatus.frameworkName ? (
                <span style={{ marginLeft: "auto", fontSize: 12, color: tokens.textDim }}>框架：{scriptStatus.frameworkName}</span>
              ) : null}
            </div>
            {overdueStepNames.length > 0 ? (
              <div className="callout callout-warn">
                ⚠ 步骤{overdueStepNames.map((n) => `「${n}」`).join("、")}已超过最长等待时间，可能漏讲或卡住。
              </div>
            ) : null}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {scriptStatus.steps.map((s) => (
                <div key={s.id} className="step-row">
                  <span className="step-name">{s.name}</span>
                  <Badge tone="dim">{PRIORITY_LABEL[s.priority] ?? "建议"}</Badge>
                  <span className="step-wait">
                    {s.maxWaitMs > 0 ? `${Math.round(s.maxWaitMs / 1000)}s 内需完成` : "不限时"}
                  </span>
                  <span className="step-status">
                    {s.overdue ? (
                      <Badge tone="warn">已超时</Badge>
                    ) : scriptStatus.phase === "idle" ? (
                      <Badge tone="dim">未开始</Badge>
                    ) : (
                      <Badge tone="ok">正常</Badge>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>

      {/* ---- 问题区 ---- */}
      <Panel title={`问题提醒（本次会话 ${mon.issues.length} 条）`}>
        {mon.issues.length === 0 ? (
          <div className="empty">暂无问题。分析窗口完成后，新问题会出现在这里。</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {mon.issues.map((issue) => (
              <IssueCard key={issue.id} issue={issue} onLocate={(segId) => {
                const el = document.getElementById(`seg-${segId}`);
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  el.classList.remove("seg-highlight");
                  // force reflow so the animation can replay
                  void el.offsetWidth;
                  el.classList.add("seg-highlight");
                  setTimeout(() => el.classList.remove("seg-highlight"), 1500);
                }
              }} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <span className="metric-k">{label}</span>
      <span className="metric-v">
        {value}
        {hint ? <span className="metric-hint">{hint}</span> : null}
      </span>
    </div>
  );
}

export function IssueCard({ issue, onLocate }: { issue: Issue; onLocate?: (segmentId: string) => void }) {
  const tone = SEVERITY_TONE[issue.severity] ?? "dim";
  return (
    <article className={`issue-card sev-${issue.severity}`}>
      <div className="issue-head">
        <Badge tone={tone}>{SEVERITY_LABEL[issue.severity] ?? issue.severity}</Badge>
        <span className="issue-type">{TYPE_LABEL[issue.type] ?? issue.type}</span>
        <span className="issue-time">{formatClock(issue.startMs)}</span>
        {issue.needsReview ? <Badge tone="warn">需人工核查</Badge> : null}
        {issue.occurrenceCount && issue.occurrenceCount > 1 ? (
          <Badge tone="dim">持续出现 ×{issue.occurrenceCount}</Badge>
        ) : null}
        <span className="issue-seg">
          segment: {issue.segmentIds.join(", ") || "—"}
        </span>
      </div>
      <div className="issue-body">
        <div>原话：<span className="issue-quote">“{issue.quote}”</span></div>
        <div className="issue-basis">依据：{issue.basis}</div>
        <div>建议：{issue.recommendation}</div>
        {issue.suggestedScript ? (
          <div className="issue-script">参考话术：{issue.suggestedScript}</div>
        ) : null}
      </div>
      {onLocate && issue.segmentIds.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={() => onLocate(issue.segmentIds[0])}>定位原句</Button>
        </div>
      ) : null}
    </article>
  );
}

/** Anchor row renderer used when locating segments. */
export function SegmentAnchor({ seg }: { seg: TranscriptSegment }) {
  return (
    <div id={`seg-${seg.id}`} className="seg-row">
      <span className="seg-time">{formatClock(seg.startMs)}</span>
      <span className="seg-text">{seg.text}</span>
    </div>
  );
}
