# Auth 浏览器打开器：Windows 命令注入防护（R2-01）

状态：已实现。范围：`src/auth/browser.ts`、`src/auth/cli-oauth.ts`。

## 背景

`acode auth login`（Windows）用 `openUrlInBrowser(initData.authorize_url)` 打开网络返回的
OAuth 授权 URL。原实现在 win32 分支用 `cmd.exe /c start "" <url>`——cmd.exe 按 `"` 切换引号态，
authorize_url 内嵌裸双引号即可逃逸引号态，其后 `&calc&` 作为新命令在 CLI 用户上下文执行
（finding R2-01，P2）。这是同仓 `bootstrap/src/app/platform-open-port.ts`（H1，2026-10-04）
已修模式的漏修第二副本。

## 产品规则

- Windows 打开系统 URL/文件必须经非 shell opener（`explorer.exe`），argv 经 CreateProcess 传递，
  无元字符解释层。**禁止**经 `cmd.exe` / `start` 等 shell 形态打开任何来自网络或用户的字符串。
- 非 Windows 分支保持原 opener：darwin=`open`、linux=`xdg-open`。
- OAuth init 响应的 `authorize_url` 校验为 fail-closed：必须是 https，且**不得含裸双引号**
  （合法 https URL 的双引号应已 percent-encode 为 `%22`）。

## 状态所有者与接口

- `browserOpenCommand(platform, url)` 是唯一的 opener 命令构造点，返回 `{executable, args}`。
- `parseInitData` 是 authorize_url 的唯一校验点，在 URL 流向 opener 前执行。
- 两道防线独立：opener 层（explorer.exe 非 shell）+ 校验层（拒裸双引号）。任一层单独即可挡下
  注入；纵深防御要求两层都在。

## 验收场景

- 不变量：`browser.ts` 源码不出现 `executable: "cmd(.exe)"`、不出现 `"start"` 参数字面量，
  且包含 `explorer.exe`。（防回归到漏洞写法）
- 行为：`authorize_url = 'https://x/?q="&calc&"'` 在 win32 分支产出 argv
  `["explorer.exe", <完整 URL>]`，URL 作为单个参数原样传递，不真启动进程。
- 测试见 `tests/browser-open-command-injection.test.ts`。
