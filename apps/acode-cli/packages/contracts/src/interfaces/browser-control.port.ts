/**
 * BrowserControlPort —— agent 侧浏览器控制端口（契约桶）。
 *
 * 例外偿还（contracts-onboarding-max-file-lines-browser-control-port +
 * disable-count-browser-control-port）：本文件原为 546 行单体（行 1 的 max-lines 禁用头注
 * 已随拆分删除），已拆为 3 个叶子并降为纯 barrel，
 * 公开导出面逐名不变：
 *   - browser-backend：backend descriptor、viewport 限制、discovery/session context
 *   - browser-command：command method 词汇、playwright 动作、录制选项与动作
 *   - browser-command-result：BrowserCommand 联合、执行结果形态与 BrowserControlPort 端口本身
 * 依赖单向：browser-command / browser-command-result → browser-backend（结果叶再依赖命令叶），
 * 叶子只向前指，本文件只 re-export，无叶子回边。跨叶符号不相交。
 *
 * 类型说明：BrowserCommand/BrowserCommandResult 与 @acode/shared 的 browser-use 契约同构。
 * 此处定义结构镜像（不 import @acode/shared，避免 agent contracts 的 zod v3 与 shared zod v4
 * 跨包耦合）；协议边界用 shared 的 zod schema 做运行时校验，两侧一致性由 round-trip 测保证。
 */

export * from "./browser-backend.js";
export * from "./browser-command.js";
export * from "./browser-command-result.js";
