# Claude Code CLI Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Claude Code CLI (`claude -p`) as a third agent harness and make it the default, keeping `pi` and `hermes` selectable by flag.

**Architecture:** The multi-harness abstraction (`HarnessType`) is preserved. `"claude"` joins `"pi" | "hermes"` and becomes the default everywhere a harness is resolved (run creation, cron-job metadata, polling-round context). A new `runClaude()` invokes `claude -p "<prompt>" --output-format json --dangerously-skip-permissions [--model <m>]`, buffers the single JSON result object, and feeds it through an extended `parsePollingRoundMetadata()` that reads `.result` (assistant text) and `.usage` (tokens). No workflow YAML or persona files change.

**Tech Stack:** TypeScript (ESM, Node.js >= 22), compiled with `tsc` to `dist/`. Tests use the built-in `node:test` runner and import from the compiled `dist/` tree. SQLite via `node:sqlite`.

## Global Constraints

- **Node.js >= 22.** Do not introduce dependencies outside the existing set (`@modelcontextprotocol/sdk`, `json5`, `yaml`). Tamandua is zero-runtime-dependency by design.
- **Build before test.** Tests import from `dist/`. The cycle is: edit `src/**`, run `npm run build`, then run tests. The build script uses `cp`/`chmod`/`rm`, so **run all `npm`/`node` commands through the Bash tool (bash), not PowerShell.**
- **Run one test file:** `node --test <path/to/file.test.ts>`. If Node reports a TypeScript syntax error, use `node --test --experimental-strip-types <path/to/file.test.ts>`. Full suite: `npm test`.
- **Preserve pi/hermes behavior.** `--pi-as-harness` and `--hermes-as-harness` must keep working exactly as before. Only the *default* changes to `claude`.
- **Keep file names `pi-*.ts` as-is** (`pi-command-preview.ts`, `pi-stream-parser.ts`, `pi-config.ts`). No renames in this plan — minimize diff/risk.
- **Unix-only runtime is fine.** Process-group termination and PATH binary discovery stay Unix-oriented, matching existing code. No cross-platform work.
- **Commit after each task** with a `feat:`/`test:`/`docs:` prefix and this trailer line:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Branch:** all work lands on `feat/claude-code-harness` (already created and checked out).

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/installer/types.ts` | Shared types incl. `HarnessType` | Add `"claude"` |
| `src/installer/agent-scheduler.ts` | Binary discovery, harness execution, routing, token parsing | Add `findClaudeBinary`, `runClaude`, claude routing branch, claude-result parsing, default→claude, extend `extractTokenUsage` |
| `src/installer/run-harness.ts` | Scheduling-time validation + `getRunHarnessType` | Validate claude binary; default→claude |
| `src/installer/run.ts` | Run creation, writes `harness_type` into context | Default→claude |
| `src/cli/workflow-run-args.ts` | Parse `workflow run` flags | Add `--claude-as-harness`, 3-way mutex |
| `src/cli/cli.ts` | CLI help + `harnessAs`→`harnessType` | Help text; accept `"claude"` |
| `src/installer/install.ts` | Workflow install | `readPiConfig()` best-effort |
| `README.md`, `skills/tamandua-agents/SKILL.md` | User docs | Harness default, requirements, diagram |
| Test files (see tasks) | Regression coverage | New + updated |

---

### Task 1: Extend `HarnessType` and token-usage key coverage

**Files:**
- Modify: `src/installer/types.ts:1`
- Modify: `src/installer/agent-scheduler.ts` (function `extractTokenUsage`, ~lines 862-880)
- Test: `src/installer/agent-scheduler-claude-usage.test.ts` (create)

**Interfaces:**
- Produces: `HarnessType = "pi" | "hermes" | "claude"`. `extractTokenUsage(usageLike: unknown): number | null` now also sums Claude usage keys `cache_creation_input_tokens` and `cache_read_input_tokens`.

- [ ] **Step 1: Write the failing test**

Create `src/installer/agent-scheduler-claude-usage.test.ts`:

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractTokenUsage } from "../../dist/installer/agent-scheduler.js";

describe("extractTokenUsage — Claude usage shape", () => {
  it("sums input, output, and Claude cache token keys", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    };
    assert.equal(extractTokenUsage(usage), 200);
  });

  it("handles Claude usage with only input/output", () => {
    assert.equal(extractTokenUsage({ input_tokens: 10, output_tokens: 5 }), 15);
  });

  it("returns null for empty/irrelevant object", () => {
    assert.equal(extractTokenUsage({ foo: 1 }), null);
  });
});
```

- [ ] **Step 2: Build and run test to verify it fails**

Run: `npm run build && node --test src/installer/agent-scheduler-claude-usage.test.ts`
Expected: FAIL — the cache-key test returns `150` (cache keys not summed) instead of `200`.

- [ ] **Step 3: Add `"claude"` to `HarnessType`**

In `src/installer/types.ts:1`, change:

```typescript
export type HarnessType = "pi" | "hermes";
```

to:

```typescript
export type HarnessType = "pi" | "hermes" | "claude";
```

- [ ] **Step 4: Extend `extractTokenUsage` cache keys**

In `src/installer/agent-scheduler.ts`, inside `extractTokenUsage`, update the `parts` array so the cache-read/cache-write lookups include Claude's key names:

```typescript
  const parts: Array<number | null> = [
    firstNumeric(usage, ["input", "inputTokens", "input_tokens", "prompt_tokens"]),
    firstNumeric(usage, ["output", "outputTokens", "output_tokens", "completion_tokens"]),
    firstNumeric(usage, ["cacheRead", "cache_read", "cache_read_tokens", "cache_read_input_tokens"]),
    firstNumeric(usage, ["cacheWrite", "cache_write", "cache_write_tokens", "cache_creation_input_tokens"]),
  ];
```

- [ ] **Step 5: Build and run test to verify it passes**

