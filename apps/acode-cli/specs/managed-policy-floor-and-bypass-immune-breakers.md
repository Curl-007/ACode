# 托管策略地板 + 旁路免疫熔断器（P2 骨架）

安全加固 P2 骨架项。给 ACode 的权限决策补两层此前完全缺失的机制：

1. **托管策略地板（managed policy floor, strictest-wins）**：管理员可下发一份只能收紧、
   不能放宽的策略，任何用户/项目/CLI 配置都无法放松它。
2. **旁路免疫熔断器（bypass-immune circuit breakers）**：一组内置的危险动作检查，
   **即使 yolo/bypass 也强制弹窗**——把「yolo = 无条件放行」改成「yolo = 放行除熔断器外的一切」。

P1-6 的项目 restrictive floor 是本骨架的特例（见 `project-permission-restrictive-floor.md`
末段）；本骨架落地后，项目层、用户层、策略层共用同一套「只能收紧」的表达。

## 背景

`core/src/permission/service.ts` 的 `checkPermission` 在 yolo 模式下**第一步就 allow**
（`mode === "yolo" && !planEnabled → allow`），且先于 `disallowedTools` 硬禁用检查——
即当前 yolo 下连用户自己禁用的工具也会被放行。没有任何机制能在 yolo 直通之前插入
不可绕过的检查，也没有任何配置层能表达「无论用户怎么配都不能放松」的基线。

## 产品规则

### R1 托管策略地板

- **来源**：OS 托管路径的单一 JSON 文件（管理员权限才能写入，普通用户/项目不可达）：
  - Windows: `C:\ProgramData\ACode\managed-settings.json`
  - macOS: `/Library/Application Support/ACode/managed-settings.json`
  - Linux: `/etc/acode/managed-settings.json`
  - 测试/开发可用 `ACODE_MANAGED_POLICY_FILE` 覆盖路径（打包态忽略该 env，与 P1-7
    更新源门禁同一哲学：打包版不吃 env 注入）。
- **只能表达收紧**：schema 只接受 `permissions.deny` / `permissions.ask`（规则数组）、
  `permissions.disallowedTools`（字符串数组）、`permissions.disableBypassPermissionsMode`
  （布尔）。**出现 `allow` 类字段或未知键 → 解析拒绝**（strict schema），防止策略文件
  被误用成放宽通道。
- **`permissions.requireLocalPermissionApproval`（布尔，可选）**：schema 接受该键但 CLI
  权限判定**忽略**它（不进 floor 数据、不影响 deny/ask/yolo 语义）。它的语义由 host
  botsService 消费——强制 bot 任务权限只能在桌面本机确认（见
  `packages/services/specs/bot-permission-local-approval.md` R2）。**必须让 CLI 严格 schema
  接受该键**，否则管理员一部署它，CLI 就会因未知键把整份策略降级成 MINIMAL_LOCKDOWN、
  丢掉 deny 规则。canonical schema 已单一来源化到 `packages/shared/src/node/managedPolicy.ts`
  （见该 spec R3），CLI 加载器是其薄包装。
- **strictest-wins**：策略层参与合并时只并集、不替换——`disallowedTools` 与用户/项目层
  取并集；deny/ask 规则作为独立规则集参与判定，压过所有放行分支。任何低层配置
  （System<User<Project<Session<Env<Cli）都不能移除或弱化策略条目。
- **disableBypassPermissionsMode=true** 时：yolo 直通失效，yolo 会话按 build 模式判定
  （副作用动作 ask）；显式请求切换 yolo 被拒（见 R4）。
- **解析失败 fail-closed 降级**：文件存在但解析失败 → 发 `config_managed_policy_invalid`
  诊断（error），并按最小封锁 `{ disableBypassPermissionsMode: true }` 生效（不附加
  deny/ask 规则）。理由：静默忽略一份管理员明确部署过的策略文件比误锁更危险；
  但不因一个 typo 把整机 deny-all。
