# Spec：Provider Base URL 明文 http 端点告警（安全加固 P2 #7）

## 背景与威胁

- 自定义 Provider 的 `baseUrl` 允许 `http:`（`packages/provider/src/config/provider-data-schema.ts`
  只校验 URL 形态，不限制协议），设置表单（`ProviderDraftSave.ts`、`ProviderCardSections.tsx`）
  原样保存且无任何提示。API Key 与完整对话内容会以明文经过链路中间节点（企业网关、
  恶意 Wi-Fi、ARP/代理劫持），属于凭据与隐私泄露面。
- 威胁模型：用户在设置页把第三方/自建端点误填为 `http://`；或继承的内置模板曾含 http。
  攻击者不接触本机，只处在网络路径上即可窃取 API Key。

## 需求（plan 原文）

> 7. **http 明文端点告警**（`packages/provider/src/config/provider-data-schema.ts:67,74` +
>    `ProviderDraftSave.ts:14-31`）：自定义 Provider baseUrl 接受 `http:` 且无告警，
>    API Key 明文传输。加「非 https 显式警告」。

## 行为规则

1. **判定**：`isPlaintextHttpBaseUrl(value)`（`packages/provider/src/config/provider-endpoint-security.ts`）
   当且仅当 `value` 可被 `new URL` 解析且 `protocol === "http:"` 时为 true。
   - 空串 / 非法 URL 返回 false：非法 URL 的错误已由 `completeProviderApiDataSchema`
     的 url 校验负责，判定函数不重复分类，也不把「输入中的草稿」误报为安全问题。
   - 该函数是 UI 与未来诊断层的唯一判定事实源；协议名大小写由 URL 规范归一。
2. **UI 内联警告（非阻断）**：`ProviderConnectionSection`（`packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`）
   在 Base URL 字段下方渲染警告行：
   - 编辑态盯**草稿值**（用户边输入边看到）；只读继承态盯**继承值**（只读不等于安全）。
   - 复用既有警告语义：`text-warning` 色 + `AlertTriangleIcon`（同 `BrowserOAuthLoginButton`、
     `StatusCards` 的既有模式），data-testid `model-provider-base-url-http-warning`。
   - 警告不阻断保存：http 是少数内网/离线场景的合法选择，产品决策是「知情」而非「禁止」。
   - i18n 双语文案（`settings.modelProvider.baseUrlPlaintextHttpWarning`）。
3. **数据/诊断层边界（诚实声明）**：provider 配置链路已有 `ConfigValidationIssue`
   （`config-overlay.ts`）与 `validateComplete()` 准入校验，但其 code 联合类型
   **只有阻断语义**（required-field-missing / invalid-url / invalid-config…），没有
   warning 严重度；且 issue 的产生与消费分布在 `packages/provider/src/resolver.ts` 与
   `packages/services` 的 provider-settings 链路——超出本次变更的文件所有权
   （provider/src/config/** + ui 的 model-provider-section）。
   因此本次**只做 UI 警告 + 本判定函数**，不发明新的诊断管线。后续若要把告警下沉为
   持久化诊断，应先给 `ConfigValidationIssue` 增加 severity 维度（breaking 契约变更，
   需独立 spec），而不是在 config 层塞入一次性 side-channel。

## 兼容性

- 不改变 schema 行为：`http:` baseUrl 仍然合法可保存（禁止保存会破坏内网端点等合法场景，
  且属行为变更，需产品另行决策）。
- 不影响 P1-5 的 apiKey vault 化链路（`hasProviderFormStoredApiKey`、`ApiKeyInput.storedInVault`）。

## 验收

- `isPlaintextHttpBaseUrl`：`http://` → true（含大写协议、带路径、带端口）；
  `https://`、空串、非 URL 字符串、null/undefined → false。
- UI：草稿值切到 `http://` 时警告行出现，切回 `https://` 时消失；只读态继承 http 时同样出现。
- 双语 locale 各含 `settings.modelProvider.baseUrlPlaintextHttpWarning`。
- 测试：`packages/provider/test/provider-endpoint-security.test.ts`（纯判定函数层）。
  UI 渲染层无既有组件测试基建（`packages/ui/test` 无 React 渲染测试），本次以
  typecheck + 判定函数测试覆盖，渲染逻辑靠 code review 与手工验证。
