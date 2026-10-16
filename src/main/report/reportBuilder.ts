import { Store } from "../storage/store";
import { computeMetrics } from "../analysis/metrics";
import { computeStepCoverage, replayScriptPhases } from "../analysis/ruleEngine";
import type { Framework, Issue, ReportSummary, ScriptReport, SessionEndReason } from "../../shared/contracts";
import { PHASE_LABEL } from "../../shared/contracts";

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

  // 话术步骤覆盖：重放稳态转写还原阶段区间（与实时会话同一台状态机，确定性一致）。
  // 框架必须用「本会话实际使用的那个」，不能无脑取列表第一个——否则多框架场景下
  // 报告会用商品 A 的步骤去算商品 B 的覆盖率，且用户完全看不出来。
  let script: ScriptReport | null = null;
  const boundFrameworkId = session.framework_id;
  const defaultFramework = store.listFrameworks()[0] ?? null;
  let framework: Framework | null = null;
  let frameworkSource: ScriptReport["frameworkSource"] = "session-bound";
  let frameworkFallbackReason: string | null = null;
  if (boundFrameworkId) {
    const bound = store.getFramework(boundFrameworkId);
    if (bound) {
      framework = bound;
    } else {
      // 框架已被删除：回退到默认框架，但必须标明——此时的覆盖率结论可能完全不对。
      framework = defaultFramework;
      frameworkSource = "fallback-deleted";
      frameworkFallbackReason = `会话记录的话术框架（${boundFrameworkId}）已被删除，已回退到默认框架「${defaultFramework?.name ?? "无"}」；此时的步骤覆盖结论可能不准确`;
    }
  } else if (defaultFramework) {
    // 老会话没有 framework_id：历史上只有单框架，回退大概率正确，但不保证。
    framework = defaultFramework;
    frameworkSource = "fallback-unrecorded";
    frameworkFallbackReason = "该会话未记录使用的框架（早期版本或未配置），已回退到默认框架；若当时使用的不是默认框架，覆盖结论不准确";
  }
  if (framework) {
    const phases = replayScriptPhases(segments);
    script = {
      frameworkName: framework.name,
      frameworkSource,
      frameworkFallbackReason,
      phases: phases.map((p) => ({ phase: p.phase, startMs: p.startMs, endMs: p.endMs })),
      steps: computeStepCoverage(framework, phases).map((c) => ({
        name: c.step.name,
        priority: c.step.priority,
        maxWaitMs: c.step.maxWaitMs,
        maxStayMs: c.maxStayMs,
        overdue: c.overdue,
      })),
    };
  }

  return {
    session: {
      id: session.id,
      startedAtIso: session.started_at_iso,
      endedAtIso: session.ended_at_iso,
      audioSource: session.audio_source,
      listenedMs,
      endReason: (session.end_reason as SessionEndReason | null) ?? null,
    },
    asr: {
      // connectionCount / disconnectCount 仍未持久化：那需要一张连接事件表，
      // 超出本轮范围，保持 null（未测量），绝不用 0 冒充。
      //
      // gapCount 不同——sessions.gap_count 自 v5 迁移起就落库了，
      // orchestrator 在 ASR 断线重连时累加（以连接为单位、主动结束不计）。
      // 老库迁移后为 0，表示「确实没有断线缺口」，与「未测量」是两回事。
      connectionCount: null,
      disconnectCount: null,
      gapCount: typeof session.gap_count === "number" ? session.gap_count : 0,
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
      requestCount: null,
      failedCount: null,
      estimatedTokens: estimateTokens(metrics.chineseChars, metrics.englishWords),
    },
    analysisRuns: runStats,
    script,
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
  frameworkConflict: "与框架事实不符",
  other: "其他",
};

const PRIORITY_LABEL: Record<number, string> = {
  0: "可选",
  1: "建议",
  2: "必须",
};

/** 话术步骤覆盖章节（未配置框架时给出说明，不虚构数据）。 */
function scriptSection(report: ReportSummary): string {
  if (!report.script) {
    return `<h2>话术步骤覆盖</h2>\n<p class="kv">未配置话术框架，无步骤覆盖数据。</p>`;
  }
  const s = report.script;
  const phaseRows = s.phases.length
    ? s.phases
        .map(
          (p) => `<tr>
  <td>${esc(PHASE_LABEL[p.phase] ?? p.phase)}</td>
  <td>${formatMs(p.startMs)}</td>
  <td>${formatMs(p.endMs)}</td>
  <td>${formatMs(p.endMs - p.startMs)}</td>
</tr>`,
        )
        .join("\n")
    : '<tr><td colspan="4">未识别到话术阶段</td></tr>';
  const stepRows = s.steps
    .map(
      (st) => `<tr>
  <td>${esc(st.name)}</td>
  <td>${PRIORITY_LABEL[st.priority] ?? st.priority}</td>
  <td>${st.maxWaitMs > 0 ? formatMs(st.maxWaitMs) : "不限时"}</td>
  <td>${formatMs(st.maxStayMs)}</td>
  <td class="${st.overdue ? "sev-warning" : ""}">${st.overdue ? "已超时" : "正常"}</td>
</tr>`,
    )
    .join("\n");
  return `<h2>话术步骤覆盖</h2>
<p class="kv">框架：${esc(s.frameworkName)}${s.frameworkSource === "session-bound" ? "" : ` <span style="color:#b45309;font-weight:bold;">（${s.frameworkSource === "fallback-deleted" ? "框架已删除，已回退默认框架" : "框架未记录，已回退默认框架"}）</span>`}</p>
${s.frameworkFallbackReason ? `<div style="border-left:3px solid #b45309;background:#fffbeb;padding:8px 10px;margin:6px 0;font-size:12px;color:#78350f;">⚠ ${esc(s.frameworkFallbackReason)}</div>` : ""}
<table>
<thead><tr><th>阶段</th><th>进入</th><th>离开</th><th>停留</th></tr></thead>
<tbody>${phaseRows}</tbody>
</table>
<table>
<thead><tr><th>步骤</th><th>优先级</th><th>最长等待</th><th>最长停留</th><th>状态</th></tr></thead>
<tbody>${stepRows || '<tr><td colspan="5">无步骤</td></tr>'}</tbody>
</table>`;
}

