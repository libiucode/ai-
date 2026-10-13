import { useCallback, useEffect, useState } from "react";
import type { Issue, ReportSummary, SessionSummary, TranscriptSegment } from "../../shared/contracts";
import { PHASE_LABEL } from "../../shared/contracts";
import {
  Badge,
  Button,
  Panel,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  TYPE_LABEL,
  formatClock,
  tokens,
} from "../ui/basics";
import { PRIORITY_LABEL } from "./frameworkSchema";
import { IssueCard } from "./MonitorPage";

export function HistoryPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    segments: TranscriptSegment[];
    issues: Issue[];
  } | null>(null);
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [view, setView] = useState<"detail" | "report">("detail");

  const loadSessions = useCallback(async () => {
    const r = await window.appApi.listSessions();
    setSessions(r.sessions);
    if (r.error) setExportMsg(`会话列表加载失败：${r.error.message}`);
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function open(id: string) {
    setSelectedId(id);
    setView("detail");
    setLoading(true);
    setReport(null);
    const [d, r] = await Promise.all([
      window.appApi.getSessionDetail(id),
      window.appApi.generateReport(id, "json"),
    ]);
    setDetail({ segments: d.segments, issues: d.issues });
    setReport(r);
    setLoading(false);
  }

  async function doExport(format: "markdown" | "json") {
    if (!selectedId) return;
    setExportMsg("导出中…");
    const p = await window.appApi.exportReport(selectedId, format);
    setExportMsg(p ? `已保存到 ${p}` : "导出已取消");
  }

  async function doDelete(id: string) {
    await window.appApi.deleteSession(id);
    if (selectedId === id) {
      setSelectedId(null);
      setDetail(null);
      setReport(null);
    }
    await loadSessions();
  }

  return (
    <div style={{ display: "flex", gap: 12 }}>
      <Panel title={`历史会话（${sessions.length}）`} style={{ width: 320, flexShrink: 0, alignSelf: "flex-start" }}>
        {sessions.length === 0 ? (
          <div style={{ fontSize: 13, color: tokens.textDim }}>还没有会话。去“实时监控”开始第一次监听。</div>
        ) : null}
        {sessions.map((s) => (
          <div
            key={s.id}
            style={{
              padding: "8px 6px",
              borderBottom: `1px solid ${tokens.border}`,
              cursor: "pointer",
              background: selectedId === s.id ? tokens.accentSoft : "transparent",
              borderRadius: 6,
            }}
            onClick={() => void open(s.id)}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{s.id.slice(0, 8)}</span>
              <Badge tone={s.status === "stopped" ? "dim" : "ok"}>{s.status === "stopped" ? "已结束" : "进行中"}</Badge>
            </div>
            <div style={{ fontSize: 12, color: tokens.textDim, marginTop: 2 }}>
              {new Date(s.startedAtIso).toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: tokens.textDim }}>
              {s.finalSegmentCount} 条稳态 · {s.issueCount} 条问题 · {s.audioSource === "microphone" ? "麦克风" : "系统声音"}
            </div>
            <div style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" onClick={() => void doDelete(s.id)}>删除</Button>
            </div>
          </div>
        ))}
      </Panel>

      <div style={{ flex: 1, minWidth: 0 }}>
        {!selectedId ? (
          <Panel>
            <div style={{ color: tokens.textDim, fontSize: 13 }}>选择左侧会话查看详情与报告。</div>
          </Panel>
        ) : loading ? (
          <Panel><div style={{ color: tokens.textDim }}>加载中…</div></Panel>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <Button variant={view === "detail" ? "primary" : "default"} onClick={() => setView("detail")}>转写与问题</Button>
              <Button variant={view === "report" ? "primary" : "default"} onClick={() => setView("report")}>报告</Button>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <Button onClick={() => void doExport("markdown")}>导出 HTML 报告</Button>
                <Button onClick={() => void doExport("json")}>导出 JSON 报告</Button>
              </div>
            </div>
            {exportMsg ? <div style={{ fontSize: 12, color: tokens.textDim, marginBottom: 8 }}>{exportMsg}</div> : null}

            {view === "report" && report ? (
              <ReportView report={report} />
            ) : detail ? (
              <>
                <Panel title={`问题（${detail.issues.length}）`} style={{ marginBottom: 12 }}>
                  {detail.issues.length === 0 ? (
                    <div style={{ fontSize: 13, color: tokens.textDim }}>该会话没有问题记录。</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {detail.issues.map((i) => (
                        <IssueCard key={i.id} issue={i} />
                      ))}
                    </div>
                  )}
                </Panel>
                <Panel title={`稳态转写（${detail.segments.length}）`}>
                  <div style={{ maxHeight: 360, overflowY: "auto", fontSize: 13, lineHeight: 1.7 }}>
                    {detail.segments.map((seg) => (
                      <div key={seg.id} style={{ display: "flex", gap: 8 }}>
                        <span style={{ color: tokens.textDim, flexShrink: 0 }}>{formatClock(seg.startMs)}</span>
                        <span>{seg.text}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ReportView({ report }: { report: ReportSummary }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel title="会话信息">
        <KV k="会话 ID" v={report.session.id} />
        <KV k="开始时间" v={new Date(report.session.startedAtIso).toLocaleString()} />
        <KV k="实际监听时长" v={formatClock(report.session.listenedMs)} />
        <KV k="音源" v={report.session.audioSource === "microphone" ? "麦克风" : "系统声音"} />
      </Panel>

      <Panel title="分析质量与缺口">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <KV k="ASR/LLM 请求次数" v={String(report.asr.connectionCount)} />
          <KV k="失败次数" v={String(report.asr.disconnectCount)} />
          <KV k="转写缺口" v={String(report.asr.gapCount)} />
          <KV k="分析运行" v={`${report.analysisRuns.success}/${report.analysisRuns.total} 成功`} />
          <KV k="估算 token" v={String(report.llm.estimatedTokens)} />
        </div>
        {report.analysisRuns.failed > 0 ? (
          <div style={{ marginTop: 8, fontSize: 13, color: tokens.warn }}>
            ⚠ 有 {report.analysisRuns.failed} 次分析运行失败（LLM 超时或坏 JSON），相应窗口的问题可能缺失。以上统计不含失败窗口。
          </div>
        ) : null}
      </Panel>

      <Panel title="问题统计">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 8 }}>
          <KV k="问题总数" v={String(report.issues.total)} />
          <KV k="已确认" v={String(report.issues.confirmed)} />
          <KV k="需人工核查" v={String(report.issues.needsReview)} />
          <KV k="严重 / 警告 / 提示" v={`${report.issues.bySeverity.critical ?? 0} / ${report.issues.bySeverity.warning ?? 0} / ${report.issues.bySeverity.info ?? 0}`} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Object.entries(report.issues.byType).map(([t, n]) => (
            <Badge key={t} tone="dim">{TYPE_LABEL[t] ?? t} ×{n}</Badge>
          ))}
        </div>
      </Panel>

      <Panel title="话术指标">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <KV k="有效讲话" v={formatClock(report.metrics.speechMs)} />
          <KV k="静音" v={formatClock(report.metrics.silenceMs)} />
          <KV k="中文字数" v={String(report.metrics.chineseChars)} />
          <KV k="语速（讲话）" v={`${report.metrics.charsPerSpeechMinute} 字/分`} />
          <KV k="语速（总时长）" v={`${report.metrics.charsPerTotalMinute} 字/分`} />
          <KV k="最长静音" v={formatClock(report.metrics.longestSilenceMs)} />
        </div>
      </Panel>

      <Panel title="话术步骤覆盖">
        {!report.script ? (
          <div style={{ fontSize: 13, color: tokens.textDim }}>未配置话术框架，无步骤覆盖数据。</div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: tokens.textDim, marginBottom: 8 }}>框架：{report.script.frameworkName}</div>
            {report.script.phases.length === 0 ? (
              <div style={{ fontSize: 13, color: tokens.textDim, marginBottom: 8 }}>未识别到话术阶段。</div>
            ) : (
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, marginBottom: 12 }}>
                <thead>
                  <tr>
                    {["阶段", "进入", "离开", "停留"].map((h) => (
                      <th key={h} style={{ textAlign: "left", borderBottom: `1px solid ${tokens.border}`, padding: "4px 8px", color: tokens.textDim }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.script.phases.map((p, i) => (
                    <tr key={i}>
                      <td style={{ padding: "4px 8px" }}>{PHASE_LABEL[p.phase] ?? p.phase}</td>
                      <td style={{ padding: "4px 8px" }}>{formatClock(p.startMs)}</td>
                      <td style={{ padding: "4px 8px" }}>{formatClock(p.endMs)}</td>
                      <td style={{ padding: "4px 8px" }}>{formatClock(p.endMs - p.startMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr>
                  {["步骤", "优先级", "最长等待", "最长停留", "状态"].map((h) => (
                    <th key={h} style={{ textAlign: "left", borderBottom: `1px solid ${tokens.border}`, padding: "4px 8px", color: tokens.textDim }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.script.steps.map((s, i) => (
                  <tr key={i}>
                    <td style={{ padding: "4px 8px" }}>{s.name}</td>
                    <td style={{ padding: "4px 8px" }}>{PRIORITY_LABEL[s.priority] ?? String(s.priority)}</td>
                    <td style={{ padding: "4px 8px" }}>{s.maxWaitMs > 0 ? formatClock(s.maxWaitMs) : "不限时"}</td>
                    <td style={{ padding: "4px 8px" }}>{formatClock(s.maxStayMs)}</td>
                    <td style={{ padding: "4px 8px" }}>
                      {s.overdue ? <Badge tone="warn">已超时</Badge> : <Badge tone="ok">正常</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      <Panel title={`问题时间轴（${report.issueTimeline.length}）`}>
        {report.issueTimeline.length === 0 ? (
          <div style={{ fontSize: 13, color: tokens.textDim }}>无问题记录。</div>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {["时间", "类型", "严重", "原话", "依据", "建议"].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: `1px solid ${tokens.border}`, padding: "4px 8px", color: tokens.textDim }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.issueTimeline.map((i) => (
                <tr key={i.issueId}>
                  <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{formatClock(i.firstSeenMs)}</td>
                  <td style={{ padding: "4px 8px" }}>{TYPE_LABEL[i.type] ?? i.type}</td>
                  <td style={{ padding: "4px 8px" }}>
                    <Badge tone={SEVERITY_TONE[i.severity] ?? "dim"}>{SEVERITY_LABEL[i.severity] ?? i.severity}</Badge>
                  </td>
                  <td style={{ padding: "4px 8px" }}>“{i.quote}”</td>
                  <td style={{ padding: "4px 8px", color: tokens.textDim }}>{i.basis}</td>
                  <td style={{ padding: "4px 8px" }}>{i.recommendation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ fontSize: 13 }}>
      <span style={{ color: tokens.textDim }}>{k}：</span>
      <span style={{ color: tokens.text, fontWeight: 600 }}>{v}</span>
    </div>
  );
}
