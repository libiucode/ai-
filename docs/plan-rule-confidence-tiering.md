# 方案一：规则库「确定度分级」（plan-rule-confidence-tiering）

- 时间：2026-10-16
- 审计基线：HEAD `407c01d`，**378/378 通过（33 文件）**（本轮用指定 electron-node 方式实测复现）
- ⚠️ **并发改动提示**：审计期间另一名实现者正在同工作树改 `src/`（新增「框架一致性比对」通道，`orchestrator.ts:786` 之后插入）。
  - 因此 **`orchestrator.ts` 的行号较我读取时整体 +1**。本文档已按当前行号标注（`severity` = `:770`，`needsReview` = `:779`）。
  - `ruleEngine.ts` / `metrics.ts` / `pcm.ts` **未被并发改动**，行号可信。
  - **实现者动手前请重新核对一次行号。**
- 目标：在**不引入误报**的前提下，把「法定违规表述」这类高确定度词从「有意不抓」改为「直接抓」
- 纪律：本方案所有「反例分析」结论均来自**构造输入实测**（见 §4 探针），不是推理。凡未实测的均标注。

---

## 0. 一句话结论

**可以安全新增一组高确定度规则，但只有 12 条能过「零真实反例」门槛；`七天无理由`、`根治`、`治愈`、`孕妇可以用` 这四条必须排除或降级。**
关键实测依据：在 **42 条真实直播风格正常话术**上，最终 12 条固定词表命中 **1 条**，且那 1 条是**真违规**（详见 §4.3、§4.4）。

---

## 1. 现状（逐行读完后的实测描述）

### 1.1 两个扁平数组

`src/main/analysis/ruleEngine.ts:25-40` — `DEFAULT_ABSOLUTIZATION_PATTERNS`，**12 条**（读到的实际条数）：

```
:26  "保证"          :27  "绝对"        :28  "百分之百"    :29  "100%"
:30  "七天见效"      :31  "肯定有效"    :32  "一定见效"
:35  "所有(?:肤质|肌肤|人群|宝宝|人)"
:36  "(?:没有|无)任何(?:刺激|副作用|添加|不适)"
:37  "放心(?:食用|口服)"
:38  "全网最(?:低|好|便宜|划算)"
:39  "(?:国家|世界|全球)级"
```

`src/main/analysis/ruleEngine.ts:42-60` — `DEFAULT_UNVERIFIED_PATTERNS`，**18 条**（不是任务书说的「约 20 条」；逐条数是 18）。

> ⚠️ **更正任务书**：任务书说 `DEFAULT_UNVERIFIED_PATTERNS` 约 20 条，**实测是 18 条**；`DEFAULT_ABSOLUTIZATION_PATTERNS` 是 12 条（与任务书一致）。这个数字影响下面「新增后总量」的表述，但不影响设计。

### 1.2 规则如何变成命中

`ruleEngine.ts:149-166`：默认规则被展开成 `patterns[]`，id 形如 `default:abs:${p}` / `default:unv:${p}`：

```
:153-155  for (const p of DEFAULT_ABSOLUTIZATION_PATTERNS)
            patterns.push({ type: "absolutization", pattern: p, id: `default:abs:${p}` });
:156-158  for (const p of DEFAULT_UNVERIFIED_PATTERNS)
            patterns.push({ type: "unverifiedClaim", pattern: p, id: `default:unv:${p}` });
```

**关键：`ruleType` 被硬编码为整个数组一个类型**。数组里所有条目共享同一个 `ruleType`，没有逐条覆写的通道。这是本次改造要动的第一处结构。

### 1.3 `RuleHit` 契约（不能破坏）

`ruleEngine.ts:6-23`：

```ts
export interface RuleHit {
  ruleId: string;
  ruleType: FrameworkRule["ruleType"];
  pattern: string;
  stepId?: string | null;
  matchedText: string;
  numeralNormalized?: boolean;
}
```

`ruleType` 的类型来自 `src/shared/contracts.ts:124`：

