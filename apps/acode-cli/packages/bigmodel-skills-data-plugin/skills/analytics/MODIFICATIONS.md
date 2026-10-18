# External package-path adaptation

The upstream instructional body is unchanged. Six links from `../../tools/` were rebased to the bundled `tools/` directory because this platform package places `SKILL.md` at the ZIP root. The exact upstream file is preserved as `UPSTREAM-SKILL.md`.


# 2026-10-09 适配版变更

本文件说明相对于上游版本的修改；包内使用规则不替代实际运行环境的权限、安全及合规控制。
原包编号：S058；原名称：analytics；原 ZIP SHA-256：9bddcf96e07d79ecd3f57ae7fd6b0e834f28d6e2b7e14fa9ddcadf08d1dee118。

原 LICENSE 与 UPSTREAM.md 原样保留；原有版权、许可和署名继续适用，不改标专有许可，不表示上游背书。已移除内容不随本包重新分发。

移除第三方部署、旧重复入口、像素与回放示例；保留离线事件方案。

- 修改：SKILL.md
- 移除：UPSTREAM-SKILL.md
- 修改：evals/evals.json
- 修改：references/event-library.md
- 移除：references/ga4-implementation.md
- 移除：references/gtm-implementation.md
- 修改：tools/REGISTRY.md
- 移除：tools/integrations/amplitude.md
- 移除：tools/integrations/ga4.md
- 移除：tools/integrations/mixpanel.md
- 移除：tools/integrations/posthog.md
- 移除：tools/integrations/segment.md

原入口元数据（历史来源记录，不代表本版运行依赖或当前批准）：
```json
{
  "name": "analytics",
  "description": "When the user wants to set up, improve, or audit analytics tracking and measurement. Also use when the user mentions \"set up tracking,\" \"GA4,\" \"Google Analytics,\" \"conversion tracking,\" \"event tracking,\" \"UTM parameters,\" \"tag manager,\" \"GTM,\" \"analytics implementation,\" \"tracking plan,\" \"how do I measure this,\" \"track conversions,\" \"Mixpanel,\" \"Segment,\" \"are my events firing,\" or \"analytics isn't working.\" Use this whenever someone asks how to know if something is working or wants to measure marketing results. For choosing attribution models, comparing multi-touch/MMM/incrementality, or reconciling conflicting numbers across tools, see attribution. For A/B test measurement, see ab-testing.",
  "metadata": {
    "version": "2.0.1"
  }
}
```
