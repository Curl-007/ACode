import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 已登记的 descriptor 频道集合（rpc-service-boundary spec 的门禁快照）。
// 根因（review R1-04 / 测试专项 P2）：旧门禁是 `assert.ok(descriptorCount >= 40)`，
// 下限阈值贴边——删一个又加一个 descriptor（频道漂移）不会改变数量，门禁恒绿；
// 数量增长（新增未评审的 RPC 面）同样被下限放过。改为按**频道名集合精确比对**：
// 任何删除、新增或改名都会让 deepEqual 失败，检出静默漂移。
// 变更 descriptor 时必须同步更新此集合（新增/删除频道），否则本门禁红。
// 采集方式：以 createServiceDescriptor 调用点的运行时 descriptor.channelName 为准
// （channelName 是 descriptor 的稳定运行时标识，见 src/descriptors.ts）。
const REGISTERED_DESCRIPTOR_CHANNELS = [
  "acode-agent",
  "acode-session",
  "acode-task",
  "bots",
  "broadcast",
  "client-config",
  "client-scenes",
  "coding-plan-subscription",
  "commands",
  "credential",
  "cua-permission",
  "cua-pip-session",
  "feedback",
  "file",
  "file-watcher",
  "git",
  "git-checkpoint",
  "hooks",
  "mcp-sync",
  "media-preview",
  "memory",
  "model-selection",
  "oauth",
  "off-peak-task",
  "onboarding-record",
  "plugin-management",
  "plugin-sync",
  "plugins",
  "prompt-attachment-transfer",
  "provider-provisioning-target",
  "provider-settings",
  "setting",
  "settings-sync",
  "skill-sync",
  "skills",
  "subagents",
  "system",
  "terminal",
  "usage-stats",
  "window-controller",
].sort();

test("每个 RPC descriptor 精确声明公开 interface 的全部方法和事件", async () => {
  const config = ts.readConfigFile(resolve(packageRoot, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const discoveredChannels = [];

  for (const file of program.getSourceFiles()) {
    if (
      !file.fileName.replaceAll("\\", "/").startsWith(`${packageRoot.replaceAll("\\", "/")}/src/`)
    ) {
      continue;
    }
    const declarations = [];
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(file) === "createServiceDescriptor"
      ) {
        declarations.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!declarations.length) continue;
    const module = await import(pathToFileURL(file.fileName).href);

    for (const declaration of declarations) {
      const name = declaration.name.text;
      const typeNode = declaration.initializer.typeArguments?.[0];
      assert.ok(typeNode, `${name} 必须关联公开 interface`);
      const members = checker.getPropertiesOfType(checker.getTypeFromTypeNode(typeNode));
      assert.ok(members.length > 0, `${name} interface 未解析，不能以空表声称覆盖完成`);
      const expectedNames = members.map((member) => member.name).sort();
      const descriptor = module[name];
      assert.ok(Array.isArray(descriptor.allowedMethods), `${name} 缺少显式方法/事件表`);
      assert.equal(
        new Set(descriptor.allowedMethods).size,
        descriptor.allowedMethods.length,
        `${name} 包含重复成员`,
      );
      assert.deepEqual(
        [...descriptor.allowedMethods].sort(),
        expectedNames,
        `${name} 与公开 interface 不一致`,
      );
      assert.equal(Object.isFrozen(descriptor.allowedMethods), true, `${name} 方法表必须冻结`);
      // ARCH-01 迁移完成后的机械门禁（rpc-service-boundary spec 规则 7）：
      // 每个会收到 wire 参数的成员（方法 + onDynamicXxx 动态事件）都必须登记参数校验器；
      // 新增成员若未登记校验器，本门禁直接红。
      // 普通事件（onXxx 非 onDynamicXxx）豁免：ProxyChannel.listen 对普通事件先命中
      // eventMap 缓冲直返，校验器路径不可达（proxy-channel.ts fromService.listen），
      // 登记与否只是防御性声明，不构成真实边界，因此允许缺省也允许存在。
      const isPlainEvent = (method) => /^on[A-Z]/.test(method) && !/^onDynamic[A-Z]/.test(method);
      const validators = descriptor.argumentValidators;
      assert.ok(validators, `${name} 缺少 argumentValidators 表`);
      assert.equal(Object.isFrozen(validators), true, `${name} 校验器表必须冻结`);
      for (const method of descriptor.allowedMethods) {
        if (isPlainEvent(method)) continue;
        assert.equal(
          typeof validators.get(method),
          "function",
          `${name}.${method} 未登记参数校验器（ARCH-01 迁移门禁）`,
        );
      }
      for (const key of validators.keys()) {
        assert.ok(
          descriptor.allowedMethods.includes(key),
          `${name} 校验器表包含方法表之外的键 ${key}`,
        );
      }
      // 收集运行时频道名作为集合比对依据（每个 descriptor 唯一，见下方去重断言）。
      assert.equal(
        typeof descriptor.channelName,
        "string",
        `${name} 缺少 channelName（createServiceDescriptor 必须以频道标识服务）`,
      );
      discoveredChannels.push(descriptor.channelName);
    }
  }

  // 频道必须唯一：同名频道意味着两个 descriptor 抢占同一 RPC 面。
  const uniqueChannels = [...new Set(discoveredChannels)].sort();
  assert.equal(
    uniqueChannels.length,
    discoveredChannels.length,
    `存在重复频道：${discoveredChannels.filter((c, i) => discoveredChannels.indexOf(c) !== i).join(", ")}`,
  );

  // 精确集合比对（取代旧的 `descriptorCount >= 40` 下限）：
  // - 删除一个 descriptor → 少一个频道 → 红；
  // - 新增一个未登记 descriptor → 多一个频道 → 红；
  // - 改名/漂移（删一加一）→ 集合内容不同 → 红（下限阈值检不出）。
  assert.deepEqual(
    uniqueChannels,
    REGISTERED_DESCRIPTOR_CHANNELS,
    "RPC descriptor 频道集合与登记快照不一致；增删或改名 descriptor 时必须同步更新 " +
      "REGISTERED_DESCRIPTOR_CHANNELS",
  );
});
