# ACode

<div align="center">
  <img src="public/logo/acode.svg" alt="ACode" width="96" height="96" />
  <p><strong>AI coding workspace: desktop · browser · terminal</strong></p>
</div>
<p align="center">
  <a href="README.zh-CN.md">简体中文</a> | English
</p>

ACode is an AI coding workspace with desktop, browser, and terminal interfaces. This repository contains the full source code — clients, backend services, shared UI, and the Agent CLI and runtime — maintained independently by the repository owner.

## Highlights

- **No monitoring or telemetry**: roughly 26k lines of monitoring/telemetry implementation removed (ARMS RUM, OTLP reporting, crash collection, resource and network sampling, UI instrumentation), with regression checks keeping those exits from coming back.
- **Vendor services off by default**: account sign-in, feedback, coding plans, official MCP, and the plugin marketplace are all off by default, each with its own switch in Settings.
- **No unconsented data egress**: snapshot packaging, encryption, and direct-upload paths were reviewed across the repository; this version has no unconsented data egress implementation.
- **Transparent source builds**: desktop clients and the CLI distribution are built with GitHub Actions from this repository's source, with artifacts published to Releases.

### What was removed

Compared with the open-source baseline, this repository contains **no monitoring or telemetry implementation**:

| Area                        | Removed                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client monitoring SDK       | Alibaba Cloud ARMS RUM (`@arms/rum-electron`), its patch, initialization, route instrumentation, and renderer bridges                                   |
| Usage and network telemetry | Network metric aggregation and reporting, API event ingestion, host/scheduler forwarding, remote-session usage sampling                                 |
| Resource and performance    | Periodic resource sampling, memory diagnostics, data-size stats, TTFT export, MCP telemetry                                                             |
| Crash collection            | Crash dump reporting, OOM annotations, stability telemetry                                                                                              |
| CLI telemetry               | The entire `@acode/telemetry` package (OTLP export, model API recording, agent metrics and traces)                                                      |
| UI instrumentation          | All session-open, subscription-error, automation, prompt-template, and user-action instrumentation, plus the platform reporting methods and IPC bridges |
| Protocol and configuration  | Telemetry event protocols and reporting paths; added filtering so legacy telemetry environment variables cannot re-enter the agent                      |

**Kept on purpose**: local logs (for troubleshooting), user-initiated feedback, and normal business requests (model calls, update checks). The device identifier is used only for business identity and local locks.

**Verification**: the change passes `pnpm typecheck`, `pnpm lint` (0 errors), and per-module regression tests. Full lists and verification limits are in the removal reports: [desktop](packages/desktop/specs/telemetry-removal-report.md), [CLI](apps/acode-cli/specs/telemetry-removal-report.md), [UI](packages/ui/specs/telemetry-removal-report.md).

### Local credential protection

Sign-in tokens and paid API keys are stored in `~/.acode/v2/credentials.json`, encrypted with AES-256-GCM (the `enc:v2:` format). The encryption master key is **no longer** derived offline from machine attributes (platform / home directory / username) — previously any process that could read that file could reconstruct every credential purely offline. The key source is now, by priority:

1. the `ACODE_CREDENTIAL_SECRET` environment variable (only honored when no key file exists yet);
2. a per-install random key file `~/.acode/v2/credential-key.json` (32 bytes, `0600`, generated on first use).

**Two data-loss risks you must know about:**

- **`credential-key.json` lives or dies with your credentials.** Deleting it, or backing up / migrating by copying `credentials.json` but forgetting the key file, makes every `enc:v2:` credential **permanently unrecoverable**. Treat the two files as one unit and back them up together. The app's built-in data-directory migration (switching `ACODE_DATA_BASE_DIR`) carries the key file automatically — no manual step needed.
- **Rolling back to an older version silently corrupts your sign-in.** An older build only recognizes the `enc:v1:` prefix; on an `enc:v2:` value it returns the **ciphertext verbatim as plaintext** — which surfaces as a mysteriously broken login (401) or an invalid API key, not a clear error. After upgrading to this version, do not roll back to a pre-upgrade build; if you must, sign out on the desktop first, then sign in again on the old version.