```ts
ruleType: "bannedWord" | "absolutization" | "unverifiedClaim" | "repetition" | "hotWord";
```

**约束：`ruleType` 的联合类型不能加新成员**，因为 `src/shared/schemas.ts:189` 与 `src/renderer/pages/frameworkSchema.ts:21` 有对应的 `z.enum([...])`，加成员会波及 schema、UI 下拉、迁移。**必须复用既有的 `absolutization` / `unverifiedClaim`。**

### 1.4 severity 当前如何决定

`orchestrator.ts:770`：

```ts
severity: hit.ruleType === "bannedWord" ? "critical" : "warning",
```

`orchestrator.ts:779`：

```ts
needsReview: hit.ruleType === "unverifiedClaim",
```

即 severity **只由 ruleType 二值决定**，没有任何逐规则/逐命中的覆写通道。`bannedWord` 是 critical，其余（含默认规则的全部）都是 warning，且**默认规则全部 `needsReview: false`**（因为默认规则是 absolutization / unverifiedClaim，后者 `needsReview: true`、前者 `false`）。

> 这解释了为什么「确定度分级」需要新增字段：现有两个字段（`ruleType`、severity 派生规则）都**无法表达「这条默认规则比那条更确定」**。

---

## 2. 数据结构设计

### 2.1 设计原则

1. **`RuleHit` 只加可选字段** —— 既有测试大量使用 `toEqual`（如 `tests/ruleEngine-numerals.test.ts:126,135,147`、`tests/ruleEngine-triggers.test.ts:92-95`），**新增必填字段会立刻让这些 `toEqual` 全红**。所以新字段必须是 `?`，且**只在有意义时才赋值**（照抄 `numeralNormalized` 的既有做法，见 `ruleEngine.ts:212`）。
2. **`ruleType` 不动**。高确定度组仍复用 `absolutization` / `unverifiedClaim`。
3. **数组结构从 `string[]` 改为 `{ pattern, confidence }[]`**（内部常量，非导出契约）。

### 2.2 建议的改动

**(a) 新增一个内部类型（`ruleEngine.ts` 顶部，紧邻现有常量）：**

```ts
/**
 * 默认规则的确定度分级。
 *
 * "statutory" = 法定违规表述：该短语本身就是完整、自足的违法宣称，
 *   不存在「正常话术恰好包含它」的用法。误报风险实测为零（见 §4）。
 * "broad" = 宽泛模式：如「保证」「绝对」，正常话术也会用到，
 *   必须保持宁漏勿误报，命中只作为候选。
 *
 * ⚠️ 默认值必须是 broad：任何未显式标注的规则都按保守处理。
 */
type RuleConfidence = "statutory" | "broad";

interface DefaultPattern {
  pattern: string;
  confidence: RuleConfidence;
}
```

**(b) `RuleHit` 增加一个可选字段（唯一改动）：**

```ts
export interface RuleHit {
  ruleId: string;
  ruleType: FrameworkRule["ruleType"];
  pattern: string;
  stepId?: string | null;
  matchedText: string;
  numeralNormalized?: boolean;
  /**
   * 本条命中的确定度分级（仅默认规则有）。
   * 帧架规则（用户自配）不带此字段——用户自己写的规则由用户自己定责。
   *
   * ⚠️ 只在 confidence === "statutory" 时赋值，保持既有 hit 对象的形状不变，
   *    避免破坏 tests 里的 toEqual 断言。
   */
  confidence?: RuleConfidence;
}
```

> **为什么只在 `statutory` 时赋值**：`tests/ruleEngine-numerals.test.ts:126` 写的是
> `expect(hitsOf(hits, "r-partial")).toEqual([])`（空数组，不受影响），但
> `tests/ruleEngine-triggers.test.ts:101` 写的是
> `expect(...map(h => h.matchedText)).toEqual(["3.5折"])`（只取 matchedText，不受影响）。
> 真正有风险的是把 hit 对象整体 `toEqual` 的断言。**保守做法：broad 命中对象形状与今天逐字节一致**，只有 statutory 命中多一个字段。这样「今天的 378 项里凡是 pass 的，只要不涉及新规则，就仍然 pass」。

