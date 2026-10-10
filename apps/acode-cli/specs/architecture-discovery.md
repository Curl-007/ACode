# Architecture dependency discovery

## Scope

The architecture checker resolves workspace package imports and TypeScript path
aliases for every module declared in `architecture-policy.yaml`. A module root
often points at a package's `src/` directory, while the package manifest and
`tsconfig` live at the package or repository root. Discovery must therefore
search from the common repository ancestor of all policy roots, not only below
each source root.

The policy must also list every repository package that is part of the product
surface, even while it remains `managed: false`. Legacy coverage is explicit:
the current package set includes `harness-sdk`, `model-option-map`, and the
generated JavaScript surface of `acode-cua`.

## Ownership and invariants

- `scripts/architecture/discovery.mjs` owns discovery. The checker consumes its
  result and does not maintain a second package or alias index.
- The search root is the deepest common ancestor of policy roots. It is bounded
  to the repository tree and skips generated/vendor directories.
- Every discovered workspace package is keyed by its manifest `name` and points
  to the manifest directory. A package import resolves through that package's
  `src/` tree using the existing source-file resolver.
- Every `tsconfig*.json` below the search root contributes its declared `paths`
  entries. Duplicate entries are removed deterministically.
- Architecture context output uses each dependency module's declared public
  entrypoints first; it falls back to a `contract.ts` only for legacy modules
  without an entrypoint. A private nested `contract.ts` must never be presented
  as the dependency contract when the policy names another public file.
- Missing, malformed, or unreadable manifests/configs are ignored as before;
  discovery never turns an architecture check into a runtime dependency.

## Acceptance scenarios

1. A policy root at `packages/foo/src` resolves `@acme/bar` when the sibling
   package manifest is at `packages/bar/package.json`.
2. A policy root at `apps/acode-cli/packages/contracts/src` discovers the
   repository and nested package manifests without requiring a second policy
   root at every package directory.
3. A `tsconfig.json` or nested `tsconfig.*.json` outside a module's `src`
   directory contributes its aliases.
4. A malformed manifest/config and a skipped `node_modules` directory do not
   change the check result or throw; repository `.acode/` user state is skipped
   as well.
