# RPC 服务方法边界

## 产品规则

1. 服务暴露端只允许调用装配时声明的 RPC 方法；未知方法、`constructor`、`__proto__`、`prototype` 和
   `Object.prototype` 继承方法必须在服务方法体执行前拒绝。
2. 现有 `ProxyChannel.fromService(service)` 调用保持兼容：未传显式名单时，从服务自己的可枚举函数和
   非 `Object.prototype` 原型链上的函数建立一次冻结方法表。这项兼容能力只保留在 RPC 库；
   services 的全部 `ServiceDescriptor` 必须显式声明 `allowedMethods`，由 `ServiceCollection`
   转交代理；实现类的内部原型方法不得进入远程公开面。
3. 调用方可传 `allowedMethods` 显式收窄公开面；名单外的普通方法和动态事件统一返回稳定的
   `Method not found`/`Event not found` 错误。需要保留动态事件时，事件名（例如
   `onDynamicData`）也必须出现在名单中；普通事件同样必须列在名单里。显式名单不能把服务上
   不存在或不可调用的成员变成可调用成员。
4. 事件订阅沿用 `onXxx`/`onDynamicXxx` 约定；普通事件只能经 `listen` 订阅。
5. services 方法/事件表精确覆盖当前公开 interface 的成员，成员名受 `keyof T` 类型约束。
   该表在 descriptor 创建时复制并冻结，调用方修改传入数组不能扩张公开面。
   缺少方法表的运行时 descriptor 不得回退到原型发现，按空表 fail-closed。
6. 显式名单通过 `Reflect.get(service, name)` 解析真实可调用成员，保留 Proxy `get` 提供的
   connection scope、握手、可信 context 与 owner 路由覆盖；不得从底层属性描述符直接取方法。
   `ProxyChannel.toService` 创建的远端 Proxy 虽没有可枚举成员，也能按显式名单再次暴露合法方法和事件。
7. 全部 services descriptor 的公开方法与 `onDynamicXxx` 动态事件都必须登记运行时参数校验器
   （2026-10-09 迁移完成，40/40 descriptor；`packages/services/tests/rpc-descriptor-surface.test.mjs`
   以机械门禁强制，新增成员未登记校验器直接红）。校验发生在服务方法体执行前；失败统一返回
   `code = "rpc-invalid-arguments"`、`method` 和不含敏感值的 `details`，不得把原始参数写入错误或日志。
   普通事件（`onXxx` 非动态）豁免：`fromService.listen` 对普通事件先命中缓冲 `eventMap` 直返，
   校验器路径不可达，登记与否仅为防御性声明。校验器是保守的传输层护栏（arity + 顶层类型 +
   明确必填的 id/path 字符串），深度业务 schema 校验仍归服务层；不得把校验器表宣称为完整输入 schema。

## 状态所有者与事件顺序

- `ProxyChannel.fromService` 创建的冻结 `Set`/方法表是公开面唯一所有者；调用期间不重新读取对象原型。
- 方法表遵循 JavaScript 成员遮蔽规则：实例自有成员（即使不是函数）优先于原型成员，
  不会因为自有成员不可调用而回退暴露同名原型方法。
- 参数校验表与方法表在装配时一并冻结；调用时先查方法，再校验参数，最后才调用服务方法。
  校验器不能读取或持久化业务状态，也不能通过修改原始 Map 在装配后扩张公开面。
- 无显式名单时只发现实例与自定义原型的成员名，再通过 `Reflect.get` 冻结该名的真实引用；
  显式名单不依赖枚举。两者均拒绝保留字和未经自定义覆盖的 `Object.prototype` 成员。
- `call` 事件顺序为：收到请求 → 查冻结方法表 → 未命中立即拒绝；命中后以原服务对象为 `this` 调用。
- 服务实例的业务状态仍由服务实例所有；RPC 层只保存方法引用和公开名，不复制业务状态。
- `ServiceCollection` 同时保存 descriptor 与实例；覆盖实现只替换实例，不改变 descriptor 的方法表。
- 两种交付模式（Desktop continuous / Web replayable）共用同一声明表；各自现有 connection scope、
  credential guard 和 owner/lease 继续负责角色和数据路由，不因名单迁移改变事实所有者。

## 失败语义与迁移边界

- 失败发生在服务方法执行前，返回既有 Promise rejection 形态，公共错误文本保持 `Method not found: <name>`。
- 这是传输边界加固，不改变 channel 名称或合法调用参数；迁移覆盖所有现有服务的方法和事件。
- 新增远程方法/事件时，先更新公开 interface，再同步 `allowedMethods` 与 `argumentValidators`；
  覆盖测试阻止遗漏与残留成员。
- 新增敏感写方法时必须同时登记参数校验器和一个非法参数行为测试。历史迁移债务已于 2026-10-09
  清零：全部 40 个 descriptor 的方法与动态事件均已登记校验器，并由 rpc-descriptor-surface
  覆盖门禁持续强制；白名单 + 保守校验器仍不等于完整输入校验，深度 schema 归服务层。

## 验收场景

1. class 原型上的合法方法仍可调用。
2. `toString`、`constructor`、`__proto__`、任意未知字符串均在服务体执行前拒绝。
3. `allowedMethods: ["read"]` 只允许 `read`，`write` 和不存在的方法拒绝。
4. 既有事件监听和无名单的服务 RPC 回归通过。
5. 全部 services descriptor 都提供与 interface 精确一致的名单；新增/删除方法却未更新名单会失败。
6. 真实 ChannelClient/ChannelServer 调用 OAuth 公共读取成功，`persistOAuthSession` 等内部方法拒绝，
   假 credential port 未观察到任何写入；终端公开动态事件和普通事件仍可订阅。
7. override 实现增加内部方法不会扩大公开面；缺少表与修改原始数组不能扩大公开面。
8. Proxy 的方法、普通事件、动态事件覆盖均生效；装配后改动覆盖函数不改变已冻结引用。
9. 远端 `toService` Proxy 通过名单再次暴露的方法、普通事件和动态事件可转发，名单外成员拒绝。
10. 真实 connection scope 经 ServiceCollection 与 ChannelClient/Server 暴露后，桌面和手机模式
    均拒绝未握手 command、终端客户端 flow control 和资源事件；base 服务未观察到越权调用。
11. 通过真实 ChannelClient/ChannelServer 调用凭据、终端或 OAuth 的畸形参数时，服务方法体未执行，
    客户端收到稳定 `rpc-invalid-arguments` 错误及方法名；错误中不含凭据值、完整路径或 token。
