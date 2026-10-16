/**
 * renderer 内容状态面包屑的 wire 契约（specs：packages/desktop/specs/
 * main-stall-diagnostics.md R11；spec 是唯一事实源）。
 *
 * 独立叶子模块：channels.ts 的 PlatformChannelMap 与 platform.ts 的
 * IPlatformService.sendContentBreadcrumb 共同消费本类型；channels → platform
 * 已有导入边，platform 不得反向导入 channels（避免环），故契约落在叶子。
 *
 * 桶化理由：精确值既是噪声（每条消息都 diff）又是隐私面（内容规模细节），
 * 日志只落桶名。main 侧运行时校验 fail-closed（desktop contentBreadcrumb.ts 的
 * parseContentBreadcrumbPayload）：任一字段缺失/类型错/闭集外 ⇒ 整条丢弃。
 */
export interface ContentBreadcrumbWirePayload {
  route_kind: "chat" | "settings" | "browser" | "other";
  transcript_msgs_bucket: "zero" | "small" | "medium" | "large" | "huge";
  composer_blocks_bucket: "zero" | "few" | "many";
  rows_held_bucket: "zero" | "small" | "medium" | "large";
}
