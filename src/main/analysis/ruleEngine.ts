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
  "七天见效",
  "肯定有效",
  "一定见效",
  // 第①级真实转写暴露的遗漏：承诺类与全称量词
  // 注意：此处覆盖「所有人」，不再单列字面「所有人」，避免同一处双命中。
  "所有(?:肤质|肌肤|人群|宝宝|人)",
  "(?:没有|无)任何(?:刺激|副作用|添加|不适)",
  "放心(?:食用|口服)",
  "全网最(?:低|好|便宜|划算)",
  "(?:国家|世界|全球)级",
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
  // 第①级真实转写暴露的遗漏：比价、效果期限、即时效果、成分配比
  "(?:平时|专柜|官网|官方|旗舰店)[^。，,！!？?]{0,8}(?:都)?(?:要|卖|是)\\s*[¥￥]?\\s*\\d+(?:\\.\\d+)?\\s*(?:多)?",
  "(?:坚持|连续)(?:用|使用|喝|吃|涂抹)?\\s*\\d+\\s*(?:天|周|月)",
  "第[一二三四五六七八九十\\d]+天[^。，,！!？?]{0,6}(?:就|便)",
  "浓度\\s*\\d+(?:\\.\\d+)?\\s*[%％]",
];

/**
 * 仅用于规则匹配的数字归一化。
 *
 * 背景：ASR 的 convert_num_mode=1 会把「二裂酵母」识别成「2裂酵母」，
 * 导致写「二裂酵母」的热词规则匹配不上转写原文。
 *
 * 做法：把文本和规则都规范化到「阿拉伯数字」这一种形态，因此只需要一个
 * 变体，不存在多形态互相干扰的问题。同时维护字符级索引映射，命中后能
 * 精确回到原文区间，quote 保证逐字来自原文，存储原文与 F3 证据校验不受影响。
 */
const CN_DIGITS: Record<string, string> = { 零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

export interface NormalizedText {
  /** 规范化后的文本（中文数字已折叠为阿拉伯数字） */
  text: string;
  /** map[i] = 规范化文本第 i 个字符对应的原文起始下标；map[text.length] = 原文长度 */
  map: number[];
}

/** 把中文数字折叠为阿拉伯数字，并保留到原文的字符级索引映射。 */
export function normalizeDigits(text: string): NormalizedText {
  let out = "";
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    let total = 0;
    let section = 0;
    let sawUnit = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch in CN_DIGITS) { section = section * 10 + Number(CN_DIGITS[ch]); i++; continue; }
      if (ch in CN_UNITS) {
        const unit = CN_UNITS[ch];
        const coef = section === 0 && !sawUnit ? 1 : section;
        if (unit >= 10000) { total = (total + section) * unit; section = 0; }
        else { total += coef * unit; section = 0; }
        sawUnit = true;
        i++;
        continue;
      }
      break;
    }
    if (i === start) { out += text[i]; map.push(i); i++; continue; }
    if (sawUnit || section > 0) {
      const digits = String(total + section);
      for (let k = 0; k < digits.length; k++) { out += digits[k]; map.push(start); }
    } else {
      out += text.slice(start, i);
      for (let k = start; k < i; k++) map.push(k);
    }
  }
  map.push(text.length);
  return { text: out, map };
}