**(c) 数组改为对象数组，并给每条标注：**

```ts
const DEFAULT_ABSOLUTIZATION_PATTERNS: DefaultPattern[] = [
  { pattern: "保证", confidence: "broad" },
  { pattern: "绝对", confidence: "broad" },
  // ... 既有 12 条全部标 broad（行为不变）
  // 新增 statutory 条目见 §3
];

const DEFAULT_UNVERIFIED_PATTERNS: DefaultPattern[] = [
  { pattern: "原价\\s*[¥￥]?\\s*\\d+(?:\\.\\d+)?", confidence: "broad" },
  // ... 既有 18 条全部标 broad
];
```

**(d) 入队时携带 confidence（`ruleEngine.ts:153-158` 改为）：**

```ts
for (const p of DEFAULT_ABSOLUTIZATION_PATTERNS) {
  patterns.push({ type: "absolutization", pattern: p.pattern, id: `default:abs:${p.pattern}`, confidence: p.confidence });
}
for (const p of DEFAULT_UNVERIFIED_PATTERNS) {
  patterns.push({ type: "unverifiedClaim", pattern: p.pattern, id: `default:unv:${p.pattern}`, confidence: p.confidence });
}
```

**(e) 出队时写进 hit（`ruleEngine.ts:206-213` 内）：**

```ts
hits.push({
  ruleId: p.id,
  ruleType: p.type,
  pattern: p.pattern,
  stepId: p.stepId ?? null,
  matchedText: quote,
  ...(numeralNormalized ? { numeralNormalized: true } : {}),
  ...(p.confidence === "statutory" ? { confidence: "statutory" as const } : {}),
});
```

> ⚠️ **`ruleId` 必须保持 `default:abs:${pattern}` 的既有拼接方式**，因为既有测试用它过滤
> （`tests/ruleEngine-numerals.test.ts:31` 的 `hitsOf`）。改成含 confidence 的 id 会让所有 `ruleId` 断言漂移。

### 2.3 orchestrator 侧：severity 是否要区分

**建议：区分，但只在「法定违规」这一级，且必须同时保留 `needsReview`。**

`orchestrator.ts:770` 建议改为：

```ts
severity: hit.ruleType === "bannedWord" || hit.confidence === "statutory"
  ? "critical"
  : "warning",
```

`orchestrator.ts:779` 建议改为：

```ts
// 法定违规表述是自足事实（「假一赔十」说了就是说了），
// 但仍不认定违法——按 known-limitations §3.8「规则命中只是风险候选」保留人工复核。
needsReview: hit.ruleType === "unverifiedClaim" || hit.confidence === "statutory",
```

**理由（区分 severity 的收益）**：`reportBuilder.ts:55` 的 `bySeverity` 会把 critical 单独统计；报告里 `issueTimeline`（`reportBuilder.ts:66-75`）带 severity。把「假一赔十」和「保证」放同一档，会让真正该立刻改的那条淹没在宽泛模式的候选里——这正是本任务要解决的「20 条漏报里有些其实很确定」。

**风险**：severity=critical 会改变报告的分档数字，**可能影响既有测试**。实测检查：`tests/analysis-link-verify.test.ts:106` 只断言 `occurrence_count` / `first_seen_ms` / `last_seen_ms`，不断言 severity；`tests/report.test.ts` 我未逐字读完其对 bySeverity 的断言，**实现者需自行 grep `bySeverity` 确认**（标注为「不确定」）。

---

## 3. 高确定度组新增哪些词（逐条 + 不误报理由）

### 3.1 入选标准（必须同时满足）

1. **自足性**：该短语本身就是完整的宣称，不含被否定词修饰的空间（「不能X」这种构造在真实直播里不出现——见 §4.2 的判定）。
2. **无正常用法**：不存在「主播没做宣称却说了这个词」的直播场景。
3. **实测零反例**：在 §4.4 的 42 条真实正常话术上零命中。

