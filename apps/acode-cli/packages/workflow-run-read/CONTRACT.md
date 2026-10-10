# Dynamic Workflow run 读模型契约

`contract.ts` 是跨包唯一入口，提供 label、lineage、活动时长、artifact/workspace 只读
projection 和 journal capability 窄化。该包不拥有 run、attempt、journal 或缓存状态，也不
写入 session store；bootstrap 的应用 service 通过端口注入事实并消费派生结果。

`domain/` 只包含确定的输入到输出投影；`app/` 只决定如何读取宿主提供的 journal/store
能力，不直接创建 SQLite 或文件系统适配器。artifact bytes 与 workspace transcript/result
会在读回前校验 run 的父会话归属，并只使用 journal 已确认的 uri/节点。缺少能力必须返回
可观察的 `undefined` 或让宿主跳过对应读面，不能偷偷构造内存事实。

迁移边界见 `apps/acode-cli/specs/workflow-run-read-model-boundary.md`。后续 W1-R2/R3
再迁移 launch/submit/lifecycle 等有状态服务，不能从本包复制 run owner。