Run: `npm run build && node --test src/installer/agent-scheduler-claude-usage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/installer/types.ts src/installer/agent-scheduler.ts src/installer/agent-scheduler-claude-usage.test.ts
git commit -m "feat: add claude HarnessType and Claude cache-token key coverage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Parse Claude's `--output-format json` result in `parsePollingRoundMetadata`

**Files:**
- Modify: `src/installer/agent-scheduler.ts` (function `parsePollingRoundMetadata`, ~lines 934-1008)
- Test: `src/installer/agent-scheduler-claude-parse.test.ts` (create)

**Interfaces:**
- Consumes: `extractTokenUsage` (Task 1), `PollingRoundMetadata` type (existing).
- Produces: `parsePollingRoundMetadata(output)` now recognizes a single Claude result object (`{type:"result", result, usage}`) and returns `assistantOutput` = `.result`, `tokenUsage` from `.usage`, `jsonMetadataDetected: true`.

- [ ] **Step 1: Write the failing test**

Create `src/installer/agent-scheduler-claude-parse.test.ts`:

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePollingRoundMetadata } from "../../dist/installer/agent-scheduler.js";

describe("parsePollingRoundMetadata — Claude result object", () => {
  it("extracts .result as assistantOutput and .usage as tokenUsage", () => {
    const claudeOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "HEARTBEAT_OK",
      session_id: "abc",
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const md = parsePollingRoundMetadata(claudeOutput);
    assert.equal(md.assistantOutput, "HEARTBEAT_OK");
    assert.equal(md.tokenUsage, 150);
    assert.equal(md.jsonMetadataDetected, true);
  });

  it("handles pretty-printed (multi-line) Claude result JSON", () => {
    const claudeOutput = JSON.stringify(
      {
        type: "result",
        result: "STATUS: done\nCHANGES: x",
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 10 },
      },
      null,
      2,
    );
    const md = parsePollingRoundMetadata(claudeOutput);
    assert.equal(md.assistantOutput, "STATUS: done\nCHANGES: x");
    assert.equal(md.tokenUsage, 20);
  });

  it("still parses legacy pi JSONL (message_end) output", () => {
    const piOutput = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
        usage: { input: 3, output: 2 },
      },
    });
    const md = parsePollingRoundMetadata(piOutput);
    assert.equal(md.assistantOutput, "HEARTBEAT_OK");
    assert.equal(md.tokenUsage, 5);
  });
});
```

- [ ] **Step 2: Build and run test to verify it fails**

Run: `npm run build && node --test src/installer/agent-scheduler-claude-parse.test.ts`
Expected: FAIL — Claude cases fail because the whole object is treated as a single JSONL "event" and `.result`/`.usage` are not extracted (`assistantOutput` ends up as the raw JSON, `tokenUsage` null). The pi case passes.

- [ ] **Step 3: Add the Claude-result branch**

In `src/installer/agent-scheduler.ts`, inside `parsePollingRoundMetadata`, immediately **after** the empty-output early return (the block returning when `normalized.length === 0`) and **before** the `const lines = normalized.split(...)` line, insert:

```typescript
  // Claude Code (`--output-format json`) emits a single JSON result object,
  // not the pi JSONL event stream. Detect and handle it first.
  try {
    const whole = asRecord(JSON.parse(normalized));
    if (
      whole &&
      (whole.type === "result" ||
        (typeof whole.result === "string" && asRecord(whole.usage)))
    ) {
      const resultText =
        typeof whole.result === "string" ? whole.result.trim() : "";
      const assistantOutput = resultText.length > 0 ? resultText : normalized;
      const tokenUsage = extractTokenUsage(whole.usage);
      const hints = extractIdentifierHints(`${assistantOutput}\n${normalized}`);
      return {
        assistantOutput,
        tokenUsage,
        runId: hints.runId,
        stepId: hints.stepId,
        jsonMetadataDetected: true,
      };
    }
  } catch {
    // Not a single JSON object — fall through to pi JSONL / text handling.
  }
```

- [ ] **Step 4: Build and run test to verify it passes**

Run: `npm run build && node --test src/installer/agent-scheduler-claude-parse.test.ts`
Expected: PASS (3 tests, including the legacy pi case).

- [ ] **Step 5: Guard against regressions in the existing parser test**

Run: `npm run build && node --test src/installer/pi-stream-parser-extra.test.ts tests/parse-polling-metadata.test.ts`
Expected: PASS (existing pi parsing untouched).

- [ ] **Step 6: Commit**

```bash
git add src/installer/agent-scheduler.ts src/installer/agent-scheduler-claude-parse.test.ts
git commit -m "feat: parse Claude --output-format json result in polling metadata

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add `findClaudeBinary` and `runClaude`

**Files:**
- Modify: `src/installer/agent-scheduler.ts` (add near `findHermesBinary` ~line 154 and `runHermes` ~line 398; extend `RunPiOptions` ~line 187)
- Test: `src/installer/agent-scheduler-claude-exec.test.ts` (create)

**Interfaces:**
- Produces:
  - `findClaudeBinary(): string` — **synchronous** (mirrors `findHermesBinary`). Honors `TAMANDUA_CLAUDE_BINARY` (must be executable), else searches `PATH` for `claude`. Throws with a clear message otherwise.
  - `runClaude(prompt: string, options?: RunPiOptions): Promise<string>` — spawns `claude -p "<prompt>" --output-format json --dangerously-skip-permissions [--model <options.model>]`, buffers stdout, returns it trimmed (the raw JSON result object).
  - `RunPiOptions` gains optional `model?: string`.

- [ ] **Step 1: Write the failing test**

Create `src/installer/agent-scheduler-claude-exec.test.ts`:

```typescript
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  findClaudeBinary,
  runClaude,
} from "../../dist/installer/agent-scheduler.js";

function makeMockBinary(binPath: string, behavior: string): void {
  fs.writeFileSync(binPath, `#!/bin/sh\n${behavior}\n`, { mode: 0o755 });
}

