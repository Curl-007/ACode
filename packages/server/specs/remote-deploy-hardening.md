# 远端部署补强：磁盘余量预检 / 版本兼容窗 / manifest 验签接口

覆盖 `deploy.ts` 部署事务的三道新增门禁。机制参照外部还原工程的远端资产分发
纪律（下载前 7× 磁盘余量预检、sdkCompat 兼容窗、钉扎公钥验签 manifest），
实现与文案自撰；验签密钥管理属发布管线，本批只预留接口。

## 产品规则

### R1 远端磁盘余量预检（remoteDeployDiskSpace.ts）

1. **时机**：部署决策判定 `shouldDeploy` 之后、任何远端写入（上传/远端下载/
   marker 写入）之前执行；跳过部署的路径不做预检。
2. **探测**：经 backend exec 执行 `df -Pk <目标>`（失败依次回退 `df -k`、`df`），
   目标按 `REMOTE_BASE` → `"$HOME"` → `/` 顺序取第一个可解析结果；解析末行
   倒数第二列（Available，1024 块）换算字节。
3. **估算**：资产大小 = 本次部署组件的必需相对路径文件在本地 release 目录的
   stat 总和；release 目录不可得时回退 manifest 组件的可选 `sizeBytes` 声明；
   两者都不可得 → 记 warn 跳过比较（无法估算 ≠ 余量充足，但上传失败的 ENOSPC
   会自然暴露，不用臆造数字拒绝部署）。
4. **门禁**：可用余量 < 7 × 估算资产大小 → 拒绝部署，错误码
   `remote-disk-space-insufficient`，文案含可用余量、需求量与估算来源。
   7× 覆盖「下载 + 解包 + 版本目录并存 + GC 滞后」的峰值占用。
5. **探测失败**（远端无 df、输出不可解析、exec 失败）→ warn 后继续部署；
   预检自身异常不得成为新的部署失败源。

### R2 server-cli↔desktop 版本兼容窗（remoteVersionCompat.ts）

1. manifest 可选 `compat` 字段：
   `{ schemaVersion?, testedVersions?, minDesktopVersion?, maxDesktopVersion? }`，
   由发布管线产出（本批登记，见登记项 1）；desktop 部署路径读取时做防御性解析，
   形状不符按未声明处理。
2. **硬窗**：`minDesktopVersion`/`maxDesktopVersion` 存在时，当前 `ACODE_VERSION`
   必须落在窗内（点分数字比较；核心版本相同时 prerelease < 正式）；窗外 →
   拒绝部署，错误码 `remote-server-compat-out-of-window`，文案含声明窗与当前版本。
3. **testedVersions**：非空且不含当前版本 → warn（未测试 ≠ 不兼容），不拒绝。
4. **未声明**（字段缺失的存量 manifest）→ 允许部署并记录一次日志；
   发布管线开始产出该字段后，硬窗语义自动生效，无需二次改码。

### R3 manifest 验签接口预留（remoteAssetManifestSignature.ts）

1. `RemoteAssetManifestSignatureVerifier.verify(manifest, context)` 是唯一验签
   入口；结果状态闭集 `verified` / `invalid` / `not-configured`。
2. 本批只提供 `not-configured` 实现（钉扎公钥的密钥管理属发布管线，不实装
   密码学验签）；接口形状按「manifest 原文 + 来源（cdn/local-cache）」设计，
   未来实现可直接消费签名 sidecar。
3. deploy 接受 `DeployOptions.manifestSignatureVerifier` 注入；deploy.ts 可见的
   三条 manifest 获取路径（remote-download、local fresh、CDN fallback）统一经
   memoized guard：`invalid` → 拒绝部署（错误码
   `remote-asset-manifest-signature-invalid`）；`not-configured` → 记录一次并
   放行；guard 同时执行 R2 兼容窗检查（同一 manifest 只检查一次）。
4. remoteAssetCache/remoteAssetInstaller 内部自取的 manifest 不经过 deploy.ts
   guard，属验签实装批次的收口范围（登记项 2）。

## 状态所有者与事件顺序

- guard 的检查结果按 manifest 对象 memoize（WeakMap），deploy 事务内多条路径
  共用同一裁决，不产生第二个事实源。
- 顺序固定为：部署决策 → manifest guard（验签接口 + 兼容窗）→ 磁盘余量预检 →
  远端写入。任何一道门禁失败都发生在远端状态被修改之前；已持久化的
  refresh-pending marker 不因预检失败而回滚（其语义是「下次继续强刷」，
  与门禁正交）。

## 失败语义与迁移边界

- 三道门禁全部 fail-safe 分级：验签 `not-configured` 与磁盘探测失败放行并留痕，
  兼容窗硬窗外与磁盘不足拒绝并解释；不因新增门禁让存量部署路径变脆。
- 老 manifest（无 compat、无 sizeBytes、无签名 sidecar）行为与门禁引入前一致。
- 磁盘预检只读远端（df），不写任何远端文件。

## 登记项

1. **发布管线**：manifest 产出 `compat`（testedVersions/min/max）与组件
   `sizeBytes` 字段；`RemoteAssetManifest` 类型（remoteAssetCache.ts，非本批
   所有权）随管线批次扩展声明。
2. **验签实装**：钉扎公钥分发、签名 sidecar 格式、`invalid` 的强制语义与
   remoteAssetCache 内部 manifest 获取路径的 guard 收口。
3. **UI 文案**：`remote-disk-space-insufficient` / `remote-server-compat-out-of-window`
   错误在连接失败面的展示与 locale 键，随远程连接错误面批次登记。

## 验收场景

1. df 输出（GNU/BusyBox 形态、Filesystem 名换行）解析出正确可用字节；垃圾输出
   返回 null 且部署继续（warn）。
2. 估算 100MB、余量 699MB → 拒绝并解释；余量 700MB → 放行；无法估算 → warn 跳过。
3. compat 硬窗 `[1.0.0, 2.0.0]`，当前 0.9.0 → 拒绝（窗外）；当前 1.5.0 → 放行；
   testedVersions 不含当前版本 → warn 放行；无 compat 字段 → 放行。
4. 注入 verifier 返回 `invalid` → 部署在首个远端写入前拒绝；`not-configured` →
   放行且同一 manifest 只 verify 一次（memoize）。
5. 预检失败路径不产生任何远端写入（fake backend 断言 exec 只出现 df 探测）。
