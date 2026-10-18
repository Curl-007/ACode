# 2026-10-09 适配版变更

本文件说明相对于上游版本的修改；包内使用规则不替代实际运行环境的权限、安全及合规控制。
原包编号：S025；原名称：bi-builder；原 ZIP SHA-256：7a80af62dc8407fd6cce4cb972811112e16f04d968f91cc539a81efe58dfea84。

原 LICENSE 与 UPSTREAM.md 原样保留；原有版权、许可和署名继续适用，不改标专有许可，不表示上游背书。已移除内容不随本包重新分发。

重写只读数据层和受控导出；移除客户端全字段导出；修复CSV编码与跨期日期错配。

- 修改：SKILL.md
- 修改：references/dashboard-patterns.md
- 修改：references/data-layer.md
- 修改：references/export-patterns.md
- 修改：references/recharts-guide.md
- 修改：references/table-patterns.md
- 新增：scripts/bi-data-utils.mjs
