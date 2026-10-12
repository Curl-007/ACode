# Third-party materials

This directory holds the source material behind [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) and the third-party declarations shipped in build artifacts.

## Contents

| Path                       | Purpose                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory.json`           | Production dependency union across the workspace plus copied source/assets and native tools: exact versions, sources, hashes and the notice hash. Its `scope` field documents what it does and does not cover. |
| `copied-components.json`   | Source components copied into the repository (revision and upstream source).                                                                                                                                   |
| `embedded-components.json` | Components embedded inside dependencies (parent package, revision and source).                                                                                                                                 |
| `npm-overrides.json`       | Overridden npm packages with the exact upstream notice snapshot used for each.                                                                                                                                 |
| `native-search/`           | Native search tool sources and licence material (`sources.json`, `licenses/`).                                                                                                                                 |
| `runtime/`                 | Node runtime licence texts and source references (`sources.json`).                                                                                                                                             |
| `upstream/`                | Byte-exact upstream notice snapshots referenced by the inventory (sha256-named files).                                                                                                                         |

## Generating and checking

- Regenerate the notice file and verify freshness: `node scripts/licenses.mjs notices`
- Strict check (fails on incomplete or stale material): `node scripts/licenses.mjs notices --strict`

## Reproducibility check (single entry)

The ledger is only meaningful if regenerating it on the canonical CI platform reproduces the
committed bytes. That check has one implementation, in
[`scripts/third-party-reproducibility.mjs`](../scripts/third-party-reproducibility.mjs),
dispatched by `node scripts/licenses.mjs reproducibility`; no workflow keeps a second copy of
the logic.

| Mode        | Command                         | What it recomputes                                                                                  | Cost                                                                                        | Authority                                                                                      |
| ----------- | ------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| inputs-only | `reproducibility --inputs-only` | the `inputs` map: sha256 of every tracked repository source file, normalized `UTF-8 with CRLF → LF` | ~0.3s (2869 files, concurrent reads; ~0.4s wall clock including node startup), zero install | development signal only — cannot see dependency-tree fields                                    |
| full        | `reproducibility`               | full regeneration via `licenses.mjs notices`, then diff against the committed ledger                | CI Linux only (needs the installed tree + the musl libc patch)                              | **final authority** — the only mode that covers `packages`, `notInstalled` and `noticesSha256` |

Blocking levels:

- `ci.yml` verify runs **inputs-only** on every branch it already covers (`main`, `dev/**`,
  `release/**`, `hotfix/**`). Blocking there, but it is _not_ the release authority.
- `release.yml` verify runs **full** as its final gate step. Failure blocks publishing. This is
  what makes the "专项闸门在 release 分支的推送上全部 success" rule in
  [git-collaboration.md](../docs/git-collaboration.md) enforced by mechanism rather than by an
  operator remembering to dispatch a workflow.
- `licenses-notices.yml` keeps the musl patch, regeneration and artifact upload, and delegates
  its diff verdict to the same entry.

`--inputs-only` can be green while `full` is red. That is not a contradiction and must not be
papered over: dependency-tree drift (`pnpm-lock.yaml` moved but the ledger was not regenerated)
is invisible to inputs-only by construction. Acceptance scenario L06 in
[docs/upgrades/quality-and-release-2026-10.md](../docs/upgrades/quality-and-release-2026-10.md) pins
this boundary on purpose, so nobody later "fixes" it by claiming the local check replaces CI.

Repairs always adopt the CI-Linux regenerated artifact. Never commit a ledger regenerated on a
developer machine — line endings and platform-specific dependency variants reintroduce the very
mismatch the gate exists to catch.

## Paths filter coverage

The ledger tracks far more files than the `pull_request.paths` filter in
`licenses-notices.yml` lists, so a change to a tracked file may not trigger the gate at all.
Two lists that must agree were maintained by hand and had drifted apart
(455 of 2869 inputs covered — 15.9% — at the time U13 was filed). `node scripts/licenses.mjs
paths-filter` derives the filter from the ledger's `inputs` map so one of the two lists is
generated, and `paths-filter --coverage` reports the current coverage with a hard 100% gate.

## Where the notices ship

- Build artifacts keep the applicable `LICENSE` / `NOTICE` / `COPYING` files alongside their other declarations.
- The CLI distribution includes `THIRD-PARTY-NOTICES.md` next to the agent bundle.
- The server packaging stage writes `runtime/THIRD-PARTY-NOTICES.md`, `LICENSE.node.txt` and `NODE-SOURCES.json`, and keeps per-component notices under `licenses/<component>/THIRD-PARTY-NOTICES.md`.

## Limits

The inventory is a conservative union across distributions; not every listed component is included on every platform, and it is not a per-installer SBOM or a certification that all licence obligations are met for every use. Package metadata licence identifiers are descriptive; the original terms always prevail.
