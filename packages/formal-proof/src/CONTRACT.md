# formal-proof

本模块是 ACode 输入裁决模型的形式化证明可视化应用（vite + d3）。对外唯一包导出是
`./model`（`@acode/formal-proof/model`）；`contract.ts` 是治理登记契约面，逐名转发
`model.ts` 的公开符号，两者同时登记为 publicEntrypoints。`main.ts`（d3 渲染入口）
与 `styles.css` 是应用内部实现，不出包、不入契约。

消费方拿到的是纯函数决策模型：核心词汇类型（`RunPhase`/`QueueState`/
`CompactMemory`/`GoalState`/`TurnTarget`/`DecisionKind` 等）、数据结构
（`ProductContext`/`Candidate`/`Decision`/`TraceNode`/`TraceStats`）、预置数据
（`profiles`/`userCandidates`）与裁决/trace 函数（`evaluate`/`buildTraceTree`/
`collectStats`/`flatten`/`enumerateCandidates` 及标签工具）。

owner 是 `formal-proof-model`。状态所有权：模型唯一可变状态是 trace 节点编号计数
（`nextNodeId`/`nextCaseId`），`buildTraceTree` 入口先 `resetIds()` 重置，输出对
同一输入确定；`evaluate` 本身无状态。apps/acode-cli bootstrap 的裁决投影
（projection-state.ts）以注释声明与本模型 evaluate 逐条对齐——对齐关系单向：
model.ts 是事实来源，bootstrap 是消费投影，本模块零 workspace 依赖（requires: []）。

行数例外（ARCH-04 纳管登记）：`main.ts`（905 行）与 `model.ts`（920 行）超过
400 行全局上限，以例外 `onboard-formal-proof-over-limit`（expires 2026-12-31）
登记为限期债：到期前必须拆分收回上限，`.architecture-baseline.json` 不参与掩盖。
`model.ts` 同时是 publicEntrypoint 且远超 300 行——这不触发 max-contract-lines：
该规则只匹配 basename 以 `contract.` 开头的文件（scripts/architecture/index.mjs），
本文件的 contract.ts 只有转发语句，远低于上限。
