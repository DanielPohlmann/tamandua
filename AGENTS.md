# AGENTS.md

Instructions for AI coding assistants and developers working on the tamandua codebase.

## Development

### Build and Install

```bash
# Build from source (checkout root):
./build              # npm install + tsc + inject-version
./install            # symlink ~/.local/bin/tamandua → this checkout
./build-and-install  # both steps at once
```

The `build` script requires Node.js >= 22. It runs `npm install` followed by `npm run build` (TypeScript compilation, HTML copy, version injection).

The `install` script delegates to `scripts/install.sh --local <pwd>` — it creates a symlink so `tamandua` on your PATH always uses the dist from your checkout. No global npm install, no GitHub clone needed.

```bash
# After editing source, rebuild:
./build

# Run tests:
npm test
```

## Project Structure

```
tamandua/
├── bin/tamandua                  # Shell wrapper
├── src/
│   ├── index.ts                  # Export entry
│   ├── db.ts                     # SQLite database (runs, steps, stories, worktrees, autoresearch sessions)
│   ├── autoresearch/
│   │   └── autoresearch.ts       # AutoResearch experiment engine (durable optimization loops, confidence scoring)
│   ├── cli/
│   │   ├── cli.ts                # Main CLI entry point
│   │   ├── ant.ts                # ASCII art easter egg
│   │   └── ant.test.ts           # Easter egg tests
│   ├── installer/
│   │   ├── install.ts            # Workflow installer
│   │   ├── uninstall.ts          # Workflow uninstaller
│   │   ├── agent-provision.ts    # Agent workspace provisioning
│   │   ├── agent-scheduler.ts    # Pi-based agent polling scheduler
│   │   ├── workflow-fetch.ts     # Fetch bundled workflows
│   │   ├── workflow-spec.ts      # Load/workflowspec from YAML
│   │   ├── workspace-files.ts    # File copy utilities
│   │   ├── step-ops.ts           # Step claim/complete/fail/pipeline logic
│   │   ├── run.ts                # Run creation
│   │   ├── status.ts             # Run status queries
│   │   ├── events.ts             # Event logging
│   │   ├── logs-tail-format.ts   # Shared logs-tail line formatting (CLI + dashboard API)
│   │   ├── worktree-manager.ts   # Managed git worktree creation/removal for runs
│   │   ├── run-harness.ts        # Harness (pi/hermes) invocation for runs
│   │   ├── rugpull.ts            # Relaunch-upon-rugpull handling
│   │   ├── pi-stream-parser.ts   # pi --mode json output stream parsing
│   │   ├── agent-cron.ts         # Agent cron job records
│   │   ├── paths.ts              # Path resolution
│   │   ├── types.ts              # Shared types
│   │   ├── pi-config.ts          # pi config reading
│   │   └── symlink.ts            # CLI symlink management
│   ├── server/
│   │   ├── daemon.ts             # Dashboard daemon process (co-manages dashboard + MCP listeners)
│   │   ├── daemonctl.ts          # Daemon lifecycle control
│   │   ├── dashboard.ts          # Dashboard HTTP server
│   │   ├── control-server.ts     # Daemon control plane (pause/resume/terminate runs)
│   │   ├── control-client.ts     # Client for the daemon control plane
│   │   ├── kanban-data.ts        # Kanban snapshot/card-detail builders
│   │   ├── mcp-server.ts         # Remote MCP HTTP server bootstrap (streamable transport)
│   │   ├── index.html            # Dashboard UI
│   │   └── kanban.html           # Kanban board UI (per-run)
│   ├── medic/
│   │   ├── medic.ts              # Health check orchestration
│   │   ├── checks.ts             # Individual health checks
│   │   └── medic-cron.ts         # Cron setup for medic
│   └── lib/
│       ├── logger.ts             # File logging
│       ├── logger.test.ts        # Logger tests
│       ├── frontend-detect.ts    # Frontend file detection
│       ├── home-dir.ts           # homeDir(): HOME-aware home resolution (use instead of os.homedir())
│       └── posix-shell.ts        # Git Bash discovery; runs .sh scripts on Windows without cmd's "open with"
├── workflows/                    # Bundled workflow definitions (worktree variants symlink agent dirs)
├── agents/shared/                # Shared agent personas (setup, pr, verifier — symlinked into workflows)
├── skills/                       # Bundled skills
├── docs/                         # User documentation
├── tests/                        # Integration tests
├── e2e-tests/                    # End-to-end tests (smoke + real; NOT part of npm test)
├── www/                          # Static website (tamandua.org)
├── scripts/                      # Build scripts
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

Tamandua is an agent team orchestrator built on top of pi (the coding agent CLI).

### Runtime model

- Agent settings live at `~/.pi/agent/settings.json`
- Work is dispatched via direct `pi --print` invocation (no gateway HTTP API)
- Sessions use `pi --print --session`
- Agent config lives in `~/.tamandua/agents.json`
- Permissions are expressed as role descriptions

### Agent Scheduler

The agent scheduler uses in-memory `setInterval` timers (not OS cron) to poll agents:

1. Polling phase: for run-scoped jobs the scheduler runs `peekStep()` in-process first and skips the round on NO_WORK, so no harness is launched (no plugins, MCP servers or model turn) when the agent has nothing pending. Otherwise the agent's prompt still starts with `step peek` → HAS_WORK or NO_WORK
2. Work phase: if HAS_WORK, spawns `pi --print` with the agent's workspace and prompt
3. `runPi` emits lifecycle logs (`pi pre-launch`, `pi launched`, `pi completed`/`pi execution failed`) with PID, timing, and bounded stream preview metadata for observability without dumping full prompts or large stderr payloads
4. `executePollingRound` emits stage logs (`Polling round skipped/start/complete/failed`) with shared round context (`jobId`, `agentId`, timeout/workdir/model when available) and bounded outcome/error previews
5. Polling rounds run pi in JSON mode (`--mode json`) so scheduler logic can extract `message_end.message.usage` token metadata and attribute increments to `runs.tokens_spent` using run IDs parsed from tool outputs (with step-id fallback).
   When the output names no run or step (claude's JSON result never does), a run-scoped job's own `runId` owns the tokens; only heartbeat rounds and jobs without a run go to system spend.
6. Successful token attribution emits a `run.tokens.updated` event (`tokenDelta` + `tokensSpent` fields); terminal run lifecycle events (`run.completed`/`run.failed`) also carry `tokensSpent` for cost visibility.

### Step Lifecycle

```
waiting → pending → running → done/failed
```

- Steps start as `waiting` (blocked by preceding steps)
- Pipeline advancement marks them `pending`
- Agent claims → `running`
- Agent completes → `done`, pipeline advances
- Agent fails → retry or escalate

### CLI Help Convention

Every CLI command and subcommand supports `--help` / `-h` through a shared infrastructure
in `src/cli/cli.ts` (canonical implementation: commit `bf326a5c015b4da479df83e87bbc2bd7c1063857`).

**Core infrastructure functions:**

- `hasHelpFlag(args: string[]): boolean` — detects `--help` or `-h` anywhere in `args`
- `printHelp(text: string): void` — writes `text` to stdout and exits with code 0
- `printHelpSubcommand(subcommands: Record<string, string>): void` — renders an aligned
  subcommand listing from a `{ name: description }` map

**Per-command help functions** follow the `get<Thing>Help()` naming convention:
one function per command or subcommand that returns a multi-line help string.
Examples: `getStepPeekHelp()`, `getWorkflowRunHelp()`, `getUpdateHelp()`,
`getDashboardStartHelp()`. The full pattern is `get{Group}{Action}Help` —
e.g. `getMcpStartHelp` covers `tamandua mcp start --help`.

**--help dispatch** runs at the very top of `main()` before any command execution,
I/O, or side effects (including update warnings). This guarantees `--help` is always
available and never triggers unintended operations.

**`getUsageText()`** (global usage, shown when no recognized command is passed with
`--help`) opens with: `Run tamandua <command> --help for detailed command help.`
followed by a top-level command listing.

**When adding or changing commands:** every new command or subcommand needs:
- A corresponding `get<Thing>Help()` function
- A `--help` dispatch if-block in `main()` (before the command execution path)

## State

- SQLite database: `~/.tamandua/tamandua.db`
- Agent config: `~/.tamandua/agents.json`
- Cron jobs: `~/.tamandua/cron-jobs.json`
- Events: `~/.tamandua/events.jsonl`
- Logs: `~/.tamandua/tamandua.log`
- Medic: `~/.tamandua/medic.json`

## Artifacts to Review on Changes

When making changes, review whether these artifacts need updating:

- `docs/creating-workflows.md` — user-facing workflow documentation
- `skills/tamandua-agents/SKILL.md` — provisioned to agents as AGENTS.md/IDENTITY.md/SOUL.md
- `src/server/mcp-server.ts` — MCP tools registered for agent use
- `src/cli/cli.ts` — CLI commands that agents invoke, and per-command help functions (`get<Thing>Help()`)
- `src/server/index.html` — dashboard UI
- `src/server/kanban.html` — kanban board UI
- `README.md` — project overview

Output format contract: agent output is classified by exact STATUS markers
(`STATUS: done`, `STATUS: failed`/`error`); missing markers cause the step to
be treated as lost/abandoned and retried. Bundled personas carry a
`## CRITICAL — STATUS Line Requirement` section — keep it when adding new
workflow agents (see docs/creating-workflows.md).

