import { Store } from "../storage/store";
import { computeMetrics } from "../analysis/metrics";
import type { Issue, ReportSummary } from "../../shared/contracts";

function rowToIssue(r: Record<string, unknown>): Issue {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    analysisRunId: r.analysis_run_id as string,
    type: r.type as Issue["type"],
    severity: r.severity as Issue["severity"],
    startMs: r.start_ms as number,
    endMs: r.end_ms as number,
    segmentIds: JSON.parse((r.segment_ids as string) ?? "[]") as string[],
    quote: r.quote as string,
    basis: r.basis as string,
    recommendation: r.recommendation as string,
    suggestedScript: (r.suggested_script as string) ?? null,
    confidence: r.confidence as number,
    needsReview: (r.needs_review as number) === 1,
    status: r.status as Issue["status"],
    occurrenceCount: r.occurrence_count as number,
    firstSeenMs: r.first_seen_ms as number,
    lastSeenMs: r.last_seen_ms as number,
  };
}

/** Estimates tokens from the raw transcript character count (CJK ≈ 1 token/char heuristic). */
export function estimateTokens(chineseChars: number, englishWords: number): number {
  return Math.round(chineseChars * 1.6 + englishWords * 1.3);
}

/**
 * Builds a report summary entirely from real database rows.
 * Never includes API keys or service configuration.
 */
export function buildReportSummary(store: Store, sessionId: string): ReportSummary | null {
  const session = store.getSession(sessionId);
  if (!session) return null;

  const segments = store.querySegments({ sessionId, finalOnly: true });
  const issues = store.listIssues(sessionId).map(rowToIssue);
  const intervals = store.querySpeechIntervals(sessionId, 0, Number.MAX_SAFE_INTEGER);
  const startMs = 0;
  const endMs = Math.max(
    segments.reduce((max, s) => Math.max(max, s.endMs), 0),
    intervals.reduce((max, i) => Math.max(max, i.endMs), 0),
    0,
  );
  const metrics = computeMetrics(segments, intervals, startMs, endMs);
  const runStats = store.analysisRunStats(sessionId);

  const bySeverity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
  const byType: Record<string, number> = {};
  let confirmed = 0;
  let needsReview = 0;
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
    byType[issue.type] = (byType[issue.type] ?? 0) + 1;
    if (issue.needsReview) needsReview++;
    else confirmed++;
  }

  const issueTimeline = issues.map((i) => ({
    issueId: i.id,
    type: i.type,
    severity: i.severity,
    firstSeenMs: i.firstSeenMs ?? i.startMs,
    quote: i.quote,
    segmentIds: i.segmentIds,
    basis: i.basis,
    recommendation: i.recommendation,
  }));

  const startedAt = new Date(session.started_at_iso).getTime();
  const endedAt = session.ended_at_iso
    ? new Date(session.ended_at_iso).getTime()
    : Date.now();
  const listenedMs = Math.max(0, endedAt - startedAt);

  return {
    session: {
      id: session.id,
      startedAtIso: session.started_at_iso,
      endedAtIso: session.ended_at_iso,
      audioSource: session.audio_source,
      listenedMs,
    },
    asr: {
      connectionCount: runStats.total,
      disconnectCount: runStats.failed,
      gapCount: runStats.failed,
    },
    issues: {
      total: issues.length,
      bySeverity,
      byType,
      confirmed,
      needsReview,
    },
    issueTimeline,
    metrics: {
      speechMs: metrics.speechMs,
      silenceMs: metrics.silenceMs,
      chineseChars: metrics.chineseChars,
      englishWords: metrics.englishWords,
      charsPerSpeechMinute: Math.round(metrics.charsPerSpeechMinute),
      charsPerTotalMinute: Math.round(metrics.charsPerTotalMinute),
      longestSilenceMs: Math.round(metrics.longestSilenceMs),
    },
    llm: {
      requestCount: runStats.total,
      failedCount: runStats.failed,
      estimatedTokens: estimateTokens(metrics.chineseChars, metrics.englishWords),
    },
    analysisRuns: runStats,
    generatedAtIso: new Date().toISOString(),
  };
}