- **文件不存在**：零行为变化（回归守护：无策略文件的安装与改动前完全一致）。

### R2 旁路免疫熔断器

- 熔断器是**内置不变量**，不依赖任何配置（策略地板可以额外收紧，但不能放松熔断器）。
- 判定位置：`checkPermission` 内、**yolo 直通之前**、策略 deny/ask 之后。命中即返回
  ask（`ruleId = breaker.<class>`），**不**返回 deny——保留用户「我知道我在做什么」的
  最终决定权，与既有 ask 语义一致。
- 熔断器**只降级 allow**：已是 deny 的保持 deny；已是 ask 的保持原 ruleId（不覆写，
  避免丢失原始原因）；plan 模式的 deny 也不受影响。
- 骨架实现三类（第四类「跨机隔离」留作扩展点，见「不在本骨架范围」）：

| 类 | ruleId | 触发条件 |
|---|---|---|
| 空变量根删除 | `breaker.bashRootDelete` | Bash 命令经 `analyzeBashCommand` AST 解析后，存在删除类命令（`rm`/`rmdir`/`del`/`Remove-Item`）携带递归/强制旗标，且其路径参数满足任一：① 含未解析展开（ParameterExpansion/SimpleExpansion/CommandExpansion，即 `rm -rf "$DIR"` 形态——变量为空时等价于删根）；② 解析后等于文件系统根或用户 home；③ 参数为空字符串 |
| 路径逃逸写 | `breaker.pathEscapeWrite` | Write/Edit/ApplyPatch 的目标路径（经 `resolveWorkspacePath` 以 workingDirectory 解析）落在 workspaceRoot 之外（workspaceRoot 已知时）。**ask 而非 deny**：与 `path-policy.ts:36-38` 的既有产品决定一致（子代理可能需要查看用户指定的兄弟仓库），但 yolo 下不再静默放行 |
| 敏感位置读 | `breaker.sensitiveRead` | Read/Glob/Grep/Bash 的目标命中**封闭清单**的凭据位置模式（ssh 私钥、系统/用户凭据库、浏览器 profile、云 CLI 凭据目录）。清单是代码内常量，不接受配置扩展（扩展走策略地板的 deny/ask） |

- Bash 解析失败/超长（`hasParseErrors`）时，删除类命令按「含未解析展开」同等对待
  （fail-closed 到 ask）；非删除类命令不受影响。

### R3 判定优先级（决策顺序即安全边界）

```
checkPermission(context, capability, projectRules, rulePolicy)
  │
  ├─ 0. policyFloor.deny 命中            → deny   （绝对最高，压过一切分支）
  ├─ 1. policyFloor.ask 命中             → ask    （压过 yolo / plan-readonly / allow）
  ├─ 2. disallowedTools（含策略并集）     → deny
  ├─ 3. plan-mode transition（既有）
  ├─ 4. requiresUserInteraction（既有）
  ├─ 5. alwaysAsk（既有，含 session/workflow-owner 免确认）
  ├─ 6. bypass-immune breakers 命中      → ask    （在 yolo 直通之前；只降级 allow）
  ├─ 7. yolo fast-path（policyFloor.disableBypassPermissionsMode=true 时跳过，
  │        落入 build 判定）
  └─ 8. auto / project rules / plan / allowedTools / edit / build（既有顺序不变）
```

状态所有者：策略地板的**唯一读取点**是 `adapters/src/config/managed-policy.ts`（新模块），
由 `createConfig` 在 System 之前读入、以 `ConfigScope.Policy`（priority 60，高于 Cli 50）
参与合并；合并后进入 `RuntimeConfig.permission.policy`，由 `create-app.ts` 构造
`PermissionService` 时注入 `PermissionConfig.policyFloor`。熔断器的**唯一判定点**是
`core/src/permission/bypass-immune-breakers.ts`（新模块，纯函数），由 `PermissionService`
在第 6 步调用——不在 permission-flow 做 post-decision override，保证两个调用方
（executor 与 input-recheck）自动同语义。

