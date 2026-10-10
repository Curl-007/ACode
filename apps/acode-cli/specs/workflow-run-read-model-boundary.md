# Dynamic Workflow run 读模型 bounded context

状态：W1-R3a-1 物理迁移（2026-10-09）。本批迁移 run 读面中的标量投影、journal capability 窄化，以及 artifact/workspace 的只读 projection；launch、submit、lifecycle、replay 和 roster 仍由 bootstrap 装配，不能把本批描述成完整 W1。

## 目标与所有权

- 新包 `@acode/workflow-run-read` 是 Dynamic Workflow run 读模型的唯一实现包。
- `label`、lineage 指针和活动时长是纯/读模型派生值；不回写 journal，不保存第二份 run 状态。
- artifact 归并、artifact item/bytes 读取与 workspace transcript/result 读取都是只读 projection；授权仍由注入的 journal 与父会话端口完成，不在读模型包内拥有运行时状态。
- journal capability 由调用方注入并按结构能力窄化；包不实例化 SQLite、不创建内存 journal，也不拥有 run 生命周期。
- bootstrap 只通过新包公开入口消费这些函数；不得继续从 `bootstrap/src/app/dynamic-workflow-run-{label,lineage,elapsed,journal,artifact-projection,artifact-queries,artifact-read,workspace}.js` 深导入。
- Dynamic Workflow 引擎包保持纯核心；读模型包可依赖 contracts、adapters 和 dynamic-workflow 的公开类型，不反向依赖 bootstrap。

## 契约与失败语义

1. `resolveDynamicWorkflowRunLabel` 只按显式 name、脚本首个非空行、runId 的顺序派生，最多 80 个 UTF-16 code unit 且不得留下孤立高代理项；永不写回 journal。
2. `lineageFields` 只返回存在的指针；`supersededByOf` 只接受 stopped settlement，completed/errored 携带的伪字段视为缺席。
3. `runLineageActiveMs` 从当前 run 沿 `resumedFrom` 上溯，最多 64 跳，按非负活动区间求和；缺少 `listRunLifeSpans` 或没有生命记录返回 `undefined`，环路不能死循环。
4. journal/store 能力检测按方法存在性进行，缺少能力时返回 `undefined`/降级能力，不构造替代事实；`resolveDynamicWorkflowJournalStore` 缺少持久 journal 时返回 `undefined`，并记录可操作日志。
5. 读模型函数是同步、确定的派生操作（外部 journal 读取由注入端口完成）；不修改输入对象、不改变 run 终态和序号。
6. artifact/workspace 读面缺少对应 journal/store 能力时必须可观察地返回空/`undefined`；artifact bytes 只能使用 journal 已授权且已完成版本上的 uri，workspace 清单与正文都必须先校验 run 所属父会话。

## 事件/依赖边界

```text
journal/store port -> workflow-run-read (query narrowing + scalar projection)
                               -> bootstrap facade/observation (read-only response)
Dynamic Workflow engine ------^       (只经公开包入口，不回指 bootstrap)
```

## 验收

- 新包独立 `typecheck`、`lint`、`build` 通过，公开入口只导出契约允许的读面。
- 真实 bootstrap observation 使用包名入口；删除四个 bootstrap 实现文件后仍可编译，源码守护测试拒绝深导入和相对 reach-in。
- label/lineage/elapsed、journal capability、artifact projection/bytes/items 与 workspace transcript/result 的现有行为回归通过；额外覆盖缺能力降级、64 跳/环路、UTF-16 代理边界、越权 run 和有界截断。
- `pnpm architecture:check --changed` 无 new/regrown 违规；不刷新 legacy baseline。