/** Escapes text for HTML report output. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const SEVERITY_LABEL: Record<string, string> = {
  critical: "严重",
  warning: "警告",
  info: "提示",
};

export const TYPE_LABEL: Record<string, string> = {
  bannedWord: "禁用词",
  absolutization: "绝对化用语",
  unverifiedClaim: "未核实宣称",
  repetition: "话术重复",
  pace: "语速异常",
  silence: "长时间静音",
  frameworkStep: "话术步骤缺失",
  other: "其他",
};

/** Renders the HTML report from real report data. */
export function buildHtmlReport(report: ReportSummary): string {
  const rows = report.issueTimeline
    .map(
      (i) => `<tr>
  <td>${formatMs(i.firstSeenMs)}</td>
  <td>${esc(TYPE_LABEL[i.type] ?? i.type)}</td>
  <td>${esc(SEVERITY_LABEL[i.severity] ?? i.severity)}</td>
  <td>${esc(i.quote)}</td>
  <td>${esc(i.basis)}</td>
  <td>${esc(i.recommendation)}</td>
  <td>${i.segmentIds.join("<br/>") || "—"}</td>
</tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>盯播报告 ${esc(report.session.id.slice(0, 8))}</title>
<style>
body { font-family: "Microsoft YaHei", sans-serif; margin: 24px auto; max-width: 1100px; color: #222; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 13px; }
th { background: #f3f4f6; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
.kv { font-size: 13px; color: #555; }
.sev-critical { color: #b91c1c; font-weight: bold; }
.sev-warning { color: #b45309; }
.sev-info { color: #374151; }
</style>
</head>
<body>
<h1>AI 盯播直播报告</h1>
<p class="kv">
会话 ${esc(report.session.id)} · 开始 ${esc(report.session.startedAtIso)} ·
实际监听 ${formatMs(report.session.listenedMs)} · 音源 ${esc(report.session.audioSource === "microphone" ? "麦克风" : "系统声音")}<br/>
生成时间 ${esc(report.generatedAtIso)}
</p>

<h2>问题概览</h2>
<p class="kv">共 ${report.issues.total} 条：已确认 ${report.issues.confirmed}，需人工核查 ${report.issues.needsReview}。
分布（严重 ${bySev(report, "critical")} / 警告 ${bySev(report, "warning")} / 提示 ${bySev(report, "info")}）。
LLM 请求 ${report.llm.requestCount} 次（失败 ${report.llm.failedCount}），分析运行 ${report.analysisRuns.total} 次（失败 ${report.analysisRuns.failed}）。
转写缺口 ${report.asr.gapCount} 次。估算 token ${report.llm.estimatedTokens}。</p>

<h2>问题时间轴</h2>
<table>
<thead><tr><th>时间</th><th>类型</th><th>严重</th><th>原话证据</th><th>判断依据</th><th>建议</th><th>segment</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">无问题记录</td></tr>'}</tbody>
</table>

<h2>话术指标</h2>
<table>
<tbody>
<tr><th>有效讲话</th><td>${formatMs(report.metrics.speechMs)}</td><th>静音</th><td>${formatMs(report.metrics.silenceMs)}</td></tr>
<tr><th>中文字数</th><td>${report.metrics.chineseChars}</td><th>英文词数</th><td>${report.metrics.englishWords}</td></tr>
<tr><th>语速（按讲话）</th><td>${report.metrics.charsPerSpeechMinute} 字/分</td><th>语速（按总时长）</th><td>${report.metrics.charsPerTotalMinute} 字/分</td></tr>
<tr><th>最长静音</th><td>${formatMs(report.metrics.longestSilenceMs)}</td><th></th><td></td></tr>
</tbody>
</table>

<h2>问题分类</h2>
<table>
<thead><tr><th>类型</th><th>数量</th></tr></thead>
<tbody>
${Object.entries(report.issues.byType)
  .map(([t, n]) => `<tr><td>${esc(TYPE_LABEL[t] ?? t)}</td><td>${n}</td></tr>`)
  .join("\n") || '<tr><td colspan="2">无</td></tr>'}
</tbody>
</table>
</body>
</html>`;
}

function bySev(report: ReportSummary, sev: string): number {
  return report.issues.bySeverity[sev] ?? 0;
}
