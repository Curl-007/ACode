# 2026-10-09 适配版变更

本文件说明相对于上游版本的修改；包内使用规则不替代实际运行环境的权限、安全及合规控制。
原包编号：S029；原名称：Lead Research Assistant；原 ZIP SHA-256：479774603993f3d32423e32e121eb0d8896f344b9543e3667d2b2c2cb4c22396。

原 LICENSE 与 UPSTREAM.md 原样保留；原有版权、许可和署名继续适用，不改标专有许可，不表示上游背书。已移除内容不随本包重新分发。

限定企业经营信息、合法来源与必要联系渠道；研究和营销发送分开。

- 修改：SKILL.md

内部 name 从 Lead Research Assistant 规范为 lead-research-assistant；审核编号 S029 和原包来源不变。部署时需核对平台的名称映射。

原入口元数据（历史来源记录，不代表本版运行依赖或当前批准）：
```json
{
  "name": "Lead Research Assistant",
  "description": "Research company and contact information for sales outreach",
  "version": "1.0",
  "author": "claude-office-skills",
  "license": "MIT",
  "category": "sales",
  "tags": [
    "lead",
    "research",
    "sales",
    "prospecting"
  ],
  "department": "Sales",
  "models": {
    "recommended": [
      "claude-sonnet-4",
      "claude-opus-4"
    ],
    "compatible": [
      "claude-3-5-sonnet",
      "gpt-4",
      "gpt-4o"
    ]
  },
  "mcp": {
    "server": "office-mcp",
    "tools": [
      "create_docx",
      "xlsx_to_json"
    ]
  },
  "capabilities": [
    "lead_research",
    "company_analysis",
    "contact_discovery"
  ],
  "languages": [
    "en",
    "zh"
  ]
}
```

## ACode 收录适配（2026-10-18，specs/bigmodel-skills-marketplace-plugins.md R3）

- 目录名 `Lead Research Assistant` → `lead-research-assistant`（与 frontmatter `name` 对齐；ACode 插件技能按目录发现）。
