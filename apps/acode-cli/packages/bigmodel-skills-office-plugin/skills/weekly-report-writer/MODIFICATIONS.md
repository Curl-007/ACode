# MODIFICATIONS

本技能相对上游/平台版本的改动登记。

## ACode 收录适配（2026-10-18，specs/bigmodel-skills-marketplace-plugins.md R3）

- 删除 `depends_on_skill:`：ACode 不消费该键，未知键会置 safeToAutoLoad=false。
- 删除 `depends_on_binary:`：ACode 不消费该键，未知键会置 safeToAutoLoad=false。
