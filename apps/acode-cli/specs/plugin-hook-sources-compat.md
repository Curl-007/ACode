# Spec：插件 hook 来源发现的多生态兼容（hook sources compat）

移植自上游 ZCodium e5d6e269 的行为规则；与 `plugin-foreign-manifest-compat.md` 同属
跨生态插件兼容域，但发现对象不同：那边是插件清单（plugin.json），这里是 hook 声明文件。

## 事实源与所有权

- **唯一发现点**：`apps/acode-cli/packages/adapters/src/plugins/hook-sources.ts` 的
  `listPluginHookSources`。详情枚举（`plugins/describe`）与真实 loader 共用该函数，
  不允许出现第二套 hook 文件探测逻辑。
- **守护测试**：`apps/acode-cli/tests/plugin-hook-sources-compat.test.mjs`。

## 行为规则

### R1 候选位置与优先级

hook 声明文件按以下顺序探测，**首个存在者生效，只加载一份**：

```
hooks/hooks.json（ACode/Claude 约定）  >  插件根 hooks.json（Codex 约定）
```

- Codex 插件规范把 hooks 放在插件根 `hooks.json`；只探测 `hooks/hooks.json` 会把
  Codex 布局的 hooks 静默丢弃（无诊断）。
- 两处同时存在时以 `hooks/hooks.json` 为准：多生态插件可能同时维护两份、内容按
  生态定制（例如钩子命令里的变量前缀不同），ACode 运行时语义对齐 Claude 语境，
  不能两份 hook 同时触发。

### R2 与 manifest.hooks 声明的去重

- 自动发现（R1）命中的文件按 realpath 记入已加载集合；`manifest.hooks` 再声明
  同一路径时不重复加载，产生 `plugin_hook_invalid`（Duplicate…）warning 诊断。
- realpath 归一化兜住符号链接指向同一文件的情形。

### R3 失败语义

- hook 文件 JSON 解析失败：`plugin_hook_read_failed` error 诊断，不阻断插件其余
  组件加载。
- `manifest.hooks` 路径逃逸插件根：`plugin_component_path_invalid` error 诊断。

## 非目标

- 不合并两份布局的 hook 内容（见 R1 理由）。
- 不扩展到清单兼容域（.cursor-plugin 等约定见 foreign-manifest spec）。