/** 规则侧：把中文数字折叠为阿拉伯数字，使规则与规范化文本可比。 */
export function normalizePatternNumerals(pattern: string): string {
  return normalizeDigits(pattern).text;
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

  // 文本只规范化一次；规则也做同样的数字折叠，因此不存在多形态互相干扰。
  const normalized = normalizeDigits(text);
  const seen = new Set<string>();
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(normalizePatternNumerals(p.pattern), "g");
    } catch {
      continue; // invalid regex pattern from user config: skip
    }
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized.text)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      const end = Math.min(m.index + m[0].length, normalized.text.length);
      // 用字符级映射把规范化区间还原成原文区间，quote 逐字来自原文。
      const originalStart = normalized.map[m.index];
      const originalEnd = normalized.map[end] ?? text.length;
      if (originalStart === undefined || originalEnd === undefined || originalEnd <= originalStart) {
        re.lastIndex += m[0].length;
        continue;
      }
      const quote = text.slice(originalStart, originalEnd);
      if (!quote) { re.lastIndex += m[0].length; continue; }
      const key = `${p.id}|${originalStart}|${originalEnd}`;
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

  /**
   * Framework step overdue check: returns steps whose maxWaitMs is exceeded.
   *
   * 历史缺陷：对所有步骤都用「当前阶段停留时长」判定，导致阶段一长就所有步骤
   * 一起报超时。现在只判定「自己映射到当前阶段」的步骤；无法映射到阶段的步骤
   * 不做超时断言（宁可漏报也不误报）。
   */
  overdueSteps(framework: Framework | null, nowMs: number): string[] {
    if (!framework || this.phase === "idle") return [];
    const elapsed = nowMs - this.phaseEnteredMs;
    return framework.steps
      .filter((s) => stepPhaseOf(s) === this.phase && s.maxWaitMs > 0 && elapsed > s.maxWaitMs)
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
  /** 该步骤所属阶段中的最长一次停留；无法映射到任何阶段时为 0 */
  maxStayMs: number;
  overdue: boolean;
  /** 该步骤映射到的阶段；null 表示无法从步骤配置推断阶段 */
  phase: ScriptPhase | null;
}

/**
 * 步骤 → 阶段 的映射。
 *
 * 历史缺陷：`computeStepCoverage` 对所有步骤都返回同一个「所有阶段最长停留」，
 * 因为阶段和步骤之间根本没有映射，覆盖统计因此失真（每个步骤看起来要么全超时、
 * 要么全不超时）。模块 A 的「讲全了没有」直接依赖这个映射。
 *
 * 映射优先级：
 * 1. 步骤显式声明的 `phase`（话术框架编辑期可选字段，最可靠）；
 * 2. 步骤绑定的规则命中的阶段（见 coverageFromRuleHits，证据最强）；
 * 3. 步骤名称关键词（下面的表），作为没有显式声明时的保守推断。
 * 推断不出阶段时返回 null，调用方必须按「未知」处理，不得猜测。
 */
const STEP_PHASE_KEYWORDS: Array<{ phase: ScriptPhase; re: RegExp }> = [
  // 先判 cta：价格/售后/促单类步骤名常同时含「介绍」等词，避免误归到 productIntro
  { phase: "cta", re: /促单|成交|下单|价格|优惠|折扣|库存|售后|退换|运费|链接|收尾|结束|感谢|秒杀|抢购/ },
  { phase: "interaction", re: /互动|评论|弹幕|关注|点赞|答疑|问答|提问|抽奖|福利|粉丝|连麦/ },
  { phase: "opening", re: /开场|开场白|欢迎|自我介绍|暖场|新来|开播/ },
  { phase: "productIntro", re: /卖点|产品|商品|介绍|痛点|需求|功效|成分|材质|规格|用法|使用|演示|对比|场景|容量|颜色/ },
];

/** 步骤显式声明的阶段（话术框架可选字段；未声明时为 undefined）。 */
export function declaredStepPhase(step: FrameworkStep): ScriptPhase | null {
  const value = (step as FrameworkStep & { phase?: unknown }).phase;
  return typeof value === "string" && value !== "idle" ? (value as ScriptPhase) : null;
}

/** 由步骤名称推断阶段；推断不出返回 null（不猜测）。 */
export function inferStepPhase(step: FrameworkStep): ScriptPhase | null {
  for (const { phase, re } of STEP_PHASE_KEYWORDS) {
    if (re.test(step.name)) return phase;
  }
  return null;
}

/** 步骤对应的阶段：显式声明优先，其次名称关键词，都没有则 null。 */
export function stepPhaseOf(step: FrameworkStep): ScriptPhase | null {
  return declaredStepPhase(step) ?? inferStepPhase(step);
}

/** 单步骤覆盖统计。只统计该步骤自己阶段的停留，不再让所有步骤共享同一个最大值。 */
export function computeStepCoverage(
  framework: Framework,
  phases: ReplayedPhase[],
): StepCoverage[] {
  return framework.steps.map((step) => {
    const phase = stepPhaseOf(step);
    const maxStayMs = phase === null
      ? 0
      : phases.reduce((max, p) => (p.phase === phase ? Math.max(max, p.endMs - p.startMs) : max), 0);
    return { step, maxStayMs, overdue: step.maxWaitMs > 0 && maxStayMs > step.maxWaitMs, phase };
  });
}
