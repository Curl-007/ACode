# Spec：ConfigValidationIssue severity 维度 + 明文 http 端点持久诊断（安全加固 P2 #7 后续）

状态：已实现（provider 产生点/门控 + services/ui 接线同批交付）。本 spec 是
`packages/provider/specs/provider-http-endpoint-warning.md` §3「诚实声明」预留的后续步骤：
给 `ConfigValidationIssue` 增加 severity 维度（契约变更），再把明文 http Base URL 告警
下沉为沿既有 `ProviderSettingsView.issues` 通道流转的持久诊断。

## 背景

- `ConfigValidationIssue`（`packages/provider/src/config-overlay.ts`）是 provider 配置域的
  校验诊断契约，现有 9 个 code **全部是阻断语义**：resolver 里任何 issue 都会让 provider
  不可执行、模型不可选、整 provider 被逐出 registry（`resolver.ts` 的 `issues.length` 门控）。
- 明文 `http://` baseUrl 是「知情不禁止」的告警语义（产品决策见 http-warning spec），
  塞进现有契约会把 provider 踢出 registry——因此上一批只做了设置页内联警告，诊断层未接。
- 传输面已存在：resolver 的 issues 经 `createProviderSettingsView`（`facades.ts:634,658`）
  进 `ProviderSettingsView`，走 `provider-settings` RPC channel 到 renderer 全局快照
  （`useRootProviderSettingsSnapshot` → `providerSettingsSnapshot`）。**本变更零协议改动**。
- CLI worker 与桌面 host 跑同一个 resolver（`process-provider-registry-runtime.ts:74`），
  severity 语义一次改动两端一致。

## 契约变更（R1）

`ConfigValidationIssue` 增加**可选** `severity` 字段：

```ts
export type ConfigValidationSeverity = "error" | "warning";

export interface ConfigValidationIssue {
  readonly code: /* 既有 9 个 */ | "plaintext-http-endpoint";
  readonly path: readonly string[];
  readonly message: string;
  /** 缺省视为 error：全部既有产生点都是阻断语义，零改动、零行为变化。 */
  readonly severity?: ConfigValidationSeverity;
}
```

- 可选字段 + 缺省 error = **additive 契约**：所有既有产生点（schema-validation 翻译器、
  各 Overlay.validateComplete、resolver 手工 issue）不改一行即保持阻断语义。
- severity 词汇对齐 CLI 侧既有惯例（`apps/acode-cli/packages/adapters/src/config/schema.ts:312`
  的 `ConfigDiagnostic.severity: "warning" | "error"`）。两个类型属不同域（CLI config.json vs
  provider 配置），不做合并，只对齐词汇。
- 判定 helper 是**唯一门控谓词**（单一事实源，禁止各调用点手写 `.filter(i => i.severity...)`）：
  - `isBlockingConfigIssue(issue)`：`(issue.severity ?? "error") === "error"`。
  - `hasBlockingConfigIssues(issues)`：`issues.some(isBlockingConfigIssue)`。
  - 两者随 `config-overlay.ts` 经 `@acode/provider` 根导出公开。
- 新 code `plaintext-http-endpoint`：明文 http 端点告警，severity 恒为 `"warning"`。

## 行为规则

### R2 产生点（唯一）

`ProviderApiConfig.validateComplete`（`packages/provider/src/config/provider-config.ts`）在
zod 校验结果之后追加：`isPlaintextHttpBaseUrl(this.baseUrl)` 为 true 时产出一条
`{ code: "plaintext-http-endpoint", path: [...path, "baseUrl"], severity: "warning", message }`。

- 判定函数复用 `provider-endpoint-security.ts` 的既有单一事实源（http-warning spec R1）。
- 与 zod 错误可共存（baseUrl 非法 URL 时 zod 产出 invalid-url error，判定函数对非法 URL
  返回 false，不会双报）。
- 继承/合并后的有效配置走同一 validateComplete（resolver 对 effective config 调用），
  因此内置模板继承来的 http 值同样产出 warning。

### R3 门控全部改为 blocking-aware（错误语义逐字保持）

