import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_MODEL_PROVIDER_IDS, type UsageEntitlementSnapshot } from "@acode/shared";
import type { CodingPlanUsageSource } from "../src/settings/usage-stats/CodingPlanUsagePanel.js";
import {
  createSettingsUsageCodingPlanTabId,
  hasActiveCodingPlanSnapshot,
  isTeamCodingPlanUsageSource,
  resolveSettingsUsageCodingPlanSourceId,
  resolveSettingsUsageCodingPlanTabLabel,
} from "../src/settingsUsageCodingPlanTabs.js";

/**
 * SettingsPage batch-4 helper 外迁的接缝内决策表单测（settings 上帝组件拆分计划扩展批次，
 * 2026-10-28）：覆盖 usage coding-plan tab 的 team 判定 / tab id 构造与解析 round-trip /
 * 标签解析正则边界 / 有效套餐快照判定矩阵。
 * 派生簇 hook（useSettingsUsageCodingPlanSources）依赖 React 渲染环境，本仓测试无 jsdom，
 * 不在本表单测范围内，登记为已知留白。
 */

const ZAI_INDIVIDUAL = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
const BIGMODEL_TEAM = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;

function makeTeamSource(label: string): CodingPlanUsageSource {
  return {
    id: "team:org-1/project-1",
    providerId: BIGMODEL_TEAM,
    label,
    accountAccess: {
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "team-coding-plan",
      productId: "product-1",
      organizationId: "org-1",
      projectId: "project-1",
    },
  };
}

function makePersonalSource(label: string): CodingPlanUsageSource {
  return {
    id: ZAI_INDIVIDUAL,
    providerId: ZAI_INDIVIDUAL,
    label,
    accountAccess: {
      type: "zhipu-account",
      family: "zai",
      planKind: "individual-coding-plan",
    },
  };
}

function makeStartPlanSource(label: string): CodingPlanUsageSource {
  return {
    id: ZAI_INDIVIDUAL,
    providerId: ZAI_INDIVIDUAL,
    label,
    accountAccess: {
      type: "zhipu-account",
      family: "zai",
      planKind: "start-plan",
    },
  };
}

function makeProviderAccessSource(label: string): CodingPlanUsageSource {
  return {
    id: ZAI_INDIVIDUAL,
    providerId: ZAI_INDIVIDUAL,
    label,
    accountAccess: {
      type: "zhipu-account",
      accountType: "zai",
      mode: "individual-coding-plan",
      entitled: true,
    },
  };
}

function makeSnapshot(
  overrides: Partial<UsageEntitlementSnapshot> = {},
): UsageEntitlementSnapshot {
  return {
    generatedAt: 0,
    authenticated: true,
    provider: { id: ZAI_INDIVIDUAL, name: "Z.ai" },
    remaining: null,
    subscription: null,
    quota: null,
    ...overrides,
  };
}

test("isTeamCodingPlanUsageSource: 仅 team-coding-plan planKind 判定为 team", () => {
  assert.equal(isTeamCodingPlanUsageSource(makeTeamSource("BigModel - Team")), true);
  assert.equal(isTeamCodingPlanUsageSource(makePersonalSource("Z.ai - Coding Plan")), false);
  assert.equal(isTeamCodingPlanUsageSource(makeStartPlanSource("Z.ai - Start Plan")), false);
  // ACodeProviderAccountAccess 没有 planKind 字段，"planKind" in 判定为 false。
  assert.equal(isTeamCodingPlanUsageSource(makeProviderAccessSource("Z.ai")), false);
});

test("usage coding-plan tab id: 构造与解析 round-trip", () => {
  assert.equal(createSettingsUsageCodingPlanTabId("src-1"), "codingPlan:src-1");
  assert.equal(
    resolveSettingsUsageCodingPlanSourceId(createSettingsUsageCodingPlanTabId("src-1")),
    "src-1",
  );
  // team source id 自带冒号，解析必须只剥掉第一个前缀。
  const teamTabId = createSettingsUsageCodingPlanTabId("team:org-1/project-1");
  assert.equal(teamTabId, "codingPlan:team:org-1/project-1");
  assert.equal(resolveSettingsUsageCodingPlanSourceId(teamTabId), "team:org-1/project-1");
});

test("resolveSettingsUsageCodingPlanSourceId: 非 codingPlan: 前缀返回 null", () => {
  assert.equal(resolveSettingsUsageCodingPlanSourceId("app"), null);
  assert.equal(resolveSettingsUsageCodingPlanSourceId("codingPlan"), null);
  // 边界：空前缀后缀得到空字符串 source id，而非 null。
  assert.equal(resolveSettingsUsageCodingPlanSourceId("codingPlan:"), "");
});

