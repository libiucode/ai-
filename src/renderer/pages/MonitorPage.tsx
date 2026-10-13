import { useEffect, useMemo, useRef, useState } from "react";
import type { Issue, TranscriptSegment } from "../../shared/contracts";
import { PHASE_LABEL } from "../../shared/contracts";
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
import { useMonitorState } from "../hooks/useMonitorState";
import { startLoopbackCapture, startMicCapture, type CaptureHandle } from "../capture/audioCapture";

interface DeviceOption {
  id: string;
  label: string;
  isDefault: boolean;
}

export function MonitorPage({ onOpenHistory }: { onOpenHistory: () => void }) {
  const mon = useMonitorState();
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  const [now, setNow] = useState(Date.now());
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // 1s heartbeat for countdown + duration display
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
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

  useEffect(() => () => captureRef.current?.stop(), []);

  const active = ["starting", "capturing", "reconnecting", "analyzing"].includes(mon.sessionState);

  const sessionElapsedMs = useMemo(() => {
    if (!mon.sessionStartedAt) return 0;
    return active || mon.sessionState === "paused" ? now - new Date(mon.sessionStartedAt).getTime() : 0;
  }, [mon.sessionStartedAt, now, active, mon.sessionState]);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [mon.finals.length, mon.partials.length]);

  async function doStart(source: "microphone" | "systemLoopback") {
    setCaptureError(null);
    const onLevel = (l: number) => setLevel(l);
    let result;
    if (source === "microphone") {
      result = await startMicCapture(deviceId, onLevel);
    } else {
      result = await startLoopbackCapture(onLevel);
    }
    if (!result.ok) {
      setCaptureError(result.error.message);
      return;
    }
    captureRef.current = result.handle;
    await mon.startSession({
      audioSource: source,
      deviceId: source === "microphone" ? deviceId : null,
    });
  }

  async function doStop() {
    captureRef.current?.stop();
    captureRef.current = null;
    setLevel(0);
    await mon.stopSession();
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
            {!active && mon.sessionState !== "paused" ? (
              <>
                <select
                  className="input select"
                  value={deviceId ?? ""}
                  onChange={(e) => setDeviceId(e.target.value || null)}
                  disabled={active}
                >
                  <option value="">默认麦克风</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
                <Button variant="primary" onClick={() => doStart("microphone")}>开始麦克风监听</Button>
                <Button onClick={() => doStart("systemLoopback")}>监听系统声音</Button>
              </>
            ) : null}
            {mon.sessionState === "paused" ? (
              <Button variant="primary" onClick={mon.resumeSession}>继续</Button>
            ) : null}
            {active ? <Button onClick={mon.pauseSession}>暂停</Button> : null}
            {active || mon.sessionState === "paused" ? (
              <Button variant="danger" onClick={doStop}>结束</Button>
            ) : null}
            {mon.sessionState === "completed" ? (
              <Button variant="primary" onClick={onOpenHistory}>查看历史与报告</Button>
            ) : null}
          </div>
        </div>

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
        </div>

        {captureError ? <div className="callout callout-danger">{captureError}</div> : null}
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
