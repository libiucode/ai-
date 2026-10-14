import type { Framework, FrameworkRule, FrameworkStep, ScriptPhaseName } from "../../shared/contracts";

/** 阶段名复用 shared contracts，避免两处定义漂移。 */
export type ScriptPhase = ScriptPhaseName;

export interface RuleHit {
  ruleId: string;
  ruleType: FrameworkRule["ruleType"];
  pattern: string;
  stepId?: string | null;
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
  "原价\\s*[¥￥]?\\s*\\d+(?:\\.\\d+)?",
  "(?:优惠|减免|直降)\\s*\\d+(?:\\.\\d+)?",
  "(?:只要|只卖|现价)\\s*[¥￥]?\\s*\\d+(?:\\.\\d+)?",
  "\\d+(?:\\.\\d+)?\\s*折",
  "(?:提升|改善|减少|降低|有效率)\\s*\\d+(?:\\.\\d+)?\\s*[%％]",
  "(?:瘦|减重)\\s*\\d+(?:\\.\\d+)?\\s*(?:斤|公斤|千克)",
  "(?:保温|保冷)(?:达到|长达|可达)?\\s*\\d+(?:\\.\\d+)?\\s*小时",
  "只剩\\d+",
  "今天最?低价",
  "政府认证",
  "获得.*奖项",
  "销量第一",
];

/**
 * 仅用于规则匹配的中文数字↔阿拉伯数字归一化。
 *
 * 背景：ASR 的 convert_num_mode=1 会把「二裂酵母」识别成「2裂酵母」，
 * 导致写「二裂酵母」的热词规则匹配不上转写原文。这里双向归一化
 * （二→2、2→二）后只用于判定是否命中，绝不改写原文：
 * quote 仍必须逐字来自片段原文，F3 证据校验不受影响。
 */
const CN_DIGITS: Record<string, string> = { 零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

/**
 * 把中文数字折叠为阿拉伯数字串。
 * 「十二」→「12」，「五百」→「500」，「二十五」→「25」。
 * 解析失败时原样返回，绝不猜测。
 */
function chineseToArabic(text: string): string {
  let out = "";
  let i = 0;
  // 连续的中文数字段：按 位值 累加，段尾整体替换为阿拉伯数字。
  while (i < text.length) {
    const start = i;
    let total = 0;
    let section = 0; // 当前待与高位相加的低位段
    let sawUnit = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch in CN_DIGITS) { section = section * 10 + Number(CN_DIGITS[ch]); i++; continue; }
      if (ch in CN_UNITS) {
        const unit = CN_UNITS[ch];
        // 「十」前没有数字时按 1 计（如「十二」）
        const coef = section === 0 && !sawUnit ? 1 : section;
        if (unit >= 10000) { total = (total + section) * unit; section = 0; }
        else { total += coef * unit; section = 0; }
        sawUnit = true;
        i++;
        continue;
      }
      break;
    }
    if (i === start) { out += text[i]; i++; continue; }
    out += String(total + section);
  }
  return out;
}

/** 阿拉伯数字转中文数字（个位、十位、百位、千位，够覆盖商品名与时长中的数字）。 */
function arabicToChinese(text: string): string {
  const CN = "零一二三四五六七八九";
  const under1000 = (n: number): string => {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    let out = hundreds > 0 ? `${CN[hundreds]}百` : "";
    if (rest === 0) return out || "零";
    const tens = Math.floor(rest / 10);
    const ones = rest % 10;
    if (tens === 0) out += hundreds > 0 ? `零${CN[ones]}` : CN[ones];
    else if (tens === 1) out += `十${ones === 0 ? "" : CN[ones]}`;
    else out += `${CN[tens]}十${ones === 0 ? "" : CN[ones]}`;
    return out;
  };
  return text.replace(/\d+/g, (digits) => {
    const n = Number(digits);
    if (!Number.isFinite(n) || n > 9999) return digits;
    if (n < 10) return CN[n];
    if (n < 1000) return under1000(n);
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    return `${CN[thousands]}千${rest === 0 ? "" : rest < 100 ? `零${under1000(rest)}` : under1000(rest)}`;
  });
}

/** 生成用于匹配判定的归一化文本：中文数字→阿拉伯数字 + 阿拉伯数字→中文数字，两种形态都参与。 */
export function normalizeForMatching(text: string): string[] {
  const arabic = chineseToArabic(text);
  const chinese = arabicToChinese(text);
  if (arabic === text && chinese === text) return [text];
  return [text, arabic, chinese];
}

