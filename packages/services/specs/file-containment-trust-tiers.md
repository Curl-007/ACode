# 文件遏制层与解包信任档矩阵（file containment + archive trust tiers）

状态：已实施（2026-10-15，价值提取第二轮 批C·文件/归档安全 落地件；
需求源：价值提取第二轮 T1-m1 / T1-m3 / T3 stat-skew 条目）。
核心模块落点：`packages/shared/src/node/fileContainment.ts`、
`packages/shared/src/node/statSkewProbe.ts`、
`packages/shared/src/node/archiveTrustPolicy.ts`，经 `@acode/shared/node` 公开入口导出。
CLI 侧对应件：`apps/acode-cli/specs/file-containment-trust-tiers.md`。
守护测试：`packages/shared/test/fileContainment.test.ts`、
`packages/shared/test/archiveTrustPolicy.test.ts`、
`packages/services/test/pluginSyncPathWindowsLexical.test.ts`、
`packages/services/test/skillSyncArchiveTrust.test.ts`、
`packages/desktop/tests/visualization-vendor-containment.test.mjs`。

## 背景与威胁模型

- 解包/同步/协议服务面对的路径与归档内容都来自低信任来源（市场下载、跨设备同步、
  打包资产目录）。既有防线是纯词法校验（`pluginSyncPath.ts`、`skillSyncPath.ts`、
  `zip-source.ts` 的 containment），缺四类身份级防护：
  1. 词法合法但经符号链接/硬链接改道的读写（TOCTOU：校验与打开之间换链）；
  2. Windows 段级危险名（DOS 设备名 con/nul/com1…、尾点/尾空格、段内冒号 ADS）；
  3. 多链接 inode（nlink>1 硬链接把"受控目录内文件"别名到目录外）；
  4. 归档炸弹（聚合/逐条目压缩比）、Windows 归一化碰撞（大小写/尾点变体互相覆盖）、
     嵌套归档逃避逐条目检查。
- Node 没有 openat2(RESOLVE_BENEATH)，"beneath 打开"必须用等价组合实现：
  逐目录段 lstat + O_NOFOLLOW（平台可用时）+ 打开后 fstat 身份复核。
- 身份复核能力不可用时必须 fail-closed：拒绝降级为纯路径 open/readFile。

## 所有权与落点

- 遏制层与解包策略矩阵的**唯一所有者**是 `packages/shared/src/node/`（单源）：
  实测 `apps/acode-cli/packages/adapters`、`packages/services`、`packages/desktop`
  均已依赖 `@acode/shared`（workspace:* 链接到根 `packages/shared`），`./node` 是
  架构策略登记的公开入口（architecture-policy.yaml publicEntrypoints 含
  `packages/shared/src/node.ts`），无需双源分叉，也无需 parity 测试。
- 消费点只消费公开入口，不深导入 `src/node/*` 文件路径。
- 解包引擎不绑定归档格式：zip（yauzl，adapters 侧）与 tar（services 侧自研读取器）
  各自保留解码器，逐条目策略判定统一走 `ArchiveExtractionSession`。
  `packages/shared` 无 yauzl 依赖，因此"预览不解包"这类需要 zip 解码器的能力落在
  adapters 包内（见 CLI 对应件 spec）。

## 产品规则

### R1 遏制层五层（fileContainment.ts）

封闭错误类：`FileContainmentError`，`code` 为小写下划线闭集
`escape | symlink | multilink | not_regular | size | root`（不新增、不自由文本化）。

1. **词法校验**（同步纯函数，`resolveContainedPath` / `findRelativePathEscapeReason`）：
   拒绝非字符串、NUL、UNC（`//`/`\\` 前缀）、`\\?\`（含 `//?/`）设备路径前缀、盘符前缀
   （`C:`）、posix 绝对路径、normalize 后 `..` 或 `../` 开头；`.` 与空段按上游语义过滤。
   Windows 段级规则（默认 `process.platform === "win32"` 时启用，可显式覆盖以便测试）：
   拒 DOS 设备名 `con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]`（含可选 `.扩展名` 后缀，
   上标 ¹²³ 变体因 Windows 文件名大写映射会折叠为 1/2/3）、拒尾点/尾空格段、拒段内
   冒号（NTFS ADS）。
2. **逐目录段 lstat**：自锚根起逐段 lstat，链上任一符号链接或非目录 → `symlink` 拒绝。
   lstat 与 open 之间的窗口由第 3 层身份复核补偿（不假设原子性）。