test("resolveSettingsUsageCodingPlanTabLabel: team source 去掉 BigModel 前缀", () => {
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: false,
      index: 0,
      source: makeTeamSource("BigModel - 团队版 Pro"),
    }),
    "团队版 Pro",
  );
  // 大小写不敏感且允许省略横线两侧空白。
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: false,
      index: 0,
      source: makeTeamSource("bigmodel-Team Suite"),
    }),
    "Team Suite",
  );
  // 无匹配前缀时保留原 label。
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: false,
      index: 0,
      source: makeTeamSource("GLM Team"),
    }),
    "GLM Team",
  );
  // 前缀即全部内容时裁剪结果为空，回退原 label。
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: false,
      index: 0,
      source: makeTeamSource("BigModel -"),
    }),
    "BigModel -",
  );
  // team 分支优先于多 personal source 分支。
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: true,
      index: 1,
      source: makeTeamSource("BigModel - 团队版 Pro"),
    }),
    "团队版 Pro",
  );
});

test("resolveSettingsUsageCodingPlanTabLabel: 多 personal source 去掉 Coding Plan 后缀", () => {
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: true,
      index: 0,
      source: makePersonalSource("Z.ai - Coding Plan"),
    }),
    "Z.ai",
  );
  // 大小写不敏感。
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: true,
      index: 0,
      source: makePersonalSource("Z.ai - coding plan"),
    }),
    "Z.ai",
  );
  // 后缀不在末尾（后面还有内容）时不裁剪。
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: true,
      index: 0,
      source: makePersonalSource("Z.ai - Coding Plan Extra"),
    }),
    "Z.ai - Coding Plan Extra",
  );
  // 无横线后缀时保留原 label。
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: true,
      index: 0,
      source: makePersonalSource("Z.ai"),
    }),
    "Z.ai",
  );
  // 后缀即全部内容时裁剪结果为空，回退原 label。
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: true,
      index: 0,
      source: makePersonalSource("- Coding Plan"),
    }),
    "- Coding Plan",
  );
});

test("resolveSettingsUsageCodingPlanTabLabel: 单 personal source 一律用 defaultLabel", () => {
  assert.equal(
    resolveSettingsUsageCodingPlanTabLabel({
      defaultLabel: "Coding Plan",
      hasMultiplePersonalSources: false,
      index: 0,
      source: makePersonalSource("Z.ai - Coding Plan"),
    }),
    "Coding Plan",
  );
});

test("hasActiveCodingPlanSnapshot: provider 必须匹配", () => {
  assert.equal(hasActiveCodingPlanSnapshot(null, ZAI_INDIVIDUAL), false);
  // provider 不匹配时即使带 subscription details 也不算 active。
  assert.equal(
    hasActiveCodingPlanSnapshot(
      makeSnapshot({
        provider: { id: "other-provider", name: "Other" },
        subscription: {
          identityType: "email",
          identityMasked: "a@b.c",
          details: [
            {
              productId: "product-1",
              productName: "Coding Plan",
              purchaseTime: null,
              beginTime: null,
            },
          ],
        },
      }),
      ZAI_INDIVIDUAL,
    ),
    false,
  );
});

test("hasActiveCodingPlanSnapshot: 明确 no_plan 才隐藏入口", () => {
  // provider 匹配但无 subscription details 且非 unavailable → 不 active。
  assert.equal(hasActiveCodingPlanSnapshot(makeSnapshot(), ZAI_INDIVIDUAL), false);
  // no_plan 即使有 subscription details 也强制隐藏。
  assert.equal(
    hasActiveCodingPlanSnapshot(
      makeSnapshot({
        unavailableReason: "no_plan",
        subscription: {
          identityType: "unknown",
          identityMasked: null,
          details: [
            {
              productId: "product-1",
              productName: "Coding Plan",
              purchaseTime: null,
              beginTime: null,
            },
          ],
        },
      }),
      ZAI_INDIVIDUAL,
    ),
    false,
  );
  // 其它 unavailableReason（如 not_authenticated）不满足兜底分支。
  assert.equal(
    hasActiveCodingPlanSnapshot(
      makeSnapshot({ unavailableReason: "not_authenticated" }),
      ZAI_INDIVIDUAL,
    ),
    false,
  );
});

test("hasActiveCodingPlanSnapshot: quota 失败 unavailable 或带 subscription details 仍 active", () => {
  // quota 暂时失败：provider 匹配 + unavailableReason "unavailable" → active。
  assert.equal(
    hasActiveCodingPlanSnapshot(
      makeSnapshot({ unavailableReason: "unavailable" }),
      ZAI_INDIVIDUAL,
    ),
    true,
  );
  // 显式空 details 数组同样走 unavailable 兜底。
  assert.equal(
    hasActiveCodingPlanSnapshot(
      makeSnapshot({
        unavailableReason: "unavailable",
        subscription: { identityType: "unknown", identityMasked: null, details: [] },
      }),
      ZAI_INDIVIDUAL,
    ),
    true,
  );
  // 有 subscription details → active（无 unavailableReason）。
  assert.equal(
    hasActiveCodingPlanSnapshot(
      makeSnapshot({
        subscription: {
          identityType: "email",
          identityMasked: "a@b.c",
          details: [
            {
              productId: "product-1",
              productName: "Coding Plan",
              purchaseTime: null,
              beginTime: null,
            },
          ],
        },
      }),
      ZAI_INDIVIDUAL,
    ),
    true,
  );
});