### R4 模式切换边界

`disableBypassPermissionsMode=true` 时，显式请求 yolo/bypassPermissions 被拒
（复用 P0-3 的 `modeRemoteForbidden` 同款拒绝语义，本地来源回 `modePolicyForbidden`）。
决策层（R3 第 7 步）的跳过是安全底线；模式切换拒绝是 UX 一致性，两者都必须有。

## 接口

- `adapters/src/config/managed-policy.ts`：
  `loadManagedPolicyFloor(options?: { filePath?: string; env?: Record<string,string|undefined>; isPackaged?: boolean }): { floor: ManagedPolicyFloor | undefined; diagnostics: ConfigDiagnostic[] }`
- `contracts/src/config`：`ConfigScope.Policy = "policy"`（priority 60）；
  `RuntimeConfig.permission.policy?: ManagedPolicyFloorData`（deny/ask/disallowedTools/
  disableBypassPermissionsMode 的 wire 形态）。
- `core/src/permission/service.ts`：`PermissionConfig.policyFloor?: ManagedPolicyFloor`；
  `PermissionContext.workspaceRoot?: string`（熔断器路径判定用，缺省时路径类熔断器不触发，
  与既有「拿不到工作目录照常判定」同一容错哲学）。
- `core/src/permission/bypass-immune-breakers.ts`：
  `evaluateBypassImmuneBreakers(context, capability): { ruleId: string; reason: string } | undefined`

## 验收场景

见 `apps/acode-cli/tests/managed-policy-floor.test.mjs` 与
`apps/acode-cli/tests/bypass-immune-breakers.test.mjs`（mkdtemp fixture，不触碰真实
工作区/托管路径）：

**策略地板**
1. 无策略文件 → 行为与改动前逐项一致（yolo 仍直通、build 仍按既有判定）。
2. 策略 deny 规则压过 yolo、session allow、project allow、allowedTools。
3. 策略 ask 规则在 yolo 下仍 ask。
4. `disableBypassPermissionsMode=true` → yolo 会话的副作用动作 ask（不再直通）；
   显式请求 yolo 被拒（modePolicyForbidden）。
5. 策略含 `allow` 字段或未知键 → 解析拒绝 + 诊断；解析失败 → 最小封锁生效。
6. `disallowedTools` 策略∪用户∪项目三层并集，任何一层都不能清空其它层。
7. 打包态忽略 `ACODE_MANAGED_POLICY_FILE` env（isPackaged=true 时只读 OS 托管路径）。

**熔断器**
8. yolo 下 `rm -rf "$UNSET_VAR"` / `rm -rf /` / `rm -rf ~` → ask（breaker.bashRootDelete）；
   `rm -rf ./build` → 不触发（既有 yolo 直通）。
9. yolo 下 Write 到 workspaceRoot 之外 → ask（breaker.pathEscapeWrite）；workspace 内 → 不触发。
10. yolo 下 Read `~/.ssh/id_rsa` → ask（breaker.sensitiveRead）；workspace 内文件 → 不触发。
11. 熔断器不覆写已有 deny / ask 的 ruleId；alwaysAsk 工具照常走 alwaysAsk。
12. Bash 解析失败时删除类命令 fail-closed 到 ask；非删除类不受影响。

## 不在本骨架范围

- **跨机隔离熔断器**：远程/手机 attachment 场景的「动作落在错误主机」检查需要与
  owner/lease 路由（AGENTS.md「进程、协议与远程控制」）联合设计，留作扩展点
  （`evaluateBypassImmuneBreakers` 的检查列表可追加）。
- **策略地板的分发/更新通道**（MDM、远程策略服务）：本骨架只定义本地托管文件形态。
- **auto 模式 LLM 分类器**：P3 backlog，与本骨架正交（auto 目前仍是 unimplemented deny）。
- 桌面 Settings UI 的策略展示（只读视图）：后续 UX 项。
