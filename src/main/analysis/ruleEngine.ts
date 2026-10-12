import type { Framework, FrameworkRule } from "../../shared/contracts";

export interface RuleHit {
  ruleId: string;
  ruleType: FrameworkRule["ruleType"];
  pattern: string;
  matchedText: string;
}

const DEFAULT_ABSOLUTIZATION_PATTERNS = [
  "保证",
  "绝对",
  "百分之百",
  "100%",
  "所有人",
  "七天见效",
  "肯定有效",
  "一定见效",
];

const DEFAULT_UNVERIFIED_PATTERNS = [
  "原价\\d+",
  "优惠\\d+",
  "只剩\\d+",
  "今天最?低价",
  "政府认证",
  "获得.*奖项",
  "销量第一",
];

export interface RuleEngineInput {
  framework: Framework | null;
  productFacts: string;
}

export function matchRules(
  text: string,
  input: RuleEngineInput,
): RuleHit[] {
  const hits: RuleHit[] = [];
  const patterns: Array<{ type: FrameworkRule["ruleType"]; pattern: string; id: string }> = [];

  // defaults
  for (const p of DEFAULT_ABSOLUTIZATION_PATTERNS) {
    patterns.push({ type: "absolutization", pattern: p, id: `default:abs:${p}` });
  }
  for (const p of DEFAULT_UNVERIFIED_PATTERNS) {
    patterns.push({ type: "unverifiedClaim", pattern: p, id: `default:unv:${p}` });
  }

  // framework rules
  if (input.framework) {
    for (const r of input.framework.rules) {
      if (!r.enabled) continue;
      patterns.push({ type: r.ruleType, pattern: r.pattern, id: r.id });
    }
  }

  for (const p of patterns) {
    try {
      const re = new RegExp(p.pattern, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        hits.push({
          ruleId: p.id,
          ruleType: p.type,
          pattern: p.pattern,
          matchedText: m[0],
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    } catch {
      // invalid regex pattern from user config: skip
    }
  }
  return hits;
}

/**
 * Script-loop state machine. Only advances on explicit triggers:
 * new opening, product switch, CTA, or manual reset — never just on time.
 */
export type ScriptPhase =
  | "idle"
  | "opening"
  | "productIntro"
  | "interaction"
  | "cta";

const PHASE_TRIGGERS: Array<{ phase: ScriptPhase; re: RegExp }> = [
  { phase: "opening", re: /开场|新来的|欢迎.*来到|开始直播/ },
  { phase: "productIntro", re: /今天.*(介绍|带来|上架)|换.*(产品|商品)|看一下.*(这款|这个产品)/ },
  { phase: "cta", re: /下单|拍.*链接|点击.*(小黄车|购物车)|.*号链接/ },
];

export class ScriptLoopState {
  private phase: ScriptPhase = "idle";
  private phaseEnteredMs = 0;

  get current(): ScriptPhase {
    return this.phase;
  }

  get phaseElapsedMs(): number {
    return this.phaseEnteredMs;
  }

  /** Feed final text with its session-relative time; returns new phase if changed. */
  feed(text: string, nowMs: number): ScriptPhase | null {
    for (const t of PHASE_TRIGGERS) {
      if (t.re.test(text)) {
        if (this.phase !== t.phase) {
          this.phase = t.phase;
          this.phaseEnteredMs = nowMs;
          return t.phase;
        }
        return null;
      }
    }
    return null;
  }

  reset(nowMs: number) {
    this.phase = "idle";
    this.phaseEnteredMs = nowMs;
  }

  /** Framework step overdue check: returns steps whose maxWaitMs is exceeded. */
  overdueSteps(framework: Framework | null, nowMs: number): string[] {
    if (!framework || this.phase === "idle") return [];
    const elapsed = nowMs - this.phaseEnteredMs;
    return framework.steps
      .filter((s) => s.maxWaitMs > 0 && elapsed > s.maxWaitMs)
      .map((s) => s.name);
  }
}
