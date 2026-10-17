import { z } from "zod";

// 该 schema 同时被 validation 聚合入口和 legacy protocol 使用，必须放在无反向依赖的叶子模块。
// 根因：protocol 从 validation 导入它，而 validation 又导入 protocol 的资源采样 schema，
// ESM/Jiti 在 clean Docker 中会先读到尚未初始化的 binding，导致 `.optional()` 启动即崩溃。
// dontAsk = P1 权限裁决批2 的「拒绝代替询问」模式：ask 漏斗收敛为 deny，不弹窗。
// automationRepo 持久化断言面与协议面共用本闭集，扩集即两处同时生效。
export const acodeTaskModeSchema = z.enum([
  "yolo",
  "plan",
  "edit",
  "auto",
  "autoEdit",
  "build",
  "dontAsk",
]);
