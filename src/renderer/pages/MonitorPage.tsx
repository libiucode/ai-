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
  inputStyle,
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
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ---- 顶部状态区 ---- */}
      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <Badge tone={stateTone[mon.sessionState]}>{STATE_LABEL[mon.sessionState]}</Badge>
          <div style={{ fontSize: 13, color: tokens.text }}>
            会话：{mon.sessionId ? mon.sessionId.slice(0, 8) : "—"}
            {mon.sessionStartedAt ? ` · 开始 ${new Date(mon.sessionStartedAt).toLocaleTimeString()}` : ""}
          </div>
          <div style={{ fontSize: 13, color: tokens.textDim }}>
            音源：{captureRef.current?.sourceLabel ?? (audio?.source === "microphone" ? "麦克风" : audio?.source === "systemLoopback" ? "系统声音" : "—")}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 13, color: tokens.textDim }}>电平</span>
            <div style={{ width: 80, height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, level * 400)}%`, height: "100%", background: tokens.ok }} />
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {!active && mon.sessionState !== "paused" ? (
              <>
                <select
                  style={{ ...inputStyle, width: 200 }}
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
        <div style={{ display: "flex", gap: 18, marginTop: 10, flexWrap: "wrap", fontSize: 12, color: tokens.textDim }}>
          <span>采集：{audio ? CAPTURE_STATE_LABEL[audio.state] : "未启动"}</span>
          <span>ASR：{asr ? ASR_STATE_LABEL[asr.state] : "未连接"}{asr && asr.reconnectAttempt > 0 ? `（第 ${asr.reconnectAttempt} 次）` : ""}</span>
          <span>最后稳态：{lastFinalAgo !== null ? `${Math.round(lastFinalAgo / 1000)} 秒前` : "—"}</span>
          {audio && audio.queueOverflowCount > 0 ? <span style={{ color: tokens.warn }}>队列溢出 {audio.queueOverflowCount} 次</span> : null}
        </div>
        {captureError ? <div style={{ marginTop: 8, color: tokens.danger, fontSize: 13 }}>{captureError}</div> : null}
        {mon.hasTranscriptGap ? (
          <div style={{ marginTop: 8, padding: "6px 10px", background: tokens.warnSoft, borderRadius: 6, fontSize: 13, color: tokens.warn }}>
            ⚠ ASR 曾断线重连，断线期间存在转写缺口，缺口内没有字幕数据。
          </div>
        ) : null}
        {mon.errors.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            {mon.errors.slice(0, 3).map((e, i) => (
              <div key={i} style={{ fontSize: 12, color: tokens.danger }}>
                [{e.code}] {e.message}
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        {/* ---- 转写区 ---- */}
        <Panel title="实时字幕">
          <div style={{ fontSize: 12, color: tokens.textDim, marginBottom: 6 }}>
            临时字幕为识别中间结果（灰色斜体），不落库；稳态字幕为已定稿内容。
          </div>
          <div ref={transcriptRef} style={{ height: 300, overflowY: "auto", fontSize: 13, lineHeight: 1.7 }}>
            {mon.finals.length === 0 && mon.partials.length === 0 ? (
              <div style={{ color: tokens.textDim }}>暂无字幕。开始监听并说话后，这里会显示识别结果。</div>
            ) : null}
            {mon.finals.map((seg) => (
              <div key={seg.id} style={{ display: "flex", gap: 8 }}>
                <span style={{ color: tokens.textDim, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{formatClock(seg.startMs)}</span>
                <span style={{ color: tokens.text }}>{seg.text}</span>
                <span style={{ color: tokens.textDim, fontSize: 11, flexShrink: 0 }}>稳态 #{seg.sourceSeq}</span>
              </div>
            ))}
            {mon.partials.map((p) => (
              <div key={p.key} style={{ display: "flex", gap: 8, opacity: 0.55 }}>
                <span style={{ flexShrink: 0 }}>…</span>
                <span style={{ fontStyle: "italic", color: tokens.textDim }}>{p.text}</span>
                <span style={{ fontSize: 11, flexShrink: 0 }}>临时</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* ---- 指标区 ---- */}
        <Panel title="指标">
          <Metric label="监听时长" value={formatClock(sessionElapsedMs)} />
          <Metric
            label="有效讲话 / 静音"
            value={
              audio
                ? `${Math.round((sessionElapsedMs * 0) + (mon.finals.length > 0 ? 1 : 0) * 0) || "—"}`
                : "—"
            }
            hint="精确值见分析窗口与报告"
          />
          <Metric label="稳态片段数" value={String(mon.finals.length)} />
          <Metric label="问题数（本次）" value={String(mon.issues.length)} />
          <Metric
            label="最近分析"
            value={mon.analysis?.lastRunStatus ? String(mon.analysis.lastRunStatus) : "—"}
            hint={mon.analysis?.queued ? "有窗口在排队" : undefined}
          />
          <Metric label="分析倒计时" value={analysisCountdownSec ? `${analysisCountdownSec}s` : "按间隔触发"} />
        </Panel>
      </div>

      {/* ---- 话术步骤覆盖 ---- */}
      <Panel title="话术步骤覆盖">
        {!scriptStatus || scriptStatus.steps.length === 0 ? (
          <div style={{ color: tokens.textDim, fontSize: 13 }}>
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
              <div style={{ marginBottom: 8, padding: "6px 10px", background: tokens.warnSoft, borderRadius: 6, fontSize: 13, color: tokens.warn }}>
                ⚠ 步骤{overdueStepNames.map((n) => `「${n}」`).join("、")}已超过最长等待时间，可能漏讲或卡住。
              </div>
            ) : null}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {scriptStatus.steps.map((s) => (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ color: tokens.text, width: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                  <Badge tone="dim">{PRIORITY_LABEL[s.priority] ?? "建议"}</Badge>
                  <span style={{ color: tokens.textDim, fontSize: 12 }}>
                    {s.maxWaitMs > 0 ? `${Math.round(s.maxWaitMs / 1000)}s 内需完成` : "不限时"}
                  </span>
                  <span style={{ marginLeft: "auto" }}>
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
          <div style={{ color: tokens.textDim, fontSize: 13 }}>暂无问题。分析窗口完成后，新问题会出现在这里。</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {mon.issues.map((issue) => (
              <IssueCard key={issue.id} issue={issue} onLocate={(segId) => {
                const el = document.getElementById(`seg-${segId}`);
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "center" });
                  el.style.background = tokens.accentSoft;
                  setTimeout(() => (el.style.background = ""), 1500);
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
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${tokens.border}` }}>
      <span style={{ fontSize: 13, color: tokens.textDim }}>{label}</span>
      <span style={{ fontSize: 13, color: tokens.text, fontWeight: 600 }}>
        {value}
        {hint ? <span style={{ fontWeight: 400, color: tokens.textDim, marginLeft: 6 }}>{hint}</span> : null}
      </span>
    </div>
  );
}

