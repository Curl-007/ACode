import type { Model, ModelRequest, ModelResult } from "./contract.js";

/**
 * 契约消费示例：宿主只依赖 contract.ts 暴露的 Model 端口完成一次文本生成，
 * 不接触任何 provider adapter 实现（golden-module contract.example.ts 同款手法）。
 */
export async function generateOnce(model: Model, request: ModelRequest): Promise<ModelResult> {
  return model.generateText(request);
}
