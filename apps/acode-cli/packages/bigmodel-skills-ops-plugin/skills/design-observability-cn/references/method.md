# 可观测性设计方法

## 遥测字典

每项记录：要回答的问题、名称、类型、产生位置、单位、允许维度、禁止维度、采样、保留期、脱敏、预估量级、负责人和验证方式。指标标签先估算基数；用户 ID、订单号、请求原文等进入受控日志或追踪字段，不进入指标标签。

## 告警卡

记录：关联用户旅程/SLO、触发表达式、短长窗口、持续时间、严重度、去重键、预期动作、负责人、看板、手册、恢复条件和无动作时的去向。连续无人行动的告警删除、降级或转看板。

完整示例：

```yaml
name: async-job-queue-age-high
user_impact: 新提交任务无法在承诺时间内开始处理
condition: queue_oldest_age_seconds > 300
duration: 10m
severity: P2
dedup_key: service+environment+queue
owner: task-platform-oncall
dashboard: /dashboards/async-job-health
runbook: /runbooks/async-job-queue-age
expected_action: 检查消费吞吐、失败重试与下游限额
recovery: queue_oldest_age_seconds < 120 持续 15m
```

路径是项目内占位示例，使用时替换为当前组织真实可访问资源。不能只写“联系值班同学”或“查看相关看板”。

量级预估优先用 `事件数 × 单事件字节 × 保留天数 × 副本/索引放大`；链路用 `入口请求 × 采样率 × 平均 span 数 × 单 span 字节`。缺参数时保留公式和区间，不给伪精确成本。

## 演练闸门

对已知故障注入受控信号，验证：用户影响是否先可见；能否定位到边界或依赖；链路采样是否保留错误；日志是否脱敏；告警是否去重；观测后端失效时是否仍有独立入口。任何一项失败都形成可验收的观测改进，不只增加更多日志。