export function IssueCard({ issue, onLocate }: { issue: Issue; onLocate?: (segmentId: string) => void }) {
  const tone = SEVERITY_TONE[issue.severity] ?? "dim";
  return (
    <div style={{ border: `1px solid ${tokens.border}`, borderRadius: tokens.radius, padding: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Badge tone={tone}>{SEVERITY_LABEL[issue.severity] ?? issue.severity}</Badge>
        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text }}>{TYPE_LABEL[issue.type] ?? issue.type}</span>
        <span style={{ fontSize: 12, color: tokens.textDim }}>{formatClock(issue.startMs)}</span>
        {issue.needsReview ? <Badge tone="warn">需人工核查</Badge> : null}
        {issue.occurrenceCount && issue.occurrenceCount > 1 ? (
          <Badge tone="dim">持续出现 ×{issue.occurrenceCount}</Badge>
        ) : null}
        <span style={{ marginLeft: "auto", fontSize: 11, color: tokens.textDim }}>
          segment: {issue.segmentIds.join(", ") || "—"}
        </span>
      </div>
      <div style={{ marginTop: 8, fontSize: 13 }}>
        <div style={{ color: tokens.text }}>
          原话：<span style={{ background: tokens.warnSoft, padding: "1px 4px", borderRadius: 4 }}>“{issue.quote}”</span>
        </div>
        <div style={{ color: tokens.textDim, marginTop: 4 }}>依据：{issue.basis}</div>
        <div style={{ color: tokens.text, marginTop: 4 }}>建议：{issue.recommendation}</div>
        {issue.suggestedScript ? (
          <div style={{ color: tokens.accent, marginTop: 4 }}>参考话术：{issue.suggestedScript}</div>
        ) : null}
      </div>
      {onLocate && issue.segmentIds.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={() => onLocate(issue.segmentIds[0])}>定位原句</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Anchor row renderer used when locating segments. */
export function SegmentAnchor({ seg }: { seg: TranscriptSegment }) {
  return (
    <div id={`seg-${seg.id}`} style={{ display: "flex", gap: 8 }}>
      <span style={{ color: tokens.textDim, flexShrink: 0 }}>{formatClock(seg.startMs)}</span>
      <span>{seg.text}</span>
    </div>
  );
}
