# LSP 诊断回流编辑闭环（T1#1 · omp 价值提取波1）

来源：omp v18.12.1（MIT）`packages/coding-agent/src/lsp/**`。本 spec 固化移植后的
产品规则、状态所有者、接口与验收场景；移植文件头部保留
`// Ported from oh-my-pi (MIT) — <原路径>, Copyright (c) 2025 Mario Zechner & Stencil Labs`。

## 0. 目标分层

- **P0 进程内 TS 诊断闭环**：Edit/Write 落盘 `.ts`/`.tsx` 后运行进程内 TypeScript
  语义诊断，新增诊断附进工具结果的模型可见内容（model content），不重复刷历史诊断。
- **P1 通用 LSP 客户端 + lsp 工具**：Content-Length JSON-RPC stdio 客户端 + 13 action
  工具面 + writethrough（didChange 推送/按版本等诊断/format-on-write）。
- **P2 auto-repair 不做**（另行立项）。

## 1. 状态所有者（单一所有者）

| 状态 | 所有者 | 备注 |
| --- | --- | --- |
| 语言服务器进程/连接 | `core/src/lsp/client.ts` 模块级 `clients` Map（key=配置身份键） | 进程生命周期唯一所有者 |
| 初始化失败负缓存 | `client.ts` `initFailures`（key=身份键，3 分钟退避） | 显式 reload/lsp reload 才清除 |
| 打开文档 overlay | `LspClient.openFiles`（uri→version+syncedHash） | 磁盘为准做 reconcile |
| 每文件已见诊断集合 | `diagnostics-ledger.ts` `DiagnosticsLedger`（按文件身份去位置去重） | 会话级，由 hook 模块持有 |
| 迟到诊断队列 | `deferred-diagnostics.ts` `DeferredDiagnosticsQueue` | 注入运行时轮次（见 §6） |
| 进程内 TS Program 缓存 | `ts-diagnostics.ts` `TsProgramCache`（key=tsconfig 路径或文件根） | oldProgram 增量复用 |
| 文件落盘后挂起诊断 | `edit-diagnostics-hook.ts` pending map + deferred 队列 | edit/write handler 消费 |

禁止第二写入路径：任何模块不得绕过 `client.ts` 直接 spawn 语言服务器或改写
`openFiles`/`diagnostics` 缓存。

## 2. P0 进程内 TS 诊断

- 触发：Edit/Write handler 成功落盘扩展名 `.ts`/`.tsx` 的文件后同步执行（P1 LSP
  服务器未就绪时 P0 是唯一回流路径）。
- 编译面：`ts.createProgram`（库内先例
  `apps/acode-cli/packages/dynamic-workflow/src/compiler/compile.ts:99,117`）。
  Program 缓存按 tsconfig（向上查 `tsconfig.json`，无则按文件根目录）持有，后续
  调用传 `oldProgram` 增量复用；只对目标文件取 syntactic+semantic 诊断，不做全工程。
- 诊断身份：`diagnosticIdentity` 去掉 `path:line:col ` 位置前缀后的消息文本。
  ledger 只保留「本轮新增」——与上一轮身份集合的差集；身份集合为空时删除该文件条目。
- 输出：`FileDiagnosticsResult`（server="typescript(in-process)"、messages、summary、
  errored），格式化行 `relPath:line:col [severity] message (code)`。
- 上限：单次最多 50 条；超限截断并在 summary 注明。

## 3. P1 LSP 客户端生命周期

1. **配置**：内置 defaults（typescript-language-server、typescript-native（tsc
   --lsp，二选一按 tsc 安装形态）、eslint、pyright、gopls、rust-analyzer）。项目
   `lsp.json`/`.acode/lsp.json` 覆盖合并；rootMarkers 命中 + 命令可解析（项目本地
   bin 优先：`node_modules/.bin`、Python venv bin/Scripts、Windows 可执行后缀）才启用。
   TS 服务器二选一：`tsc` 属 TS7（无 lib/tsserver.js）→ native，否则 typescript-language-server。
2. **惰性 spawn**：首次请求（工具调用或 writethrough）才 `child_process.spawn`。
3. **身份键**：`resolvedCommand:cwd:JSON(args+initOptions+settings+languageId)`；
   配置变更后旧身份客户端由 `shutdownStaleClients` 确认停掉，防止陈旧进程常驻。
4. **负缓存**：确定性 initialize 失败（非调用方超时/取消）记 3 分钟退避；期间直接失败。
5. **空闲关停**：可配置 `idleTimeoutMs`（配置文件）；后台 checker 60s 扫描，
   pendingRequests 非空视为 busy 不回收；请求收尾刷新 lastActivity。
6. **握手**：initialize（CLIENT_CAPABILITIES）→ initialized → didChangeConfiguration；
   服务端请求（workspace/configuration、workspaceFolders、applyEdit、
   registerCapability、progress、showMessage/Document、各 refresh）按 spec 应答。
7. **关停**：shutdown→exit 握手 + 超时强杀；进程退出拒绝全部 pending 请求。

## 4. lsp 工具（13 action）

`diagnostics/definition/references/hover/symbols/rename/code_actions/
type_definition/implementation/status/reload/capabilities/request`。
（rename_file 可选项未纳入本波，见 §8 已知限制。）