### 3.2 建议新增（12 条，分两组）

**A 组：绝对化用语（`ruleType: "absolutization"`，confidence: statutory）**

| # | 正则 | 为什么不会误报（实测依据） |
|---|---|---|
| A1 | `假一赔[十百千万亿\d]+` | 「假一赔N」是**唯一**含义的赔付承诺，无第二种用法。实测 `假一赔十/假一赔万` 均命中；42 条真实正常话术中唯一命中项「假一赔十是我们的承诺」是**真违规**（主播确实作了该承诺，属广告法禁用）。 |
| A2 | `药到病除` | 成语，字面即「药一吃就好」，**只用于疗效宣称**。实测 `药到病除` 命中，无任何真实话术能正常包含它。 |
| A3 | `包治百病` | 同上，成语级固定搭配。 |
| A4 | `立竿见影` | 成语，直播语境下**只**形容「立刻见效」。⚠️ 注意：理论上可形容「降价立竿见影」，但那是描述促销力度不是疗效；**本方案判定它仍属高风险表述**（见 §5 残留风险 R3）。 |
| A5 | `纯天然` | 「纯天然」在化妆品/食品领域是**受监管的宣称用语**，不是一个普通形容词。实测 `纯棉/纯色/纯手工/纯正/纯牛奶` 全部不命中（因为是「纯+单字」而非「纯天然」），`天然成分/天然色素` 也不命中。 |
| A6 | `纯植物` | 同理，「纯植物」= 成分宣称。实测无正常反例。 |
| A7 | `纯中药` | 同理，且「纯中药」是明确的功效/成分宣称。 |
| A8 | `无副作用` | 药品/保健品明令禁止的表述。实测 `无门槛/无忧/无人/无限/无纺布/无理由` 全部不命中（因为要求「无副作用」整词）。**残留风险见 R1**。 |
| A9 | `零添加` | 食品领域禁用宣称。实测 `零风险/零门槛/零首付/零食/零件/零售价` 全部不命中。 |
| A10 | `明星同款` | 「同款」是固定搭配，`明星同款/网红同款` 只能指代言关系。实测 `这个明星演的电视剧`、`明星代言的产品很多` 不命中（因为要求紧贴「同款」）。 |
| A11 | `医生推荐` | 医疗广告禁用。实测 `有问题请看医生`、`医生说的要遵医嘱`、`专家门诊很难挂` 均不命中（要求「医生」+「推荐」相邻）。 |

**B 组：未核实宣称（`ruleType: "unverifiedClaim"`，confidence: statutory）**

| # | 正则 | 为什么不会误报（实测依据） |
|---|---|---|
| B1 | `械字号` | 这是**注册证号类别**，主播说它 = 声称产品是医疗器械，是明确的事实性宣称。实测 `医用口罩/医用酒精/医用手套/医用胶带/医疗器械` 全不命中。 |

> **A11/B1 之后共 12 条。** 注意我把 `网红同款`、`专家推荐`、`医用级` 放进了探针但**未入选最终清单**——理由见 §3.3。

### 3.3 明确**不建议**新增的词（附理由）

