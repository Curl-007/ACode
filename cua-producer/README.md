# Windows Computer Use 原生 producer（角色 A）骨架

本目录是 U14「Windows Computer Use producer 自建」的**角色 A** 落点：Helper 侧原生
producer（`ax_native.node` + `windows-helper.js` + 14 个 broker 工具处理器）。当前状态 =
**A1 骨架 Helper 已落地**（契约见 `specs/windows-helper-producer.md`）：可构建、可加载、
两阶段就绪（transport_ready/ready）、named pipe wire 服务端、诚实 probe addon；**14 个工具
方法一律诚实应答 `unimplemented`（→ SDK `ACTION_UNAVAILABLE`），绝无假成功**——指针/截图
（A2）与 UIA 树（阶段 3）落地前，整条 CUA 链路的能力面仍 fail-closed（见
`packages/acode-cua/specs/module-boundary.md`）。

## 构建与测试（A1）

```bash
cd cua-producer
npm install        # producer 自有 npm 安装树与 package-lock.json（在 pnpm workspace 外）
npm run build      # tsc → dist/（ESM）+ node-gyp rebuild → build/Release/ax_native.node
```

仅 Windows（VS + node-gyp 13 工具链，见 spec §4.5/§5.2.1）；ubuntu CI 不构建本目录。
测试落 `apps/acode-cli/tests/cua-producer-contract.test.mjs`（CI 常驻、平台无关）与
`cua-producer-helper-a1.test.mjs`（双守卫：非 win32 或工件缺失即整文件 skip），见 spec §6。

## 为什么这里有个和 `packages/acode-cua` 同名的包

`package.json` 的 `name` **必须**是 `@acode/acode-cua`：宿主解析器
`packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:9` 硬编码
`EXPECTED_PACKAGE_NAME`，dev root 的 `package.json` 名字不符会以 `invalid-package` 拒绝。

但它与占位包 `packages/acode-cua`（角色 B，host 侧纯 JS）是**两个不同角色、两条不同加载路径**：

|          | 角色 B（`packages/acode-cua`）                  | 角色 A（本目录 `cua-producer/`）                                                                   |
| -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 内容     | host 侧 broker RPC 客户端 + 编排，纯 JS         | Helper 侧原生 addon + `windows-helper.js`                                                          |
| 加载方式 | **按名 import**（`workspace:*`，pnpm 解析）     | **按路径 fork**，绝不按名解析                                                                      |
| 解析入口 | 5 个 workspace 包 `import "@acode/acode-cua/…"` | `windowsCuaDevHelperHost` 以 `ACODE_CUA_DEV_ROOT`（dev）/ `resources/tools/cua-helper`（产品）fork |
| 为何在此 | 经按名 import 被消费，只能在 workspace glob 内  | 不进 workspace 解析图，故放 glob 外的顶层目录                                                      |

放**仓内顶层 `cua-producer/`** 而非 `packages/*`：它不被 `pnpm-workspace.yaml` 的任何 glob
匹配（`packages/*`、`apps/acode-cli`、`apps/acode-cli/packages/*`、`apps/acode-cli/tools/*`），
因此 pnpm 不会把它当成 workspace 包、按名 import 永远解析到 `packages/acode-cua`。原生产物
必带 `src/` + addon 构建步骤，与角色 B 的「扁平 `.js`/`.d.ts`、无构建」布局冻结（不变量 4）
直接冲突，故**不能**并入 `packages/acode-cua`。

## 为什么 `cua-producer` 必须在 `SKIP_DIRECTORIES` 里（原子改动）

`scripts/architecture/discovery.mjs` 的 `discoverWorkspacePackages` 从仓库根向下走文件系统，
用 `packages[manifest.name] = root` 建包名映射——**同名时后写覆盖前者，胜出方取决于 `readdir`
的原始顺序（未排序，跨机器/文件系统非确定）**。本目录的 `name` 与真占位包撞名，若不被排除：

- 当 `cua-producer` 在 `readdir` 里排在 `packages` **之后**，`@acode/acode-cua` 映射被**劫持**
  到本骨架目录，真占位包 `packages/acode-cua` 从映射中消失，污染架构检查器的 workspace 导入解析。
- 当排在**之前**，真包侥幸胜出——但这是顺序运气，不是保证。