- **审批分级**：`LSP_READONLY_ACTIONS`（diagnostics/definition/type_definition/
  implementation/references/hover/symbols/status/capabilities）按输入动态判只读
  （`resolvePermissionCapability` → readOnly+免审批）；rename/code_actions(apply)、
  reload、request 走写入审批（entry 静态 needsApproval）。
- **超时**：`timeout` 入参秒（5–300，默认 30）；工具内合成 `AbortSignal.timeout`，
  与调用方 signal 合流。项目感知服务器（非 linter）做 `waitForProjectLoaded`。
- **references/rename/definition 无 symbol**：项目感知服务器必须显式 `symbol`
  （`name` 或 `name#N` 第 N 次出现），不静默回退行首列。
- **diagnostics**：单文件或 glob（≤20 目标截断提示）；逐适用服务器 refreshFile→
  waitForDiagnostics，按 range+message 去重、按严重度排序输出。
- **rename/code_actions apply**：WorkspaceEdit 全量校验（重叠拒绝、snippet 拒绝）
  后落盘；applyEdit 成功后 reconcile 受影响 overlay + watched-files 通知。
- **reload**：单服务器 reloadServer（didChangeConfiguration 回推设置；写不进去就
  teardown 重启）；`*` 重读配置 + `shutdownStaleClients`。
- **request**：原始方法逃生口，`payload` JSON 或按 file/line/symbol 自动构造位置参数。

## 5. Writethrough（edit/write → LSP）

1. 落盘成功后：对适用服务器 `captureDiagnosticVersions`（写前版本基线）→
   `syncFileContent`（didOpen/didChange）→（format-on-write 时）textDocument/formatting
   按 `isLinter` 优先选格式化服务器 → `notifyFileSaved` → `getDiagnosticsForFile`
   按 `minVersions`/`expectedDocumentVersions` 拒收陈旧诊断。
2. 内联等待 500ms；超时转 deferred 通道（内层预算 max(12s, lsp.requestTimeout)），
   不阻塞 edit/write 返回。
3. 管线硬上限 = 等待预算 + 10s grace：慢服务器本轮跳过，不悬挂编辑。
4. 格式化选项：内容嗅探缩进（首缩进行定 tabs/spaces，GCD 定步长）+ 2 空格回退；
   trim 尾随空白/补末换行为固定开。

## 6. Deferred diagnostics（迟到诊断注入）

- 工具结果已返回后才到达的诊断：`DeferredDiagnostics.begin(path)` 发放句柄；
  `finalize(undefined)` 挂起、`onDeferredDiagnostics(result)` 送达。
- 送达时按 ledger 去重（可配 `deduplicate`，默认开），空结果静默丢弃。
- 文件变更版本（mutation version）单调递增；注入时 `isStale()` 判定被更新的同文件
  变更超越则丢弃。
- **注入形态**：`<system-reminder>` 包裹的文本，进入 `DeferredDiagnosticsQueue`。
  本波落点：下一次 Edit/Write 工具结果模型内容尾随 `Deferred diagnostics` 块
  （owned-only 路径）；运行时轮次级注入（runtime turn loop 消费队列 →
  mid-conversation system reminder，复用 `system-reminder/source.ts` 的
  `diagnostics` source）为共享桶申请（见报告），接线后队列改为 runtime drain。
- 注入点在共享桶（runtime/helpers + ToolExecutionContext 端口），本波不改共享桶。

## 7. 验收场景

1. ledger 去重单测：同一诊断第二轮不重复；新增一条只报新增；全消失后条目删除。
2. deferred 注入单测：late 到达 → 进队列 → drain 产出 reminder 文本；同文件再变更
   → stale 丢弃；deduplicate 开启时空结果不入队。
3. 负缓存 + 空闲关停单测：确定性 init 失败后第二次调用立即失败；idleTimeout 到期
   `checkIdleClients` 关停；pending 请求期间不回收。
4. stub 语言服务器集成测试：stdio stub 实现 initialize/publishDiagnostics/definition，
   客户端覆盖 diagnostics+definition 两条链路。
5. edit .ts 产生新增诊断回流单测：写入含类型错误的 .ts → edit 工具模型内容含
   新诊断行；再次 edit（无新增）不重复。
6. 现有 edit/write 测试不回归（core 现无测试文件，回归面=core typecheck + 本波新增
   钩子在无 LSP/无 ts 场景零行为变化）。

## 8. 本波削减（显式登记）

- `rename_file` 未实现（omp workspace/willRenameFiles 多服务器编辑收集→整体回滚语义
  留待下一波；edits.ts 已具备 applyEditsThenRename 基建）。
- writethrough 批处理（omp batch 合并多文件写后统一 flush）未移植；单文件直通。
- workspace `*` 诊断（omp workspace-diagnostics）降级为明确不支持提示。
- lspmux/mux 共享服务器 broker 未移植（omp 也是可选优化路径）。
- format-options 的 .editorconfig 读取未移植，仅内容嗅探+回退。
- rust-analyzer workspace-ready 轮询保留为简单进度等待，无 analyzerStatus 轮询。
