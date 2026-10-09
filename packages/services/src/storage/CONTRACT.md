# Storage 契约

`contract.ts` 是浏览器安全的服务与数据入口；`node.ts` 是宿主装配工厂、ports 与
Node adapters 的公开入口。其他模块不能深入 app/domain/adapters。Desktop Main
拥有资源管理器存储服务实例；它不是 Host task/session 状态，也不作为 RPC channel 注册。

`createStorageService` 是扫描 job、最近快照与清理流程的唯一 owner。startScan 取消旧
job 并返回新的 jobId；cancelScan 仅取消匹配的当前 job。onScanProgress 事件携带 jobId，
可能包括旧 job 的尾包，消费者按 jobId 过滤；getSnapshot 只返回最近启动 job 的快照。
dispose 取消当前扫描并释放事件源。

业务 app 通过 RootsResolver、ScanRunner、FsCleaner ports 请求副作用；路径解析、
异步遍历、磁盘查询与删除由 Node adapters 执行。扫描取消使用 AbortSignal；clean
只处理 domain 清理计划允许的类别与目标，保留目录规则不由 UI 拼接。底层失败沿稳定
存储结果或异常返回，不以超时替代 owner、jobId 或取消边界。

该模块的职责和生产行为保持既有语义；新增 Node 入口只收口原宿主装配出口。
验证使用现有 storage 行为测试、services 类型检查和 managed 架构门禁。
