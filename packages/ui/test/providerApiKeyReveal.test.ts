// 已存储模型 API Key 的用户可见性（安全加固 handoff §5.5「小眼睛按需 reveal」）的
// 源码契约钉桩：眼睛在 storedInVault 下不再 disabled、reveal 走 credentialService.load、
// 隐藏/provider 切换/卸载即清明文、展示值与草稿值分离、明文绝不进日志。
// 依据：docs/security-hardening-handoff.md §5.4/§5.5；ui 测试无 jsdom 先例
// （appearancePreferences.test.ts 头注），组件不真渲染，按源码文本层断言。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const ZH = "../src/i18n/locales/zh-CN.ts";
const EN = "../src/i18n/locales/en-US.ts";

const REVEAL_I18N_KEYS = [
  "settings.modelProvider.showApiKey",
  "settings.modelProvider.hideApiKey",
  "settings.modelProvider.apiKeyRevealFailure",
  "settings.modelProvider.apiKeyRevealMissing",
];

test("E1：reveal 相关 i18n 键 zh-CN 与 en-US 成对存在", () => {
  const zh = readSource(ZH);
  const en = readSource(EN);
  for (const key of REVEAL_I18N_KEYS) {
    assert.ok(zh.includes(`"${key}"`), `${key} 缺 zh-CN`);
    assert.ok(en.includes(`"${key}"`), `${key} 缺 en-US`);
  }
});

test("ApiKeyInput：眼睛不再因 readOnly 禁用；visible 即 text；aria-label 双语键", () => {
  const input = readSource("../src/settings/model-provider-section/ApiKeyInput.tsx");
  // 旧实现 disabled={readOnly} 让已存 vault 的 Key 在只读卡片永远看不了
  // （安全加固 5.5：只读 = 不可改，不等于不可看）。
  assert.ok(!input.includes("disabled={readOnly}"), "眼睛按钮不得因 readOnly 禁用");
  assert.match(
    input,
    /type=\{visible \? "text" : "password"\}/,
    "visible 即明文形态（readOnly 展示 reveal 明文时同样需要）",
  );
  assert.match(input, /"settings\.modelProvider\.showApiKey"/);
  assert.match(input, /"settings\.modelProvider\.hideApiKey"/);
  assert.match(input, /aria-label=\{visibilityLabel\}/);
  assert.match(input, /title=\{visibilityLabel\}/);
});

test("卡片：reveal 走 credentialService.load，键拼法与 services 侧 providerApiKeyCredentialKey 对齐", () => {
  const card = readSource("../src/settings/model-provider-section/InlineEditableProviderCard.tsx");
  // 键拼法不得手写：与 packages/provider/src/provider-api-key-vault.ts 的
  // `provider:apikey:<providerId>` 逐字同源（services 侧 providerProvisioningSource/
  // credentialServiceApiKeyVault 同用这一拼写）。
  assert.match(
    card,
    /import\s*\{[^}]*providerApiKeyCredentialKey[^}]*\}\s*from\s*"@acode\/provider"/,
    "键拼法必须复用 @acode/provider 的 providerApiKeyCredentialKey",
  );
  assert.match(
    card,
    /credentialService\s*\n?\s*\.load\(providerApiKeyCredentialKey\(providerId\)\)/,
    "reveal 必须经 credentialService.load(providerApiKeyCredentialKey(providerId)) 现查",
  );
  // 只在「已 vault 化 ∧ 无草稿值」时才查 vault：草稿值就在表单里，不需要也绝不能混淆。
  assert.match(
    card,
    /!hasProviderFormStoredApiKey\(provider\) \|\| draftRef\.current\.apiKeyValue/,
    "无草稿值 + 已 vault 化才是 reveal 的触发条件",
  );
});

test("卡片：隐藏即清明文 + 竞态守卫（时序号失配丢弃在途 load）", () => {
  const card = readSource("../src/settings/model-provider-section/InlineEditableProviderCard.tsx");
  assert.match(
    card,
    /apiKeyRevealRequestRef\.current \+= 1;\s*\n\s*setRevealedApiKey\(null\);/,
    "toggle 时先作废在途 load 再清明文 state",
  );
  assert.match(
    card,
    /requestSeq !== apiKeyRevealRequestRef\.current/,
    "load 返回必须校验时序号（隐藏/provider 切换后到达的结果要丢弃）",
  );
  // provider 切换分支（providerIdRef 比对）内清明文：明文绝不跨 provider 串显。
  const syncEffect = card.indexOf("if (providerIdRef.current !== provider.providerId)");
  assert.ok(syncEffect > 0, "provider 切换分支必须存在");
  const branch = card.slice(syncEffect, syncEffect + 1200);
  assert.match(branch, /setRevealedApiKey\(null\)/, "provider 切换必须清明文");
  assert.match(branch, /apiKeyRevealRequestRef\.current \+= 1/, "provider 切换必须作废在途 load");
  // 卸载失效：空依赖 effect 的 cleanup 递增时序号。
  assert.match(
    card,
    /useEffect\(\(\) => \{\s*\n\s*const requestRef = apiKeyRevealRequestRef;\s*\n\s*return \(\) => \{\s*\n\s*requestRef\.current \+= 1;/,
    "卸载时必须作废在途 load",
  );
});

test("卡片：展示值与草稿值分离——reveal 明文只进展示，展示时输入框只读", () => {
  const card = readSource("../src/settings/model-provider-section/InlineEditableProviderCard.tsx");
  assert.match(
    card,
    /const apiKeyDisplayValue =\s*\n\s*apiKeyValue \|\| /,
    "展示值 = 草稿值优先，否则才落到 reveal 明文",
  );
  assert.match(
    card,
    /const apiKeySectionReadOnly = readOnlyEndpoints === true \|\| revealStoredApiKey;/,
    "展示 reveal 明文时输入框必须只读（明文不进 onChange/草稿，blur 不会误存）",
  );
  // 失败可见（不静默）：走 ProviderDetailFeedback 的 failure 态。
  assert.match(card, /state: "failure"/, "load 失败必须给可见失败反馈");
});

test("安全边界：明文与展示值绝不进日志", () => {
  for (const relative of [
    "../src/settings/model-provider-section/InlineEditableProviderCard.tsx",
    "../src/settings/model-provider-section/ApiKeyInput.tsx",
  ]) {
    const source = readSource(relative);
    assert.ok(
      !/logger\.\w+\([^)]*(?:revealedApiKey|plaintext|apiKeyDisplayValue)/.test(source),
      `${relative} 的日志不得携带明文/展示值`,
    );
    assert.ok(
      !source.includes("console.log") && !source.includes("console.info"),
      `${relative} 不得使用 console（UI 日志走 packages/ui/src/logger.ts）`,
    );
  }
});
