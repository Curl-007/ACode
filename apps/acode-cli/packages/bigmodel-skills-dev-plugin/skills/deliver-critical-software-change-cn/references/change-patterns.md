# 关键变更代码模式

只加载任务涉及的模式，并适配当前语言、框架和仓库惯例。

## 扩展—迁移—收缩

数据库字段变化按兼容窗口执行：

1. 扩展：新增可空字段/新表，旧代码仍能工作。
2. 双读或兼容读：优先新字段，缺失时读旧字段并记录比例。
3. 回填：分批、限速、可重入，记录游标和失败项。
4. 切换写入：监控新旧数据一致性。
5. 收缩：确认旧版本和旧数据比例归零后删除旧路径。

禁止在同一次滚动发布中直接重命名或删除仍被旧实例读取的字段。

## TypeScript：运行时验证外部输入

```ts
const UpdateInput = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(100),
});

const input = UpdateInput.parse(request.body);
```

TypeScript 类型不能验证 HTTP、队列或数据库中的运行时数据。若项目已有验证库，沿用它。

## Java/Spring：事务只包本地原子边界

```java
@Transactional
public ChangeResult change(ChangeCommand command) {
    ChangeLog existing = changeLogRepository.findByCommandId(command.commandId());
    if (existing != null) return existing.toResult();

    Aggregate aggregate = repository.getForUpdate(command.aggregateId());
    aggregate.apply(command);
    outboxRepository.append(Event.from(aggregate, command.commandId()));
    changeLogRepository.save(ChangeLog.completed(command.commandId(), aggregate.version()));
    return ChangeResult.from(aggregate);
}
```

远程调用不能被本地数据库事务自动回滚。跨边界通知使用 outbox、补偿或显式状态机，并设计重复投递。

## 乐观并发

```sql
UPDATE resource
SET value = :value, version = version + 1
WHERE id = :id AND version = :expected_version;
```

受影响行数为 0 时返回可识别的冲突，不要静默覆盖。是否自动重试取决于操作能否安全重放和用户是否需要重新确认。

## 功能开关

开关必须包含：默认值、作用范围、负责人、观测指标、失败时切回方式和删除日期。开关关闭路径也要测试；长期保留的开关会形成双倍状态空间。

## 异步任务可重入

以稳定任务 ID 记录状态和进度；每个批次提交后更新游标。重试时从已确认游标继续，写操作以业务键去重。不要用进程内布尔值代表分布式任务完成。