3. **打开身份复核**（无 openat2 的等价实现）：先 lstat 目标（bigint），符号链接即拒；
   open 时叠加 `O_NOFOLLOW`（平台常量缺席则为 0，Windows 由身份复核补偿）；打开后
   fstat 比对 dev/ino 与打开前 lstat：不一致 → 查询 stat-skew 探针（R2），仅当探针
   **实测** skew 且 dev 走向与 inoDelta 复现、且按名二次 lstat 与打开前完全一致
   （nlink/size/birthtimeNs/mtimeNs/ctimeNs）才容忍；否则 `symlink` 拒绝。
   打开前 lstat `ino === 0n` 的平台（部分 Windows 卷/网络盘）：二次按名 lstat 比对
   dev/size/mtimeNs，且必须仍是非符号链接普通文件，不符即拒。
4. **硬链接与常规文件**：fstat 后非普通文件 → `not_regular`（携带 isDirectory 标志）；
   `nlink > 1` 且未显式 `allowMultiLink` → `multilink` 拒绝；`maxSizeBytes` 超限 →
   `size` 拒绝。O_TRUNC 语义拆解为「先完成全部验证，再 `ftruncate(fd, 0)`」
   （`truncateAfterVerify` 选项），杜绝"先截断后发现目标被换"。
5. **fail-closed 纪律**：身份复核链路中任何一步不可用（open/fstat 失败、探针不可测且
   身份不一致）都直接抛错，**绝不回退**为纯路径 `open`/`readFile`；错误文案明说
   拒绝回退。锚根必须存在且为目录，否则 `root` 拒绝。

便捷读取面 `readContainedFileBytes(root, rel, opts)`：走完整五层后经同一句柄读全量
字节（可选 `maxSizeBytes` 先 fstat 拒绝再读）。

### R2 stat-skew 自检探针（statSkewProbe.ts）

- 动机：某些卷（网络重定向、容器 overlay、翻译层）按名 lstat 与按句柄 fstat 报告的
  dev/ino 不在同一编号通道，身份复核会产生**系统性假阳性**。探针把"是否 skew"变成
  实测事实而非假设。
- 机制：在锚目录以 `O_WRONLY|O_CREAT|O_EXCL` 建 `.acode-stat-probe-<hex>.tmp` 临时
  文件，比对按句柄 fstat 与按名 lstat（bigint）：按名侧非常规文件/size≠0/nlink≠1，或
  双侧 size/nlink/birthtimeNs/mtimeNs 不一致 → `unmeasured`；任一侧 dev/ino 为 0 或
  双侧 dev 相等 → `none`；dev 不等 → `skew`（记录 byNameDev/byHandleDev/inoDelta）。
  首测 skew 必须**复测一次**：复测仍 skew 且两次 byNameDev/byHandleDev 相同才判 skew
  （inoDelta 不一致则置 null）；否则 `unmeasured`。finally 关闭并 unlink（忽略错误）。
- 结果按解析后目录 memo；`unmeasured` 允许 30s 后重试，`none`/`skew` 结论本进程内
  缓存（与上游同构）。`resetStatSkewProbeCache()` 仅供测试。
- 消费纪律：只有 `kind === "skew"` 且 dev 走向/inoDelta 与实测吻合才允许容忍身份
  不一致；`unmeasured`/`no-anchor` 一律不容忍（fail-closed）。

### R3 解包信任档矩阵（archiveTrustPolicy.ts）

信任档（ACode 命名）× 能力旗标，策略对象整体 `Object.freeze`，运行期不可改档：

| 旗标 | bundled | store | local | uploaded |
| --- | --- | --- | --- | --- |
| lexicalPathSafety | on | on | on | on |
| perFileSizeCap | off | on | off | on |
| aggregateRatioCap | off | off | off | on |
| perEntryRatioCap | off | off | off | on |
| nestedArchiveBan | off | off | off | on |
| entryLengthCaps | off | on | on | on |
| skipOsMetadata | on | on | on | on |

