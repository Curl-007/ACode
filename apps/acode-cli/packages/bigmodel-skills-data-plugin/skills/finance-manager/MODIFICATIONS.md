# 2026-10-09 适配版变更

本文件说明相对于上游版本的修改；包内使用规则不替代实际运行环境的权限、安全及合规控制。
原包编号：S049；原名称：finance-manager；原 ZIP SHA-256：c9dfc024ea925b239fb454e988fe8a4d29328193e18b827fac1ee72926a77d57。

原 LICENSE 与 UPSTREAM.md 原样保留；原有版权、许可和署名继续适用，不改标专有许可，不表示上游背书。已移除内容不随本包重新分发。

去掉 CDN、原样本和假成功入口；重写标准库计算与离线报告，修复最大支出。

- 修改：SKILL.md
- 移除：analysis.json
- 新增：examples/SOURCE.md
- 新增：examples/synthetic-transactions.csv
- 移除：index.js
- 移除：package.json
- 修改：references/financial_frameworks.md
- 移除：report.html
- 修改：scripts/analyze_finances.py
- 移除：scripts/extract_pdf_data.py
- 修改：scripts/generate_report.py
- 移除：transactions.csv