describe("findClaudeBinary", () => {
  let saved: string | undefined;
  let savedPath: string | undefined;
  beforeEach(() => {
    saved = process.env.TAMANDUA_CLAUDE_BINARY;
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TAMANDUA_CLAUDE_BINARY;
    else process.env.TAMANDUA_CLAUDE_BINARY = saved;
    if (savedPath !== undefined) process.env.PATH = savedPath;
  });

  it("respects TAMANDUA_CLAUDE_BINARY when executable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-"));
    const bin = path.join(dir, "claude-custom");
    makeMockBinary(bin, "echo hi");
    process.env.TAMANDUA_CLAUDE_BINARY = bin;
    assert.equal(findClaudeBinary(), bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws when TAMANDUA_CLAUDE_BINARY set but not executable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-"));
    const bin = path.join(dir, "claude-broken");
    fs.writeFileSync(bin, "#!/bin/sh\necho hi\n", { mode: 0o644 });
    process.env.TAMANDUA_CLAUDE_BINARY = bin;
    assert.throws(() => findClaudeBinary(), /TAMANDUA_CLAUDE_BINARY set but not executable/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("searches PATH for claude", () => {
    delete process.env.TAMANDUA_CLAUDE_BINARY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-"));
    const bin = path.join(dir, "claude");
    makeMockBinary(bin, "echo claude");
    process.env.PATH = `${dir}:${savedPath ?? ""}`;
    assert.equal(findClaudeBinary(), bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws clear error when claude not found", () => {
    delete process.env.TAMANDUA_CLAUDE_BINARY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-"));
    process.env.PATH = dir;
    assert.throws(() => findClaudeBinary(), /claude binary not found in PATH/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runClaude", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.TAMANDUA_CLAUDE_BINARY; });
  afterEach(() => {
    if (saved === undefined) delete process.env.TAMANDUA_CLAUDE_BINARY;
    else process.env.TAMANDUA_CLAUDE_BINARY = saved;
  });

  it("invokes claude with -p, --output-format json, --dangerously-skip-permissions and returns stdout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-run-"));
    const argsLog = path.join(dir, "args.log");
    const bin = path.join(dir, "claude");
    // Log args, then emit a Claude-style result object.
    makeMockBinary(
      bin,
      `echo "$@" >> "${argsLog}"; printf '{"type":"result","result":"HEARTBEAT_OK","usage":{"input_tokens":1,"output_tokens":1}}'`,
    );
    process.env.TAMANDUA_CLAUDE_BINARY = bin;

    const out = await runClaude("PROMPT_TEXT", { timeout: 30, workdir: dir });
    const args = fs.readFileSync(argsLog, "utf-8");

    assert.ok(args.includes("-p"), "should pass -p");
    assert.ok(args.includes("--output-format json"), "should pass --output-format json");
    assert.ok(args.includes("--dangerously-skip-permissions"), "should skip permissions");
    assert.ok(out.includes('"type":"result"'), "returns raw JSON result");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes --model when options.model is set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-run-"));
    const argsLog = path.join(dir, "args.log");
    const bin = path.join(dir, "claude");
    makeMockBinary(bin, `echo "$@" >> "${argsLog}"; printf '{"type":"result","result":"ok"}'`);
    process.env.TAMANDUA_CLAUDE_BINARY = bin;

    await runClaude("PROMPT", { timeout: 30, workdir: dir, model: "sonnet" });
    const args = fs.readFileSync(argsLog, "utf-8");
    assert.ok(args.includes("--model sonnet"), "should pass --model sonnet");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Build and run test to verify it fails**

Run: `npm run build && node --test src/installer/agent-scheduler-claude-exec.test.ts`
Expected: FAIL — `findClaudeBinary`/`runClaude` are not exported (`undefined is not a function`).

- [ ] **Step 3: Add `findClaudeBinary`**

In `src/installer/agent-scheduler.ts`, immediately after the `findHermesBinary` function (ends ~line 183), add:

```typescript
// ── claude binary discovery ───────────────────────────────────────

export function findClaudeBinary(): string {
  const envClaude = process.env.TAMANDUA_CLAUDE_BINARY?.trim();
  if (envClaude) {
    try {
      fs.accessSync(envClaude, fs.constants.X_OK);
      return envClaude;
    } catch {
      throw new Error(
        `TAMANDUA_CLAUDE_BINARY set but not executable: ${envClaude}`
      );
    }
  }

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }

  throw new Error(
    "claude binary not found in PATH. Install the Claude Code CLI (https://code.claude.com) or set TAMANDUA_CLAUDE_BINARY."
  );
}
```

- [ ] **Step 4: Add `model` to `RunPiOptions`**

In `src/installer/agent-scheduler.ts`, in the `RunPiOptions` interface (~line 187), add the field:

```typescript
export interface RunPiOptions {
  timeout?: number; // seconds, default 60
  workdir?: string;
  env?: Record<string, string>;
  /** Optional model passed to `claude --model` (claude harness only). */
  model?: string;
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
}
```

- [ ] **Step 5: Add `runClaude`**

In `src/installer/agent-scheduler.ts`, immediately after the `runHermes` function (ends ~line 577), add. This mirrors `runHermes`'s process handling (detached group, timeout kill, bounded buffers) but builds Claude args and returns the raw stdout:

```typescript
// ── Claude Code execution ─────────────────────────────────────────

export async function runClaude(
  prompt: string,
  options: RunPiOptions = {},
): Promise<string> {
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const claudePath = findClaudeBinary();

  const childEnv: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...(options.env ?? {}),
  };

  const startedAt = Date.now();

  // Single-shot, fully autonomous invocation:
  // -p <prompt>                     print mode, prompt as positional arg
  // --output-format json            single JSON result object (result + usage)
  // --dangerously-skip-permissions  no interactive prompts (background agent)
  // --model <m>                     only when a concrete model is requested
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--dangerously-skip-permissions",
  ];
  if (options.model && options.model !== "default") {
    args.push("--model", options.model);
  }

  const preview = formatPiCommandPreview(claudePath, args);
  logger.info("claude pre-launch", {
    harness: "claude",
    commandPreview: preview.commandPreview,
    promptElided: preview.promptElided,
    argCount: preview.argCount,
    timeoutMs,
    workdir: options.workdir,
  });

  const child = spawn(claudePath, args, {
    cwd: options.workdir ?? process.cwd(),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const childPid = child.pid;
  const pgid = childPid ?? 0;

  if (childPid && options.onSpawn) {
    try {
      options.onSpawn({ pid: childPid, pgid });
    } catch (err) {
      logger.warn("claude onSpawn callback threw", { error: String(err) });
    }
  }

  logger.info("claude launched", {
    harness: "claude",
    pid: childPid ?? null,
    pgid,
    timeoutMs,
    workdir: options.workdir,
  });

  // Prompt is passed as an argument; close stdin immediately.
  child.stdin?.end();

  let stderrPieces: string[] = [];
  let stderrBytes = 0;
  const MAX_STDERR_BYTES = 10 * 1024 * 1024;
  child.stderr?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    if (stderrBytes + Buffer.byteLength(str, "utf-8") <= MAX_STDERR_BYTES) {
      stderrPieces.push(str);
      stderrBytes += Buffer.byteLength(str, "utf-8");
    }
  });

  let stdoutPieces: string[] = [];
  let stdoutBytes = 0;
  const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
  child.stdout?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    if (stdoutBytes + Buffer.byteLength(str, "utf-8") <= MAX_STDOUT_BYTES) {
      stdoutPieces.push(str);
      stdoutBytes += Buffer.byteLength(str, "utf-8");
    }
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (pgid) {
        safeKillPgid(pgid, "SIGTERM");
        setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
      } else {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0 || code === null) {
        resolve();
      } else {
        const failureStderr = stderrPieces.join("");
        const failureStderrMeta = buildStreamLogMetadata(failureStderr);
        logger.error("claude execution failed", {
          harness: "claude",
          pid: childPid ?? null,
          pgid,
          exitCode: code,
          signal,
          durationMs: Date.now() - startedAt,
          stderrBytes: failureStderrMeta.bytes,
          stderrPreview: failureStderrMeta.preview,
          stderrTruncated: failureStderrMeta.truncated,
        });
        const stderrSuffix = failureStderr ? `\nstderr: ${failureStderr}` : "";
        reject(new Error(`claude failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`));
      }
    });
  });

  const durationMs = Date.now() - startedAt;
  const rawStdout = stdoutPieces.join("").trim();
  const stderrOut = stderrPieces.join("");
  const stderrMeta = buildStreamLogMetadata(stderrOut);

  if (stderrMeta.preview) {
    logger.warn("claude stderr", {
      harness: "claude",
      pid: childPid ?? null,
      stderrBytes: stderrMeta.bytes,
      stderrPreview: stderrMeta.preview,
      stderrTruncated: stderrMeta.truncated,
    });
  }

  const stdoutMeta = buildStreamLogMetadata(rawStdout);
  logger.info("claude completed", {
    harness: "claude",
    pid: childPid ?? null,
    pgid,
    durationMs,
    exitCode: child.exitCode,
    signal: child.signalCode,
    stdoutBytes: stdoutMeta.bytes,
    stdoutPreview: stdoutMeta.preview,
    stdoutTruncated: stdoutMeta.truncated,
    stderrBytes: stderrMeta.bytes,
    hasStderr: stderrMeta.bytes > 0,
  });

  return rawStdout;
}
```

- [ ] **Step 6: Build and run test to verify it passes**

Run: `npm run build && node --test src/installer/agent-scheduler-claude-exec.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Verify actual claude flags (if `claude` is installed)**

Run: `command -v claude && claude --help 2>&1 | grep -E -- '--output-format|--dangerously-skip-permissions|--model|-p, --print' || echo "claude not installed — flags assumed from spec"`
Expected: the four flags appear in help, OR the "not installed" note. If any flag name differs, update `runClaude`'s `args` and re-run Step 6 before committing.

- [ ] **Step 8: Commit**

```bash
git add src/installer/agent-scheduler.ts src/installer/agent-scheduler-claude-exec.test.ts
git commit -m "feat: add findClaudeBinary and runClaude execution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Route to `runClaude` and default the polling layer to claude

**Files:**
- Modify: `src/installer/agent-scheduler.ts` — `buildPollingRoundContext` (~line 1305), `executePollingRound` dispatch (~lines 1419-1453), `createAgentCronJob` harness read (~lines 1585-1598)
- Modify: `src/installer/agent-scheduler-harness-routing.test.ts` (update default expectations + add claude dispatch test)

**Interfaces:**
- Consumes: `runClaude` (Task 3), `findClaudeBinary` (Task 3).
- Produces: when a job's `harnessType` is `"claude"` (or unset), `executePollingRound` calls `runClaude`. `buildPollingRoundContext` returns `harnessType: "claude"` when unset. `createAgentCronJob` resolves `"claude"` from run context and defaults to `"claude"`.

- [ ] **Step 1: Update the harness-routing test (defaults + claude dispatch)**

In `src/installer/agent-scheduler-harness-routing.test.ts`:

(a) Change the default-context assertion. Replace the test body of `"defaults harnessType to 'pi' when not set on job"` (lines 77-94) so its title and assertion use claude:

```typescript
  it("defaults harnessType to 'claude' when not set on job", () => {
    const job: CronJobInfo = {
      id: "test-job",
      workflowId: "wf-1",
      runId: "run-1",
      agentId: "wf-1_test-agent",
      intervalMinutes: 5,
      // harnessType intentionally omitted
      createdAt: new Date().toISOString(),
    };
    const agent = makeAgent();

    const context = buildPollingRoundContext(
      job, agent, 60, "/tmp/work", undefined,
    );

    assert.equal(context.harnessType, "claude");
  });
```

(b) Replace the `"dispatches to runPi when harnessType is missing (defaults to pi)"` test (lines 233-270) with a claude-default dispatch test. Add a mock `claude` binary in `beforeEach` alongside the pi mock — insert after the pi mock block (after line 138):

```typescript
    // Create mock claude binary
    const claudePath = path.join(tempHome, "claude-mock");
    const claudeLog = path.join(tempHome, "claude-args.log");
    makeMockBinary(claudePath, `echo "$@" >> "${claudeLog}"; printf '{"type":"result","result":"HEARTBEAT_OK","usage":{"input_tokens":1,"output_tokens":1}}'`);
    process.env.TAMANDUA_CLAUDE_BINARY = claudePath;
```

Then also save/restore `TAMANDUA_CLAUDE_BINARY` in this describe's `beforeEach`/`afterEach` (mirror the existing `savedPiBinary` pattern with a `savedClaudeBinary` variable). Now replace the missing-harness test:

```typescript
  it("dispatches to runClaude when harnessType is missing (defaults to claude)", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "run-default-dispatch";
    const db = getDb();
    const nowDefault = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify({
      working_directory_for_harness: workdir,
      // no harness_type
    }), nowDefault, nowDefault);

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });
    assert.ok(result.ok);

    const claudeLog = path.join(tempHome, "claude-args.log");
    await executePollingRound(
      { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", intervalMinutes: 5, harnessType: undefined, workingDirectoryForHarness: workdir, createdAt: "" },
      makeAgent(),
      workflow,
    );

    const claudeArgs = fs.readFileSync(claudeLog, "utf-8");
    assert.ok(claudeArgs.includes("--output-format json"), "claude should be invoked by default");

    await removeRunCrons(runId);
  });

  it("dispatches to runClaude when harnessType is 'claude'", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "run-claude-dispatch";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify({
      harness_type: "claude",
      working_directory_for_harness: workdir,
    }), now, now);

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });
    assert.ok(result.ok);

    const claudeLog = path.join(tempHome, "claude-args.log");
    const job = { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", intervalMinutes: 5, harnessType: "claude" as const, workingDirectoryForHarness: workdir, createdAt: "" };
    await executePollingRound(job, makeAgent(), workflow);

    const claudeArgs = fs.readFileSync(claudeLog, "utf-8");
    assert.ok(claudeArgs.includes("-p"), "claude should be invoked with -p");
    assert.ok(claudeArgs.includes("--dangerously-skip-permissions"), "claude should skip permissions");

    await removeRunCrons(runId);
  });
```

Note: the `"dispatches to runPi when harnessType is 'pi'"` and hermes tests stay as-is — pi/hermes must still route correctly.

- [ ] **Step 2: Build and run test to verify it fails**

Run: `npm run build && node --test src/installer/agent-scheduler-harness-routing.test.ts`
Expected: FAIL — default is still `"pi"` and there is no claude dispatch branch, so the new claude assertions fail.

- [ ] **Step 3: Default `buildPollingRoundContext` to claude**

In `src/installer/agent-scheduler.ts`, in `buildPollingRoundContext` (~line 1305), change:

```typescript
    harnessType: job.harnessType ?? "pi",
```

to:

```typescript
    harnessType: job.harnessType ?? "claude",
```

- [ ] **Step 4: Add the claude dispatch branch in `executePollingRound`**

In `src/installer/agent-scheduler.ts`, change the harness-default line (~line 1419):

```typescript
    const harnessType = job.harnessType ?? "pi";
```

to:

```typescript
    const harnessType = job.harnessType ?? "claude";
```

Then, in the dispatch block (~lines 1427-1453), add a `claude` branch **before** the hermes/pi branches:

```typescript
    let output: string;
    if (harnessType === "claude") {
      const claudePath = findClaudeBinary();
      const claudeModel =
        typeof context.model === "string" && context.model
          ? context.model
          : undefined;
      output = await runClaude(pollingPrompt, {
        timeout,
        workdir: workingDirectoryForHarness,
        model: claudeModel,
        env: {
          TAMANDUA_WORKER_JOB_ID: job.id,
          TAMANDUA_WORKER_PID: String(process.pid),
          TAMANDUA_CLAUDE_BINARY: claudePath,
        },
        onSpawn,
      });
    } else if (harnessType === "hermes") {
      const hermesPath = findHermesBinary();
      output = await runHermes(pollingPrompt, {
        timeout,
        workdir: workingDirectoryForHarness,
        env: {
          TAMANDUA_WORKER_JOB_ID: job.id,
          TAMANDUA_WORKER_PID: String(process.pid),
          TAMANDUA_HERMES_BINARY: hermesPath,
        },
        onSpawn,
      });
    } else {
      output = await runPi(
        ["--print", "--mode", "json", "--no-session", pollingPrompt],
        {
          timeout,
          workdir: workingDirectoryForHarness,
          env: {
            TAMANDUA_WORKER_JOB_ID: job.id,
            TAMANDUA_WORKER_PID: String(process.pid),
          },
          onSpawn,
        },
      );
    }
```

(Replace the existing `if (harnessType === "hermes") { ... } else { ... }` block with the three-way version above.)

- [ ] **Step 5: Default `createAgentCronJob` to claude**

In `src/installer/agent-scheduler.ts`, in `createAgentCronJob` (~lines 1585-1598), replace the harness-read block:

```typescript
  // Read harness_type from run context; default to "pi" if not set.
  let harnessType: HarnessType = "pi";
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const runRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
    if (runRow) {
      const ctx = JSON.parse(runRow.context) as Record<string, unknown>;
      if (ctx.harness_type === "hermes") {
        harnessType = "hermes";
      }
    }
  } catch {
    // If we can't read the context, default to "pi"
  }
```

with:

```typescript
  // Read harness_type from run context; default to "claude" if not set.
  let harnessType: HarnessType = "claude";
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const runRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
    if (runRow) {
      const ctx = JSON.parse(runRow.context) as Record<string, unknown>;
      if (ctx.harness_type === "hermes") {
        harnessType = "hermes";
      } else if (ctx.harness_type === "pi") {
        harnessType = "pi";
      }
    }
  } catch {
    // If we can't read the context, default to "claude"
  }
```

- [ ] **Step 6: Build and run test to verify it passes**

Run: `npm run build && node --test src/installer/agent-scheduler-harness-routing.test.ts`
Expected: PASS — pi, hermes, claude, and default(→claude) dispatch all verified.

- [ ] **Step 7: Commit**

```bash
git add src/installer/agent-scheduler.ts src/installer/agent-scheduler-harness-routing.test.ts
git commit -m "feat: route polling rounds to claude and default the scheduler to claude

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Default run creation + `getRunHarnessType` to claude; validate claude binary at scheduling

**Files:**
- Modify: `src/installer/run.ts:98`
- Modify: `src/installer/run-harness.ts` — `validateRunHarnessForScheduling` (~lines 113-125), `getRunHarnessType` (~lines 144-155)
- Modify: `src/installer/harness-type.test.ts` (update default-→claude assertions)

**Interfaces:**
- Consumes: `findClaudeBinary` (Task 3).
- Produces: new runs store `harness_type: "claude"` when no harness is chosen. `getRunHarnessType` returns `"claude"` for missing/absent context. Scheduling validation fails fast if `harness_type === "claude"` and the claude binary is absent.

- [ ] **Step 1: Update `harness-type.test.ts` default expectations**

In `src/installer/harness-type.test.ts`:

(a) `seedRunRecord` (line 41) defaults to `"pi"`; leave it — but the *no-arg* run-creation and getRunHarnessType tests must expect claude. Change these three assertions:

- Line 73-96 test `"is optional and defaults to 'pi' in run context"` → rename to `"is optional and defaults to 'claude' in run context"` and change the final assertion (line 95) to:
  ```typescript
      assert.equal(ctx.harness_type, "claude", "default harness_type is 'claude'");
  ```
- Line 168-174 test `"returns 'pi' for a run with no harness_type in context"`: this seeds via `seedRunRecord(runId)` which writes `harness_type: "pi"` explicitly (line 41), so it still returns `"pi"`. **Leave this test unchanged.**
- Line 176-179 test `"returns 'pi' for a non-existent run"` → rename to `"returns 'claude' for a non-existent run"` and change assertion to:
  ```typescript
      assert.equal(result, "claude");
  ```

(b) The `CronJobInfo.harnessType` "is 'pi' when harness_type is not set" test (line 221) also seeds via `seedRunRecord(runId)` → stores `"pi"` explicitly, so it stays valid. **Leave unchanged.**

- [ ] **Step 2: Build and run test to verify it fails**

Run: `npm run build && node --test src/installer/harness-type.test.ts`
Expected: FAIL — run creation still writes `"pi"` by default and `getRunHarnessType` returns `"pi"` for non-existent runs.

- [ ] **Step 3: Default run creation to claude**

In `src/installer/run.ts:98`, change:

```typescript
    harness_type: harnessType ?? "pi",
```

to:

```typescript
    harness_type: harnessType ?? "claude",
```

- [ ] **Step 4: Default `getRunHarnessType` to claude and recognize `"claude"`**

In `src/installer/run-harness.ts`, replace `getRunHarnessType` (~lines 144-155):

```typescript
export function getRunHarnessType(runId: string): HarnessType {
  const db = getDb();
  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!row) return "claude";
  try {
    const ctx = JSON.parse(row.context) as Record<string, unknown>;
    if (ctx.harness_type === "hermes") return "hermes";
    if (ctx.harness_type === "pi") return "pi";
    return "claude";
  } catch {
    return "claude";
  }
}
```

- [ ] **Step 5: Validate the claude binary at scheduling time**

In `src/installer/run-harness.ts`, first extend the import at the top (currently `import { findHermesBinary } from "./agent-scheduler.js";`) to include the claude finder:

```typescript
import { findHermesBinary, findClaudeBinary } from "./agent-scheduler.js";
```

Then, in `validateRunHarnessForScheduling`, immediately **after** the existing hermes validation block (~lines 116-125, ending with its closing `}`), add:

```typescript
  if (harnessType === "claude") {
    try {
      findClaudeBinary();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Run ${runId} requests claude harness but claude is not available: ${message}`,
      );
    }
  }
```

- [ ] **Step 6: Build and run test to verify it passes**

Run: `npm run build && node --test src/installer/harness-type.test.ts tests/harness-working-directory.test.ts src/installer/run-harness.test.ts`
Expected: PASS. (`run-harness.test.ts` covers `validateRunHarnessForScheduling`; if any case there asserts a `"pi"`/hermes default that changed, update it to match — but the existing cases key off explicit context, so they should pass unchanged.)

- [ ] **Step 7: Commit**

```bash
git add src/installer/run.ts src/installer/run-harness.ts src/installer/harness-type.test.ts
git commit -m "feat: default run creation and getRunHarnessType to claude; validate claude binary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Add `--claude-as-harness` CLI flag (default) with 3-way mutex

**Files:**
- Modify: `src/cli/workflow-run-args.ts`
- Modify: `src/cli/cli.ts` (help text ~lines 1032-1037; usage line ~1535)
- Modify: `src/cli/cli.test.ts` (harness flag tests ~lines 176-231)

**Interfaces:**
- Produces: `WorkflowRunArgs.harnessAs?: "pi" | "hermes" | "claude"`. `parseWorkflowRunArgs` accepts `--claude-as-harness`; specifying more than one harness flag throws. No flag → `harnessAs` undefined (→ claude default, applied downstream by Task 5).

- [ ] **Step 1: Update the CLI arg tests**

In `src/cli/cli.test.ts`, add a claude-flag test and broaden the mutex tests. After the existing `"parses --pi-as-harness flag"` test (~line 176-181), add:

```typescript
  it("parses --claude-as-harness flag", () => {
    const result = parseWorkflowRunArgs(["--claude-as-harness", "do the task"]);
    assert.equal(result.harnessAs, "claude");
    assert.equal(result.taskTitle, "do the task");
  });

  it("throws when --claude-as-harness combined with --pi-as-harness", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--claude-as-harness", "--pi-as-harness", "task"]),
      /Cannot specify more than one harness/,
    );
  });
```

Then update the two existing mutex tests (~lines 193-204) to match the new error message. Change both `/Cannot specify both --pi-as-harness and --hermes-as-harness/` regexes to:

```typescript
      /Cannot specify more than one harness/,
```

- [ ] **Step 2: Build and run test to verify it fails**

Run: `npm run build && node --test src/cli/cli.test.ts`
Expected: FAIL — `--claude-as-harness` is not parsed (`harnessAs` undefined) and the error message doesn't match the new regex.

- [ ] **Step 3: Update `workflow-run-args.ts`**

In `src/cli/workflow-run-args.ts`:

(a) Change the interface field (line 8) and local var (line 18) type to include `"claude"`:

```typescript
  harnessAs?: "pi" | "hermes" | "claude";
```
```typescript
  let harnessAs: "pi" | "hermes" | "claude" | undefined;
```

(b) Replace the two existing harness-flag blocks (lines 33-51) with three blocks sharing one mutex message:

```typescript
    if (token === "--claude-as-harness") {
      if (harnessAs !== undefined) {
        throw new Error(
          "Cannot specify more than one harness. Choose one of --claude-as-harness, --pi-as-harness, or --hermes-as-harness.",
        );
      }
      harnessAs = "claude";
      continue;
    }

    if (token === "--pi-as-harness") {
      if (harnessAs !== undefined) {
        throw new Error(
          "Cannot specify more than one harness. Choose one of --claude-as-harness, --pi-as-harness, or --hermes-as-harness.",
        );
      }
      harnessAs = "pi";
      continue;
    }

    if (token === "--hermes-as-harness") {
      if (harnessAs !== undefined) {
        throw new Error(
          "Cannot specify more than one harness. Choose one of --claude-as-harness, --pi-as-harness, or --hermes-as-harness.",
        );
      }
      harnessAs = "hermes";
      continue;
    }
```

- [ ] **Step 4: Update CLI help + usage text**

In `src/cli/cli.ts`, replace the harness help block (~lines 1032-1037):

```
  --pi-as-harness
      Use pi as the agent harness (this is the default).
      Mutually exclusive with --hermes-as-harness.
  --hermes-as-harness
      Use hermes as the agent harness instead of pi.
      Mutually exclusive with --pi-as-harness.
```

with:

```
  --claude-as-harness
      Use the Claude Code CLI (claude -p) as the agent harness.
      This is the default. Mutually exclusive with the other harness flags.
  --pi-as-harness
      Use pi as the agent harness instead of claude.
      Mutually exclusive with the other harness flags.
  --hermes-as-harness
      Use hermes as the agent harness instead of claude.
      Mutually exclusive with the other harness flags.
```

Then update the usage line (~line 1535):

```typescript
    "                                      [--pi-as-harness | --hermes-as-harness]",
```

to:

```typescript
    "                                      [--claude-as-harness | --pi-as-harness | --hermes-as-harness]",
```

(The `runArgs.harnessAs → harnessType` mapping at ~line 2670-2673 already passes the value through as `HarnessType`; since `"claude"` is now a valid `HarnessType`, no change is needed there.)

- [ ] **Step 5: Build and run test to verify it passes**

Run: `npm run build && node --test src/cli/cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/workflow-run-args.ts src/cli/cli.ts src/cli/cli.test.ts
git commit -m "feat: add --claude-as-harness CLI flag as default with 3-way mutex

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Make `readPiConfig()` best-effort during install

**Files:**
- Modify: `src/installer/install.ts:242-243`
- Test: `src/installer/install.test.ts` (add a case) — or `tests/` equivalent

**Interfaces:**
- Produces: `installWorkflow` (existing) no longer throws when `~/.pi/agent/settings.json` is absent.

- [ ] **Step 1: Write the failing test**

Open `src/installer/install.test.ts` and add a test that installs a bundled workflow with `HOME` pointing at a temp dir that has **no** `.pi` directory. Use the file's existing setup patterns for `HOME`/`TAMANDUA_STATE_DIR`. Add:

```typescript
  it("installs a workflow when no ~/.pi config exists (claude-only host)", async () => {
    // HOME is a fresh temp dir with no .pi directory (see beforeEach setup).
    // installWorkflow must not throw due to a missing pi config.
    await assert.doesNotReject(async () => {
      await installWorkflow({ workflowId: "do-now" });
    });
  });
```

Adjust the call to match the file's actual `installWorkflow` signature/imports (check the top of `install.test.ts` for how it is imported and how other tests invoke it; mirror those exactly, including any `bundledSourceDir` argument they pass).

- [ ] **Step 2: Build and run test to verify it fails**

Run: `npm run build && node --test src/installer/install.test.ts`
Expected: FAIL — `readPiConfig()` throws `Failed to read pi config at .../.pi/agent/settings.json`.

- [ ] **Step 3: Wrap `readPiConfig` in try/catch**

In `src/installer/install.ts`, replace lines 242-243:

```typescript
  // Read pi config for reference (we don't modify pi's config, just read it)
  await readPiConfig();
```

with:

```typescript
  // Read pi config for reference only (never modified). Absent on claude-only
  // hosts — treat as best-effort so install does not require pi to be present.
  try {
    await readPiConfig();
  } catch (err) {
    logger.debug("pi config not found; continuing (claude-only host is fine)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
```

Ensure `logger` is imported in `install.ts`. If it is not already imported, add near the other imports at the top:

```typescript
import { logger } from "../lib/logger.js";
```

(Check the existing imports first; if `logger` is already imported, do not duplicate.)

- [ ] **Step 4: Build and run test to verify it passes**

Run: `npm run build && node --test src/installer/install.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/installer/install.ts src/installer/install.test.ts
git commit -m "fix: make pi config read best-effort so install works on claude-only hosts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Documentation — README + SKILL.md (claude default) and their tests

**Files:**
- Modify: `README.md` (Harness Selection section ~lines 531-541; Requirements ~lines 608-614; mermaid diagram ~line 248; workflow-run command row ~line 492)
- Modify: `skills/tamandua-agents/SKILL.md`
- Modify: `tests/readme-hermes-docs.test.ts`, `tests/skill-hermes-docs.test.ts`

**Interfaces:** none (docs only). Tests assert doc content.

- [ ] **Step 1: Update the README doc-test expectations**

In `tests/readme-hermes-docs.test.ts`:

(a) Replace the test `"states pi is the default and recommended harness"` (lines 24-33) with:

```typescript
  it("states claude is the default harness", () => {
    assert.ok(
      readmeContent.includes("This is the default"),
      "README must state which harness is the default"
    );
    assert.ok(
      readmeContent.includes("--claude-as-harness"),
      "README must document --claude-as-harness"
    );
    assert.ok(
      readmeContent.match(/claude.*default|default.*claude/i),
      "README must state claude is the default harness"
    );
  });
```

(b) Update `"workflow run command row includes harness flags"` (lines 86-92) to expect the 3-way row:

```typescript
  it("workflow run command row includes harness flags", () => {
    assert.ok(
      readmeContent.includes("[--claude-as-harness \\| --pi-as-harness \\| --hermes-as-harness]") ||
      readmeContent.includes("[--claude-as-harness | --pi-as-harness | --hermes-as-harness]"),
      "README workflow run command row must show all three harness flags"
    );
  });
```

- [ ] **Step 2: Update the SKILL doc-test expectations**

In `tests/skill-hermes-docs.test.ts`:

(a) Replace `"states pi is the default and recommended harness"` (lines 93-102) with:

```typescript
  it("states claude is the default harness", () => {
    assert.ok(
      skillContent.match(/claude.*default|default.*claude/i),
      "SKILL.md must state that claude is the default harness"
    );
    assert.ok(
      skillContent.includes("--claude-as-harness"),
      "SKILL.md must document --claude-as-harness"
    );
  });
```

(b) Update `"workflow run command row includes harness flags"` (lines 104-109):

```typescript
  it("workflow run command row includes harness flags", () => {
    assert.ok(
      skillContent.includes("[--claude-as-harness | --pi-as-harness | --hermes-as-harness]"),
      "SKILL.md workflow run command row must show all three harness flags"
    );
  });
```

- [ ] **Step 3: Build and run tests to verify they fail**

Run: `npm run build && node --test tests/readme-hermes-docs.test.ts tests/skill-hermes-docs.test.ts`
Expected: FAIL — README/SKILL still say pi is the default and lack `--claude-as-harness`.

- [ ] **Step 4: Update README.md**

In `README.md`:

(a) **Harness Selection section** (~lines 531-541). Replace the intro sentence and table so claude is default:

```markdown
### Harness Selection

By default, Tamandua uses the **Claude Code CLI** (`claude -p`) as its agent
harness. You can override this with the harness selection flags on
`tamandua workflow run`:

| Flag | Description |
|------|-------------|
| `--claude-as-harness` | Use the Claude Code CLI (`claude -p`) as the agent harness. **This is the default.** |
| `--pi-as-harness` | Use [pi](https://github.com/mariozechner/pi-coding-agent) as the agent harness instead of claude. |
| `--hermes-as-harness` | Use [Hermes](https://github.com/nicholasgasior/hermes) as the agent harness instead of claude. |

These flags are **mutually exclusive** — specifying more than one is an error.

Tamandua discovers the `claude` binary on your `PATH`; set
`TAMANDUA_CLAUDE_BINARY` to point at a specific binary. Harness binary
validation runs at scheduling time — if the selected harness binary isn't
found or isn't executable, the run fails immediately with a clear error.
```

Keep the existing `#### Hermes Support (Alpha)` block that follows (with its "Alpha quality", "very slow", "token accounting is broken", `TAMANDUA_HERMES_BINARY`, and PATH text) — those satisfy the remaining hermes doc-tests. Just ensure the sentence that previously said "Use pi (`--pi-as-harness`) for production workflows." still contains `Use pi` + `for production` (leave that sentence intact so the `/Use pi.*for production/` assertion — which we removed in Step 1 — is no longer required; but keeping it is harmless).

(b) **Workflow-run command row** (~line 492). Change the harness fragment from:

```
[--pi-as-harness \| --hermes-as-harness]
```

to:

```
[--claude-as-harness \| --pi-as-harness \| --hermes-as-harness]
```

(c) **Mermaid diagram** (~line 248). Change:

```
    Agents -->|"pi --print"| Harness["pi harness<br/>(or Hermes, alpha)"]
```

to:

```
    Agents -->|"claude -p"| Harness["claude harness<br/>(or pi / Hermes)"]
```

(d) **Requirements** (~lines 608-614). Replace the pi requirement bullet with claude-first:

```markdown
- Node.js >= 22
- [Claude Code CLI](https://code.claude.com) (`claude`) installed on the host
  - Tamandua's default harness. Agents run via `claude -p` in non-interactive mode.
  - Set `TAMANDUA_CLAUDE_BINARY` to override the discovered binary.
- Optional: [pi](https://github.com/mariozechner/pi-coding-agent) — only needed when running with `--pi-as-harness`.
- `gh` CLI for PR creation steps
```

- [ ] **Step 5: Update SKILL.md**

In `skills/tamandua-agents/SKILL.md`, find the harness documentation section (it currently documents `--pi-as-harness`/`--hermes-as-harness`, states pi is the default, and includes the workflow-run command row `[--pi-as-harness | --hermes-as-harness]`). Apply the equivalent edits:

- Add a `--claude-as-harness` entry and state that **claude is the default** (ensure the text contains both `--claude-as-harness` and a phrase matching `/claude.*default|default.*claude/i`).
- Change the workflow-run command row to exactly `[--claude-as-harness | --pi-as-harness | --hermes-as-harness]`.
- Keep all existing hermes text (`alpha`, `very slow`, `token accounting is broken`, `TAMANDUA_HERMES_BINARY`, PATH, `mutually exclusive`, `scheduling.*time`) so the remaining skill doc-tests pass.

Use Grep to locate the exact lines first:

```bash
grep -n -- "--pi-as-harness\|--hermes-as-harness\|default\|pi harness\|pi --print" skills/tamandua-agents/SKILL.md
```

- [ ] **Step 6: Build and run the doc tests to verify they pass**

Run: `npm run build && node --test tests/readme-hermes-docs.test.ts tests/skill-hermes-docs.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify unrelated doc-tests still pass**

Run: `node --test tests/readme-mcp-tools.test.ts tests/readme-workflow-catalog.test.ts`
Expected: PASS (MCP tool count and workflow catalog sections were not edited).

- [ ] **Step 8: Commit**

```bash
git add README.md skills/tamandua-agents/SKILL.md tests/readme-hermes-docs.test.ts tests/skill-hermes-docs.test.ts
git commit -m "docs: document claude as the default harness (README + SKILL)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Clean build**

Run: `npm run build`
Expected: `tsc` completes with no errors; assets copied.

- [ ] **Step 2: Run the entire test suite**

Run: `npm test`
Expected: All tests pass. If any pre-existing test asserts a `"pi"` default that this migration changed (search the failure output for `harness`/`pi`/`default`), update that assertion to `"claude"` following the same pattern used in Tasks 4-6, rebuild, and re-run. Do not weaken assertions — only change the expected default value.

- [ ] **Step 3: Grep for any remaining hard-coded `"pi"` defaults**

Run: `grep -rn '?? "pi"' src/ ; grep -rn 'default.*"pi"\|"pi".*default' src/`
Expected: no *default-selection* occurrences remain (matches inside pi-specific execution like `runPi` args are fine). If a default-selection site remains, fix it to `"claude"`, rebuild, and re-run `npm test`.

- [ ] **Step 4: Final commit (if Step 2/3 required fixes)**

```bash
git add -A
git commit -m "test: align remaining default-harness assertions with claude

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §2 Invocation → Task 3 (`runClaude` args, cwd, stdin, `--model` conditional) + Task 4 (env vars, model threading).
- §3 Parsing (`--output-format json`, `.result`, `.usage`, cache keys) → Task 1 + Task 2.
- §4 Routing + defaults (`HarnessType`, `findClaudeBinary`, dispatch, validation) → Task 1, 3, 4, 5.
- §5 CLI/MCP flags → Task 6. (MCP exposes no harness selector today, so it inherits the claude default automatically — no MCP code change; verified indirectly by the default-write in Task 5.)
- §6 Install best-effort → Task 7.
- §7 Docs → Task 8.
- §8 Tests → each task is TDD; doc-tests in Task 8; full suite in Task 9.
- §9 Risks → migration side-effect (old runs → claude) is realized by the Task 5 default change; documented in the spec.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; test steps show full test bodies.

**Type consistency:** `HarnessType` gains `"claude"` in Task 1 before any consumer uses it. `findClaudeBinary(): string` (sync) is defined in Task 3 and consumed synchronously in Task 4 (`executePollingRound`) and Task 5 (`validateRunHarnessForScheduling`). `runClaude(prompt, options)` and `RunPiOptions.model` defined in Task 3, consumed in Task 4. `harnessAs: "pi" | "hermes" | "claude"` defined in Task 6 matches `HarnessType`.

**Note for implementer:** Line numbers are approximate (the file is ~2071 lines and shifts as you edit). Anchor edits on the quoted surrounding code, not the line number.
