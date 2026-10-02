# 外部 Agent 引擎运行时层（registry / 权限模式 / spawn / 诊断）

为 ACode 增加「多 Agent 引擎」的最小可用运行时层：引擎注册表（native + codex/opencode/gemini）、
每引擎权限模式枚举、引擎感知的进程命令解析与生命周期标记，以及镜像 ZCode 的「引擎未安装 /
运行时缺失 / 运行时崩溃」错误签名诊断。

## 关键事实与命名裁决（务必先读）

- ACode 今天是**单引擎系统**。唯一的 `ACodeProvider` 值 `"glm"` 指向 ACode 自带的 bundled native
  agent（`bundled-agents/<platform>/glm/acode.cjs`，以 `app-server --stdio` 启动）。它**不是** ZCode
  的外部 GLM 引擎，而是一个命名冲突。
- 裁决：**保留 `"glm"` 作为 native 引擎 id 与缺省值**（所有已持久化的 `provider?: "glm"`、bot 配置、
  task meta 保持有效，无需迁移），把 codex/opencode/gemini 作为**新增的外部引擎 id** 并入同一联合。
  ZCode 的外部 `glm` 槽位在 ACode 不复刻——ACode 的 `"glm"` 永远是 native。
- **FALSE PREMISE**：ZCode 3.14.3 参考实现里**没有** codex/opencode/gemini 的 spawn 实现。已逐行核对
  `zcode-recovered/src/beautified`：只有引擎枚举（kernel:27188/30088/34720）与两组错误签名数组
  （kernel:20081-20093），**没有任何外部引擎的 binary/spawnArgs/协议桥**。因此本层是「在 ACode 既有
  scaffold 上把引擎注册表 + 诊断 + 引擎感知 dispatch 落地」，外部引擎的**会话协议适配器属净新增、无参考**，
  本任务范围内 `implemented:false`，仅落地 spawn 命令解析、binary 发现与诊断（即「引擎是否安装」可被探测）。

## 产品规则

- 引擎联合：`glm`(native) | `codex` | `opencode` | `gemini`。`glm` 为缺省与 native。
- 每个引擎有：展示 label、是否 native、是否 `implemented`（能否真正驱动会话）、支持的权限模式集合、
  运行时描述符引用（binary env var / bundled 资源目录 / spawnArgs / missingBinaryMessage）。
- native(`glm`) 的权限模式 = 既有 ACode 会话模式集（build/edit/plan/yolo）。外部引擎权限模式取自 ZCode
  联合 `[default,yolo,plan,edit,acceptEdits,auto,dontAsk,bypassPermissions,autoEdit,build]` 的子集；
  codex 语义上走 `approvalPolicy`/`sandboxMode`（既有 bots schema 已承载），不走 build/edit/plan/yolo。
- 错误诊断镜像 ZCode 两组签名：
  - 非重试 workspace-prepare 错误（binary 未找到 / 未正确安装 / `Cannot find package '@openai/codex-` /
    `Missing Codex runtime files` / `Gemini API key is missing or not configured` / 进程启动失败 / 已暂停自动重试 等）。
  - opencode 运行时崩溃（`opencode runtime crashed` / `bun has crashed` / `segmentation fault` /
    `panic(main thread)` / `code=3221226505`）。
  - 分类但不过度匹配：只做小写子串命中，命中即归类，不改写原文。

## 状态所有者与写入路径

- **引擎注册表唯一所有者**：`@acode/shared` 的 `acode-agent-registry.ts`。下游（policy/runtime/bots/
  model-state/services resolver）只读消费，不得各自再定义引擎列表。
- **根类型**：`ACodeProvider`（`acode-task-types-core.ts`）从单字面量 `"glm"` 拓宽为引擎联合；注册表
  的 `ACODE_AGENT_ENGINE_IDS` 以 `satisfies readonly ACodeProvider[]` 与之绑定，漂移即编译失败。
- **运行时描述符所有者**：`acode-agent-runtime.ts` 的 per-engine map；`getEngineRuntime(engineId)` 读取，
  既有 `ACODE_AGENT_RUNTIME`(=`glm`) 与 `getACodeAgentRuntime()` 保留为 native 别名，向后兼容。
- **错误分类所有者**：`process-diagnostic.ts`（已被 services stderr/exit 路径消费）。
- **进程生命周期唯一所有者**：`acodeAgentProcessManager.ts`（不新建第二个 manager）。命令解析上下文
  携带 `engineId`，dispatch 到 native 既有路径或外部引擎 binary 解析；spawn/error/exit 事件按 engineId 标记。
- **binary 发现所有者**：`providerRuntimeResolver.ts`，按引擎描述符参数化候选链。

## 接口

