# 文件遏制层与解包信任档矩阵 · CLI 对应件（zip-source store 档 + 预览不解包）

状态：已实施（2026-10-15，价值提取第二轮 批C·文件/归档安全；需求源 T1-m3）。
主 spec（机制与矩阵全文）：`packages/services/specs/file-containment-trust-tiers.md`。
核心模块单源落点：`packages/shared/src/node/`（adapters 已依赖 `@acode/shared`，
经 `@acode/shared/node` 公开入口消费，无双源分叉）。
守护测试：`apps/acode-cli/tests/plugin-zip-trust-tiers.test.mjs`、
`apps/acode-cli/tests/plugin-zip-preview.test.mjs`、既有
`apps/acode-cli/tests/plugin-zip-extract.test.mjs`（回归不破）。

## 背景

- `packages/adapters/src/plugins/zip-source.ts` 是市场 zip 插件的唯一下载解包面：
  既有防线为词法 containment（`normalizeZipRelativePath` / `resolveZipPathWithin`）、
  symlink 条目拒绝、上限常量（下载 200MB / 解压总量 500MB / 条目 20 000 /
  单文件 50MB / 重定向 5）。缺：压缩比率（聚合+逐条目）、条目长度上限、OS 垃圾条目
  跳过、Windows 归一化碰撞预检、wx 独占写兜底、可执行位策略、信任档矩阵归属。
- 归档预览（商店列表展示 manifest/icon）若走全量解包，等于把 zip bomb 面扩大到
  "只看一眼"的路径上。

## 产品规则

### R1 store 档策略绑定（zip-source.ts）

- 信任档取 `store`（市场/商店远程下载），能力旗标与全局默认见主 spec R3；
  既有上限常量语义**原样保留**并作为会话 override 传入：
  `maxFileSizeBytes=ZIP_MAX_SINGLE_FILE_BYTES(50MB)`、
  `maxFileCount=ZIP_MAX_ENTRIES(20 000)`、
  `maxTotalUncompressedBytes=ZIP_EXTRACT_MAX_BYTES(500MB)`。
  比率闸（聚合/逐条目）store 档刻意关闭：真实市场归档高压缩形态普遍超 50:1
  （既有回归归档实测 209:1，`tests/plugin-zip-extract.test.mjs`），会误杀合法
  插件；炸弹损害由上述三重声明闸在读取任何数据前封顶（理由全文见主 spec R3）。
- 解压改两阶段（与上游"先收集计划、后落盘"同构）：
  1. 第一阶段只迭代条目元数据（lazyEntries，不开数据流）跑完
     `ArchiveExtractionSession.planEntry`：垃圾跳过、配额、比率、长度、碰撞预检、
     containment、文件/目录冲突全部在**任何写盘之前**判定；
  2. 第二阶段按计划写盘：`mkdir` 目录集合 → 逐文件读流写 `wx` 独占 → EEXIST 归一
     为归一化碰撞错误 → owner-exec 条目在非 win32 平台 `chmod 0o700`。
- 加密条目/symlink 条目/未知类型条目拒绝语义保留（既有 `classifyZipEntry`）。
- `topLevelSegments` 只统计计划内（未被垃圾跳过）条目的首段：`__MACOSX`、`._*` 等
  不再污染 `requireSingleRoot`/`stripRoot` 单根判定（行为收紧方向：此前含垃圾根的
  归档会误判多根拒绝，现在按真实内容根判定）。
- sha256 必填闸、下载重定向/超时/代理/header 纪律不动。zip-source 为内存字节流
  解包（yauzl fd 路径有既有挂起缺陷注释），不引入磁盘两阶段 TOCTOU 面；引擎的
  `revalidateFileIdentityForExtraction` 能力留给磁盘消费点（见主 spec R5）。

### R2 预览不解包（zip-preview.ts，新增文件）

- `readZipPluginArchivePreview(bytes)`：yauzl 内存打开（lazyEntries），只允许读取
  两个条目：`manifest.json`（≤1MB，超限拒）与其 `icon` 字段指向的档内条目
  （≤1MB，目录条目拒）；其余条目一律不解包不落盘。
- icon 值必须是档内相对路径字符串：以 `http` 开头（远程 URL）或解析失败 → icon 置
  null（不请求网络）；manifest JSON 解析失败 → manifest/icon 均 null（不抛错，
  预览是尽力而为面）。
- 条目名仍过会话的 lexical/碰撞检查（防 `../` manifest 或 `:` ADS 形 icon 名把读取
  改道到档外语义）。
- 导出面：本文件由 `zip-source.ts` re-export（同包直接导入也可）；
  `plugins/index.ts` 共享桶的对外导出接线**未做**（桶文件禁改，接线需求已列入
  实现报告），当前消费方为包内/测试面。

## 验收场景

1. store 档回归：既有单 deflate 大条目内存解压测试照常通过；sha256 不匹配拒。
2. 垃圾跳过：含 `.DS_Store`/`__MACOSX/x` 的 zip 解包后无该文件，且
   `requireSingleRoot` 按真实内容根判定成功。
3. 单文件声明闸：谎报 uncompressedSize >50MB 的条目在读取任何数据前拒绝；
   高压缩比（>50:1）条目不误杀（store 档比率闸关闭的钉住用例）。
4. 长度上限：条目路径 >1024 或文件名 >255 拒绝。
5. 碰撞预检：`A.txt` 与 `a.txt`（或 `b./c` 与 `b/c`）同档 → 拒绝且目标目录无残留
   半成品文件；完全同名条目后者生效（不拒）。
6. wx 兜底：目标路径已存在同名文件时写入拒绝（EEXIST 归一化碰撞错误）。
7. 可执行位：unix mode 带 owner-exec 的条目在 POSIX 落盘后为 0o700；不带则不 chmod。
8. 预览：manifest+icon 字节可读；icon 为 `https://…` 时 iconBytes 为 null 且无网络
   请求；>1MB icon 拒；预览过程不产生任何解包落盘。
