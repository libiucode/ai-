import { useCallback, useEffect, useState } from "react";
import type { Issue, ReportFormat, ReportSummary, SessionSummary, TranscriptSegment } from "../../shared/contracts";
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
import { formatEndReason } from "./endReason";

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

  async function doExport(format: ReportFormat) {
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
    <div className="history-layout">
      <Panel title={`历史会话（${sessions.length}）`} className="history-side">
        {sessions.length === 0 ? (
          <div className="empty">还没有会话。去“实时监控”开始第一次监听。</div>
        ) : null}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item${selectedId === s.id ? " active" : ""}`}
            onClick={() => void open(s.id)}
          >
            <div className="session-head">
              <span className="session-id">{s.id.slice(0, 8)}</span>
              <Badge tone={s.status === "stopped" ? "dim" : "ok"}>{s.status === "stopped" ? "已结束" : "进行中"}</Badge>
            </div>
            <div className="session-meta">
              {new Date(s.startedAtIso).toLocaleString()}
            </div>
            <div className="session-meta">
              {s.finalSegmentCount} 条稳态 · {s.issueCount} 条问题 · {s.audioSource === "microphone" ? "麦克风" : "系统声音"}
            </div>
            {s.hasGap ? (
              // 断线缺口：让用户一眼看出「这几分钟没录上」不是主播没说话。
              <div className="session-gap-warn">
                ⚠ 有转写缺口 ×{s.gapCount ?? 1}（ASR 断线重连，期间未录上）
              </div>
            ) : null}
            <div onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" onClick={() => void doDelete(s.id)}>删除</Button>
            </div>
          </div>
        ))}
      </Panel>

      <div className="history-main">
        {!selectedId ? (
          <Panel>
            <div className="empty">选择左侧会话查看详情与报告。</div>
          </Panel>
        ) : loading ? (
          <Panel><div className="loading">加载中…</div></Panel>
        ) : (
          <>
            <div className="view-bar">
              <Button variant={view === "detail" ? "primary" : "default"} onClick={() => setView("detail")}>转写与问题</Button>
              <Button variant={view === "report" ? "primary" : "default"} onClick={() => setView("report")}>报告</Button>
              <div className="spacer">
                <Button onClick={() => void doExport("html")}>导出 HTML 报告</Button>
                <Button onClick={() => void doExport("json")}>导出 JSON 报告</Button>
              </div>
            </div>
            {exportMsg ? <div className="export-msg">{exportMsg}</div> : null}

            {view === "report" && report ? (
              <ReportView report={report} />
            ) : detail ? (
              <div className="stack">
                <Panel title={`问题（${detail.issues.length}）`}>
                  {detail.issues.length === 0 ? (
                    <div className="empty">该会话没有问题记录。</div>
                  ) : (
                    <div className="stack">
                      {detail.issues.map((i) => (
                        <IssueCard key={i.id} issue={i} />
                      ))}
                    </div>
                  )}
                </Panel>
                <Panel title={`稳态转写（${detail.segments.length}）`}>
                  <div className="transcript" style={{ maxHeight: 360 }}>
                    {detail.segments.map((seg) => (
                      <div key={seg.id} className="seg-row">
                        <span className="seg-time">{formatClock(seg.startMs)}</span>
                        <span className="seg-text">{seg.text}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ReportView({ report }: { report: ReportSummary }) {
  return (
    <div className="stack">
      <Panel title="会话信息">
        <KV k="会话 ID" v={report.session.id} />
        <KV k="开始时间" v={new Date(report.session.startedAtIso).toLocaleString()} />
        <KV k="实际监听时长" v={formatClock(report.session.listenedMs)} />
        <KV k="音源" v={report.session.audioSource === "microphone" ? "麦克风" : "系统声音"} />
        <KV k="结束方式" v={formatEndReason(report.session.endReason)} />
      </Panel>

      <Panel title="分析质量与缺口">
        <div className="kv-grid">
          <KV k="分析运行" v={`${report.analysisRuns.success}/${report.analysisRuns.total} 成功`} />
        </div>
        {/*
          ASR 连接/断线次数与 LLM 请求/失败次数仍未持久化（需要连接事件表），
          保持"未统计"——不用 analysisRuns 拼近似值，也不给看似精确的数字。
          但「转写缺口」自 v5 起是真实落库的（sessions.gap_count），
          必须显示实测值：用户复盘时要能区分「主播没说话」和「ASR 断了没录上」。
        */}
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.textDim, lineHeight: 1.8 }}>
          <div>
            ASR 连接 / 断线次数：未统计
            {report.asr.gapCount > 0
              ? ` · 转写缺口：${report.asr.gapCount} 次`
              : " · 转写缺口：无"}
          </div>
          <div>LLM 请求 / 失败次数：未统计</div>
          <div>
            "连接 / 断线次数"是 ASR 连接与底层网络层在本次会话中实时产生的事件，
            没有被持久化落到数据库，所以无法在事后准确回算。
            "转写缺口"已落库，口径是「断线重连」次数（以连接为单位，主动结束不计）。
          </div>
        </div>
        {report.asr.gapCount > 0 ? (
          <div className="callout callout-warn">
            ⚠ 本场有 {report.asr.gapCount} 次 ASR 断线重连，对应时段的音频未被转写，
            相关时间点的语速、静默与问题统计可能不完整。
          </div>
        ) : null}
        {report.analysisRuns.failed > 0 ? (
          <div className="callout callout-warn">
            ⚠ 有 {report.analysisRuns.failed} 次分析运行失败（LLM 超时或坏 JSON），相应窗口的问题可能缺失。以上统计不含失败窗口。
          </div>
        ) : null}
      </Panel>

      <Panel title="问题统计">
        <div className="kv-grid" style={{ marginBottom: 8 }}>
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
        <div className="kv-grid">
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
              <table className="table" style={{ marginBottom: 12 }}>
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
                      <td 
>{PHASE_LABEL[p.phase] ?? p.phase}</td>
                      <td 
>{formatClock(p.startMs)}</td>
                      <td 
>{formatClock(p.endMs)}</td>
                      <td 
>{formatClock(p.endMs - p.startMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <table className="table">
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
                    <td 
>{s.name}</td>
                    <td 
>{PRIORITY_LABEL[s.priority] ?? String(s.priority)}</td>
                    <td 
>{s.maxWaitMs > 0 ? formatClock(s.maxWaitMs) : "不限时"}</td>
                    <td 
>{formatClock(s.maxStayMs)}</td>
                    <td 
>
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
          <table className="table">
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
                  <td 
>{TYPE_LABEL[i.type] ?? i.type}</td>
                  <td 
>
                    <Badge tone={SEVERITY_TONE[i.severity] ?? "dim"}>{SEVERITY_LABEL[i.severity] ?? i.severity}</Badge>
                  </td>
                  <td 
>“{i.quote}”</td>
                  <td style={{ padding: "4px 8px", color: tokens.textDim }}>{i.basis}</td>
                  <td 
>{i.recommendation}</td>
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
    <div className="kv">
      <span className="kv-k">{k}：</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}
