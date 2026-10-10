/**
 * formal-proof 模块清单：ACode 输入裁决模型的形式化证明可视化应用。
 *
 * model.ts 是纯函数决策模型（ProductContext × Candidate → Decision 裁决表 +
 * trace 树构建），main.ts 是 d3 渲染入口（vite 应用，不出包）；对外唯一包导出
 * 是 "./model"。本模块零 workspace 依赖，消费方只有 apps/acode-cli bootstrap
 * 的裁决表对齐注释（非代码依赖）。依赖声明与 architecture-policy.yaml 保持
 * 一致：requires: []。
 */
export const formalProofModule = {
  id: "formal-proof",
  requires: [],
  provides: ["formal-proof-model"],
  publicEntrypoints: ["contract.ts", "model.ts"],
} as const;