Because the key file sits on the same disk as the ciphertext, this scheme does **not** protect against "the whole `.acode` directory being exfiltrated" (cloud sync, backup leaks, disk images). True "separation of ciphertext and key" requires an OS keychain (Electron `safeStorage` / keytar), which first needs the synchronous cipher interface made asynchronous and the cross-process key-agreement problem solved (the desktop host and the CLI are two processes sharing one credential file). That is future work — see [`packages/services/specs/credential-storage.md`](packages/services/specs/credential-storage.md).

## Download and install

The [Releases](https://github.com/Curl-007/ACode/releases) page ships desktop clients (macOS / Windows / Linux) and the CLI distribution.

**About signing**: the builds are **not code-signed**, so the operating system blocks the first launch. That is expected — allow it once per platform as below. You can verify the download against the `sha256.txt` on the release page before allowing it.

### macOS (.dmg)

1. Download `ACode-*-mac-arm64.dmg` (Apple Silicon) or `ACode-*-mac-x64.dmg` (Intel), open it and drag ACode into Applications.
2. The app is unsigned, so Gatekeeper will say the developer cannot be verified (or that the app is damaged). **After dragging the app into Applications**, run the command below (enter your login password when asked; nothing is shown while typing):

   ```bash
   # One-time command (unblocks and launches; it exits immediately):
   sudo /usr/bin/xattr -rd com.apple.quarantine "/Applications/ACode.app" && open -a "ACode"
   ```

   The absolute `/usr/bin/xattr` path avoids shadowing by other tools with the same name (for example the Python xattr package), which fail with "option -r not recognized". Alternatively, right-click (Control-click) the app in Finder → Open → click Open again in the dialog. Afterwards it launches normally with a double-click.

### Windows (.exe)

1. Download `ACode-*-win-x64.exe` and double-click it.
2. The installer is unsigned, so SmartScreen shows the "Windows protected your PC" warning. Click **More info** → **Run anyway** and finish the installer.

   This is the expected prompt, not a sign of corruption; you can also verify the installer against the `sha256.txt` from the release page first.

### Linux (.AppImage)

Pick the build that matches your CPU architecture: `ACode-*-linux-x86_64.AppImage` (Intel / AMD) or `ACode-*-linux-arm64.AppImage` (arm64 / aarch64).

```bash
# x86_64 (Intel / AMD)
chmod +x ACode-*-linux-x86_64.AppImage
./ACode-*-linux-x86_64.AppImage

# arm64 (aarch64)
chmod +x ACode-*-linux-arm64.AppImage
./ACode-*-linux-arm64.AppImage
```

### CLI distribution (.tar.gz)

The CLI distribution is a self-contained bundle (TUI + Web + Agent) and needs Node.js 24; the install script and runtime code can both be reviewed in this repository:

```bash
tar -xzf acode-*.tar.gz
cd acode
./install.sh        # installs the acode command (defaults to ~/.acode/runtime, entry in ~/.local/bin)
acode --help        # or run directly: node bin/acode.mjs --help
```

## Build and Release

- **GitHub builds**: this repository builds from source with GitHub Actions, and CLI distributions are published to [Releases](https://github.com/Curl-007/ACode/releases). Every artifact comes from the source in this repository.
- **Release flow**: run the [Release](.github/workflows/release.yml) workflow manually in Actions. Enter `0.0.1` with pre-release checked to get `0.0.1-audit.<date>` (repeat builds on the same day get `.2`, `.3`, …; the full form `0.0.1-audit.20260922[.2]` is also accepted). With pre-release unchecked it publishes the stable `v0.0.1` (clean tag, GitHub Latest, so `/releases/latest` works). Release notes always lead with "what changed vs the baseline", then the install steps — the English block first, an exact Chinese mirror below — and the downloads list last. Every artifact is uploaded into a **draft** release first; the release is published only after the CLI and all desktop platform artifacts are uploaded, and a failed build leaves it as a draft, so download pages never resolve to a still-building version.

The branch model, commit conventions, and the full merge-and-release procedure are defined in [docs/git-collaboration.md](docs/git-collaboration.md): `main` is the release branch, feature work lands on `dev` via squash merges, and releases go through `release/*` branches.

---

## Development

One codebase serves three interfaces:

| Interface                    | Purpose                                                                                   | Development command            |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| Desktop                      | Electron desktop application                                                              | `pnpm dev:desktop`             |
| Web / ACode CLI distribution | Terminal and browser workspace; packages the TUI, Web client, backend, and Agent together | `pnpm dev:web`                 |
| Agent CLI                    | The `acode` terminal interface, which also provides the Agent runtime for Desktop and Web | `pnpm --filter @acode/cli dev` |

## Setup

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) is the source of truth for tool versions. Run all development and packaging commands below from the repository root.

```bash
pnpm bootstrap
```

`pnpm bootstrap` installs workspace dependencies, prepares local desktop runtime assets, and runs `build:bootstrap`.

The Agent CLI and runtime source code lives in [apps/acode-cli/](apps/acode-cli/) as a regular directory included when you clone this repository. No separate checkout or Git submodule initialization is required.

Additional setup and build commands:

| Command                        | Purpose                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                 | Install dependencies                                                                                                                |
| `pnpm prepare:desktop-runtime` | Prepare desktop runtime assets, including remote assets by default                                                                  |
| `pnpm prepare:remote-assets`   | Prepare remote runtime assets separately                                                                                            |
| `pnpm bootstrap:with-remote`   | Set up dependencies and local and remote assets, then build the relevant packages sequentially; skip the desktop application bundle |
| `pnpm build`                   | Recursively run each workspace package's build script, including its asset preparation steps                                        |

The default `bootstrap` skips remote asset preparation and is suitable for local desktop development. Run the corresponding preparation command when working with remote workspaces or validating remote distribution assets.

## Development and Usage

### Desktop

```bash
pnpm dev:desktop

# Use the test environment
pnpm dev:desktop:test

# Run the desktop agent as compiled V8 bytecode (the production form)
pnpm dev:desktop:bytecode
```

`pnpm dev:desktop` defaults to `pnpm dev:desktop:prod` and uses production service configuration. The startup script prepares local runtime assets, builds the desktop Agent, then starts Electron and source watchers.

Set `ACODE_DATA_BASE_DIR` to use a separate development data directory. For example, on macOS / Linux:

```bash
ACODE_DATA_BASE_DIR="$HOME/.acode-dev-home" pnpm dev:desktop:test
```

### Remote features (SSH/WSL)

Run `pnpm bootstrap:with-remote` first to prepare remote assets (mock-cdn), then `pnpm dev:desktop`; when connecting to a remote project, choose "download locally and upload" for assets. In development, assets come from the local `packages/desktop/mock-cdn` and local build outputs, uploaded to the remote host over SFTP without touching a CDN.

### Web Development

Use development mode when editing Web or backend source code:

```bash
pnpm dev:web

# Set the backend workspace (macOS / Linux)
ACODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

This starts both the Web development server (default: `http://localhost:5173`) and the backend (default: `http://localhost:3030`). Open the Web development server in your browser. `/ws` and general `/api` requests are proxied to the local backend; `/api/v1/oauth/token` is proxied separately to the configured product service.

After changing Agent source code, run `pnpm --filter @acode/cli... build` and restart the service. To validate the complete distribution, extract and run it as described under Packaging → ACode CLI distribution below.

### ACode CLI distribution

The command-line distribution includes the TUI, Web client, and Agent behind one `acode` command. With no arguments it starts the TUI; a leading `--web` starts Web mode; all other arguments go to the existing Agent CLI. Both modes run locally without Electron.

```bash
# Start the terminal UI by default
acode

# Start the Web interface
acode --web

# Set the project and port without opening a browser automatically
acode --web --workspace /path/to/project --port 3030 --no-open

# Show CLI or Web options
acode --help
acode --web --help
```

In Web mode, it uses the current directory as the workspace, listens on `127.0.0.1` without token authentication by default, selects an available port, and opens a browser. Use the URL printed in the terminal and press `Ctrl+C` to stop the service. For LAN access, use `--host 0.0.0.0`; listening on a non-local address generates an access token by default. Use the token-bearing URL printed in the terminal. Set a token with `--token`, or disable token authentication with `--no-token`.

Authentication is fail-closed: the server refuses to start when it would bind a non-loopback address (for example `--host 0.0.0.0`) without a token, so `--no-token` is only valid for loopback binds. When it does start on loopback without a token, it prints a loud "no auth, loopback only" warning at startup, because any local process or browser page can then reach it.

When starting the general Web service's HTTP entry directly, configure API/WebSocket authentication with `ACODE_SERVER_AUTH_TOKEN`. When creating the service programmatically, use the `authToken` option. Send the token in an `Authorization: Bearer <token>` header; the `?token=` URL query still works for backward compatibility but is deprecated (it leaks into logs, browser history and `Referer`) and logs a deprecation warning. The `acode_lite_token` cookie remains supported as a browser-compatibility path. To allow a trusted reverse proxy or LAN origin to redeem the trusted-host `/ws/host` upgrade, list full origins in `ACODE_SERVER_ALLOWED_ORIGINS` (comma-separated); browser upgrades carrying any other `Origin` are rejected.

See Packaging below for build instructions. `pnpm build:acode` only creates the distribution; it does not replace an existing `acode` on `PATH`. If the command still points to an older installation or another checkout, check it with `command -v acode` on macOS / Linux or `where.exe acode` on Windows.

### CLI Source Development

Use the source entry when developing the TUI or Agent:

```bash
pnpm --filter @acode/cli dev --help
pnpm --filter @acode/cli dev

# Build the CLI and its workspace dependencies
pnpm --filter @acode/cli... build
node apps/acode-cli/packages/cli/dist/acode.cjs --help
```

This entry runs the Agent CLI directly and does not handle the distribution's `--web` switch. Use `pnpm dev:web` for Web development, or the extracted `bin/acode.mjs` shown below to test the unified command.

Plugin, MCP-server, and hooks configuration for the `acode` CLI is documented in [apps/acode-cli/README.md](apps/acode-cli/README.md).

## Quality gates

Run from the repository root; `pnpm verify:pre-push` is the minimum gate before pushing. There is no repository-wide test command — test entry points follow each package's `package.json` and the actual test files next to the source.

| Command                                 | Purpose                                       |
| --------------------------------------- | --------------------------------------------- |
| `pnpm typecheck`                        | TypeScript project-references type check      |
| `pnpm lint` / `pnpm lint:fix`           | Lint and auto-fix (oxlint)                    |
| `pnpm fmt:check` / `pnpm fmt`           | Format check and format (oxfmt)               |
| `pnpm verify:pre-push`                  | Lint + architecture check (pre-push gate)     |
| `pnpm architecture:check -- --changed`  | Architecture boundary check for changed files |
| `pnpm architecture:context <module-id>` | Bounded reading context for a module          |
| `pnpm knip`                             | Unused dependencies and exports report        |
| `pnpm dep:refs --list-exports <file>`   | List a file's exports and their references    |

## Configuration

The root [.env.example](.env.example) provides sample service URLs and build configuration. Copy it to `.env` as needed and place local overrides in `.env.local`. Select the Desktop development environment with `dev:desktop:test` or `dev:desktop:prod`.

| Setting                              | Purpose                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `ACODE_DATA_BASE_DIR`                | Base directory for application data, stored under its `.acode/` subdirectory            |
| `ACODE_SERVER_WORKSPACE`             | Workspace path for the Web backend                                                      |
| `ACODE_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider configuration file; uses the built-in configuration when unset |
| `ACODE_DIST_BASE_URL`                | Download base URL used by the CLI distribution installer                                |

Runtime variables can be set explicitly in the environment of the startup command. See [config/README.md](config/README.md) for the default configuration shipped with the client.

## Packaging

See [third-party/README.md](third-party/README.md) for notice generation, distribution checks, and where the notices are included in each distribution.

### Desktop

```bash
pnpm bundle:desktop

# Set the target platform and CPU architecture
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

The default target is macOS arm64, and the default output directory is `packages/desktop/dist/`. `--os` accepts `mac`, `win`, or `linux`; `--arch` accepts `x64` or `arm64`. Packaging and signing require the tools and configuration for the target platform.

Desktop bundles compile the agent to V8 bytecode on the build host for faster startup; cross-builds (host platform ≠ target platform) and E2E coverage builds fall back to the plain JS bundle automatically. See [`packages/desktop/specs/agent-bytecode-production.md`](packages/desktop/specs/agent-bytecode-production.md).

To install: open the produced DMG and drag ACode into Applications. Local builds are unsigned; if macOS blocks the first launch, run:

```bash
sudo /usr/bin/xattr -rd com.apple.quarantine /Applications/ACode.app && open -a "ACode"
```

### ACode CLI distribution

Run `pnpm build:acode` to build the CLI/TUI, backend, and Web client, collect the TUI native libraries, workers, and runtime dependencies, then assemble the distribution. Running the distribution still requires Node.js; use the version specified in `mise.toml`.

Before packaging, set the download base URL with `ACODE_DIST_BASE_URL` in `.env`, `.env.local`, or the process environment, or pass it through `--base-url`. The URL below is a placeholder; replace it with your hosting URL when publishing:

```bash
pnpm build:acode --base-url https://downloads.example.com/acode/

# When ACODE_DIST_BASE_URL is already configured
pnpm build:acode

# Repackage existing Agent, backend, and Web build outputs
pnpm build:acode --skip-build

# Show options for the version, output directory, and more
pnpm build:acode --help
```

The version defaults to the root `package.json` version. Output is written to `dist/acode/`:

- `releases/<version>/acode-<version>.tar.gz`: runtime package.
- `releases/<version>/sha256.txt`: checksum file.
- `latest.json` and `install.sh`: version index and installer.

Upload the entire directory to the configured download base URL. The installer downloads the runtime package from that URL, installs it to `~/.acode/runtime` by default, and creates the `acode` command in `~/.local/bin`. Override these directories with `ACODE_DIST_HOME` and `ACODE_DIST_BIN_DIR`, respectively.

To test a packaged build locally, extract and run it directly without uploading or installing it:

```bash
acode_version=$(node -p "require('./dist/acode/latest.json').version")
mkdir -p dist/acode/debug
tar -xzf "dist/acode/releases/$acode_version/acode-$acode_version.tar.gz" \
  -C dist/acode/debug
# Start the TUI by default
node dist/acode/debug/acode/bin/acode.mjs

# Start Web mode
node dist/acode/debug/acode/bin/acode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

Open `http://127.0.0.1:3030` to validate the complete flow, with one backend serving the Web pages and running the Agent. The port must be available; if `pnpm dev:web` is already running, choose another `--port`.

## Repository Structure

| Directory                          | Responsibility                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop`                 | Electron Main, Host, Renderer, and desktop packaging                                                                                                                             |
| `packages/web`                     | Web client                                                                                                                                                                       |
| `packages/server`                  | HTTP / WebSocket services and remote connections                                                                                                                                 |
| `packages/acode-server-cli`        | Remote-server-side CLI and supervisor                                                                                                                                            |
| `packages/ui`                      | Shared React components, hooks, and Zustand state                                                                                                                                |
| `packages/services`                | Business services and persistence                                                                                                                                                |
| `packages/shared`                  | Shared protocols and types (including the Desktop–Agent protocol)                                                                                                                |
| `packages/rpc`                     | RPC framework                                                                                                                                                                    |
| `packages/client`                  | Agent client SDK                                                                                                                                                                 |
| `packages/provider`                | Provider account and configuration services                                                                                                                                      |
| `packages/provider-node`           | Node-side materialization of builtin provider configuration                                                                                                                      |
| `packages/model-option-map`        | Parsing, compilation, and evaluation of model option maps                                                                                                                        |
| `packages/acode-cua`               | CUA (Computer Use) placeholder package; every surface is fail-closed in this build                                                                                               |
| `packages/formal-proof`            | Formal-proof models and UI                                                                                                                                                       |
| `apps/acode-cli`                   | Agent CLI, TUI, runtime, and tools — a nested workspace whose packages (`core`, `adapters`, `contracts`, `cli`, `tui`, `dynamic-workflow`, …) live in `apps/acode-cli/packages/` |
| `scripts`, `config`, `third-party` | Build and maintenance scripts, built-in configuration, and third-party notice materials                                                                                          |
| `docs`                             | Engineering plans, handoffs, and verification records (see Documentation below)                                                                                                  |

## Documentation

Top-level guides:

- [AGENTS.md](AGENTS.md) — working conventions for contributors and AI sessions: spec-first workflow, verification requirements, module boundaries, and logging rules.
- [CONTEXT.md](CONTEXT.md) — domain vocabulary for the plugin-store surfaces; read before changing related UI.
- [DESIGN.md](DESIGN.md) — UI design specification; read before UI changes.
- [docs/git-collaboration.md](docs/git-collaboration.md) — branch model, commit conventions, and the merge-and-release flow.

Engineering documents in [docs/](docs/) record the plans, implementation status, handoffs, and verification records of the major hardening and upgrade tracks:

| Document                                                                                              | Content                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [security-hardening-plan.md](docs/security-hardening-plan.md)                                         | Prioritized (P0–P3) security hardening roadmap based on line-by-line source review                                                            |
| [security-hardening-handoff.md](docs/security-hardening-handoff.md)                                   | Implementation status, verification commands, and handoff notes for the security hardening batches                                            |
| [security-scan-triage-2026-09-29.md](docs/security-scan-triage-2026-09-29.md)                         | Triage of all 118 findings from the sealed deep security scan: false positive / by-design / mitigated / residual                              |
| [j5-performance-baseline.md](docs/j5-performance-baseline.md)                                         | Agent CLI performance and resource baseline across four runtime forms, plus the implemented levers (production V8 bytecode, token estimation) |
| [jcode-inspired-upgrade-plan.md](docs/jcode-inspired-upgrade-plan.md)                                 | Defensive-mechanism upgrade roadmap: bash target blast-radius gating, confirm reflex gates, typed workflow artifacts, provider doctor         |
| [jcode-upgrade-handoff.md](docs/jcode-upgrade-handoff.md)                                             | Per-item implementation status, review findings, and follow-ups for that upgrade                                                              |
| [cli-dispatch-and-system-prompt-upgrade-plan.md](docs/cli-dispatch-and-system-prompt-upgrade-plan.md) | Agent dispatch and system-prompt upgrade roadmap with per-item implementation status                                                          |
| [renderer-memory-soak-2026-10-01.md](docs/renderer-memory-soak-2026-10-01.md)                         | Renderer memory-leak root cause, fixes, and live-machine verification                                                                         |

Behavior changes follow a spec-first convention: product rules, state owners, interfaces, and acceptance scenarios are written down before the code, in per-module specs under `packages/*/specs/` and `apps/acode-cli/specs/` — for example the [telemetry removal reports](packages/desktop/specs/telemetry-removal-report.md) and the [credential storage spec](packages/services/specs/credential-storage.md).

## License

First-party code is licensed under **MIT** (see [LICENSE](LICENSE)). The repository contains code derived from the ACode open-source baseline, which stays under **Apache-2.0** (full text in [LICENSE-APACHE](LICENSE-APACHE)), with the original copyright and attribution notices retained. Third-party component licensing is listed in [NOTICE.md](NOTICE.md).

## Project Notice

See [NOTICE.md](NOTICE.md) for feature and promotion scope, maintenance policy, execution and data risks, licensing, and third-party copyright information.
