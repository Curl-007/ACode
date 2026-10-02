# Agent 引擎外部槽位移除（External Engine Slots Removal）

## 背景与决定

ACode 的引擎注册表（`packages/shared/src/acode-agent-registry.ts`）当前声明 4 个引擎槽位：native `glm` 与外部引擎 `codex`/`opencode`/`gemini`。外部槽位自引入起 `implemented: false`——会话协议适配器从未实现：UI 无选择入口（设置页为只读展示，永远显示「未安装」）、bot `/engine` 命令过滤后不可选、不随包分发。产品决定：**删除三个外部槽位，仅保留 native(glm)**。

## 产品规则

1. ACode 只有一个 agent 引擎：native `glm`（`acode.cjs app-server --stdio`）。注册表仍为引擎唯一所有者，`resolveAgentEngine` 保留「未知/缺省回退 native」语义——**旧持久化数据中的 `provider:"codex"/"opencode"/"gemini"` 归一为 `glm`，无需迁移**。
2. bot `/engine` 命令删除（单引擎无选择语义）。持久化 `botAllowedCommands.engine` 字段按 `/cli` 先例在 schema 中宽容保留（strict parse 不破），新配置不再写入。
3. 设置页「引擎」区块删除：单引擎下状态列表无信息量。
4. **保留边界（不受本次影响）**：
   - 外部 CLI 互操作导入（settings-sync 的 `codexCli`/`opencode` 路径、`.codex-plugin` 目录约定）——这是「从其他工具导入配置」特性，与引擎槽位无关；
   - `gemini` 作为**模型 Provider**（BYO LLM API 轴）的所有代码；
   - `process-diagnostic.ts` 的外部运行时崩溃签名（子进程 stderr 分类，通用诊断）；
   - `acodeEnginePermissionModeSchema` 取值上界联合与 `engine.permissionMode.*` 文案键（bots 权限投影仍消费）；
   - `taskIndexRepo` 的历史 provider 残留过滤（旧索引行兼容）。

## 接口变化

| 接口 | 变化 |
| --- | --- |
| `ACodeProvider`（acode-task-types-core） | `"glm" \| "codex" \| "opencode" \| "gemini"` → `"glm"` |
| `ACODE_AGENT_ENGINE_IDS` / 注册表 | 仅 `glm`；描述符删除 `implemented`、`usesApprovalPolicy` 字段 |
| `ACODE_AGENT_ENGINE_RUNTIMES` | 仅 `glm`；`externalEngineRuntime()` 与 `CODEX/OPENCODE/GEMINI_BINARY_PATH` 概念删除 |
| bots 协议 | `engine.list` / `engine.set` 命令类型与 handler 删除；`DEFAULT_BOT_COMMANDS` 移除 `engine`；`BOT_ACODE_PROVIDER_OPTIONS` 恒为 `[glm]` |
| services | `externalEngineCommandResolver.ts` 整文件删除；进程管理器 `!engine.native` dispatch 分支删除 |
| UI | `EngineSection.tsx` 删除及其设置页挂载；locales 删 `settings.engine.*`、`engine.<external>.*` 键（保留 `engine.permissionMode.*` 与 `engine.glm.*` 若仍有消费） |

## 验收场景

1. 旧会话 `provider:"codex"` 重开 → `resolveAgentEngine` 回退 glm，会话正常驱动；
2. 旧 bot 配置含 `engine:true` → strict parse 通过（宽容字段），`/engine` 消息按未知命令处理；
3. 设置页不再渲染引擎区块，无死文案键；
4. 外部 CLI 导入（codex/opencode skills/commands）与 gemini 模型 Provider 功能不受影响；
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check -- --changed`、相关单测（botDraftOptions 等）通过。

## 状态同步

- 实施日期：2026-10-02。分支：dev/0.0.1 工作区。
- 实施完成：typecheck 0 error、lint 基线（73 warnings / 0 error）、architecture 0 violations；
  测试 botDraftOptions 6/6、agent-command-env-gate 7/7、bot-guardrails 11/11、
  botPermissionLocalApproval 9/9、ui+services nonCliAcpRetirement 6/6+5/5 全绿。
- 归一语义裁决：task meta 的 provider 旧值归一为**缺省**（undefined，不伪造 glm 边界混入
  runtime provider 过滤，与 taskIndexRepo 既有边界一致）；bots draft/current 的引擎值归一为
  **字面 glm**（bot 配置必须有有效引擎，单引擎下 glm 即缺省）。
