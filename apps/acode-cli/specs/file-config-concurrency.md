# File Config 并发更新契约

## 目标

CLI、Desktop bridge 和插件启动流程可能在同一进程或不同进程同时修改同一个 JSON 配置文件。每个 patch 必须基于锁内最新磁盘快照合并，不能让后完成的旧快照覆盖先完成的字段。

## 所有者与写入路径

- 配置文件的持久化事实由 `file-config.adapter.ts` 所有。
- `updateUiLocaleInFileConfig`、插件启用/卸载、插件 options 和 builtin suppression 都必须经过同一个 `withFileLock(resolvedPath, ...)`。
- 锁覆盖完整的 read → patch → atomic rename；只给 rename 加锁不满足契约。
- 锁释放后才向调用方返回；单进程调用也使用 FIFO，跨进程使用共享锁文件。

## 不变量

1. 两个并发 patch 修改不同字段时，最终 JSON 同时包含两个 patch。
2. 两个并发 patch 修改同一字段时，结果按锁取得顺序确定，不能产生半截 JSON 或丢失其他字段。
3. 失败写入不会删除其他进程已经提交的配置，也不会留下可被误读的临时文件。
4. 读取、解析、迁移和返回值语义保持不变；只收敛更新操作的临界区。

## 验收场景

- 同一临时文件并发更新 `ui.locale` 和两个 plugin enabled keys，重复至少 20 次，所有字段都保留。
- 并发更新 plugin options 与 suppression，最终 JSON 可解析且两类 patch 都存在。
- 一个 patch 在锁内失败时，另一个 patch 仍能完成，原文件保持合法 JSON。
