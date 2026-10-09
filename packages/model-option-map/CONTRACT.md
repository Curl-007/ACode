# Model option map 契约

`contract.ts` 是模型选项映射模块唯一的治理入口；`index.ts` 仅作为现有包根导入
的兼容转发。模块负责把受限 CEL 表达式编译成可复用程序，并在请求边界将有效的
`reasoningLevel` 与 `maxOutputTokens` 应用为 JSON merge patch。

`compileRestrictedCel`、`compileModelOptionMap` 和 `compileModelOptionMaps` 是纯函数
式 API。编译缓存属于模块内部状态，由编译器 owner 维护；调用方不得复制缓存或直接
依赖 `parser.ts`、`tokenizer.ts`、`evaluator.ts` 的实现。表达式非法、结果不是 JSON
对象或选项缺失时抛出稳定的 `RestrictedCelError`/`ModelOptionMapError`，不回退到未校验
的原始请求体。

本批将模块纳入 managed architecture 检查：所有源码位于单一 `domain` 层、无外部
副作用和工作区依赖，跨模块调用必须经过包根 `index.ts` 或 `contract.ts`。变更公开
类型或求值语义时，先更新 `apps/acode-cli/specs/architecture-model-option-map.md`
与对应测试，再调整实现。
