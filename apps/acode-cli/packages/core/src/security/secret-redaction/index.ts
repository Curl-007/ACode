/**
 * 转录密钥混淆模块（WI-17）。产品规则与红线见 specs/transcript-secret-obfuscation.md。
 * 语义移植自 oh-my-pi（MIT），各文件头单独署名。
 *
 * 桶面纪律（knip）：只导出运行时插点消费的符号——出站投影
 * （runtime/methods/runtime-model.ts）与执行前还原（tool/executor/call-runner.ts）。
 * 测试直接引用叶子模块；其余符号不经桶外露。
 */
export { formatUnresolvedSecretPlaceholderHint, getSecretRedactionService } from "./service.js";