Changes that typically cascade to multiple artifacts:
- **Step lifecycle**: step claim/complete/fail/pipeline logic
- **CLI commands**: new or changed commands (step, workflow, logs, dashboard) — when adding/changing commands, verify the corresponding `get<Thing>Help()` is also updated and that the `--help` dispatch if-block exists in `main()`
- **Agent provisioning**: personas, workspace files, skill provisioning
- **Workflow structure**: new step types, loop wiring, pipeline ordering
- **Output format contracts**: agent output blocks (STATUS/CHANGES/TESTS)

If you update `skills/tamandua-agents/SKILL.md`, verify that bundled workflow persona AGENTS.md files reflect the change.

## Testing

```bash
# Run all tests (unit + integration)
npm test

# Or build first then test (tests import from dist/)
npm run build && npm test
```

Tests use Node's built-in `node:test` and `node:assert`.
Tests are safe for parallel execution with `node --test tests/*.test.ts src/**/*.test.ts`.

### End-to-End Tests

End-to-end tests live under `e2e-tests/`. There are **two kinds**, and the
distinction is critical:

| Test | Script | What it does | Duration |
|------|--------|--------------|----------|
| **Smoke (state-machine)** | `./run-all-smoke-e2e-tests` | Exercises workflow state machine, pipeline wiring, and step lifecycle using manual `step claim` / `step complete` with canned outputs. No real agents, models, or schedulers. | ~10–15 seconds |
| **Real (full pipeline)** | `./run-all-real-e2e-tests` | Launches actual Tamandua workflows that run through the full daemon → scheduler → pi agent pipeline. Uses real model invocations, real worktree creation, real git merges. | 30+ minutes per workflow |