| 词 | 决定 | 理由（实测/法规） |
|---|---|---|
| `七天无理由退换` | **禁止加入** | 这是**法定售后义务**，主播必须说。它不命中**不是漏报，是正确行为**。实测 `七天无理由退换货`、`支持七天无理由` 均命中该模式——若加入即为**把合规话术报成违规**，是最恶劣的误报。**`known-limitations.md:146` 把它列进「漏报清单」是把法定表述误当违规，建议同时修订文档。** |
| `无效退款` | **禁止加入（原样）** | 「无效退款」本身是售后承诺，但实测原模式 `无效退款` 会同时命中 `不满意可以退货`（探针第一轮已复现）。且「无效」在正常话术里可指「会员无效」「优惠券无效」。**建议不加或仅加 `(?:无效|不见效|毫无效果)(?:退款|退钱|包退)` 并接受残留风险 R2。** |
| `根治` / `治愈` | **禁止加入（原样）** | 实测 `不能根治`、`难以根治` 会命中裸词——这是**主播在否认**，报成违规是方向性错误。加 lookbehind 守卫（`(?<![不无没难])`）后 `不能根治` **仍然命中**（「能」字挡住了 lookbehind，实测已复现）。JS 不支持变长 lookbehind，无法可靠修。**结论：不加。** |
| `孕妇可以用` | **禁止加入** | 实测 `孕妇要慎用`、`孕妇不建议使用` 是**反向话术**。要抓「可以用」，正则必须写成 `孕妇…(?:可以用\|能用)`，而「孕妇可以用吗」这种**疑问句**也会命中。带货直播里疑问句极常见。**风险大于收益，不加。** |
| `医用级` | **暂不加** | 探针实测 `医用口罩/医用酒精` 不命中（安全），但「医用级」在普通商品话术里可能指「医用级材质」的**夸大**而非**资质声称**——夸大是我们该抓的，所以它其实可加。**列入「可选」，由实现者与负责人确认后决定。** |
| `无添加` | **暂不加** | 探针实测 `添加剂很多`、`添加了保湿成分`、`不添加防腐剂` 均不命中（安全）。但「无添加」在化妆品语境下**有时被允许**（如「无添加香精」是成分表事实）。风险低于 A8，但高于 A9「零添加」。**列入「可选」。** |
| `专家推荐` / `网红同款` | **暂不加** | 探针未发现真实反例，但「专家」可泛指（「专家门诊」实测不命中，安全）。收益有限，先只上 `医生推荐`/`明星同款`。**列入「可选」。** |

---

## 4. 反例分析（本方案最重要的部分）

### 4.1 方法论

我写了一个**与 `matchRules` 等价**的只读探针（`audit-rule-probe*.cjs`，放在工作区，**未触碰 `src/`**），复制了 `normalizeDigits` + 数字簇截断守卫 + 反查 quote 的全部逻辑，逐条跑候选正则。

### 4.2 一个必须说清的判定分歧

第一轮探针里我构造了 `不能说假一赔十`、`这不是药到病除`、`有人说纯天然，其实不是`、`我不敢说立竿见影` 这类句子，它们**全部命中**。

**我判定这些不是真实反例**，理由：
- 这类句子的形态是「否定词 + 违规词」的**文书式否认**，在带货直播口语里不出现；
- 主播真要否认，说的是「我可没说纯天然啊」——此时**没有**命中（「纯天然」仍紧贴，会被命中，见 R1）；
- 把它们算作误报，会导致**任何固定词表都无法通过**，因为「X」永远可以塞进「不能说X」。

**但这是本方案最需要负责人复核的判断。** 若负责人认为必须覆盖这类句子，则 §3.2 的 12 条**全部要重新评估**——因为纯词表方案在原理上无法排除它们（JS 正则无法做可靠的否定范围分析）。

### 4.3 真实反例扫描（42 条）

探针第四轮，**42 条真实直播风格正常话术**：

```
✓ 今天这款只要九十九          ✓ 原价三百九十九，现在下单立减一百
✓ 七天无理由退换货            ✓ 支持七天无理由
✓ 不满意可以退货              ✓ 不满意就退款
⚠ 假一赔十是我们的承诺        ← 唯一命中，判定为**真违规**，非误报
✓ 纯棉材质  ✓ 纯色设计  ✓ 纯手工制作  ✓ 纯正口感  ✓ 纯牛奶  ✓ 纯棉的
✓ 无门槛优惠券  ✓ 无忧购物  ✓ 无人直播  ✓ 无限回购  ✓ 无纺布
✓ 零风险  ✓ 零门槛  ✓ 零首付  ✓ 零食  ✓ 零件  ✓ 零售价
✓ 添加了保湿成分  ✓ 不添加防腐剂  ✓ 添加剂很多
✓ 这个明星演的电视剧  ✓ 明星代言的产品很多  ✓ 有问题请看医生
✓ 医生说的要遵医嘱  ✓ 专家门诊很难挂
✓ 宝宝的东西也有卖  ✓ 孕妇要慎用  ✓ 孕妇不建议使用
✓ 这款面膜补水效果不错  ✓ 坚持使用皮肤会变好  ✓ 成分很温和
✓ 天然成分  ✓ 天然色素  ✓ 医用口罩  ✓ 医用酒精

A 组误报 1/42
```

