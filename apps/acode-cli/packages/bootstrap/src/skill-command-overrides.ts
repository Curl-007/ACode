// W1-R3：collectDisabledPaths 的实现已整体移入 @acode/cli-workflow（纯函数、无 bootstrap
// 内部耦合，见 specs/cli-workflow-package-boundary.md 宿主解耦规则 5）。本文件保留为
// re-export 接缝，既有消费方（custom-commands / skills / create-app / workflow-facade）
// 路径与形状不变；全仓单一定义在新包。
export { collectDisabledPaths } from "@acode/cli-workflow/contract";
