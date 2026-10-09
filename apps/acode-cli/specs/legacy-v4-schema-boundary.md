# Legacy / v4 shared schema boundary

状态：已落地（2026-10-09）。这是 legacy protocol M2-B 的结构切片，不改变 wire
字段、解析规则或两种远程传输语义。

## 规则

1. `packages/shared/src/acode-protocol-v4/` 不得导入
   `packages/shared/src/acode-protocol/` 或其 `index.ts`。
2. 仍被 legacy 与 v4 同时消费的 schema 放在
   `packages/shared/src/acode-protocol-shared.ts`，该模块不得依赖任一协议目录。
3. legacy barrel 可以重导出中立 schema，保持已有 services、bootstrap 和 UI 的公开
   import 面；这只是兼容入口，不是 v4 的依赖入口。
4. 新命令、事件和 v4 专属 schema 仍只进入 `acode-protocol-v4/`；本规则不把 legacy
   类型整体搬入 v4。

## 当前共享 schema

- `acodeProtocolMcpServerSchema` / `ACodeProtocolMcpServer`
- `acodeBrowserAmbientContextSchema` / `ACodeBrowserAmbientContext`

它们的校验约束保持原值：MCP server 变体、OAuth 字段、隔离级别、协议版本、超时、
browser tabCount 上限和 URL 长度均不放宽。

## 所有权与事件顺序

```text
legacy barrel ─┐
               ├─> acode-protocol-shared.ts ─> legacy consumer / v4 command parser
v4 command ────┘
```

中立模块只提供纯 schema；协议 server、runtime 和 transport 不在此模块保存状态或执行业务
副作用。`desktop-continuous` 与 `web-remote-replayable` 继续使用各自的 transport
semantics，schema relocation 不改变 snapshot、queue 或 replay 行为。

## 验收

- 架构 fixture 拒绝 v4 文件导入 legacy protocol barrel。
- 同一 fixture 改导入中立模块后通过架构检查。
- v4 command 与 legacy barrel 仍接受相同的 MCP/browser payload。
- `pnpm --filter @acode/shared test`、`pnpm typecheck`、`pnpm lint` 与
  `pnpm architecture:check --changed` 通过。