export interface RuleEngineInput {
  framework: Framework | null;
  productFacts: string;
}

export function matchRules(
  text: string,
  input: RuleEngineInput,
): RuleHit[] {
  const hits: RuleHit[] = [];
  const patterns: Array<{ type: FrameworkRule["ruleType"]; pattern: string; id: string; stepId?: string | null }> = [];

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
      patterns.push({ type: r.ruleType, pattern: r.pattern, id: r.id, stepId: r.stepId });
    }
  }

  // 同一规则的多种数字形态只报一次，避免「二裂」和「2裂」双弹窗。
  const seen = new Set<string>();
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p.pattern, "g");
    } catch {
      continue; // invalid regex pattern from user config: skip
    }
    for (const variant of normalizeForMatching(text)) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(variant)) !== null) {
        if (!m[0]) { re.lastIndex++; continue; }
        // 命中位置回到原文，保证 quote 逐字来自原文而非归一化文本。
        // 变体可能因数字形态长度不同而位移，因此按匹配长度从变体同位置回切，
        // 并校验回切结果确实在原文中；对不上时用归一化前的原文位置兜底。
        const end = Math.min(m.index + m[0].length, variant.length);
        const sliceFromVariant = variant.slice(m.index, end);
        const sliceFromOriginal = text.slice(m.index, m.index + m[0].length);
        const quote = text.includes(sliceFromVariant) ? sliceFromVariant : sliceFromOriginal;
        if (!quote || !text.includes(quote)) { re.lastIndex++; continue; }
        const key = `${p.id}|${m.index}|${quote}`;
        if (seen.has(key)) { re.lastIndex += m[0].length; continue; }
        seen.add(key);
        hits.push({
          ruleId: p.id,
          ruleType: p.type,
          pattern: p.pattern,
          stepId: p.stepId ?? null,
          matchedText: quote,
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return hits;
}

/**
 * Script-loop state machine. Only advances on explicit triggers:
 * new opening, product switch, CTA, or manual reset — never just on time.
 */

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

  /** 当前阶段已停留时长；尚未识别到阶段（idle）时返回 0，不把会话总时长当成阶段时长。 */
  elapsedMs(nowMs: number): number {
    return this.phase === "idle" ? 0 : nowMs - this.phaseEnteredMs;
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

/** 报告侧重放：按顺序回放稳态转写，得到阶段区间（与实时会话同一台状态机，结果确定一致）。 */
export interface ReplayedPhase {
  phase: ScriptPhase;
  startMs: number;
  endMs: number;
}

export function replayScriptPhases(
  segments: Array<{ text: string; endMs: number }>,
): ReplayedPhase[] {
  const state = new ScriptLoopState();
  const phases: ReplayedPhase[] = [];
  let lastEndMs = 0;
  for (const seg of segments) {
    lastEndMs = Math.max(lastEndMs, seg.endMs);
    const next = state.feed(seg.text, seg.endMs);
    if (next) {
      // feed 只在阶段变化时返回新阶段；上一区间在此闭合
      if (phases.length) phases[phases.length - 1].endMs = seg.endMs;
      phases.push({ phase: next, startMs: seg.endMs, endMs: seg.endMs });
    }
  }
  // 最后一个阶段持续到最后一条转写
  if (phases.length) {
    phases[phases.length - 1].endMs = Math.max(phases[phases.length - 1].endMs, lastEndMs);
  }
  return phases;
}

export interface StepCoverage {
  step: FrameworkStep;
  /** 所有已识别阶段中最长的一次停留 */
  maxStayMs: number;
  overdue: boolean;
}

/** 单步骤覆盖统计。超时规则与实时面板一致：最长停留 > maxWaitMs 即超时（maxWaitMs=0 表示不限时）。 */
export function computeStepCoverage(
  framework: Framework,
  phases: ReplayedPhase[],
): StepCoverage[] {
  return framework.steps.map((step) => {
    const maxStayMs = phases.reduce((max, p) => Math.max(max, p.endMs - p.startMs), 0);
    const overdue = step.maxWaitMs > 0 && maxStayMs > step.maxWaitMs;
    return { step, maxStayMs, overdue };
  });
}
