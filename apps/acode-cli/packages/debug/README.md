# debug

Development-only trace and context viewer for ACode.

Run from the repository root:

```sh
pnpm --filter debug dev
```

The Hono API reads existing local diagnostics only:

- `~/.acode/cli/log/*.jsonl`
- `~/.acode/cli/db/db.sqlite`
- an optional session event JSONL file or directory selected in the UI

It does not modify agent runtime behavior or write back to the agent database.

The debug server also starts a local network capture proxy by default:

- API/UI: `http://127.0.0.1:4174`
- Proxy: `http://127.0.0.1:4184`
- Local CA: `packages/debug/certs/network-ca/certs/ca.pem`

Run the CLI you want to inspect with the environment values shown in the Network panel, usually `ACODE_HTTP_PROXY` and `ACODE_AGENT_CA_CERT`.

Why ACode-specific keys instead of the standard `HTTP_PROXY`/`SSL_CERT_FILE`: the agent runtime never inherits the standard proxy/CA variables — they are stripped at every subprocess boundary and re-derived only from these explicit `ACODE_*` keys inside controlled boundaries (see `apps/acode-cli/specs/subprocess-env-credential-allowlist.md`). Pointing the debug capture at the `ACODE_*` keys therefore routes exactly the boundaries you intend to inspect, and cannot silently re-anchor TLS trust for unrelated processes on your machine.

Failure modes: if the inspected CLI reports TLS errors or its traffic never shows up in the capture, check that both variables were present in the environment the CLI was **launched from** — exporting them in another shell afterwards never reaches a running process. The local CA (`packages/debug/certs/network-ca/certs/ca.pem`, private key alongside) is a development secret: anything that trusts it can be intercepted by whoever holds that key, so keep it out of OS/browser trust stores; it is already git-ignored.

Boundary and alternative: the capture proxy is a debug-only surface — it does not modify agent runtime behavior or write back to the agent database. When you only want log/DB inspection, disable it with `ACODE_DEBUG_NETWORK_CAPTURE=0` instead of leaving a MITM hop in front of the inspected process.
