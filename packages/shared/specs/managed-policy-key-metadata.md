# Managed Policy 每键元数据三字段试点（shared）

价值提取第二轮台账 T2-s5② 先行件（R2:1187-1213；第三轮台账
`zoode/claude-r3-reports/01-ledger-baseline.md` §2-12）：把企业配置「每键元数据
schema」中的 **redact / support.scopes / predicates.warn** 三字段，试点挂到
managedPolicy 现有权限地板 5 键上。每键元数据是未来同意 UI、支持包脱敏与管理员
警告文案的单一来源；本试点**只挂元数据**，不改任何消费判定。

Claude 侧原文对照（只读复核，详见 WI-5 报告复核表）：每键元数据完整 schema 为
flatKey/readers/support:{scopes,availableInVersion,executionTarget}/remotePolicy/
failClosedValue/redact/pathKind/egressRequirements/predicates.warn/i18n title+
description/category/order（R2:1195-1199）；台账点名先行试点其中三字段
（R2:1212-1213）。实测源码 `index.pre.js:23226-23410,:26069-26128`：redact 挂值
schema（"hash"/"keep"/"presence"/"drop"/"hostname" 五值），predicates.warn 为
`(value) => 警告文案 | null` 的纯值谓词（如 disableEssentialTelemetry===true 时
提示支持周转变慢）。

## 与相邻 spec 的关系

- `apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md` R1：
  CLI floor 映射与 fail-closed 决策——消费方，本试点不改。
- `packages/services/specs/bot-permission-local-approval.md` R3：host bot 本机
  确认门槛——消费方，本试点不改。
- `packages/shared/specs/log-privacy-redaction.md`：脱敏**机制**（词表/管线/占位符）
  保持单源于该 spec；本 spec 的 redact 是**每键声明**（这个键的值允许以什么形态
  出现），不复制机制、不新增第二套词表。
- `packages/shared/src/acode-protocol-v4/permission-rule-where.ts`：规则**来源**
  维度（一条权限规则来自哪层，managedPolicy 源标记 readonly）；本 spec 是**每键
  schema** 维度（键本身如何脱敏/谁消费/何值需警告）。两者互补不重叠。

## 产品规则

- R1 键名闭集单源：元数据注册表键集 = `keyof ManagedPolicyFileData`（当前 5 键：
  deny/ask/disallowedTools/disableBypassPermissionsMode/requireLocalPermissionApproval）。
  注册表类型为全覆盖映射 `{ readonly [K in ManagedPolicyKey]: ManagedPolicyKeyMetadata<K> }`
  ——新增策略键必须同时补齐该键元数据，否则 typecheck 不过。**每键元数据完整性由
  类型门禁保证，不靠人肉记忆**；映射的 K 参数同时给 predicates.warn 提供该键的
  强类型入参，防散落手写字面量。
- R2 三字段定义（台账原始口径，ACode 命名适配）：
  - `redact: "hash" | "keep"`（台账 R2:1212 两值口径；Claude 实现另有
    presence/drop/hostname，试点不预支）。"hash" = 值可能含内部工具名/命令片段，
    日志与支持包只允许 sha256 指纹形态；"keep" = 值本身可原样出现。**声明而非
    执行**：执行者是 log-privacy-redaction 机制与未来支持包分节，本模块不做脱敏。
  - `support.scopes: readonly ManagedPolicyConsumerScope[]`：消费面闭集
    `"cli-permission-floor" | "host-bot-permission"`，声明该键在哪些消费面生效。
    事实依据（现状文档化，非新规则）：前 4 键由 CLI floor 消费（adapters
    `managed-policy.ts`）；requireLocalPermissionApproval 仅由 host botsService
    消费（CLI 接受但忽略、不进 floor）。新增消费面须先扩闭集再改注册表。
  - `predicates.warn: (value, policy) => string | undefined`：值谓词纯函数，
    解析值落入「部署了但无任何收紧效果」时返回管理员面向的警告文案，否则
    undefined。警告文案**只复述既有 hasContent 语义**（空数组/显式 false 等同
    未部署；managed 层只能收紧、不能放宽——见 managedPolicy.ts loadManagedPolicyFile
    的判空与 `=== true` 归一），不发明新产品规则。无副作用；**不参与任何
    权限/floor/同意判定**，消费方是否展示由消费方决定（试点期无消费方）。
