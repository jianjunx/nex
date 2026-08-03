# CLAUDE.md

Nex is a Tauri 2 desktop app that wraps multiple AI coding agents (Claude
Code, Codex, Cursor CLI, etc.) into a single GUI workspace. The backend is
Rust; the frontend is React + TypeScript + CodeMirror + xterm.js.

## Build & run

```bash
# Install (one-time)
pnpm install

# Dev mode (GUI)
pnpm tauri dev
# or: pnpm dev:app

# Frontend-only tests
pnpm test                           # vitest run

# Backend tests
cd src-tauri && cargo test

# Lint
pnpm lint                           # oxlint (frontend)
cd src-tauri && cargo clippy --tests

# Production bundle (.dmg / .msi / .AppImage)
pnpm tauri build
```

## Architecture

### Backend (`src-tauri/src/`)

- `agent/` — agent plugin orchestration (the heart of the app)
  - `registry.rs` — fetches the open ACP registry
    (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`)
  - `node_runtime.rs` — self-managed Node.js runtime. Three impls:
    `SystemNodeRuntime` (which_in), `ManagedNodeRuntime` (downloads
    newest LTS from nodejs.org/dist/index.json with floor checks on
    v8/npm/openssl), `UnavailableNodeRuntime`. Version is discovered at
    runtime — **do not hardcode a Node version**.
  - `package_cache.rs` — per-agent npm install cache under
    `<app_data>/agent-packages/<id>/<spec>/`. Uses
    `package_name_from_spec` (not `sanitize`) for the actual
    `node_modules/<pkg>` lookup; LRU-evicts to keep 3 most-recent
    versions per agent.
  - `launch.rs` — `resolve_registry` returns `LaunchSpec` with
    `<node> <bin> <args>` (never `npx`). `LaunchSpec` flows to
    `spawn_agent` only; ACP adapter logs but doesn't inspect internals.
  - `shell_env.rs` — captures the user's login-shell PATH. Unix runs
    `$SHELL -ilc 'env -0'`; Windows runs `cmd /U /C set` (UTF-16LE).
  - `acp_adapter.rs` — ACP-over-stdio transport; `HANDSHAKE_TIMEOUT`
    is **120s** (first-install bootstrap can be slow).
  - `server.rs` — facade; `AgentSessionManager` is the only entry point.
- `commands/` — Tauri command handlers exposed to the frontend.
- `db/`, `git/`, `terminal/`, `watcher.rs`, `fs/` — DB / git / PTY /
  filesystem services.
- `error.rs` — `NexError` enum; the `AgentNotInstalled { what, hint }`
  variant surfaces user-actionable install failures.

### Frontend (`src/`)

- `bridge/tauri.ts` — TS mirror of Rust types + command functions.
- `stores/` — Zustand stores (agent, conversation, project, ui).
- `features/` — feature folders: `agent/`, `editor/`, `files/`,
  `git/`, `layout/`, `projects/`, `search/`, `settings/`,
  `terminal/`.
- `commands/` — TS-side command callers.
- `components/ui/` — shadcn-style primitives.

## Conventions

- Commit messages use Conventional Commits: `feat:`, `fix:`,
  `refactor:`, `style:`. Keep the subject line under ~80 chars. End
  every commit body with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- All commits use author `JJ.Xie <jj.xie@outlook.com>` (set per-repo
  via `git config user.{name,email}`, NOT global — corporate email
  `ztn.com` must never appear in this project's history).
- Backend uses `std::sync::Mutex` everywhere (matching house style);
  `tokio::sync::Mutex` is allowed only inside `PackageCache` for the
  in-flight install dedup map.
- Frontend tests live next to the file under test
  (`X.test.tsx` / `X.test.ts`); backend tests at the bottom of the
  same file under `#[cfg(test)] mod tests`.

## Things to remember when working in this repo

- **Never invoke `npx`.** Agents are spawned as `<node> <bin>` directly
  (the macOS / Windows GUI-process PATH bug is the entire reason this
  exists).
- **Never hardcode a Node version.** `ManagedNodeRuntime` discovers
  the newest LTS from `nodejs.org/dist/index.json` at runtime.
- **Windows URL naming:** Node publishes `win-x64` /
  `win-arm64` (not `windows-x86_64`). The `files` entries use
  artifact-specific names: `osx-arm64-tar`, `win-x64-zip`, etc.
  Both mappings live in `node_runtime.rs`.
- **The registry JSON is shared with Zed.** Don't fork the schema or
  add fields the Zed ACP adapter wouldn't understand.
- **ACP agent fields are flattened into `node_modules/<pkg>`**, not
  under a sanitized name. Use `package_name_from_spec` for the lookup;
  `sanitize` is only for cache-key subdirs.
- **Min Node version is `>=22.0.0`** (set in `MIN_NODE_VERSION`).
  Enforced by `SystemNodeRuntime::new`; the discover flow also
  filters on it.
- **Tauri's `setup` hook is sync.** Use
  `tauri::async_runtime::spawn` for any background work spawned
  there.
- **Tauri commands must return `Send` futures.** The ACP adapter
  uses `async_trait(?Send)` because the upstream `agent-client-protocol`
  API isn't `Send`; per-session work runs on a dedicated current-thread
  runtime inside `std::thread::Builder`.

## Open follow-ups

Not done yet — leave for dedicated PRs:

- Settings UI for `NodeBinaryOptions` (`allow_path_lookup`,
  `allow_binary_download`, `use_paths`).
- "Registry offline / cache is N hours old" UI indicator.
- Manual "clear agent cache" UI button (calls `PackageCache::sweep_lru`).
- Windows end-to-end verification on a Windows runner.
- Cache `nodejs.org/dist/index.json` to disk with a 24h TTL.