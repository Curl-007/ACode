# 遗留演进代码模式

## 适配层先隔离变化

```ts
export interface CustomerDirectory {
  findById(id: string): Promise<Customer | null>;
}

export class LegacyCustomerDirectory implements CustomerDirectory {
  constructor(private readonly legacy: LegacyClient) {}
  async findById(id: string) {
    return mapLegacyCustomer(await this.legacy.query(id));
  }
}
```

业务层只依赖当前业务语言定义的接口。适配层不是永久垃圾桶：必须有负责人、覆盖测试和删除/保留决定。

## 特征测试固定当前行为

对于无法确认是否正确但生产依赖的行为，先用代表性输入记录输出和副作用，再在迁移过程中保持一致。敏感生产数据要脱敏、缩减并获得授权；不能直接复制客户数据成为测试夹具。

## 影子读比较

主路径继续返回旧系统结果，新路径异步读取并比较规范化后的字段，只记录差异，不影响用户。必须限制流量、脱敏日志，并区分允许差异与错误差异。

## 双写必须对账

如果确实需要双写，定义主写、失败队列、重试幂等键、对账频率和修复负责人。不能把两个同步写放在一起就声称一致；网络部分失败会制造分叉。

## 按流量逐步切换

切换维度可使用租户、用户哈希、区域或功能入口，前提是能够稳定归组并快速切回。每一级流量都有观察窗和停止条件，不以“没有人反馈”作为成功证据。

## 依赖升级先拆行为变化

把编译/API 适配、运行时行为变化和业务改动分成不同提交或阶段。一次同时升级框架、重写模块并改业务规则，会失去回归定位能力。
