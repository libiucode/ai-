import { normalizeDigits } from "./ruleEngine";

/**
 * 话术框架「一致性比对」——通道 A：数值断言核对。
 *
 * ## 为什么需要它
 *
 * 领导原话：「每1分钟对过去5分钟主播讲解的内容进行分析，**和给定的话术框架进行比对**，找出问题。」
 *
 * 既有的 `ScriptLoopState` / `computeStepCoverage` 做的是**覆盖率**——
 * 「哪几步讲了/没讲」，靠关键词猜阶段（见 known-limitations §3b.6，
 * 自认「漏说关键词的阶段不会出现在覆盖统计里」）。
 *
 * 本模块做的是另一件事：**一致性**——「主播说的和框架写的一不一致」。
 * 例：框架声明「保温12小时」，主播口播「保温24小时」→ 确定性冲突。
 *
 * ## 为什么只在本地做数值核对，不做语义判断
 *
 * 数值冲突是**可验证**的：12 ≠ 24。不依赖模型，可写回归测试，误报可控。
 * 语义冲突（框架说「不承诺疗效」、主播说「七天见效」）本地判不了，
 * 应交给既有 LLM 链路并强制 needsReview —— 那不在本模块职责内。
 *
 * ## 纪律：宁可漏报，不可误报
 *
 * 本模块的默认处置是**不报**。下列情形一律跳过：
 * - 量纲不同且无法换算
 * - 数值相同（正常复述）
 * - 无法确定主语（避免把别的参数的数值当成这条事实的冲突）
 * - 出现在对比语境（「比上一代多了200毫升」）
 */

/** 从框架事实文本里解析出的一条可核对断言。 */
export interface FactAssertion {
  /** 原始事实行，逐字保留。 */
  raw: string;
  /** 数值。 */
  value: number;
  /** 原始单位写法（如「小时」「毫升」）。 */
  unit: string;
  /** 归一到同一量纲后的比较键（如「时长」「容积」「质量」）。 */
  dimension: string;
  /** 归一到基准单位后的数值（如「12小时」→ 720 分钟）。 */
  baseValue: number;
}

/** 一条检出的冲突。 */
export interface FactConflict {
  fact: FactAssertion;
  /** 口播里与之冲突的数值。 */
  spokenValue: number;
  spokenUnit: string;
  /** 口播原文里这段数字-单位所在的**连续子串**（逐字来自转写，供证据门禁校验）。 */
  quote: string;
}

/**
 * 单位表：`unit -> { dimension, factor }`。
 *
 * factor 是「1 个该单位 = 多少基准单位」。基准单位选取：
 * - 时长 → 分钟
 * - 容积 → 毫升
 * - 质量 → 克
 *
 * ⚠️ 只收录**含义无歧义**的单位。刻意不收「天/周/月」「小时」以外的模糊表述，
 * 也不做跨量纲猜测（如把「斤」当成重量以外的东西）。
 */
const UNITS: Record<string, { dimension: string; factor: number }> = {
  分钟: { dimension: "时长", factor: 1 },
  分: { dimension: "时长", factor: 1 },
  小时: { dimension: "时长", factor: 60 },
  // 「天/周」纳入：缺失它会让最典型的一类冲突失效——
  // 框架「坚持使用14天」vs 口播「坚持用7天」检测不出来（实测发现）。
  // 代价是「7天无理由退换」这类**服务条款**语境会被误认为时长断言，
  // 由 isServiceTermContext() 排除，而不是靠不收录单位来回避。
  天: { dimension: "时长", factor: 60 * 24 },
  周: { dimension: "时长", factor: 60 * 24 * 7 },
  毫升: { dimension: "容积", factor: 1 },
  ml: { dimension: "容积", factor: 1 },
  升: { dimension: "容积", factor: 1000 },
  克: { dimension: "质量", factor: 1 },
  g: { dimension: "质量", factor: 1 },
  千克: { dimension: "质量", factor: 1000 },
  公斤: { dimension: "质量", factor: 1000 },
  斤: { dimension: "质量", factor: 500 },
};