- R3 每键元数据表（当前 5 键；值依据见注）：

  | 键 | redact | support.scopes | predicates.warn |
  |---|---|---|---|
  | permissions.deny | hash | cli-permission-floor | 空数组 → 无收紧效果警告 |
  | permissions.ask | hash | cli-permission-floor | 空数组 → 无收紧效果警告 |
  | permissions.disallowedTools | hash | cli-permission-floor | 空数组 → 无收紧效果警告 |
  | permissions.disableBypassPermissionsMode | keep | cli-permission-floor | 显式 false → 无放宽效果警告 |
  | permissions.requireLocalPermissionApproval | keep | host-bot-permission | 显式 false → 无放宽效果警告 |

  hash 依据：规则/工具名可能含内部工具名（CLI 诊断纪律「不回显文件内容」，
  adapters managed-policy.ts:95）；keep 依据：布尔值无敏感内容。
- R4 不变量：
  - 注册表对象、每条元数据、scopes 数组全部 `Object.freeze`——构建期静态事实，
    非运行时可变状态；无所有者、无写入路径。
  - 访问器 `getManagedPolicyKeyMetadata(key)` 对闭集外键返回 undefined（不抛、
    不回落默认值），与 missing 态同一克制形态；类型签名只接受 ManagedPolicyKey，
    运行时 undefined 分支仅对无类型调用方可达（含 `__proto__`/`constructor`
    原型链键，用 hasOwn 判定）。
  - warn 入参为解析成功后的 policy 数据（wire 形态）；求值时机由调用方决定，
    `loadManagedPolicyFile` 全程不调用 warn——加载行为与试点前逐字节一致。
- R5 消费方兼容边界（试点范围裁剪）：
  - **不**新增策略键；**不**做 GPO 三源分层/MDM plist/注册表批量读（企业版 L 级
    全层，REG §9.8 登记）；**不**做 local(configLibrary)/remote(served) 层。
  - `loadManagedPolicyFile`/`resolveManagedPolicyFilePath` 的签名、返回形态与
    missing/invalid/empty/ok 判别语义不变；policy wire 形态不变——元数据**不混入**
    policy 对象（它是模块级静态注册表，不是文件数据），`Pick<ManagedPolicyFileLoadResult,
    "status" | "policy">` 的既有消费方（services botPermissionLocalApproval）与
    CLI floor 映射零改动、零行为变化。
  - 新增导出（`MANAGED_POLICY_KEY_METADATA`/`getManagedPolicyKeyMetadata` 及配套
    类型）先落在 `src/node/managedPolicy.ts` 模块内；`src/node.ts` 桶文件补导出
    属跨域改动，另行评审执行——试点期无跨包消费方，不需要桶导出即可自洽。
- R6 试点不含（防止半套 schema 预支企业版设计空间）：i18n title/description、
  category/order、readers、remotePolicy（requiresUserConsent 等）、failClosedValue、
  egressRequirements、pathKind、availableInVersion/executionTarget。警告文案暂为
  英文硬编码（与 CLI ConfigDiagnostic 管理员诊断语言一致），出现真实消费面时
  再进 i18n 体系。

## 验收场景

1. 注册表完整性：以 status=ok 实际加载出的 policy 对象键集与注册表键集**双向**
   对账一致；每键三字段齐备；redact ∈ 闭集；scopes 非空且 ⊆ 闭集。
2. 类型约束：`ManagedPolicyFileData` 新增第 6 键而未补元数据时 typecheck 报错
   （全覆盖映射）；redact/scopes 写闭集外字面量即报错。由 tsc 保证，运行时
   测试不重复校验类型本身。
3. warn 语义：列表键空数组 → 非空警告且文案含键路径；非空 → undefined。布尔键
   false → 警告；true → undefined。纯函数：对冻结入参求值不抛、重复求值结果一致。
4. 访问器边界：闭集键返回注册表同引用；未知键/原型链键返回 undefined。
5. 回归：`tests/managed-policy.test.mjs` 既有用例全绿（判别式、strict 拒绝、
   路径解析、打包态门禁）；load 结果与 policy 对象的键集不因试点改变。
6. 下游兼容：@acode/services（managedPolicy 消费方）typecheck 通过。
