import { useEffect, useState } from "react";

declare global {
  interface Window {
    appApi: {
      startSession(config: { audioSource: "microphone" | "systemLoopback"; deviceId?: string | null }): Promise<{ sessionId: string; error: unknown }>;
      pauseSession(): Promise<void>;
      stopSession(): Promise<void>;
      listAudioDevices(): Promise<Array<{ id: string; label: string; kind: string; isDefault: boolean }>>;
      subscribeEvents(event: string, listener: (payload: unknown) => void): () => void;
      sendAudioChunk(data: Float32Array, sourceRate: number): void;
    };
  }
}

export default function App() {
  const [status, setStatus] = useState("未开始");
  const [finalTexts, setFinalTexts] = useState<string[]>([]);
  const [partialText, setPartialText] = useState("");
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => {
    const off1 = window.appApi.subscribeEvents("transcript.final", (p) => {
      const seg = p as { text: string };
      setFinalTexts((prev) => [...prev.slice(-100), seg.text]);
    });
    const off2 = window.appApi.subscribeEvents("transcript.partial", (p) => {
      setPartialText((p as { text: string }).text);
    });
    const off3 = window.appApi.subscribeEvents("analysis.issues", (p) => {
      const arr = p as Array<{ type: string; quote: string; recommendation: string }>;
      setIssues(arr.map((i) => `[${i.type}] ${i.quote}: ${i.recommendation}`));
    });
    return () => {
      off1();
      off2();
      off3();
    };
  }, []);

  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => {
      window.appApi.sendAudioChunk(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate);
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    await window.appApi.startSession({ audioSource: "microphone", deviceId: null });
    setStatus("采集中（麦克风）");
  }

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>AI 盯播工具</h1>
      <div>状态: {status}</div>
      <button onClick={startMic}>开始麦克风监听</button>
      <button onClick={() => window.appApi.stopSession()}>停止</button>
      <h2>实时字幕</h2>
      <div style={{ color: "#888" }}>{partialText}</div>
      <div>
        {finalTexts.map((t, i) => (
          <div key={i}>{t}</div>
        ))}
      </div>
      <h2>问题提醒</h2>
      <ul>
        {issues.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