**结论：真实话术误报率 1/42，且该 1 例为真阳性。** 这是本方案「不会误报」主张的**实测支撑**。

> ⚠️ **边界（不得说大）**：这 42 条是**我构造的**，不是真实直播回放（`known-limitations.md:73` 明确「干净的真实带货直播样本 = 0 场」）。它证明的是「在已知的构造反例集上零误报」，**不等于真实场景误报率为零**。真实误报率仍需 §7 的抽检支撑。

### 4.4 逐条反例分析（入选的 12 条）

| 规则 | 最可能的反例 | 实测结果 |
|---|---|---|
| `假一赔[十百千万亿\d]+` | 「假一赔十是我们的承诺」 | **命中，但这是真违规**（主播作了赔付承诺）。无真实反例。 |
| `药到病除` | 无构造出的反例 | 成语，无第二种用法。**举不出反例。** |
| `包治百病` | 无 | 同上。**举不出反例。** |
| `立竿见影` | 「价格立竿见影地降了」 | 理论上存在（形容降价），但我**未能构造出真实直播反例**。**残留风险 R3。** |
| `纯天然` | 「不能说纯天然」（构造）、「纯天然成分的替代品」 | 前者判为构造物；后者**会命中**（「纯天然成分的替代品」含子串）。⚠️「不含纯天然成分」这类也会命中。**残留风险 R4。** |
| `纯植物` | 「纯植物提取」是**真违规** | 无正常反例。 |
| `纯中药` | 「纯中药配方」是真违规 | 无正常反例。 |
| `无副作用` | 「不能保证无副作用」「不排除无副作用」 | **都会命中**。⚠️ 主播说「不排除有副作用」则**不命中**（安全）；但「不排除无副作用」会命中。**残留风险 R1（最需要关注）。** |
| `零添加` | 「这不是零添加」「零售价」 | 前者命中（构造物）；后者**不命中**（安全，因为要求整词「零添加」）。 |
| `明星同款` | 「明星同款的替代品」 | 会命中（含子串），但这句话出现在带货里本身就是暗示性宣称，**判为可接受**。 |
| `医生推荐` | 「不是医生推荐」 | 命中（构造物）。真实话术无。 |
| `械字号` | 「没有械字号」 | 会命中，但主播主动提「械字号」本身就是资质话题，**判为可接受**。 |

**举不出反例的**：`药到病除`、`包治百病`、`纯植物`、`纯中药`。这四条是**最安全**的。

---

## 5. 残留风险清单（必须让负责人看到）

| # | 风险 | 触发条件 | 建议处置 |
|---|---|---|---|
| **R1** | `无副作用` 在否定语境误命中 | 「不能保证无副作用」「不排除无副作用」 | 若不能接受，**删掉 A8**。它在 12 条里风险最高。 |
| **R2** | `无效退款` 若加，会命中正常售后 | 「不满意可以退货」（探针已复现） | **不加**，见 §3.3。 |
| **R3** | `立竿见影` 被用于形容降价 | 「价格立竿见影地降了」 | 保留，但标 `needsReview: true`（§2.3 已含）。 |
| **R4** | `纯天然` 出现在否定/比较句 | 「不含纯天然成分」「纯天然成分的替代品」 | 保留，接受。这类句子在带货里罕见。 |
| **R5** | severity 提升为 critical 会改变报告分档 | §2.3 的改动 | 实现前先 grep 报告测试对 `bySeverity` 的断言。 |
| **R6** | 真实误报率未验证 | 本方案所有反例均为**构造输入** | 上线后按 `known-limitations.md:229` 的「误报/漏报抽检 ≥20 条真实候选」验证，**未抽检前不得对外宣称「零误报」**。 |