- `packages/shared/src/acode-task-types-core.ts`：`ACodeProvider` 拓宽为引擎联合。
- `packages/shared/src/acode-agent-registry.ts`（新）：`ACODE_AGENT_ENGINE_IDS`、`ACodeAgentEngineId`、
  `acodeAgentEngineIdSchema`、`ACodeAgentEngineDescriptor`、`ACODE_AGENT_ENGINE_REGISTRY`、
  `isNativeAgentEngine`、`resolveAgentEngine`、`getAgentEngineDescriptors`、`getAgentEnginePermissionModes`。
- `packages/shared/src/acode-agent-policy.ts`：`acodeAgentProviderSchema` 改为 enum；
  `normalizeAgentProviderToACodeAgent` 引擎感知（默认 native，合法引擎透传）；新增 `isAgentEngineId`。
- `packages/shared/src/acode-agent-runtime.ts`：per-engine `ACODE_AGENT_ENGINE_RUNTIMES` + `getEngineRuntime`。
- `packages/shared/src/acode-protocol-legacy-types.ts`：`acodeEnginePermissionModeSchema`（ZCode 联合）。
- `packages/shared/src/process-diagnostic.ts`：`AGENT_ENGINE_NON_RETRYABLE_SIGNATURES`、
  `AGENT_ENGINE_RUNTIME_CRASH_SIGNATURES`、`isNonRetryableWorkspacePrepareError`、
  `isOpenCodeRuntimeCrashError`、`classifyAgentEngineError`。
- `packages/shared/src/bots.ts`：`botCurrentOptionsSchema.cli`、`botDraftOptionsSchema.provider` 改 enum；
  `BOT_ACODE_PROVIDER_OPTIONS` 由注册表生成。
- `packages/shared/src/acode-protocol/index.ts`：`acodeSessionCreateParamsSchema` 增可选 `engine`（向后兼容）。
- `packages/shared/src/acode-agent-model-state.ts`：`getACodeAgentAvailableModes(engineId?)` 引擎作用域。
- `packages/services/src/runtime-tools/providerRuntimeResolver.ts`：`findACodeAgentRuntimeBinary(engineId?)`、
  `findACodeAgentRuntimeNodeBundle(engineId?)` 按描述符参数化。
- `packages/services/src/acode-agent/acodeAgentProcessManager.ts`：`ACodeAgentCommandResolverContext.engineId`，
  `resolveDefaultACodeAgentCommand` 引擎 dispatch，事件标记 engineId，exit/stderr 接错误分类。
- UI：`packages/ui/src/lib/acodeSessionProjection.ts` 与 `display-help.ts` 引擎作用域模式投影；
  `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` 增 `engine.*` / `settings.engine.*` 键。

## 事件顺序

```text
引擎感知 spawn（native 不变；外部引擎走 binary 解析）:
  getClient/createTask(engineId)
    └─ commandResolver(context{engineId})
         ├─ engineId=glm(native) → 既有 bundled/electron/deployed 路径（字节级不变）
         └─ engineId=codex|opencode|gemini → getEngineRuntime(id) → findACodeAgentRuntimeBinary(id)
              ├─ 命中 binary → spawn（协议适配器未接，implemented:false 时 create 路径拒绝驱动会话）
              └─ 未命中 → 返回 null + missingBinaryMessage → 进程管理器 surface「引擎未安装/运行时缺失」

stderr/exit 诊断:
  child stderr line / exit
    └─ classifyAgentEngineError(text)
         ├─ isOpenCodeRuntimeCrashError → "runtime-crash"
         ├─ isNonRetryableWorkspacePrepareError → "non-retryable-prepare"
         └─ 否则 → 既有 parseACodeProcessDiagnostic / 原样 tail
```

## 验收场景

1. native 缺省：不传 engineId / 传 `"glm"`，命令解析、spawn、协议、模式列表与改动前字节一致。
2. 旧持久化数据：`provider:"glm"` 的 task meta / bot 配置仍通过 schema 校验，不触发迁移。
3. 引擎枚举：`acodeAgentEngineIdSchema` 接受 4 个引擎、拒绝其它；`ACODE_AGENT_ENGINE_IDS` 与
   `ACodeProvider` 漂移时编译失败。
4. 外部引擎 binary 缺失：`findACodeAgentRuntimeBinary("codex")` 在未安装时返回 null；命令解析回退到
   `missingBinaryMessage`，`classifyAgentEngineError` 把 `Missing Codex runtime files` 归为
   `non-retryable-prepare`，把 `opencode runtime crashed` 归为 `runtime-crash`。
5. 权限模式：`getAgentEnginePermissionModes("glm")` = native 模式集；codex 不含 build/edit/plan/yolo。
6. i18n：`engine.*` 与 `settings.engine.*` 键在 en-US 与 zh-CN 同时存在且数量一致。
7. `pnpm typecheck` 与 `pnpm lint` 0 新增错误；既有 exhaustive `Record<ACodeProvider,…>` 改 `Partial` 不破消费方。
