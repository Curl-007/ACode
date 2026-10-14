# Third-party notices

## scripts/ — derived from the ZCode computer-use plugin SDK

The five SDK modules under `scripts/` (`computer-use-client.mjs`,
`computer-use-errors.mjs`, `computer-use-envelope.mjs`, `computer-use-keys.mjs`,
`computer-use-target.mjs`) and `scripts/check-sdk.mjs` derive from the
`computer-use` plugin v0.6.3 published by Z.ai on the `zcode-plugins-official`
plugin marketplace (upstream package `@zcode/zcode-cua-plugin`, `"license":
"MIT"`, author `Z.ai`). Upstream shipped the SDK as a single 1208-line
`scripts/computer-use-client.mjs` plus a 4-line smoke check.

Local changes:

- the monolithic SDK was split into the five modules listed above, with a
  one-way acyclic dependency direction (`client → errors/envelope/target/keys`,
  `target → errors/envelope/keys`, `envelope → errors`);
- `check-sdk.mjs` was expanded from the upstream 4-line stub into the 25-line
  module-presence plus import smoke test;
- brand and wiring identifiers were renamed from the upstream `zcode` forms to
  this repository's `acode` forms, to match the host that actually loads this
  plugin: the bridge symbol
  `Symbol.for("acode.node-repl.computer-use-bridge")` (matching
  `node-repl-host/src/cua-bridge.ts`), the `ACODE_CUA_PLUGIN_ROOT`,
  `ACODE_CUA_PERMISSION_BROKER_SOCKET` and `ACODE_CUA_HELPER_BUILD_ID`
  environment variables and the `__ACODE_CUA_HELPER_BUILD_ID__` build define
  (matching `node-repl-host/src/server.ts` and
  `node-repl-host/scripts/build.mjs`), the `\\.\pipe\acode-node-repl-cua-<uuid>`
  named-pipe prefix (matching `node-repl-host/src/cua-broker.ts`), and
  user-visible "ZCode" wording, now "ACode".

## LICENSE

The upstream plugin package ships no LICENSE file; its MIT licensing is
declared in its `package.json` and in `.acode-plugin/plugin.json` (`"license":
"MIT"`, author `Z.ai`). The `LICENSE` at the root of this plugin reproduces the
standard MIT text verbatim as published by the same official marketplace
(`video2code` 0.6.0 plugin, `Copyright (c) 2026 Z.ai`), so the upstream
copyright and permission notice travels with the derived SDK modules as the MIT
License requires.

## skills/, docs/ — rewritten

`skills/computer-use/SKILL.md` and `docs/computer-use.md` were rewritten for
this repository against the checked-out host source
(`apps/acode-cli/packages/node-repl-host/`, `packages/acode-cua/`), replacing
the corresponding upstream documents rather than copying them. They describe
the same tool contract as upstream, restated for this repository's identifiers,
package layout and fail-closed runtime posture.
