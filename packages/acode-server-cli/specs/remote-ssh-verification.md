# Remote SSH verification command

## Contract

`pnpm --filter @acode/server-cli verify:remote-ssh` is the discoverable entry
point for the existing Docker based remote verification harness. It runs the
Linux x64 staged release archive through an Ubuntu `sshd` container and checks
SSH connectivity, daemon readiness, loopback binding, the replayable `/ws`
upgrade, the one time `/ws/host` capability ticket, node-pty loading, and
ready-to-stopped lifecycle cleanup.

The command is an external environment gate. It must fail with a clear missing
archive or Docker error and must never silently skip verification. The archive
is prepared explicitly with `pnpm --filter @acode/server-cli stage
--target linux-x64`; `--target linux-arm64` remains available by invoking the
underlying script directly. `--keep` is for local debugging only.

## Ownership and cleanup

- `scripts/verify-remote-ssh.mjs` owns container, tunnel, temporary key, and
  cleanup sequencing.
- The package script only provides the stable command name and target default;
  it does not duplicate verifier logic or persist credentials.
- A failed check cleans the temporary container, tunnel, and key unless the
  verifier was explicitly run with `--keep`.

## Acceptance scenarios

1. With Docker and a staged archive present, the package command invokes the
   verifier with `--target linux-x64`.
2. Without Docker or the archive, the command exits non-zero and names the
   missing prerequisite.
3. The verifier remains independently callable for `linux-arm64` and `--keep`.