档位语义：`bundled`=随安装包分发；`store`=市场/商店远程下载（zip-source.ts）；
`local`=同一用户自有设备间同步（skill/plugin sync tar）；`uploaded`=第三方上传
（本批无消费点，冻结备用）。
与上游矩阵的有意差异：lexicalPathSafety 全档开启（ACode 各消费点既有词法拒绝语义
本就严于上游 plugin 档）；uploaded 档比率/嵌套全开（第三方内容最低信任）。
store 档**不开比率闸**：市场 zip 的真实形态（高压缩文本、弱随机负载）普遍超过
50:1——既有回归归档实测聚合 209:1（`apps/acode-cli/tests/plugin-zip-extract.test.mjs`），
比率闸会误杀合法插件；炸弹损害由既有三重声明闸封顶（单文件 50MB + 总量 500MB +
条目 2 万，全部先于数据读取按 manifest 声明判定）。local 档不开比率上限：
markdown/文本类内容 gzip 压缩比常超 50:1，会误杀；不开嵌套禁令：同步保真要求
用户目录内合法 zip 资产可随档同步。比率闸机制本体（聚合+逐条目）由 uploaded 档
与会话引擎承载，单测直接守护。

全局默认上限（冻结常量，消费点可传更窄 override，不得放宽）：
单文件 512MB、条目数 100 000、压缩比 50:1、条目路径长 1024、文件名长 255。

### R4 解包会话（ArchiveExtractionSession）

`createArchiveExtractionSession({ tier, rootDir, compressedSizeBytes?, limits? })`。
逐条目 `planEntry(entry)`（entry：name/uncompressedSize/compressedSize/isDirectory/
unixMode?），按序执行（顺序即上游语义）：

1. 垃圾条目跳过（skipOsMetadata 档）：basename 命中 `.DS_Store`/`.localized`/
   `__MACOSX`（含前缀目录）/`._*`/`Thumbs.db`/`ehthumbs.db`/`desktop.ini`，或名字含
   CR（如 `icon\r`）→ `skip`，不计配额、不落盘。
2. 条目数上限 → 拒。
3. lexicalPathSafety：严格段校验（拒空段/`.`/`..`/反斜杠/盘符/NUL/绝对路径），
   win32 平台叠加 R1 的 Windows 段级规则（设备名/尾点尾空格/冒号）。
4. perFileSizeCap（目录条目按 0 计）→ 拒。
5. 聚合未压缩总量累加，超 `maxTotalUncompressedBytes`（消费点传入）→ 拒。
6. aggregateRatioCap（compressedSizeBytes 已知且 >0）：总量/压缩体积 > 50 → 拒
   （zip bomb 早拒，在解压数据前按 manifest 尺寸判）。
7. entryLengthCaps：路径长 >1024 或 basename 长 >255 → 拒。
8. nestedArchiveBan：扩展名命中 `.zip`/`.tar`/`.tgz`/`.tar.gz` → 拒（上游仅 `.zip`，
   此处为有意超集：tar 面同样能嵌套）。
9. perEntryRatioCap：compressedSize>0 且 uncompressed/compressed > 50 → 拒。
10. 结构 containment：目标相对路径解析后必须严格位于 rootDir 内；解析到根自身的
    目录条目忽略、文件条目拒。
11. 文件/目录冲突：同一路径既登记为文件又登记为目录（含祖先展开）→ 拒。
12. Windows 归一化碰撞预检（**平台无关**，跨平台归档互提）：条目名含 `:` → 拒；
    归一化（反斜杠→斜杠、posix.normalize、逐段剥尾点/尾空格、过滤空段、小写化）后
    与**不同**原始名重复 → 拒；完全同名重复条目按上游 Map 语义后者替换前者
    （配额照计）。

落盘纪律（消费点执行，引擎给出计划）：
- 文件写入一律 `wx` 独占写；EEXIST → 归一化碰撞错误（文件系统层兜底，防"预检后、
  写盘前"窗口与预检盲区）。
- 可执行位策略：仅当归档条目 unix mode 带 owner-exec（`mode & 0o100`）时，写完后
  `chmod 0o700`；不还原其他权限位。Windows 上跳过 chmod（无 exec 位语义，
  与 pluginSyncArchive 既有平台门一致）。
- 目录先于文件创建（会话 plan 输出 directories/files 两个有序集合）。

### R5 校验→解包 TOCTOU 复核（fileContainment.ts 提供）

- `captureFileIdentitySnapshot(stat)` → `{dev,ino,size,mtimeNs}`（字符串序列化 bigint）。
- `revalidateFileIdentityForExtraction(path, snapshot)`：经 R1 身份打开重开文件，fstat
  比对四元组，不符 → 拒（"归档在校验与解包之间被替换"语义错误）；相符返回**已验证
  句柄**，解包流必须从该同一 fd 读取，不再按名二次打开。