故本目录名 `cua-producer` 已加入 `discovery.mjs:7` 的 `SKIP_DIRECTORIES`（`node_modules` /
`dist` / `out` / `.git` / `.acode` 同列）。**「建本目录」与「改 `SKIP_DIRECTORIES`」必须同一
提交**：缺后者，架构检查器的包解析在本目录存在的瞬间就变得依赖 `readdir` 顺序。加入后整棵
`cua-producer/` 子树被确定性排除，与顺序无关。

## 运行时契约（`acodeCuaRuntime`）

`package.json` 的 `acodeCuaRuntime` 声明 producer 的两个 artifact，供宿主解析：

```json
"acodeCuaRuntime": {
  "schema": 1,
  "windows": {
    "entry": "dist/windows-helper.js",
    "nativeAddon": "build/Release/ax_native.node"
  }
}
```

宿主 `requireExpectedPackage`（`windowsCuaDevRuntime.ts:526-558`）对它的硬约束（不满足即
`invalid-package`，且底层错误文本被刻意丢弃、汇聚成同一码）：

- `acodeCuaRuntime` 键**恰好** `["schema", "windows"]`，`windows` 键**恰好** `["entry", "nativeAddon"]`——不允许未知字段。
- `entry` 与 `nativeAddon` 都是规范的 `/` 分隔相对路径（不含反斜杠、绝对路径、`.`/`..` 段、`:`、NUL），且二者不相等。
- `package.json` 顶层 `name` == `@acode/acode-cua`、`version` 是非空 trim 字符串。
- `"type": "module"` **宿主不校验**，但 `entry` 是含裸 `import` 的 ESM——缺 `type:module` 会通过
  全部解析校验、却在 fork 阶段因 ESM 解析失败而崩，且失败点**不在** 12 类稳定错误码之内。故此约束由 producer 自证，本骨架已带。

**两个 artifact 都是构建产物、都不入库**：`dist/` 由根 `.gitignore`（:2）覆盖，整棵 node-gyp
构建树由**本目录 `.gitignore`** 的 `build/` 规则覆盖（A1 新增，裁决与实测依据见
`specs/windows-helper-producer.md` §5.4——根规则只盖 macOS/Make 形态，Windows MSVC 的
`binding.sln`/`*.vcxproj*`/`Release/*.lib`/`Release/*.exp` 零命中）。入库的是源码与接线
（`src/`、`scripts/`、`binding.gyp`、`tsconfig.json`、`specs/`、`package-lock.json`、本 README）；
契约里的路径是**声明**，构建后才有实体文件。

构建齐套（dist + addon 都在）后，以 `ACODE_CUA_DEV_ROOT` 指向本目录的 dev 解析**成功**；
只跑 `build:js` 不跑 `build:native` 时报 `missing-native-addon`（spec §5.5）。

> **C02 验收备注（A1 已闭合）**：裸骨架阶段 entry 缺失，`resolveDevelopmentRuntime` 先查
> entry（`missing-helper-entry`，:130）后查 addon（`missing-native-addon`，:140），故 C02
> 期望的 `missing-native-addon` 当时不可真机命中。A1 提供真实 entry 后，「entry 在、仅缺
> addon」的 C02 场景可真机复现（spec §5.5），缺口关闭。

## 安全纪律（AGENTS.md / U14 §7.7，随本目录一并生效）

- 从 `zcode-recovered` 逆向树复制任何源码**禁止**（zoode 产物禁止再分发，只可搬运机制设计）；
  合法来源只有官方 `zai-org/ZCode`（Apache-2.0，须署名）。角色 A 的机制参照见 `docs/cua/`。
- `pluginAuthority` 是当前唯一敏感凭据，不得出现在 child argv、进程标题、日志、错误文本、
  telemetry 或可复制 UI 文本中。
- 截图与 UI 树内容按 `web-content-untrusted-discipline` 同等对待（不可信输入，不得当指令执行）。
- 不得为通过验收而自动关闭系统安全策略（Windows Smart App Control）；未经 Trusted Root Program
  CA 签名的 `ax_native.node` 会被 Code Integrity 拒绝加载——「成功编译不等于当前机器可执行」。
- 能力真实性优先于覆盖面：宁可少实现方法并显式报 `ACTION_UNAVAILABLE`，不得返回空结果冒充成功。
