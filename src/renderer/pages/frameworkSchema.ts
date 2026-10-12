import { z } from "zod";

/** 话术配置页的编辑期 schema（阶段2）：保存前校验，缺字段给具体错误。 */

export const FrameworkStepEditSchema = z.object({
  id: z.string().min(1, "步骤缺少 id"),
  frameworkId: z.string().min(1, "步骤缺少 frameworkId"),
  name: z.string().min(1, "步骤名称不能为空"),
  priority: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
  ]),
  maxWaitMs: z.number().int().nonnegative("最长等待时间不能为负"),
});

export const FrameworkRuleEditSchema = z.object({
  id: z.string().min(1, "规则缺少 id"),
  frameworkId: z.string().min(1, "规则缺少 frameworkId"),
  stepId: z.string().nullable(),
  ruleType: z.enum(["bannedWord", "absolutization", "unverifiedClaim", "repetition", "hotWord"]),
  pattern: z.string().min(1, "规则内容不能为空"),
  enabled: z.boolean(),
});

export const FrameworkEditSchema = z.object({
  id: z.string().min(1, "缺少 id"),
  name: z.string().min(1, "话术名称不能为空"),
  steps: z.array(FrameworkStepEditSchema),
  rules: z.array(FrameworkRuleEditSchema),
  productFacts: z.string(),
  updatedAt: z.string(),
});

export type FrameworkEdit = z.infer<typeof FrameworkEditSchema>;

export const PRIORITY_LABEL: Record<number, string> = {
  0: "可选",
  1: "建议",
  2: "必须",
};

export const RULE_TYPE_LABEL: Record<string, string> = {
  bannedWord: "禁用词",
  absolutization: "绝对化用语",
  unverifiedClaim: "未核实宣称",
  repetition: "重复话术",
  hotWord: "热词",
};
