import { useEffect, useRef, useState, useCallback } from "react";
import type {
  AppError,
  AsrStatus,
  AudioStatus,
  Issue,
  ScheduleStatus,
  ScriptStatus,
  TranscriptSegment,
} from "../../shared/contracts";
import type { AnalysisStatusLike, RendererAppApi } from "../../shared/api";
import {
  isAutoEndedError,
  nextStateOnAutoEnded,
  nextStateOnCaptureIdle,
} from "./sessionEnd";

declare global {
  interface Window {
    appApi: RendererAppApi;
  }
}

/** Session-level UI state machine (阶段5). */
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

/** Bounded transcript buffer: keeps memory flat over multi-hour runs. */
const MAX_VISIBLE_FINALS = 200;
const MAX_PARTIAL_CHARS = 2000;

export interface UiIssuesState {
  /** issues from the current session, newest first */
  current: Issue[];
}

export function useMonitorState() {
  const [sessionState, setSessionState] = useState<UiSessionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null);
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [asr, setAsr] = useState<AsrStatus | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisStatusLike | null>(null);
  const [script, setScript] = useState<ScriptStatus | null>(null);
  /** 本场会话绑定的排期结束时刻；null 表示不按排期结束。 */
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleStatus | null>(null);
  const [partials, setPartials] = useState<Array<{ key: string; text: string }>>([]);
  const [finals, setFinals] = useState<TranscriptSegment[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [errors, setErrors] = useState<AppError[]>([]);
  const [hasTranscriptGap, setHasTranscriptGap] = useState(false);
  const [lastFinalAt, setLastFinalAt] = useState<number | null>(null);
  const sessionStateRef = useRef<UiSessionState>("idle");

  const setUiState = useCallback((s: UiSessionState) => {
    sessionStateRef.current = s;
    setSessionState(s);
  }, []);

  useEffect(() => {
    const offs = [
      window.appApi.subscribeEvents("transcript.partial", (seg) => {
        setPartials((prev) => {
          const next = [...prev.filter((p) => p.key !== seg.id), { key: seg.id, text: seg.text }];
          return next.length > 3 ? next.slice(-3) : next;
        });
      }),
      window.appApi.subscribeEvents("transcript.final", (seg) => {
        const partialKey = `partial:${seg.connectionId}:${seg.sourceSeq}`;
        setPartials((prev) => prev.filter((p) => p.key !== partialKey));
        setFinals((prev) => {
          const next = [...prev, seg];
          return next.length > MAX_VISIBLE_FINALS ? next.slice(-MAX_VISIBLE_FINALS) : next;
        });
        setLastFinalAt(Date.now());
      }),
      window.appApi.subscribeEvents("capture.status", (st) => {
        setAudio(st);
        if (sessionStateRef.current === "capturing" && st.state === "paused") {
          setUiState("paused");
        }
        // 采集回到 idle 只有一条路径：主进程 stop()。此时会话已在主进程侧结束。
        // 若界面还以为在监听（capturing/analyzing/reconnecting），说明收到了
        // 一条我们没预料到的结束信号（例如主进程侧另有触发者），
        // 此时必须让状态机落地到 completed，否则界面会一直假装在录。
        if (st.state === "idle") {
          const next = nextStateOnCaptureIdle(sessionStateRef.current);
          if (next !== sessionStateRef.current) setUiState(next);
        }
      }),
      window.appApi.subscribeEvents("asr.status", (st) => {
        if (st.state !== "connected") setPartials([]);
        setAsr(st);
        if (st.state === "reconnecting") {
          setHasTranscriptGap(true);
          if (sessionStateRef.current === "capturing") setUiState("reconnecting");
        } else if (st.state === "connected" && sessionStateRef.current === "reconnecting") {
          setUiState("capturing");
        }
      }),
      window.appApi.subscribeEvents("analysis.status", (st) => {
        setAnalysis(st);
        if (st.running && sessionStateRef.current === "capturing") setUiState("analyzing");
        else if (!st.running && sessionStateRef.current === "analyzing") setUiState("capturing");
      }),
      window.appApi.subscribeEvents("analysis.issues", (arr) => {
        setIssues((prev) => [...arr, ...prev].slice(0, 100));
      }),
      window.appApi.subscribeEvents("script.status", (st) => {
        setScript(st);
      }),
      window.appApi.subscribeEvents("schedule.status", (st) => {
        setScheduleStatus(st);
      }),
      window.appApi.subscribeEvents("app.error", (err) => {
        setErrors((prev) => [err, ...prev].slice(0, 20));
        // 自动结束（排期到点等）由主进程通过 app.error 通知。
        // 这条必须驱动状态机——否则会话在后台已停、界面仍显示「监听中」、
        // 采集句柄还在喂音频，正是最不该出现的「假装在录」。
        // 与手点结束走同一个收尾状态（completed），保证两条路径收敛一致。
        if (isAutoEndedError(err.code)) {
          setScheduleStatus({ scheduledEndAtIso: null });
          const next = nextStateOnAutoEnded(sessionStateRef.current);
          if (next !== sessionStateRef.current) setUiState(next);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [setUiState]);

  const startSession = useCallback(
    async (config: { audioSource: "microphone" | "systemLoopback"; deviceId?: string | null }) => {
      setUiState("starting");
      setFinals([]);
      setPartials([]);
      setIssues([]);
      setErrors([]);
      setAnalysis(null);
      setScript(null);
      setScheduleStatus(null);
      setHasTranscriptGap(false);
      setLastFinalAt(null);
      try {
        const result = await window.appApi.startSession(config);
        if (result.error) {
          setErrors((prev) => [result.error!, ...prev]);
          setUiState("error");
          return false;
        }
        setSessionId(result.sessionId);
        setSessionStartedAt(new Date().toISOString());
        setUiState("capturing");
        return true;
      } catch (err) {
        setErrors([
          { code: "UI_START_FAILED", message: err instanceof Error ? err.message : "启动失败", retryable: false },
        ]);
        setUiState("error");
        return false;
      }
    },
    [setUiState],
  );

  const pauseSession = useCallback(async () => {
    setUiState("stopping");
    await window.appApi.pauseSession();
    setUiState("paused");
  }, [setUiState]);

  // 恢复：必须通知主进程（历史上只改 UI 状态，主进程永远停在 paused）
  const resumeSession = useCallback(async () => {
    setUiState("starting");
    await window.appApi.resumeSession();
    setUiState("capturing");
  }, [setUiState]);

  const stopSession = useCallback(async () => {
    setUiState("stopping");
    await window.appApi.stopSession();
    setUiState("completed");
  }, [setUiState]);

  const trimmedPartials = partials.map((p) => ({
    ...p,
    text: p.text.slice(-MAX_PARTIAL_CHARS),
  }));

  return {
    sessionState,
    sessionId,
    sessionStartedAt,
    audio,
    asr,
    analysis,
    script,
    scheduleStatus,
    partials: trimmedPartials,
    finals,
    issues,
    errors,
    hasTranscriptGap,
    lastFinalAt,
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
  };
}