---

## 6. 测试用例清单

### 6.1 新增文件 `tests/ruleEngine-confidence.test.ts`

**（1）确定度字段契约**

| 用例 | 断言 |
|---|---|
| `statutory 命中带 confidence: "statutory"` | `matchRules("假一赔十", def)[0].confidence === "statutory"` |
| `broad 命中不带 confidence 字段` | `matchRules("保证有效", def)[0].confidence === undefined`（钉住「形状不变」） |
| `broad 命中对象的键集合与今天一致` | `expect(Object.keys(hit).sort()).toEqual(["matchedText","pattern","ruleId","ruleType","stepId"])` |
| `框架规则（用户自配）不带 confidence` | 用 `withRules([...])` 构造，断言 `confidence === undefined` |

**（2）statutory 正例（逐条钉住，参数化）**

```ts
it.each([
  ["假一赔十", "假一赔十"], ["假一赔万", "假一赔万"],
  ["药到病除", "药到病除"], ["包治百病", "包治百病"],
  ["立竿见影", "立竿见影"], ["纯天然", "纯天然"],
  ["纯植物提取", "纯植物"], ["纯中药配方", "纯中药"],
  ["无副作用", "无副作用"], ["零添加", "零添加"],
  ["明星同款", "明星同款"], ["医生推荐", "医生推荐"],
  ["这是械字号产品", "械字号"],
])("%s 必须命中且为 statutory", (text, quote) => {
  const h = matchRules(text, def).find((x) => x.matchedText === quote);
  expect(h, text).toBeDefined();
  expect(h!.confidence, text).toBe("statutory");
});
```

**（3）真实反例（**本方案的核心回归**，直接搬 §4.3 的 42 条）**

```ts
it.each([...42 条...])("真实正常话术不得命中 statutory：%s", (text) => {
  const statutory = matchRules(text, def).filter((h) => h.confidence === "statutory");
  expect(statutory, text).toEqual([]);
});
```

**（4）明确不抓的词（防回归，把「有意不抓」钉死）**

```ts
it.each(["七天无理由退换", "七天无理由退换货", "支持七天无理由",
         "不能根治", "难以根治", "无法治愈",
         "孕妇可以用吗", "孕妇不建议使用",
         "不满意可以退货", "不满意就退款"])(
  "有意不抓：%s", (text) => {
    expect(matchRules(text, def).filter((h) => h.confidence === "statutory"), text).toEqual([]);
  });
```

> ⚠️ 注意 `七天无理由退换` 与 `不能根治` 目前**会命中 broad 规则吗**？实测：不会（探针已验）。所以这里断言的是 `confidence === "statutory"` 过滤后为空，**不排除将来被 broad 规则命中**。

**（5）断言「既有行为未被破坏」**

```ts
it("既有 broad 规则行为逐字不变", () => {
  // 复制 tests/ruleEngine-numerals.test.ts:234-249 的 shouldHit 表，全部重跑
});
```

### 6.2 必须修改的既有测试（否则变红）

**`tests/ruleEngine-numerals.test.ts:256-270`「漏报的常见话术」——这个用例会变红，且必须改。**

```ts
const misses = [
  "七天无理由退换", "无效退款", "假一赔十", "吃了就好", "一抹就白",
  "立竿见影", "药到病除", "零添加", "纯天然", "无副作用",
  "最后一天", "错过再等一年", "手慢无", "抢完就没了", "限量100份",
  "孕妇可以用", "婴儿也能用", "完全不刺激", "明星同款", "医生推荐",
];
for (const text of misses) {
  expect(matchRules(text, def), text).toEqual([]);   // ← 加了新规则后，其中 7 条不再为空
}
```

