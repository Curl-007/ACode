import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("每个 RPC descriptor 精确声明公开 interface 的全部方法和事件", async () => {
  const config = ts.readConfigFile(resolve(packageRoot, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  let descriptorCount = 0;

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
      descriptorCount += 1;
    }
  }

  assert.ok(descriptorCount >= 40, `应覆盖当前 40 个 descriptor，实际仅 ${descriptorCount} 个`);
});