/** 单位别名归一（大小写、全角）。 */
function canonicalUnit(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[ｍＭ]/g, "m").replace(/[ｌＬ]/g, "l");
  return s;
}

/**
 * 从文本里抽出所有「数字 + 单位」对。
 *
 * 数字来源：先经 `normalizeDigits()` 做中文数字折叠（复用既有实现，
 * 使「二十五小时」与「25小时」可比），再把折叠后的区间映射回原文，
 * **保证 quote 逐字来自原文**。
 */
function extractNumberUnitPairs(text: string): Array<{ value: number; unit: string; quote: string }> {
  const norm = normalizeDigits(text);
  const out: Array<{ value: number; unit: string; quote: string }> = [];
  // 折叠后的数字后紧跟单位。单位按长度降序匹配，避免「毫升」被「升」抢先。
  const unitKeys = Object.keys(UNITS).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitKeys.join("|")})`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm.text)) !== null) {
    const numStart = m.index;
    const numEnd = m.index + m[1].length;
    const fullEnd = m.index + m[0].length;
    // 数字区间必须完整落在某个数字簇内，或被簇完整包含——否则说明规则截断了数字，
    // 与 ruleEngine 的截断守卫同一思路：宁可丢，不可造证据。
    const truncated = norm.clusters.some(
      (c) => (numStart < c.end && numEnd > c.start) && !(numStart <= c.start && numEnd >= c.end),
    );
    if (truncated) continue;
    const origStart = norm.map[numStart];
    const origEnd = norm.map[fullEnd] ?? text.length;
    if (origStart === undefined || origEnd === undefined || origEnd <= origStart) continue;
    out.push({
      value: Number(m[1]),
      unit: canonicalUnit(m[2]),
      quote: text.slice(origStart, origEnd),
    });
  }
  return out;
}

/**
 * 判断某段文本是否处于「对比语境」。
 *
 * 「比上一代多了200毫升」里的 200 不是对事实的陈述，而是增量描述——
 * 把它当成冲突是典型误报。检出对比词即跳过该处数值。
 */
function isComparativeContext(text: string, valueStart: number): boolean {
  const window = text.slice(Math.max(0, valueStart - 12), valueStart);
  return /比|相比|对比|多了|少了|增加了|提升了|降低了|从.{0,6}到/.test(window);
}

/**
 * 判断某段文本是否属于「服务条款 / 售后规则」语境。
 *
 * 真实口播实测：「我们现在做的是**7天无理由退换货**」「30天质量问题包退换」。
 * 这里的「7天」是**平台服务期**，不是商品参数的断言。
 * 若商品事实里恰好有一条时长断言（如「保温12小时」），把服务期当成冲突就是误报。
 *
 * 排除词覆盖电商售后常见表述。宁可漏报：服务条款本就不该走数值核对，
 * 而应由「框架比对」的语义通道（LLM + needsReview）处理。
 */
function isServiceTermContext(text: string, valueStart: number, valueEnd: number): boolean {
  const before = text.slice(Math.max(0, valueStart - 8), valueStart);
  const after = text.slice(valueEnd, Math.min(text.length, valueEnd + 10));
  const around = before + after;
  return /无理由|退换|退货|退货|包退|包换|保修|质保|保价|发货|送达|次日达|内?到货|服务|承诺|保障|试用|体验期/.test(around);
}

/**
 * 判断一段事实文本是否是「规则说明」而非「商品参数断言」。
 *
 * 背景（实测发现）：框架的「已核实商品事实」字段经常既写商品参数、也写合规约束，
 * 例如本项目的真实框架里就有一行：
 *     「售后：7天无理由退换属平台法定规则，可以正常讲解，不视为违规」
 * 若不排除，这一行会被解析成「时长=7天」的断言，之后主播说「30天无理由退换」
 * 就会误报冲突 —— 而那句话本身完全合规。
 *
 * 同理，「不得使用『立竿见影』等表述」这类规则说明里的词也不该成为断言。
 *
 * 排除词覆盖：售后/退换/法定/规则/不得/禁止/视为/以…为准 等元陈述用语。
 * 宁可漏解析（少一条断言），也不把合规说明当商品参数。
 */
function isMetaOrPolicyLine(raw: string): boolean {
  return /售后|退换|退货|退款|法定|法规|规则|不得|禁止|不得使用|视为|不视为|以.{0,8}为准|请勿|注意|限制|约束|可以正常|合规/.test(
    raw,
  );
}

/**
 * 解析框架的「已核实商品事实」文本。
 *
 * 输入是 `Framework.productFacts`（自由文本，每行一条，见 FrameworkPage.tsx）。
 * 解析不出来的行**静默跳过**（自由描述型事实如「304不锈钢内胆」没有可核对断言）。
 *
 * 额外跳过两类行（见 isMetaOrPolicyLine 与测试反例）：
 * - 合规规则说明行（「不得宣称医疗功效」这类）
 * - 明确标注了「以…为准」的不确定值
 */
export function parseFactAssertions(productFacts: string): FactAssertion[] {
  const out: FactAssertion[] = [];
  for (const line of productFacts.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    // 规则说明 / 合规约束行不是商品参数断言，跳过。
    if (isMetaOrPolicyLine(raw)) continue;
    // 一行里取第一个数值-单位对作为该事实的断言。
    // 一行多值时取首个：多值事实（如「容量500mL，重300克」）语义复杂，
    // 强行拆解容易误判，宁可少解析。
    const pairs = extractNumberUnitPairs(raw);
    if (!pairs.length) continue;
    const p = pairs[0];
    const u = UNITS[p.unit];
    if (!u) continue;
    out.push({
      raw,
      value: p.value,
      unit: p.unit,
      dimension: u.dimension,
      baseValue: p.value * u.factor,
    });
  }
  return out;
}

/**
 * 核对单条转写文本与框架事实的数值冲突。
 *
 * 返回**零条或多条**冲突。默认不报，只有明确「同量纲 + 数值不同」才报。
 */
export function compareTextAgainstFacts(
  text: string,
  facts: FactAssertion[],
): FactConflict[] {
  if (!facts.length || !text) return [];
  const conflicts: FactConflict[] = [];
  const spoken = extractNumberUnitPairs(text);
  for (const s of spoken) {
    const su = UNITS[s.unit];
    if (!su) continue;
    const idx = text.indexOf(s.quote);
    if (idx >= 0) {
      if (isComparativeContext(text, idx)) continue;
      if (isServiceTermContext(text, idx, idx + s.quote.length)) continue;
    }
    for (const f of facts) {
      if (f.dimension !== su.dimension) continue;
      const spokenBase = s.value * su.factor;
      if (spokenBase === f.baseValue) continue;
      // 同一句里可能同时出现多个数值（如「12小时保温，500毫升容量」），
      // 逐个与同量纲事实比较，只报真实不一致的。
      conflicts.push({
        fact: f,
        spokenValue: s.value,
        spokenUnit: s.unit,
        quote: s.quote,
      });
    }
  }
  return conflicts;
}

/**
 * 逐条转写核对，产出冲突清单（含所属片段）。
 */
export function compareSegmentsAgainstFacts(
  segments: Array<{ id: string; text: string }>,
  facts: FactAssertion[],
): Array<FactConflict & { segmentId: string }> {
  const out: Array<FactConflict & { segmentId: string }> = [];
  for (const seg of segments) {
    for (const c of compareTextAgainstFacts(seg.text, facts)) {
      out.push({ ...c, segmentId: seg.id });
    }
  }
  return out;
}
