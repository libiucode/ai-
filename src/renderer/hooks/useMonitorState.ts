import { useEffect, useRef, useState, useCallback } from "react";
import type {
  AppError,
  AsrStatus,
  AudioStatus,
  Issue,
  ScriptStatus,
  TranscriptSegment,
} from "../../shared/contracts";
import type { AnalysisStatusLike, RendererAppApi } from "../../shared/api";

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
          const next = [...prev, { key: seg.id, text: seg.text }];
          return next.length > 3 ? next.slice(-3) : next;
        });
      }),
      window.appApi.subscribeEvents("transcript.final", (seg) => {
        setPartials([]);
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
      }),
      window.appApi.subscribeEvents("asr.status", (st) => {
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
      window.appApi.subscribeEvents("app.error", (err) => {
        setErrors((prev) => [err, ...prev].slice(0, 20));
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
      setScript(null);
      setHasTranscriptGap(false);
      setLastFinalAt(null);
      try {
        const result = await window.appApi.startSession(config);
        if (result.error) {
          setErrors((prev) => [result.error!, ...prev]);
          setUiState("error");
          return;
        }
        setSessionId(result.sessionId);
        setSessionStartedAt(new Date().toISOString());
        setUiState("capturing");
      } catch (err) {
        setErrors([
          { code: "UI_START_FAILED", message: err instanceof Error ? err.message : "启动失败", retryable: false },
        ]);
        setUiState("error");
      }
    },
    [setUiState],
  );

  const pauseSession = useCallback(async () => {
    setUiState("stopping");
    await window.appApi.pauseSession();
    setUiState("paused");
  }, [setUiState]);

  const resumeSession = useCallback(() => setUiState("capturing"), [setUiState]);

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