`./run-all-e2e-tests` is the convenience alias — it runs the **smoke test only**
(fast, no tokens). It does NOT run the real e2e test.

#### Real End-to-End Test — Cost and Duration

The real e2e test (`./run-all-real-e2e-tests`) is **expensive**:
- **Tokens:** Spends real API tokens on model invocations (pi agents process
the full workflow autonomously — planning, implementing, verifying, testing,
and merging).
- **Time:** Expect 30–60 minutes for the full sequential run (feature-dev-merge
+ bug-fix-merge workflows).
- **System resources:** Creates real worktrees, runs npm install, executes
tests, and performs git merges.

#### Agent Default Behavior (READ THIS)

- **AGENTS MUST NOT RUN REAL E2E TESTS BY DEFAULT.** Only run `./run-all-tests`
or `npm test` when fulfilling routine development duties.
- If running e2e tests is required, run `./run-all-e2e-tests` (smoke only, fast).
- **Only run `./run-all-real-e2e-tests` when explicitly asked** — it spends
real tokens and takes 30+ minutes. Never infer or assume it should be run.

#### When Each Test Should Be Used

- **Smoke e2e:** Use during development to validate state machine changes,
step lifecycle logic, pipeline wiring fixes. Fast enough for every commit.
- **Real e2e:** Use when validating the full daemon/scheduler/agent pipeline
end-to-end, after major infrastructure changes, or when explicitly told to.
- **Neither is included in `npm test`** — both live under `e2e-tests/` and are
separate from the regular suite.
- **Neither is compiled by `tsconfig.json`** — they live outside `src/`.

### Parallel Test Safety

Tamandua is often used to develop and test itself. All tests use isolated temporary HOME and TAMANDUA_STATE_DIR directories, so PID/port files never conflict across parallel test files.