/**
 * 样本标注：仅验证脚本会传；主进程正常导出报告不传，行为完全不变。
 * 目的是让 HTML（给人直接双击打开的工件）也带上样本性质与污染边界，
 * 避免「纯 TTS 样本」被当成真实直播引用——这类样本一旦被隐藏性质，
 * 比数字算错更危险。
 */
export interface SampleAnnotation {
  sampleNature: string;
  sourceLabel: string;
  boundaryNote: string;
  /** 该样本是否可当作干净直播引用；false 时用醒目警示色 */
  usableAsLiveSample: boolean;
}

const NATURE_LABEL: Record<string, string> = {
  "clean-live-stream": "干净真实直播",
  "advertisement-voiceover": "广告口播",
  "tts-voiceover": "纯 TTS 口播",
  mixed: "混合来源",
  unknown: "性质未知",
};

/** 渲染样本性质警示条；未传标注时返回空字符串（既有调用行为不变）。 */
function sampleBanner(annotation?: SampleAnnotation): string {
  if (!annotation) return "";
  const label = NATURE_LABEL[annotation.sampleNature] ?? annotation.sampleNature;
  const danger = !annotation.usableAsLiveSample;
  const bg = danger ? "#fef2f2" : "#f0fdf4";
  const border = danger ? "#b91c1c" : "#15803d";
  const title = danger
    ? `⚠ 样本性质：${esc(label)} —— 不得作为「真实直播」引用`
    : `样本性质：${esc(label)}`;
  return `<div style="border:2px solid ${border};background:${bg};padding:12px 14px;margin:0 0 16px;border-radius:6px;">
<div style="font-weight:bold;color:${border};margin-bottom:6px;">${title}</div>
<div class="kv" style="color:#333;">来源：${esc(annotation.sourceLabel)}</div>
<div class="kv" style="color:#333;margin-top:6px;">样本边界：${esc(annotation.boundaryNote)}</div>
</div>`;
}

/** Renders the HTML report from real report data. */
export function buildHtmlReport(report: ReportSummary, annotation?: SampleAnnotation): string {
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

  const natureLabel = annotation ? (NATURE_LABEL[annotation.sampleNature] ?? annotation.sampleNature) : null;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>盯播报告 ${esc(report.session.id.slice(0, 8))}${natureLabel ? ` · ${esc(natureLabel)}` : ""}</title>
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
${sampleBanner(annotation)}
<h1>AI 盯播直播报告</h1>
<p class="kv">
会话 ${esc(report.session.id)} · 开始 ${esc(report.session.startedAtIso)} ·
实际监听 ${formatMs(report.session.listenedMs)} · 音源 ${esc(report.session.audioSource === "microphone" ? "麦克风" : "系统声音")}<br/>
生成时间 ${esc(report.generatedAtIso)}
</p>

<h2>问题概览</h2>
<p class="kv">共 ${report.issues.total} 条：已确认 ${report.issues.confirmed}，需人工核查 ${report.issues.needsReview}。
分布（严重 ${bySev(report, "critical")} / 警告 ${bySev(report, "warning")} / 提示 ${bySev(report, "info")}）。
LLM 实际请求次数与失败次数未统计；分析窗口 ${report.analysisRuns.total} 个，完整分析（规则+语义）${report.analysisRuns.success} 个，失败 ${report.analysisRuns.failed} 个，其余为 skipped（未配置 LLM 仅跑本地规则，或窗口内无稳态转写片段）。**skipped 不计入成功：看到大量 skipped 说明该场未做语义分析，不能表述为「分析成功」。**
ASR 连接与断线次数未统计。转写缺口已统计：本场 ${report.asr.gapCount ?? 0} 次（口径为 ASR 断线重连次数，以连接为单位，主动结束不计；0 表示确实没有断线，不是未测量）。转写文本估算 token ${report.llm.estimatedTokens}（不是服务商实际计费量）。</p>

<h2>问题时间轴</h2>
<table>
<thead><tr><th>时间</th><th>类型</th><th>严重</th><th>原话证据</th><th>判断依据</th><th>建议</th><th>segment</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">无问题记录</td></tr>'}</tbody>
</table>

<h2>话术指标</h2>
<p class="kv">语速分子为中文字数加英文词数；讲话语速除以有效讲话分钟，总时长语速除以分析覆盖时段的总分钟。</p>
<table>
<tbody>
<tr><th>有效讲话</th><td>${formatMs(report.metrics.speechMs)}</td><th>静音</th><td>${formatMs(report.metrics.silenceMs)}</td></tr>
<tr><th>中文字数</th><td>${report.metrics.chineseChars}</td><th>英文词数</th><td>${report.metrics.englishWords}</td></tr>
<tr><th>语速（按讲话）</th><td>${report.metrics.charsPerSpeechMinute} 字词/分</td><th>语速（按总时长）</th><td>${report.metrics.charsPerTotalMinute} 字词/分</td></tr>
<tr><th>最长静音</th><td>${formatMs(report.metrics.longestSilenceMs)}</td><th></th><td></td></tr>
</tbody>
</table>

${scriptSection(report)}

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
