import { LlmAnalysisResultSchema, LlmConfigSchema } from "../../shared/schemas";
import type { LlmAnalysisResult, LlmConfig } from "../../shared/schemas";
import type { TranscriptSegment } from "../../shared/contracts";
import type { WindowMetrics } from "./metrics";
import { makeError } from "../security/errorFactory";

export type { WindowMetrics };

export interface LlmAnalysisInput {
  windowStartMs: number;
  windowEndMs: number;
  segments: TranscriptSegment[];
  rulesSummary: string;
  productFacts: string;
  previousSummary: string;
  metrics: WindowMetrics;
}

export const CORE_PROMPT = `你是直播讲解质量分析器。只依据给定的稳态转写片段、规则和已核实商品事实输出 JSON。
不把前文摘要当证据。不引用不存在的原话。不作违法结论。
若证据不足，issues 返回空数组，或将候选标为 needsReview=true。
每个问题必须引用一个或多个输入 segmentId，quote 必须是对应片段原文的连续子串。
同一持续问题只输出一次。建议必须指出主播接下来可以怎么说。
只返回符合 JSON Schema 的对象，不要 Markdown。`;

function buildUserContent(input: LlmAnalysisInput): string {
  const segments = input.segments
    .map(
      (s) =>
        `{"segmentId":"${s.id}","startMs":${s.startMs},"endMs":${s.endMs},"text":${JSON.stringify(s.text)}}`,
    )
    .join("\n");
  return JSON.stringify({
    window: { startMs: input.windowStartMs, endMs: input.windowEndMs },
    segments: `[${segments}]`,
    rules: input.rulesSummary,
    verifiedProductFacts: input.productFacts,
    previousStateSummary: input.previousSummary,
    objectiveMetrics: {
      speechMs: input.metrics.speechMs,
      silenceMs: input.metrics.silenceMs,
      chineseChars: input.metrics.chineseChars,
      charsPerSpeechMinute: Math.round(input.metrics.charsPerSpeechMinute),
      paceChanges: input.metrics.paceChanges,
      longestSilenceMs: input.metrics.longestSilenceMs,
      maxRepeatSimilarity: Number(input.metrics.maxRepeatSimilarity.toFixed(2)),
      repeatCandidate: input.metrics.repeatCandidate,
    },
  });
}

/** Verifies each LLM issue against the input segments; drops invalid ones. */
export function verifyIssues(
  result: LlmAnalysisResult,
  segments: TranscriptSegment[],
): LlmAnalysisResult {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const valid = result.issues.filter((issue) => {
    if (!issue.segmentIds.every((id) => byId.has(id))) return false;
    const sources = issue.segmentIds
      .map((id) => byId.get(id))
      .filter((s): s is TranscriptSegment => !!s);
    const fullText = sources.map((s) => s.text).join("");
    if (!fullText.includes(issue.quote)) return false;
    const issueStart = Math.min(...sources.map((s) => s.startMs));
    const issueEnd = Math.max(...sources.map((s) => s.endMs));
    if (issueEnd < issueStart) return false;
    return true;
  });
  return { ...result, issues: valid };
}

export class LlmClient {
  private config: LlmConfig | null = null;

  configure(raw: unknown) {
    const parsed = LlmConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw makeError("LLM_CONFIG_INVALID", "LLM 配置校验失败", false);
    }
    this.config = parsed.data;
  }

  get budgetUsed(): number {
    return this.budgetUsedInternal;
  }
  private budgetUsedInternal = 0;

  async analyze(input: LlmAnalysisInput): Promise<LlmAnalysisResult> {
    if (!this.config) {
      throw makeError("LLM_NOT_CONFIGURED", "LLM 未配置", false);
    }
    if (this.budgetUsedInternal >= this.config.budget_limit) {
      throw makeError("LLM_BUDGET_EXCEEDED", "已超出 LLM 预算上限", false);
    }
    const messages = [
      { role: "system", content: CORE_PROMPT },
      { role: "user", content: buildUserContent(input) },
    ];
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.config.max_retries; attempt++) {
      try {
        const text = await this.requestCompletion(messages);
        this.budgetUsedInternal += 1;
        const json = extractJson(text);
        const parsed = LlmAnalysisResultSchema.safeParse(json);
        if (parsed.success) {
          return verifyIssues(parsed.data, input.segments);
        }
        // one repair round-trip with validation error info
        const repairMessages = [
          ...messages,
          { role: "assistant", content: text },
          {
            role: "user",
            content: `上面的 JSON 未通过校验：${parsed.error.message}。请重新输出符合 Schema 的 JSON，不要 Markdown。`,
          },
        ];
        const repairedText = await this.requestCompletion(repairMessages);
        this.budgetUsedInternal += 1;
        const repairedJson = extractJson(repairedText);
        const repaired = LlmAnalysisResultSchema.safeParse(repairedJson);
        if (repaired.success) {
          return verifyIssues(repaired.data, input.segments);
        }
        throw makeError("LLM_BAD_JSON", "LLM 输出无法通过 Zod 校验", true);
      } catch (err) {
        lastError = err;
        if (err instanceof Error && err.message.includes("BUDGET")) throw err;
      }
    }
    throw makeError(
      "LLM_FAILED",
      `LLM 请求失败: ${lastError instanceof Error ? lastError.message : "unknown"}`,
      true,
    );
  }

  private async requestCompletion(
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    if (!this.config) throw makeError("LLM_NOT_CONFIGURED", "LLM 未配置", false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.request_timeout_ms);
    try {
      const res = await fetch(`${this.config.base_url}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body: JSON.stringify({ model: this.config.model, messages }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("empty completion");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Extracts the first JSON object from a possibly markdown-wrapped string. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no json found");
  return JSON.parse(candidate.slice(start, end + 1));
}