- **Random ports:** Tests that spawn listeners use `reserveRandomPort()` (bind-to-0). Normal tests must not bind, fetch, or probe default ports 3334/3338/3339.
- **Temp HOME isolation:** Use `fs.mkdtempSync()` for temporary HOME directories, pass `HOME` env to spawned subprocesses, clean up in `finally` blocks. Helpers that run CLI must use an explicit isolated env — do not fall back to `process.env`.
- **Scoped daemon control:** Pass `{ homeDir: tempHome }` or stop the exact child process handle created by the test. Never call lifecycle functions against real HOME; verify any PID belongs to the test environment before killing it.
- **Guard coverage:** `tests/test-isolation-guard.test.ts` scans for patterns that can touch the live daemon. Update it when adding new service lifecycle tests.
- **Resolve home with `homeDir()`, never `os.homedir()`.** `os.homedir()` reads `USERPROFILE` on Windows and ignores `HOME`, so on Windows code using it escaped the test's temp `HOME`: tests wrote the real `~/.tamandua` (pid/port files), `daemonctl` waited for pid files the daemons wrote elsewhere (hangs), and the daemons stayed alive as orphans. `homeDir()` (`src/lib/home-dir.ts`) is `HOME || os.homedir()`, identical on POSIX.
- **Stop every daemon a test brings up.** Starting a run (CLI or MCP `tamandua.run.start`) also starts the dashboard daemon; stop it (`dashboard stop`) in `finally` along with MCP / control plane. POSIX-only `after()` sweeps (`pgrep`, `/proc`) do nothing on Windows.
- **Ownership checks need a Windows path.** `/proc/<pid>/environ` exists only on Linux. `daemonctl`'s `processHomeMatches()` falls back on Windows to the process command line (tamandua server script + a port recorded in that home's port files); without it, `stop*({ homeDir })` refused to kill test daemons.
- **No `.sh` through `cmd.exe`.** `shell: true` on Windows runs cmd, which opens the "How do you want to open this file?" dialog for a `.sh` path. Pass shell commands through `windowsShellCommand()` (`src/lib/posix-shell.ts`), which hands `.sh` scripts to Git Bash (never the WSL `System32\bash.exe`; override with `TAMANDUA_BASH`).

### Windows Process Spawning

- **Never pass `detached: true` on Windows** to a process that runs other console programs (agents, shells). There it means `DETACHED_PROCESS`: the child gets no console, so every console tool it starts (node, bash, git, npm) opens a new visible window, and `windowsHide` only covers the direct child. Use `detached: process.platform !== "win32"` and kill trees with `killProcessTree()` (`taskkill /T /F`) from `src/installer/bash-step.ts`. Long-lived daemons spawned from the CLI (`daemonctl.ts`) stay detached so they outlive the CLI.
- **Pass `windowsHide: true` on every spawn** that can run inside the daemon (git, version checks, hooks): the daemon has no console, so each unhidden child flashes a window.
- **Non-detached children die with their parent on Windows** (libuv puts them in a kill-on-close job object), so agents now die when the daemon stops. Descendants that escape that job (spawned detached) are killed by `reapOrphanedDescendants()` when the agent exits.
- **`child.kill()` on Windows kills only the direct child**, not a shell's children; use `killProcessTree()` for timeouts.

`npm test` remains a convenience alias that runs the full parallel suite.

`src/server/mcp-server.ts` supports dependency injection via `createTamanduaMcpServer(..., { services })` / `startTamanduaMcpServer(..., { services })`; protocol tests in `src/server/mcp-server.test.ts` should use this hook instead of duplicating DB/event setup.

`src/server/daemon.ts` starts dashboard + MCP together (dashboard port from `~/.tamandua/port`, MCP fixed to 3338). Co-lifecycle regression coverage lives in `src/server/daemon.test.ts`.

Dashboard UI regressions are covered in `src/server/dashboard.test.ts` by fetching `/` from `createDashboardServer(...)` and asserting required HTML/script hooks (including logs-tail cursor polling markup).

`tests/workflow-validation.test.ts` validates bundled workflows: directory discovery, `workflow.yml` id matching, `workspace.files` path existence, skill wiring and frontmatter, README catalog entries (e.g., `feature-dev-merge-worktree`). Bundled workflow agents should declare `tamandua-agents` in `workspace.skills`, preserving any existing skills like `agent-browser`.
Step output parsing (`parseOutputKeyValues` in `src/installer/step-ops.ts`) lowercases keys, so an agent output like `ORIGINAL_BRANCH: main` is consumed downstream as `{{original_branch}}`.
Installer skill copy behavior (workflow-local + shared bundled skills) is covered in `tests/agent-skill-provisioning.test.ts`.

Integration tests (CLI and dashboard API) should spawn subprocesses with temp `HOME` and `TAMANDUA_STATE_DIR` to isolate event files, SQLite, and DB path resolution.
