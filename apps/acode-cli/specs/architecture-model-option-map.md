# Model option map architecture boundary

## Scope

`packages/model-option-map` owns the restricted CEL tokenizer, parser, compiler cache,
evaluator, and ordered JSON merge-patch projection used by model execution. This batch
makes the package a managed architecture module without changing its runtime API.

## Ownership and invariants

- `model-option-map-compiler` is the single owner of compiled expression caches. Consumers
  call the typed functions from `src/contract.ts` or the compatibility `src/index.ts` barrel.
- The module is pure `domain`: it performs no filesystem, process, network, timer, or
  workspace-service IO and has no required workspace module dependencies.
- `compileModelOptionMaps` compiles at model creation and applies only the effective option
  values for each request. Invalid expressions, missing effective values, and non-object
  results fail closed with the existing typed errors.
- `parser.ts`, `tokenizer.ts`, and `evaluator.ts` are implementation details. A future
  consumer must not import them directly or create a second option-map cache.

## Public boundary

`src/contract.ts` is the managed public contract. `src/index.ts` re-exports that contract so
existing `@acode/model-option-map` imports remain source-compatible. The architecture policy
declares both files as public entrypoints while all other source files stay private.

## Acceptance scenarios

1. `pnpm architecture:check --changed` reports `model-option-map` as managed and produces no
   new violations for the package or its package-root consumers.
2. `pnpm --filter @acode/model-option-map typecheck` and existing model-option-map consumer
   tests continue to pass without changing evaluation semantics.
3. A cross-module import of `src/parser.ts` or another private source file is reported as a
   `deep-import`; importing the package root or `src/contract.ts` remains allowed.

## Migration boundary

This is the first managed batch for the package. Harness SDK, CUA, CLI subpackages, and other
legacy modules remain outside this boundary and must be migrated in separate batches with their
own owner, contract, layer map, and tests. No baseline refresh is used to hide new violations.
