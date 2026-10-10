# Git 协作规则

本文件定义 ACode 仓库的分支模型、提交规范、合并与发布流程。适用于所有协作者与 AI 辅助会话;与 [AGENTS.md](../AGENTS.md) 冲突时,代码与验证要求以 AGENTS.md 为准,分支与提交要求以本文件为准。

## 分支模型

| 分支                                  | 用途                            | 切自                              | 合入                    | 合并方式        |
| ------------------------------------- | ------------------------------- | --------------------------------- | ----------------------- | --------------- |
| `main`                                | 发布版本,任何提交都必须可发布   | —(只接受 `release/*`、`hotfix/*`) | —                       | `merge --no-ff` |
| `dev`                                 | 日常集成分支,功能汇合与联调验证 | `main`(初始化)                    | `release/*`             | 入侧 squash     |
| `feature/<scope>-<摘要>`              | 单个功能开发                    | `dev`                             | `dev`                   | squash          |
| `fix/<scope>-<摘要>`                  | 缺陷修复                        | `dev`                             | `dev`                   | squash          |
| `chore/`、`docs/`、`refactor/` + 摘要 | 工程、文档、重构类改动          | `dev`                             | `dev`                   | squash          |
| `release/<版本>`                      | 发布准备:冻结、验证、出包       | `dev`                             | `main`,发布后回并 `dev` | `--no-ff`       |
| `hotfix/<摘要>`                       | 已发布版本的紧急修复            | `main`                            | `main`,随后回并 `dev`   | `--no-ff`       |

规则要点:

- **`main` 是发布分支**:只承载已验证、可发布的版本。不直接推送功能或修复提交,不允许实验性代码,不保留长期未验证的改动。任何时刻检出 `main` 都应能通过 `pnpm typecheck`、`pnpm lint` 与打包流程。
- **`dev` 是集成主干**:所有功能与修复先合入 `dev` 联调;`dev` 内容进入 `main` 的唯一路径是 `release/*` 分支。`dev` 允许快速迭代,但损坏后修复优先于一切新合入。
- **分支命名**:kebab-case;`<scope>` 用模块名(`desktop`、`web`、`server`、`ui`、`services`、`cli`、`assets`、`docs` 等),摘要简短描述改动,如 `fix/desktop-tray-icon`、`feature/cli-plugin-search`。
- **分支生命周期**:合入后及时删除分支;`release/*` 在版本发布并回并 `dev` 后删除。

## 提交规范

- 使用 Conventional Commits:`type(scope): 摘要`。`type` 取 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`;纯资源改动可用 `assets`。`scope` 与分支的 `<scope>` 一致,可省略。
- 摘要说明"改了什么",正文说明"为什么":bug 修复写明根因与修复依据,资源重生成写明生成方式与验证结果。中文或英文均可,同一系列提交保持一种语言。
- 一个提交只做一件事;不混入无关改动(图标修复与文档清理应分成两个提交)。
- 提交前至少运行 `pnpm lint`;推送前运行 `pnpm verify:pre-push`(lint + 架构检查)。有行为改动时按 AGENTS.md 补测试并实际执行验证,报告真实结果。
- 不在提交、日志或示例中写入凭据、真实用户数据和内部服务地址。误提交敏感信息时,仅 revert 不够,必须轮换凭据并清理历史。
- AI 辅助产生的提交按当前工具约定附 `Co-Authored-By` 署名行。

## 开发与合并流程

1. 同步基线:`git fetch origin` 后在 `dev` 上 `git pull --rebase`。
2. 从 `dev` 切功能/修复分支(hotfix 从 `main` 切)。
3. 开发、自测(typecheck、lint、架构检查、相关测试)。
4. rebase 到最新 `dev` 并解决冲突;冲突由分支作者负责,解决时不顺手带入无关改动。
5. 推送分支并开 PR 到 `dev`;PR 描述写动机、方案与验证结果。
6. 评审通过后以 **squash** 合入 `dev`,保持集成历史一条线。
7. 发布见下节。

禁止事项:

- 禁止直接 `push` 到 `main`、`dev`、`release/*`;一律走 PR。单人维护期可临时直推 `main`,但必须自行完成发布级验证,并在恢复多人协作后立即收回。
- 禁止对 `main`、`dev`、`release/*` force-push;个人功能分支 rebase 后仅允许 force-push 自己的、且无他人协作的分支。
- 禁止用 `--no-verify` 绕过仓库检查提交或推送。

## 发布与版本

- 版本号以根 `package.json` 为准,遵循 semver。
- 从 `dev` 切 `release/x.y.z`,在发布分支上完成全量验证(typecheck、lint、测试、桌面与 CLI 打包冒烟);验证期间只接受修复类合入,修复先落 `release/x.y.z`,不直接提交 `main`。
- **release 过了才合入 main 发布**(2026-10-08 修订):`release/x.y.z` 上全部门禁通过之前,禁止合入 `main`,也禁止触发正式出包。门禁全绿指:CI verify(typecheck/lint/架构/测试)、licenses-notices 等专项闸门在 release 分支的推送上全部 success;需要预演发布级验证时,以 `--ref release/x.y.z` 触发 Release 工作流并勾选 keep_draft(产物留 draft,不打正式 tag、不公开)。
- 门禁全绿后 PR `release/x.y.z` → `main`,以 `merge --no-ff` 合入,保留发布 lineage。
- 合入后在 Actions 手动触发 [Release](../.github/workflows/release.yml) 工作流出包:勾选预发布得到 `x.y.z-audit.<日期>[.n]` 测试版;不勾选发布正式版 `vx.y.z`(干净 tag,GitHub Latest)。tag 只由工作流创建,不手工打 tag。
- 工作流保证所有产物先传 draft、全部成功后才公开 Release;Release 说明以"相对基线的变化"开头,中英双语安装说明居中,下载列表收尾。
- 发布完成后将 `main` 回并 `dev`(或经发布分支回并),删除发布分支。
- 紧急修复走 `hotfix/*`:从 `main` 切出,修复验证后 `--no-ff` 合入 `main` 并尽快发布,随后回并 `dev`。

## 分支保护建议

多人协作启用 GitHub 分支保护:`main` 与 `dev` 要求 PR 合入、至少 1 个评审批准,并将 lint/typecheck 设为必需检查;`main` 额外要求分支 up-to-date。单人维护期可暂缓,恢复协作时立即启用。

## 二进制与生成物

- 构建产物(`dist/`、`out/`、`node_modules/` 等)已被 gitignore,不进提交。
- 图标、logo 等二进制资源是源资产,随提交入库;重新生成时保留生成脚本与验证记录(如 bbox 校验),并在提交信息中说明生成方式。
- 大体积二进制不直接入库;确有需要时先评估 Git LFS 或外部托管。
