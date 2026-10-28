# M2-0 准备件：legacy → v4 切换验收判据重写

> 创建日期：2026-10-28
> 上游调研：`docs/reviews/2026-10-28/m2-scoping.md`
> 收敛计划：`docs/legacy-protocol-convergence-plan.md` M2 节

## 背景

M2 原验收判据（`docs/legacy-protocol-convergence-plan.md:191`）：

```
git grep -l "acodeProtocolMethods|acodeProtocolClient" -- packages/services/src  # 归零
```

**结构性不可满足**：`acodeProtocolClient.ts` 是 legacy 与 v4 **共用**的版本无关 JSON-RPC 传输载体，M4 之后必须继续存在。把它从 grep 里清零的唯一办法是重命名模块——那是表面通过而非收敛。

## 裁决

1. **`acodeProtocolClient.ts` 是永久载体**。M4 删 barrel 不删它。验收判据豁免此文件名。
2. **验收判据改为「legacy 方法消费 = 0」**：只查 `acodeProtocolMethods` 常量消费，不查客户端类。

## 新验收判据

```bash
# M2 完成标准：services 内 legacy 方法名常量消费 = 0
git grep -l "acodeProtocolMethods\." -- packages/services/src  # 必须归零
```

**判据含义**：`acodeProtocolMethods.` 是 legacy 协议面方法名常量（`packages/shared/src/acode-protocol/index.ts:3495-3599`）。它的消费归零表示 services 不再调用 legacy 方法，全部切到 v4。

**豁免**：`acodeProtocolClient` 字符串（文件名/类名/类型名）不在判据内——它是永久载体，与 legacy 退役无关。

## M4 同步更新

M4 删除 legacy barrel 时，`acodeProtocolClient.ts` 保留。M4 验收判据：

```bash
# M4 完成标准：legacy barrel 删除 + acodeProtocolMethods 符号不存在
test ! -f packages/shared/src/acode-protocol/index.ts  # barrel 已删
git grep "acodeProtocolMethods" -- packages/shared/src  # 必须归零（符号已删）
git grep "acodeProtocolMethods\." -- packages/services/src  # 必须归零（消费已清）
```

## 现状基线（2026-10-28）

- `acodeProtocolMethods.` 消费：**75 处 / 2 文件**（`acodeAgentService.ts` 73 + `pluginReferenceCatalogRequest.ts` 2；`git grep "acodeProtocolMethods\." -- packages/services/src | wc -l` 实测）
- `acodeProtocolClient.ts` 状态：**已实现 `ACodeAgentRpcClient` 接口**（中立叶子已就位，2026-10-27）
- `acodeAgentService.ts` 中 `ACodeProtocolClient` 类型引用：**20 处，架构上必须保留**（`wireClient` 需要 `onNotification`/`onRequest`/`onClose`/`respond` 等独有成员）

## 验收场景

1. 本 spec 落地后，`docs/legacy-protocol-convergence-plan.md` M2 节验收判据已更新。
2. M2 各批次（M2-1 ~ M2-8）完成后，`git grep "acodeProtocolMethods\." -- packages/services/src` 逐步下降。
3. M2 全部完成后，上述 grep 归零。
4. M4 删除 legacy barrel 后，`acodeProtocolMethods` 符号不存在，`acodeProtocolClient.ts` 继续存在。