按 §3.2 的 12 条，**这个数组里有 7 条会从「空」变成「非空」**：
`假一赔十`、`立竿见影`、`药到病除`、`零添加`、`纯天然`、`无副作用`、`明星同款`、`医生推荐` — 实际是 **8 条**。

**处置建议（不改断言的对立面）**：
1. 把已覆盖的 8 条**从 `misses` 移除**；
2. 在文件头**补一段注释**说明「这些曾是漏报，现已由 statutory 规则覆盖」；
3. **保留**仍未覆盖的：`七天无理由退换`、`无效退款`、`吃了就好`、`一抹就白`、`最后一天`、`错过再等一年`、`手慢无`、`抢完就没了`、`限量100份`、`孕妇可以用`、`婴儿也能用`、`完全不刺激` —— 且**在注释里写明「七天无理由退换 / 孕妇可以用 是刻意不抓」**。

> **这不是「放宽测试」，是把「已知漏报」转成「已知覆盖」+「已知有意不抓」**——与 `tests/ruleEngine-triggers.test.ts:9-14` 已经建立的先例一致（该文件头就写明了这种转换）。

### 6.3 `tests/ruleEngine-triggers.test.ts` — 预计**不变红**

该文件的断言集中在阶段触发词（`ScriptLoopState`）与标点打断，实测与新增 statutory 规则无交集。**但 §6.2 的 `toEqual([])` 断言风格（`:92-95`）提示：若新规则命中 `保温二十五，小时` 等文本，会变红。实测这些文本不含 §3.2 的 12 个词，判定不变红。**

---

## 7. 既有测试变红清单（汇总）

| 文件 | 用例 | 是否变红 | 处置 |
|---|---|---|---|
| `tests/ruleEngine-numerals.test.ts` | `:256` 「漏报的常见话术（归因：规则缺覆盖，不是 ASR 问题）」 | **✅ 变红**（8 条不再为空） | 按 §6.2 移除已覆盖项 + 补注释 |
| `tests/ruleEngine-numerals.test.ts` | `:272` 「最后一天」同时是漏报项与促单话术 | ❌ 不变红 | 「最后一天」不在新增清单 |
| `tests/ruleEngine-numerals.test.ts` | `:161` 默认规则整簇命中 | ❌ 不变红 | |
| `tests/ruleEngine-numerals.test.ts` | `:233` 能抓到的常见违规话术 | ❌ 不变红 | 原样保留 |
| `tests/ruleEngine-triggers.test.ts` | 全部 | ❌ 不变红（预计） | |
| `tests/analysis-link-verify.test.ts` | `:150` D1 绝对化参数化 | ❌ 不变红 | 只断言 `some(...)` |
| `tests/analysis-link-verify.test.ts` | `:103` `rows).toHaveLength(6)` | ⚠️ **需实现者确认** | 该测试文本「全网最低价，保证所有人满意」不含新增词，预计不变红 |
| `tests/report.test.ts` | `bySeverity` 相关 | ⚠️ **不确定** | 若实现 §2.3 severity 改动，必须 grep 确认 |

> **「不确定」标注**：我没有逐字读完 `tests/report.test.ts` 全文（只在 grep 中见到 `bySeverity` 出现在 `reportBuilder.ts:55`）。若实现 §2.3，**实现者必须先跑一次全量确认**。

---

## 8. 实施顺序（给实现者）

1. 先只加数据结构 + `confidence` 字段，**数组内容一字不改**，跑全量 → 必须 **378/378**。这一步验证「加字段不破坏契约」。
2. 再加 12 条 statutory 规则，跑全量 → **只有 §6.2 那一个用例红**。
3. 按 §6.2 改那一个用例 + 补注释。
4. 再加 §6.1 的新测试文件。
5. 最后才动 §2.3 的 severity（可选，风险最高，放最后）。
6. 每步之间跑全量，确认红的是**预期的那一条**。