| 门控点 | 现状 | 改为 |
|---|---|---|
| `resolver.ts` `createRegistryProviderConfig` / `createRegistryModelConfig` | `issues.length > 0 → ok:false` | `hasBlockingConfigIssues → ok:false`；**ok:true 变体携带 issues（warnings）**，否则 warning 在 ok 分支被丢弃 |
| `resolver.ts` providerExecutable | `providerIssues.length === 0` | `!hasBlockingConfigIssues(providerIssues)` |
| `resolver.ts` model executable/selectable | `modelIssues.length === 0` | `!hasBlockingConfigIssues(modelIssues)` |
| `resolver.ts` registry 准入 | `!ok \|\| providerIssues.length > 0 → 跳过` | `!ok → 跳过`（ok 已含 blocking 判定；warning 不再逐出 registry） |
| `providerFacadeServices.ts` 连通性测试门 | `model.issues.length > 0` | `hasBlockingConfigIssues(model.issues)` |
| ui `useModelConfigResolution.ts` | `resolution.issues.length === 0` | `!hasBlockingConfigIssues(resolution.issues)` |

- `RegistryConfigResult` 的 ok:true 变体新增 `issues` 字段是 **additive**：既有
  `result.ok ? … : result.issues` 消费方不受影响。
- 不变量：**error issue 的所有既有后果逐字保持**（不可执行、不可选、逐出 registry、
  ok:false）；warning issue 只随 `ProviderConfigResolution.issues` / View 流转，不影响任何准入。
- resolver 内 model/provider issues 的汇总（`issues.push(...)`）保留 warnings，使
  `resolution.issues` 成为完整诊断面（View 的数据源）。

### R4 UI 展示

- **编辑态内联草稿警告不变**（盯未保存草稿值，诊断只覆盖已保存配置，两者互补不重复）。
- **只读继承态警告改为诊断驱动**：由 `provider.issues` 中 code=`plaintext-http-endpoint`
  驱动（替换现在直接 `isPlaintextHttpBaseUrl(继承值)` 的判定），testid
  `model-provider-base-url-http-warning` 与样式不变。诊断即单一事实源；resolver 对
  effective config 校验，继承 http 的覆盖面与原判定等价。
- **渲染按 severity 分色**：模型级 issue 展示点（`ProviderCardSections.tsx` 的
  `model.issues?.[0]`）只把 blocking issue 渲染成 `text-destructive`；warning 渲染成
  `text-warning`。展示文案按 `issue.code` 映射 i18n key（`plaintext-http-endpoint` →
  既有 `settings.modelProvider.baseUrlPlaintextHttpWarning`），未知 code 回退 issue.message。
- provider 级 issues 的表单投影已存在（`providerSettingsFormProjection.ts` /
  `providerSettingsFormTypes.ts`），如未接到组件 props 则补线程化，不新建投影。

### R5 message 语言边界

`ConfigValidationIssue.message` 维持现状（硬编码中文，供日志与未知 code 回退）；
UI 对已知 code 一律走 i18n 映射，不直接渲染 message（避免双语界面出现单语诊断）。

## 验收场景

1. `https://` baseUrl：无任何新 issue，全部既有行为逐字不变（回归守护）。
2. `http://` baseUrl（已保存）：resolver 产出 1 条 warning；provider 仍可执行、模型仍可选、
   registry 仍准入；`resolution.issues` 与 View 含该 warning；设置页只读态显示既有样式警告。
3. `http://` baseUrl + 缺必填字段（error）：error 后果不变（不可执行、逐出 registry），
   warning 共存于 issues。
4. 非法 URL baseUrl：zod invalid-url error 照旧；判定函数返回 false，不双报 warning。
5. 编辑态输入 `http://` 草稿：内联草稿警告即时出现（不依赖保存/诊断回流）。
6. CLI worker 与桌面 host 对同一份含 http provider 的配置给出一致的 registry 准入
  （同一 resolver，warning 两端都不阻断）。

## 测试计划

- `packages/provider/test/config-validation-severity.test.ts`：契约 helper 真值表（缺省
  severity=blocking）、产生点（http→warning、https→无、非法 URL→仅 error）、
  createRegistry* 的 ok/issues 形状、resolver 端到端（warning-only 可执行+准入、
  error 逐出不变、混合场景）。fixture 惯例参照 `packages/provider-node/tests/`
  （`new ProviderApiConfig({...})`、`ModelConfig.fromData`）。
- `packages/ui/test/providerIssueWarnings.test.ts`：code→i18n key 映射与 severity 分流
  的纯函数层。
- 既有回归：`packages/provider/test/provider-endpoint-security.test.ts`、
  `packages/provider-node/tests/byo-apikey-credential-ref.test.mjs`（registry 准入路径）。

## 非目标

- 不改 CLI 域 `ConfigDiagnostic`（已有 severity，消费终点是日志，两域不合并）。
- 不新建协议消息/RPC（复用 ProviderSettingsView.issues 既有通道）。
- 不把 http 升级为阻断（产品决策「知情不禁止」不变）。
- 不动 `#reportRecovery` 恢复事件链路（形状 `{error}`，与本诊断面无关）。
