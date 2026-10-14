import type { Issue } from "../../shared/contracts";

/**
 * 问题去重键：类型 + 步骤 + 证据片段 + 引文。
 *
 * 历史缺陷：键里只有「类型 + 步骤 + 片段 ID」，同一片段内同类型的不同风险点
 * （例如第①级真实片段里的「所有肤质」「没有任何刺激」「放心食用」）会塌成一条，
 * 只保留第一个引文，直接造成模块 A 的漏报。
 *
 * 加入引文后：同一处持续问题（引文相同）跨重叠窗口仍稳定去重；
 * 同一片段内的不同风险点各自成条，不再互相吞掉。
 */
export function issueDedupeKey(
  issue: Pick<Issue, "type" | "segmentIds" | "quote">,
  stepId: string | null = null,
): string {
  const quote = (issue.quote ?? "").trim();
  return JSON.stringify([issue.type, stepId, [...new Set(issue.segmentIds)].sort(), quote]);
}