- 本批消费点现状：zip-source 为内存字节流（下载即校验 sha256，无磁盘两阶段窗口，
  且其 yauzl fd 路径有既有挂起缺陷注释，刻意不用 fd 解包）；skill/plugin sync 经
  RPC 字节数组到达。故 TOCTOU 复核作为引擎能力落地并由单测直接守护，磁盘两阶段
  消费点接入时直接复用（登记为未尽事项，见报告）。

### R6 消费点接入

1. **`apps/acode-cli/packages/adapters/src/plugins/zip-source.ts`**（store 档）：
   既有上限常量语义保留并作为 override 传入会话：单文件 50MB、条目 20 000、
   解压总量 500MB（下载 200MB/重定向 5 次/超时 180s 不动）。解压改两阶段：
   第一阶段只读元数据跑完会话（含碰撞预检），第二阶段按计划写盘（wx + exec 位）。
   topLevelSegments 只统计未被跳过的条目（`__MACOSX` 等垃圾不再污染单根判定）。
   新增 `zip-preview.ts`：预览不解包（见 CLI 对应件 spec）。
2. **`packages/services/src/plugin-sync/pluginSyncPath.ts`**：词法层叠加 R1 的
   Windows 段级规则与 NUL 拒绝（默认平台门，`windowsRules` 选项可显式覆盖供测试）；
   既有错误消息形状（`unsafe plugin sync path: <path>`）与函数签名不变，
   pluginSyncArchive/pluginSyncService 调用方零改动受益。
3. **`packages/services/src/skill-sync/skillSyncArchive.ts`**（local 档）：tar 解包
   走会话（垃圾跳过、长度上限、containment、碰撞预检、wx、exec 位 chmod 非 win32）；
   `maxExtractedBytes` 总量上限语义与 `createSkillSyncSizeLimitError` 错误形状保留
   （阶段名 `extracted-content`）；`createSkillSyncArchive` 打包面不动。
   单阶段流式解包保留（tar 读取器是流式的，碰撞检测按 R4.12 增量等价执行）。
4. **`packages/desktop/src/main/visualizationVendorProtocol.ts`**：sha256 运行态闸
   保留，叠加身份层——默认读取实现改为 `readContainedFileBytes(vendorDir, fileName)`
   （manifest 与资产文件都经五层：目录段 lstat、身份打开、nlink>1 拒、常规文件、
   经同一句柄读字节后 sha256 比对）。任何遏制错误 → 既有 fail-closed 404 语义。
   `readFileBytes`/`sha256Hex` 依赖注入面保留（测试替身），main/index.ts 接线零改动。

## 验收场景

1. 词法：绝对路径/UNC/`\\?\`/盘符/NUL/`..`（含 normalize 后显形）/Windows 设备名
   （含 `com¹`、`con.txt` 后缀形、尾点尾空格、`a:b` ADS）→ `escape` 拒绝；
   合法相对路径照常解析。
2. 链接改道：锚根下目录段是符号链接 → `symlink` 拒绝；目标文件是符号链接 → 拒；
   nlink>1 硬链接 → `multilink` 拒绝；`allowMultiLink` 显式放行仍受其余层约束。
3. 身份复核：正常文件打开成功且句柄 fstat 与预 lstat 一致；`truncateAfterVerify`
   先验证后截断；超 `maxSizeBytes` → `size` 拒绝；非常规文件 → `not_regular`。
4. skew 探针：真实文件系统上返回 `none` 或 `unmeasured`（skew 需复测一致才成立）；
   探针临时文件不残留。
5. 矩阵冻结：策略对象与全局上限不可写（strict mode 赋值抛错或静默失败后值不变）。
6. 会话：垃圾条目跳过且不计配额；条目数/单文件/总量/聚合比率/逐条目比率/长度/嵌套
   按档位与 override 拒绝；大小写与尾点变体碰撞拒；含 `:` 条目名拒；同名条目后者
   替换前者；文件/目录同路径冲突拒；owner-exec 条目在 POSIX 上落盘后 mode 为 0o700。
7. TOCTOU：快照相符返回已验证句柄；size/mtime 变化后重开 → 拒。
8. 消费点回归：zip-source 既有测试（内存解压回归、sha256 闸）不破坏；
   skill sync 归档打包/解包 round-trip 不破坏；viz-vendor 协议既有字面量钉死测试
   不破坏，符号链接/硬链接替换资产 → 404。
