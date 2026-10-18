# 平台版本差异说明

本技能包中以下 2 个文件在智谱平台分发时加入了多处中文本地化注记（如“依赖由项目管理员按已批准锁文件预装”等），
平台文件接口对单文件内容设 8192 字符返回上限，超出部分无法通过市场 API 获取，因此这两个文件按“平台前言注记 + 上游完整正文”重建：

- references/dashboard-patterns.md（平台版 41685 字节，重建版 40842 字节；前 8192 字符范围内与平台版逐字节一致，更深处平台另有约 843 字节注记未包含）
- references/table-patterns.md（平台版 15983 字节，重建版 15570 字节；自约第 300 字节起平台有替换式修改，重建版此段采用上游原文）

平台返回的原始（截断）副本保留为同名 *.platform-truncated.md sidecar 文件。
上游来源见本目录 UPSTREAM.md（https://github.com/DangJin/bi-builder-skills @ 94b589b351d1）。
