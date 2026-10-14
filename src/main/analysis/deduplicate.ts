import type { Issue } from "../../shared/contracts";

/** Evidence identity stays stable across overlapping windows and quote rewrites. */
export function issueDedupeKey(issue: Pick<Issue, "type" | "segmentIds">, stepId: string | null = null): string {
  return JSON.stringify([issue.type, stepId, [...new Set(issue.segmentIds)].sort()]);
}
