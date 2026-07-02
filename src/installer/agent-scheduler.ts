import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { resolveTamanduaCli, resolveWorkflowDir, resolveWorkflowWorkspaceDir } from "./paths.js";
import type { WorkflowSpec, WorkflowAgent, HarnessType } from "./types.js";
import { logger } from "../lib/logger.js";
import { getRoleTimeoutSeconds, inferRole } from "./install.js";
import { formatPiCommandPreview } from "./pi-command-preview.js";
import { emitEvent } from "./events.js";
import { parsePiOutputStream } from "./pi-stream-parser.js";

// ──────────────────────────────────────────────────────────────────────
// Run-Scoped Polling
//
// Job identity:  tamandua-${workflowId}-${runId}-${agentId}
// Scope:         every job is tied to ONE (runId, agentId) tuple
// Ownership:    timers + in-flight pi children are owned by whatever
//               process invokes the scheduler (daemon in production;
//               occasionally direct callers in tests).
// State:        no on-disk persistence (cron-jobs.json removed). The DB
//               is the source of truth; the daemon's reconciler restores
//               in-memory job maps from runs.scheduling_status.
// ──────────────────────────────────────────────────────────────────────

/** Maps job id → active setInterval handle. */
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Maps job id → delayed first-start timeout handle. */
const pendingStartTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Maps job id → persistent metadata. */
const jobMetadata = new Map<string, CronJobInfo>();

/**
 * Set of job ids whose pi process is currently running. Used to skip a
 * polling tick when the previous one for the same (run, agent) hasn't
 * finished — without this guard, setInterval would keep spawning new pi
 * every interval even though pi rounds can take 10–30 minutes.
 */
const inFlightJobs = new Set<string>();

// ── Nudge types ─────────────────────────────────────────────────────

export interface NudgeJobDetail {
  runId: string;
  agentId: string;
  status: "launched" | "skipped_in_flight" | "error";
  error?: string;
}

export interface NudgeResult {
  runIds: string[];
  launched: number;
  skippedInFlight: number;
  errors: Array<{ runId?: string; agentId?: string; error: string }>;
  jobs: NudgeJobDetail[];
}

/**
 * Atomically check and mark a job as in-flight.
 *
 * Returns `true` if the job was not already in flight (caller should
 * proceed) and `false` if it was (caller should skip).  The check-and-add
 * is synchronous to close the TOCTOU window between the guard and the
 * first `await` inside `executePollingRound`.
 */
export function tryMarkJobInFlight(jobId: string): boolean {
  if (inFlightJobs.has(jobId)) return false;
  inFlightJobs.add(jobId);
  return true;
}

/**
 * Maps job id → in-flight child handle, exposing pid + pgid. Used by
 * `removeRunCrons` and daemon shutdown to terminate process groups.
 */
interface InFlightChild {
  pid: number;
  pgid: number;
  killed: boolean;
}
const inFlightChildren = new Map<string, InFlightChild>();

const AGENT_PERSONA_FILES = ["AGENTS.md", "IDENTITY.md", "SOUL.md"] as const;

export interface CronJobInfo {
  /** tamandua-${workflowId}-${runId}-${agentId} */
  id: string;
  workflowId: string;
  runId: string;
  agentId: string;
  intervalMinutes: number;
  model?: string;
  workModel?: string;
  sessionLabel?: string;
  timeoutSeconds?: number;
  /** Working directory used as cwd for `pi --print` invocations. */
  workingDirectoryForHarness?: string;
  /** Harness binary to use for agent invocations ("pi" or "hermes"). */
  harnessType?: HarnessType;
  createdAt: string;
}

export interface CreateCronJobParams {
  workflowId: string;
  runId: string;
  agent: WorkflowAgent;
  workflow?: WorkflowSpec;
  intervalMinutes?: number;
  staggerOffsetMs?: number;
  workingDirectoryForHarness?: string;
}

export interface SetupAgentCronsOptions {
  workingDirectoryForHarness?: string;
  /** When true, elevates polling floor to 15 min and default to 15 min to save tokens. */
  noHurrySaveTokensMode?: boolean;
}

// ── pi binary discovery ────────────────────────────────────────────

export async function findPiBinary(): Promise<string> {
  // Prefer explicit env override
  const envPi = process.env.TAMANDUA_PI_BINARY?.trim();
  if (envPi) {
    try {
      fs.accessSync(envPi, fs.constants.X_OK);
      return envPi;
    } catch {
      throw new Error(`TAMANDUA_PI_BINARY set but not executable: ${envPi}`);
    }
  }

  // Search PATH
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "pi");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found in this dir, keep looking
    }
  }

  throw new Error(
    "pi binary not found in PATH. Install pi (https://github.com/anthropics/pi) or set TAMANDUA_PI_BINARY."
  );
}

// ── hermes binary discovery ───────────────────────────────────────

export function findHermesBinary(): string {
  // Prefer explicit env override
  const envHermes = process.env.TAMANDUA_HERMES_BINARY?.trim();
  if (envHermes) {
    try {
      fs.accessSync(envHermes, fs.constants.X_OK);
      return envHermes;
    } catch {
      throw new Error(
        `TAMANDUA_HERMES_BINARY set but not executable: ${envHermes}`
      );
    }
  }

  // Search PATH
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "hermes");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found in this dir, keep looking
    }
  }

  throw new Error(
    "hermes binary not found in PATH. Install hermes or set TAMANDUA_HERMES_BINARY."
  );
}

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

// ── Low-level pi execution ─────────────────────────────────────────

export interface RunPiOptions {
  timeout?: number; // seconds, default 60
  workdir?: string;
  env?: Record<string, string>;
  /** Optional model passed to `claude --model` (claude harness only). */
  model?: string;
  /**
   * Optional callback invoked once the child process is spawned. Used by
   * `executePollingRound` to register the child + pgid in `inFlightChildren`
   * so termination paths can kill the process group.
   */
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
}

const MAX_LOG_STREAM_PREVIEW = 200;

interface StreamLogMetadata {
  bytes: number;
  preview: string;
  truncated: boolean;
}

function buildStreamLogMetadata(stream: string): StreamLogMetadata {
  const normalized = stream.trim();
  const truncated = normalized.length > MAX_LOG_STREAM_PREVIEW;
  const preview = truncated ? `${normalized.slice(0, MAX_LOG_STREAM_PREVIEW)}…` : normalized;

  return {
    bytes: Buffer.byteLength(stream, "utf-8"),
    preview,
    truncated,
  };
}

function safeKillPgid(pgid: number, signal: NodeJS.Signals): void {
  try {
    // Negative PID => kill the entire process group.
    process.kill(-pgid, signal);
  } catch {
    // Group may already be gone.
  }
}

export async function runPi(
  args: string[],
  options: RunPiOptions = {},
): Promise<string> {
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const piPath = await findPiBinary();

  const childEnv: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...(options.env ?? {}),
  };

  const preview = formatPiCommandPreview(piPath, args);
  const startedAt = Date.now();

  logger.info("pi pre-launch", {
    commandPreview: preview.commandPreview,
    argvPreview: preview.argvPreview,
    redactedIndices: preview.redactedIndices,
    truncatedIndices: preview.truncatedIndices,
    promptElided: preview.promptElided,
    argCount: preview.argCount,
    timeoutMs,
    workdir: options.workdir,
  });

  // Spawn pi in its own process group so termination paths can kill the
  // whole subtree (pi spawns its own child processes for tools/sessions).
  const child = spawn(piPath, args, {
    cwd: options.workdir ?? process.cwd(),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const childPid = child.pid;
  // On Linux, the spawned child becomes its own group leader (pgid === pid)
  // when detached:true. Fall back to childPid if getpgid is unavailable.
  const pgid = childPid ?? 0;

  if (childPid && options.onSpawn) {
    try {
      options.onSpawn({ pid: childPid, pgid });
    } catch (err) {
      logger.warn("pi onSpawn callback threw", { error: String(err) });
    }
  }

  logger.info("pi launched", {
    pid: childPid ?? null,
    pgid,
    timeoutMs,
    workdir: options.workdir,
  });

  // End stdin immediately — pi --print waits for stdin EOF before responding
  child.stdin?.end();

  // Collect stderr (bounded)
  let stderrPieces: string[] = [];
  let stderrBytes = 0;
  const MAX_STDERR_BYTES = 10 * 1024 * 1024; // 10MB cap for stderr
  child.stderr?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    if (stderrBytes + Buffer.byteLength(str, "utf-8") <= MAX_STDERR_BYTES) {
      stderrPieces.push(str);
      stderrBytes += Buffer.byteLength(str, "utf-8");
    }
  });

  // Stream stdout through readline → parsePiOutputStream.
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const parseResultPromise = parsePiOutputStream(rl);

  // Wait for child exit. Apply timeout guard.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Terminate the whole process group: SIGTERM, then SIGKILL after 5s.
      if (pgid) {
        safeKillPgid(pgid, "SIGTERM");
        setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
      } else {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
      reject(new Error(`pi timed out after ${timeoutMs}ms`));
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
        const failureDurationMs = Date.now() - startedAt;
        const failureStderr = stderrPieces.join("");
        const failureStderrMeta = buildStreamLogMetadata(failureStderr);
        logger.error("pi execution failed", {
          pid: childPid ?? null,
          pgid,
          exitCode: code,
          signal,
          durationMs: failureDurationMs,
          stderrBytes: failureStderrMeta.bytes,
          stderrPreview: failureStderrMeta.preview,
          stderrTruncated: failureStderrMeta.truncated,
        });
        const stderrSuffix = failureStderr ? `\nstderr: ${failureStderr}` : "";
        reject(new Error(`pi failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`));
      }
    });
  });

  // Wait for stdout parsing to finish (it will complete once stdout closes)
  const parseResult = await parseResultPromise;

  const durationMs = Date.now() - startedAt;
  const stderrOut = stderrPieces.join("");
  const stderrMeta = buildStreamLogMetadata(stderrOut);

  if (stderrMeta.preview) {
    logger.warn("pi stderr", {
      pid: childPid ?? null,
      stderrBytes: stderrMeta.bytes,
      stderrPreview: stderrMeta.preview,
      stderrTruncated: stderrMeta.truncated,
    });
  }

  // Reconstruct filtered stdout from parsed events for backwards compatibility.
  const filteredLines: string[] = [];
  if (parseResult.textFallback !== null) {
    filteredLines.push(parseResult.textFallback);
  }
  for (const event of parseResult.events) {
    filteredLines.push(JSON.stringify(event));
  }
  if (parseResult.assistantText.length > 0) {
    filteredLines.push(parseResult.assistantText);
  }
  const filteredStdout = filteredLines.join("\n");
  const stdoutMeta = buildStreamLogMetadata(filteredStdout);

  logger.info("pi completed", {
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

  return filteredStdout.trim();
}

// ── Hermes execution ──────────────────────────────────────────────

export async function runHermes(
  prompt: string,
  options: RunPiOptions = {},
): Promise<string> {
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const hermesPath = await findHermesBinary();

  const childEnv: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...(options.env ?? {}),
  };

  const startedAt = Date.now();

  // Hermes single-shot invocation:
  // -q <prompt> delivers the task in single message mode.
  // --max-turns 8192 gives the agent plenty of room to complete the work.
  // --yolo skips permission confirmations (hermes equivalent of pi -y).
  // -Q suppresses banner/spinner (but NOT session_id).
  // Keep user config enabled so Hermes uses the configured provider/model.
  const args = [
    "chat",
    "--max-turns", "8192",
    "--yolo",
    "-Q",
    "-q", prompt,
  ];

  logger.info("hermes pre-launch", {
    harness: "hermes",
    hermesPath,
    promptLength: Buffer.byteLength(prompt, "utf-8"),
    timeoutMs,
    workdir: options.workdir,
  });

  // Spawn hermes in its own process group for clean termination.
  const child = spawn(hermesPath, args, {
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
      logger.warn("hermes onSpawn callback threw", { error: String(err) });
    }
  }

  logger.info("hermes launched", {
    harness: "hermes",
    pid: childPid ?? null,
    pgid,
    timeoutMs,
    workdir: options.workdir,
  });

  // End stdin immediately — hermes reads from args (-q).
  child.stdin?.end();

  // Collect stderr (bounded).
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

  // Collect stdout fully (hermes produces plain text, not JSON events).
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

  // Wait for child exit, with timeout guard.
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
      reject(new Error(`hermes timed out after ${timeoutMs}ms`));
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
        const failureDurationMs = Date.now() - startedAt;
        const failureStderr = stderrPieces.join("");
        const failureStderrMeta = buildStreamLogMetadata(failureStderr);
        logger.error("hermes execution failed", {
          harness: "hermes",
          pid: childPid ?? null,
          pgid,
          exitCode: code,
          signal,
          durationMs: failureDurationMs,
          stderrBytes: failureStderrMeta.bytes,
          stderrPreview: failureStderrMeta.preview,
          stderrTruncated: failureStderrMeta.truncated,
        });
        const stderrSuffix = failureStderr ? `\nstderr: ${failureStderr}` : "";
        reject(new Error(`hermes failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`));
      }
    });
  });

  const durationMs = Date.now() - startedAt;
  const rawStdout = stdoutPieces.join("");
  const stderrOut = stderrPieces.join("");
  const stderrMeta = buildStreamLogMetadata(stderrOut);

  if (stderrMeta.preview) {
    logger.warn("hermes stderr", {
      harness: "hermes",
      pid: childPid ?? null,
      stderrBytes: stderrMeta.bytes,
      stderrPreview: stderrMeta.preview,
      stderrTruncated: stderrMeta.truncated,
    });
  }

  // Filter out session_id lines. Hermes appends a session identifier
  // (e.g. "session_id: 20260518_103004_cdae11") at the end of stdout.
  // Remove it so the scheduler sees clean output.
  const filteredStdout = rawStdout
    .split("\n")
    .filter((line) => !/^session_id:\s*\S+/.test(line.trim()))
    .join("\n")
    .trim();

  const stdoutMeta = buildStreamLogMetadata(filteredStdout);

  logger.info("hermes completed", {
    harness: "hermes",
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

  return filteredStdout;
}

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

// ── Prompt builders ─────────────────────────────────────────────────

async function readOptionalPersonaFile(
  workspaceDir: string,
  fileName: typeof AGENT_PERSONA_FILES[number],
): Promise<string | null> {
  const filePath = path.join(workspaceDir, fileName);
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const trimmed = content.trim();
    if (trimmed.length === 0) return null;
    return content.trimEnd();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function buildAgentPersonaInstructions(agentId: string): Promise<string> {
  const workspaceDir = resolveWorkflowWorkspaceDir(agentId);
  const sections: string[] = [];

  for (const fileName of AGENT_PERSONA_FILES) {
    const content = await readOptionalPersonaFile(workspaceDir, fileName);
    if (!content) continue;
    sections.push(`### ${fileName}\n\n${content}`);
  }

  if (sections.length === 0) return "";

  return [
    "The following files are the provisioned Tamandua persona instructions for this workflow agent.",
    "Follow them when executing claimed work. Repository-level instructions from the harness working directory still apply for repository-specific conventions.",
    "",
    ...sections,
  ].join("\n\n");
}

/**
 * Build the prompt an agent gets to check for and execute work.
 *
 * @param workflowId – the workflow this agent serves
 * @param agentId    – the agent's ID
 * @param runId      – run-scoped polling: passed to `step peek` / `step claim`
 *                     via `--run-id` so the CLI only matches steps in this run
 */
export function buildAgentPrompt(workflowId: string, agentId: string, runId: string): string {
  const cli = resolveTamanduaCli();

  return [
    `You are agent "${agentId}" in workflow "${workflowId}" (run ${runId}).`,
    ``,
    `Your job is to poll for work and execute it.`,
    ``,
    `STEP 1 — Check for pending work:`,
    `Run: node "${cli}" step peek "${agentId}" --run-id "${runId}"`,
    ``,
    `STEP 2 — If NO_WORK:`,
    `Reply HEARTBEAT_OK and stop. Do NOT do anything else.`,
    ``,
    `STEP 3 — If HAS_WORK:`,
    `Claim the step and capture the JSON response:`,
    `Run: node "${cli}" step claim "${agentId}" --run-id "${runId}"`,
    `The output will be JSON: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}`,
    `SAVE the stepId — you MUST use it in step 4.`,
    ``,
    `Read the "input" field carefully. It describes the actual work you must do.`,
    `Execute the work using all available tools and capabilities.`,
    ``,
    `STEP 4 — Report results using the SAVED stepId (NOT the agent ID):`,
    `On success: echo 'STATUS: done
CHANGES: <what you changed>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `On failure: node "${cli}" step fail "<stepId>" "<clear reason>"`,
    ``,
    `CRITICAL: You MUST report results using the step complete or step fail commands.`,
    `Failing to report will leave the workflow stuck forever. Always report, even if you`,
    `could not complete the work — use step fail with a clear reason.`,
  ].join("\n");
}

/**
 * Build the work prompt for when work was already claimed.
 * Does NOT include step claim — just work execution instructions.
 */
export function buildWorkPrompt(workflowId: string, agentId: string, runId: string): string {
  const cli = resolveTamanduaCli();

  return [
    `You are agent "${agentId}" in workflow "${workflowId}" (run ${runId}).`,
    `You have already claimed this step. Now execute the work.`,
    ``,
    `The claimed step JSON contains a "stepId" field. You MUST save this and use it`,
    `when reporting results.`,
    ``,
    `Work instructions are in the "input" field. Execute them thoroughly.`,
    ``,
    `When done, report your results using the SAVED stepId (NOT the agent ID):`,
    `On success: echo 'STATUS: done
CHANGES: <what you changed>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `On failure: node "${cli}" step fail "<stepId>" "<reason>"`,
    ``,
    `CRITICAL: You MUST report results. Do not exit without calling step complete or step fail.`,
  ].join("\n");
}

/**
 * Build the polling prompt — a two-phase script executed by `pi --print`.
 *
 * Phase 1 (cheap): peek for work. If none → HEARTBEAT_OK.
 * Phase 2 (work):   if work exists, claim it and execute.
 *
 * Both peek + claim are scoped to a specific runId so concurrent runs of
 * the same workflow can't cross-claim each other's steps.
 */
export function buildPollingPrompt(
  workflowId: string,
  agentId: string,
  runId: string,
  agentPersonaInstructions = "",
): string {
  const cli = resolveTamanduaCli();

  const persona = agentPersonaInstructions.trim();
  const prompt = [
    `You are a polling agent for workflow "${workflowId}", agent "${agentId}", run "${runId}".`,
    `You run in --print mode. Your goal: check for work and execute it if present.`,
  ];

  if (persona.length > 0) {
    prompt.push(
      ``,
      `─── PROVISIONED AGENT PERSONA ───`,
      persona,
      `─── END PROVISIONED AGENT PERSONA ───`,
    );
  }

  prompt.push(
    ``,
    `─── PHASE 1: PEEK ───`,
    `Run this exact command and capture its output:`,
    `node "${cli}" step peek "${agentId}" --run-id "${runId}"`,
    ``,
    `If the output contains NO_WORK:`,
    `  Reply exactly: HEARTBEAT_OK`,
    `  Then STOP. Do not proceed to PHASE 2.`,
    ``,
    `If the output contains HAS_WORK:`,
    `  Proceed to PHASE 2.`,
    ``,
    `─── PHASE 2: CLAIM AND EXECUTE ───`,
    `1. Claim the step and capture the JSON response:`,
    `   node "${cli}" step claim "${agentId}" --run-id "${runId}"`,
    `   The output is JSON: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}`,
    `   SAVE the stepId — you MUST use it when reporting results.`,
    ``,
    `2. Read the "input" field carefully. It describes the actual work you must do.`,
    ``,
    `3. Execute the work using all available tools and capabilities.`,
    ``,
    `4. When finished, report using the SAVED stepId (NOT the agent ID):`,
    `   - Success: echo 'STATUS: done
CHANGES: <what you did>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `   - Failure: node "${cli}" step fail "<stepId>" "<clear reason for failure>"`,
    ``,
    `─── RULES ───`,
    `- ALWAYS report results. Never exit without calling step complete or step fail.`,
    `- If you cannot complete the work, use step fail — do not hang.`,
    `- Keep responses concise; you are a background agent.`,
    `- If something is unclear, use step fail with an explanation of what is missing.`,
  );

  return prompt.join("\n");
}

// ── Polling loop internals ──────────────────────────────────────────

const MAX_POLLING_OUTPUT_PREVIEW = 240;
const MAX_POLLING_ERROR_PREVIEW = 240;

type PollingRoundOutcome =
  | "heartbeat"
  | "work_done"
  | "work_failed"
  | "empty_output"
  | "other_output";

interface BoundedPreviewMetadata {
  preview: string;
  bytes: number;
  truncated: boolean;
}

interface PollingRoundOutputSummary extends BoundedPreviewMetadata {
  outcome: PollingRoundOutcome;
  lines: number;
}

function buildBoundedPreview(value: string, maxChars: number): BoundedPreviewMetadata {
  const truncated = value.length > maxChars;
  const preview = truncated ? `${value.slice(0, maxChars)}…` : value;

  return {
    preview,
    bytes: Buffer.byteLength(value, "utf-8"),
    truncated,
  };
}

/** @internal exported for regression tests */
export function classifyPollingRoundOutcome(output: string): PollingRoundOutcome {
  if (output.length === 0) return "empty_output";
  if (/\bHEARTBEAT_OK\b/.test(output)) return "heartbeat";
  if (/STATUS:\s*(fail|failed|error)/i.test(output)) return "work_failed";
  if (/STATUS:\s*done/i.test(output)) return "work_done";
  return "other_output";
}

function summarizePollingRoundOutput(output: string): PollingRoundOutputSummary {
  const normalized = output.trim();
  const bounded = buildBoundedPreview(normalized, MAX_POLLING_OUTPUT_PREVIEW);

  return {
    ...bounded,
    outcome: classifyPollingRoundOutcome(normalized),
    lines: normalized ? normalized.split(/\r?\n/).length : 0,
  };
}

const UUID_CAPTURE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const RUN_ID_FIELD_REGEX = new RegExp(`["']?run(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");
const STEP_ID_FIELD_REGEX = new RegExp(`["']?step(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");

export interface PollingRoundMetadata {
  assistantOutput: string;
  tokenUsage: number | null;
  runId: string | null;
  stepId: string | null;
  jsonMetadataDetected: boolean;
}

interface PollingIdentifierHints {
  runId: string | null;
  stepId: string | null;
}

type RunIdSource = "metadata_run_id" | "step_lookup" | "none";

interface ResolvedRunId {
  runId: string | null;
  source: RunIdSource;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTokenUsage(value: number): number {
  return Math.max(0, Math.round(value));
}

function firstNumeric(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = parseNumeric(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function extractTokenUsage(usageLike: unknown): number | null {
  const usage = asRecord(usageLike);
  if (!usage) return null;

  const directTotal = firstNumeric(usage, ["totalTokens", "total_tokens", "total"]);
  if (directTotal !== null) return normalizeTokenUsage(directTotal);

  const parts: Array<number | null> = [
    firstNumeric(usage, ["input", "inputTokens", "input_tokens", "prompt_tokens"]),
    firstNumeric(usage, ["output", "outputTokens", "output_tokens", "completion_tokens"]),
    firstNumeric(usage, ["cacheRead", "cache_read", "cache_read_tokens", "cache_read_input_tokens"]),
    firstNumeric(usage, ["cacheWrite", "cache_write", "cache_write_tokens", "cache_creation_input_tokens"]),
  ];

  if (!parts.some((value) => value !== null)) return null;

  const total = parts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return normalizeTokenUsage(total);
}

function collectTextFragments(value: unknown, sink: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;

  if (typeof value === "string") {
    if (value.trim().length > 0) sink.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTextFragments(item, sink, depth + 1);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const nested of Object.values(record)) {
    collectTextFragments(nested, sink, depth + 1);
  }
}

function extractAssistantText(messageLike: unknown): string {
  const message = asRecord(messageLike);
  if (!message) return "";

  const content = message.content;
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  const textSegments: string[] = [];
  for (const item of content) {
    const contentRecord = asRecord(item);
    if (!contentRecord) continue;
    if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
      textSegments.push(contentRecord.text);
    }
  }

  return textSegments.join("\n");
}

function extractIdentifierHints(text: string): PollingIdentifierHints {
  const runMatch = text.match(RUN_ID_FIELD_REGEX);
  const stepMatch = text.match(STEP_ID_FIELD_REGEX);

  return {
    runId: runMatch?.[1] ?? null,
    stepId: stepMatch?.[1] ?? null,
  };
}

export function parsePollingRoundMetadata(output: string): PollingRoundMetadata {
  const normalized = output.trim();
  if (normalized.length === 0) {
    return {
      assistantOutput: "",
      tokenUsage: null,
      runId: null,
      stepId: null,
      jsonMetadataDetected: false,
    };
  }

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

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      const record = asRecord(parsed);
      if (record) events.push(record);
    } catch {
      // best-effort parsing; ignore malformed/non-JSON lines
    }
  }

  if (events.length === 0) {
    const hints = extractIdentifierHints(normalized);
    return {
      assistantOutput: normalized,
      tokenUsage: null,
      runId: hints.runId,
      stepId: hints.stepId,
      jsonMetadataDetected: false,
    };
  }

  let assistantOutput = "";
  let tokenUsage: number | null = null;
  const toolTextFragments: string[] = [];

  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "message_end") {
      const message = asRecord(event.message);
      if (message?.role === "assistant") {
        const assistantText = extractAssistantText(message).trim();
        if (assistantText.length > 0) assistantOutput = assistantText;

        const extractedUsage = extractTokenUsage(message.usage);
        if (extractedUsage !== null) tokenUsage = extractedUsage;
      }
    }

    if (type.startsWith("tool_execution")) {
      collectTextFragments(event, toolTextFragments);
    }
  }

  if (!assistantOutput) {
    assistantOutput = normalized;
  }

  const hintsFromToolData = extractIdentifierHints(toolTextFragments.join("\n"));
  const fallbackHints = extractIdentifierHints(`${assistantOutput}\n${normalized}`);

  return {
    assistantOutput,
    tokenUsage,
    runId: hintsFromToolData.runId ?? fallbackHints.runId,
    stepId: hintsFromToolData.stepId ?? fallbackHints.stepId,
    jsonMetadataDetected: true,
  };
}

async function resolveRunIdForAttribution(metadata: PollingRoundMetadata): Promise<ResolvedRunId> {
  if (metadata.runId) {
    return { runId: metadata.runId, source: "metadata_run_id" };
  }

  if (!metadata.stepId) {
    return { runId: null, source: "none" };
  }

  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const row = db.prepare("SELECT run_id FROM steps WHERE id = ?").get(metadata.stepId) as { run_id: string } | undefined;
    if (!row?.run_id) return { runId: null, source: "none" };
    return { runId: row.run_id, source: "step_lookup" };
  } catch {
    return { runId: null, source: "none" };
  }
}

interface TokenSpendUpdate {
  workflowId?: string;
  tokensSpent: number;
}

async function incrementRunTokenSpend(runId: string, tokenUsage: number): Promise<TokenSpendUpdate | null> {
  const { getDb } = await import("../db.js");
  const db = getDb();
  const result = db
    .prepare("UPDATE runs SET tokens_spent = tokens_spent + ?, updated_at = datetime('now') WHERE id = ?")
    .run(tokenUsage, runId);

  if ((result.changes ?? 0) <= 0) return null;

  const row = db
    .prepare("SELECT workflow_id, tokens_spent FROM runs WHERE id = ?")
    .get(runId) as { workflow_id: string; tokens_spent: number } | undefined;

  if (!row) return null;

  return {
    workflowId: row.workflow_id,
    tokensSpent: row.tokens_spent,
  };
}

/**
 * Auto-complete fallback. See original implementation comments.
 *
 * In the run-scoped world we still pass the run id through so orphan
 * recovery is run-scoped on failures.
 */
export async function autoCompleteStepIfRunning(
  context: Record<string, unknown>,
  metadata: PollingRoundMetadata,
): Promise<void> {
  if (!metadata.stepId) {
    logger.warn("Auto-complete fallback skipped — no stepId in output", { ...context });
    return;
  }

  const { getDb } = await import("../db.js");
  const { completeStep } = await import("./step-ops.js");
  const db = getDb();

  const row = db
    .prepare("SELECT status, type, current_story_id, run_id FROM steps WHERE id = ?")
    .get(metadata.stepId) as { status: string; type: string; current_story_id: string | null; run_id: string } | undefined;

  if (!row) {
    logger.warn("Auto-complete fallback skipped — step not found", {
      ...context,
      stepId: metadata.stepId,
    });
    return;
  }

  if (row.type === "loop" && row.current_story_id === null) {
    logger.debug("Auto-complete fallback skipped — loop step mid-iteration (agent already advanced via CLI)", {
      ...context,
      stepId: metadata.stepId,
      stepStatus: row.status,
    });
    return;
  }

  if (row.status !== "running") {
    logger.debug("Auto-complete fallback skipped — step not running (agent likely reported via CLI)", {
      ...context,
      stepId: metadata.stepId,
      stepStatus: row.status,
    });
    return;
  }

  const recoveryRunId =
    typeof context.runId === "string" && context.runId
      ? (context.runId as string)
      : row.run_id;

  try {
    const result = completeStep(metadata.stepId, metadata.assistantOutput);
    logger.info("Auto-complete fallback invoked completeStep on work_done output", {
      ...context,
      stepId: metadata.stepId,
      result: result.status,
      outputBytes: Buffer.byteLength(metadata.assistantOutput, "utf-8"),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Auto-complete fallback completeStep threw", {
      ...context,
      stepId: metadata.stepId,
      error: errorMessage,
    });

    const failureReason =
      `Previous attempt produced output that could not be auto-completed: ${errorMessage}. ` +
      `If this involved STORIES_JSON, ensure the STORIES_JSON line ends with a literal "]" and ` +
      `is followed by no trailing prose, comments, or markdown — only blank lines or another KEY: line.`;
    try {
      const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
      const workerJobId = typeof context.jobId === "string" ? context.jobId : undefined;
      const recoveryResult = recoverOrphanedStepsForAgent(
        context.agentId as string,
        recoveryRunId,
        undefined,
        undefined,
        failureReason,
        workerJobId,
      );
      if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
        logger.info("Orphaned step recovery after auto-complete throw", {
          ...context,
          stepId: metadata.stepId,
          recovered: recoveryResult.recovered,
          failed: recoveryResult.failed,
          skipped: recoveryResult.skipped,
          autoCompleteError: errorMessage,
        });
      }
    } catch (recoveryErr) {
      logger.error("Orphaned step recovery after auto-complete throw failed", {
        ...context,
        stepId: metadata.stepId,
        error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      });
    }
  }
}

async function attributePollingRoundTokenUsage(
  context: Record<string, unknown>,
  outputSummary: PollingRoundOutputSummary,
  metadata: PollingRoundMetadata,
): Promise<void> {
  if (metadata.tokenUsage === null) {
    if (metadata.jsonMetadataDetected) {
      logger.debug("Polling round token usage unavailable — usage metadata missing", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "usage_metadata_missing",
      });
    } else {
      logger.warn("Polling round token usage unavailable — --mode json may be off", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "non_json_output",
      });
    }
    return;
  }

  if (metadata.tokenUsage <= 0) {
    logger.debug("Polling round token usage not attributed", {
      ...context,
      outcome: outputSummary.outcome,
      reason: "non_positive_usage",
      tokenUsage: metadata.tokenUsage,
    });
    return;
  }

  if (outputSummary.outcome === "heartbeat") {
    try {
      const { incrementSystemTokenSpend } = await import("../db.js");
      const newSystemTotal = incrementSystemTokenSpend(metadata.tokenUsage);
      emitEvent({ts: new Date().toISOString(), event: "system.tokens.updated", runId: "system", tokenDelta: metadata.tokenUsage, tokensSpent: newSystemTotal});
      logger.info("Heartbeat polling round token usage attributed to system spend", {...context, outcome: outputSummary.outcome, reason: "heartbeat_system_overhead", tokenUsage: metadata.tokenUsage, systemTokensSpent: newSystemTotal});
    } catch (err) {
      logger.warn("Heartbeat polling round system token attribution failed", {...context, outcome: outputSummary.outcome, tokenUsage: metadata.tokenUsage, error: String(err)});
    }
    return;
  }

  const resolved = await resolveRunIdForAttribution(metadata);
  if (!resolved.runId) {
    logger.warn("Polling round token usage not attributed to run — run id unresolved", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      outputPreview: outputSummary.preview,
      outputTruncated: outputSummary.truncated,
    });

    // Attribute to system spend instead of silently discarding
    try {
      const { incrementSystemTokenSpend } = await import("../db.js");
      const newSystemTotal = incrementSystemTokenSpend(metadata.tokenUsage);

      emitEvent({
        ts: new Date().toISOString(),
        event: "system.tokens.updated",
        runId: "system",
        tokenDelta: metadata.tokenUsage,
        tokensSpent: newSystemTotal,
      });

      logger.info("Polling round token usage attributed to system spend", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        systemTokensSpent: newSystemTotal,
      });
    } catch (err) {
      logger.warn("Polling round system token attribution failed", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        error: String(err),
      });
    }
    return;
  }

  try {
    const updated = await incrementRunTokenSpend(resolved.runId, metadata.tokenUsage);

    if (!updated) {
      logger.warn("Polling round token usage not attributed — run missing", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        runId: resolved.runId,
        runIdSource: resolved.source,
      });
      return;
    }

    emitEvent({
      ts: new Date().toISOString(),
      event: "run.tokens.updated",
      runId: resolved.runId,
      workflowId: updated.workflowId,
      tokenDelta: metadata.tokenUsage,
      tokensSpent: updated.tokensSpent,
    });

    logger.debug("Polling round token usage attributed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      runId: resolved.runId,
      runIdSource: resolved.source,
      tokensSpent: updated.tokensSpent,
    });
  } catch (err) {
    logger.warn("Polling round token attribution failed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      error: String(err),
    });
  }
}

export function buildPollingRoundContext(
  job: CronJobInfo,
  agent: WorkflowAgent,
  timeoutSeconds: number,
  workingDirectoryForHarness: string | undefined,
  workflow?: WorkflowSpec,
): Record<string, unknown> {
  const model = agent.pollingModel ?? workflow?.polling?.model ?? agent.model ?? job.workModel ?? job.model;

  return {
    jobId: job.id,
    runId: job.runId,
    workflowId: job.workflowId,
    agentId: job.agentId,
    role: agent.role ?? inferRole(agent.id),
    timeoutSeconds,
    workdir: workingDirectoryForHarness,
    workingDirectoryForHarness,
    model,
    harnessType: job.harnessType ?? "pi",
  };
}

export async function executePollingRound(
  job: CronJobInfo,
  agent: WorkflowAgent,
  workflow?: WorkflowSpec,
): Promise<void> {
  const role = agent.role ?? inferRole(agent.id);
  const timeout = agent.timeoutSeconds ?? job.timeoutSeconds ?? getRoleTimeoutSeconds(role);
  const legacyJobWorkdir = (job as CronJobInfo & { workdir?: string }).workdir;
  const workingDirectoryForHarness = job.workingDirectoryForHarness ?? legacyJobWorkdir;
  const context = buildPollingRoundContext(job, agent, timeout, workingDirectoryForHarness, workflow);

  if (!workingDirectoryForHarness) {
    logger.error("Polling round refused — missing harness workdir", {
      ...context,
      reason: "missing_working_directory_for_harness",
    });
    await removeRunCrons(job.runId);
    return;
  }

  // ── Race-safe in-flight guard ───────────────────────────────────
  // Must happen synchronously *before* any awaited async work so
  // concurrent nudge + timer tick invocations cannot launch duplicate
  // harness processes.
  if (!tryMarkJobInFlight(job.id)) {
    logger.info("Polling round skipped — previous harness still in flight", {
      ...context,
      reason: "previous_round_in_flight",
    });
    return;
  }

  // ── Run-scoped status check ──────────────────────────────────────
  // If this run is no longer 'running' (terminal/paused) tear down the
  // job and skip. Without this check, timers leaked from previous CLI
  // processes would keep polling pi for completed runs.
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT status, scheduling_status FROM runs WHERE id = ?")
      .get(job.runId) as { status: string; scheduling_status: string | null } | undefined;
    if (!row || (row.status !== "running" && row.status !== "paused")) {
      logger.info("Polling round skipped — run no longer running; tearing down job", {
        ...context,
        runStatus: row?.status ?? "missing",
        reason: "run_not_running",
      });
      await removeRunCrons(job.runId);
      return;
    }
    if (row.status === "paused") {
      logger.debug("Polling round skipped — run paused", { ...context });
      return;
    }
    if (row.scheduling_status === "draining_pause") {
      logger.debug("Polling round skipped — run draining before pause (in-flight work can complete)", { ...context });
      return;
    }
  } catch (err) {
    logger.warn("Run status check failed; continuing polling round", {
      ...context,
      error: String(err),
    });
  }

  // ── Stale-claim sweeper (run-scoped) ─────────────────────────────
  try {
    const staleThresholdMs = timeout * 1.5 * 1000;
    const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
    const staleResult = recoverOrphanedStepsForAgent(
      job.agentId,
      job.runId,
      staleThresholdMs,
    );
    if (staleResult.recovered > 0 || staleResult.failed > 0) {
      logger.info("Stale-claim sweeper ran", {
        ...context,
        recovered: staleResult.recovered,
        failed: staleResult.failed,
        skipped: staleResult.skipped,
        staleThresholdMs,
      });
    }
  } catch (sweepErr) {
    logger.warn("Stale-claim sweeper failed", {
      ...context,
      error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
    });
  }

  try {
    let agentPersonaInstructions = "";
    try {
      agentPersonaInstructions = await buildAgentPersonaInstructions(job.agentId);
    } catch (err) {
      logger.warn("Agent persona instructions unavailable", {
        ...context,
        workspaceDir: resolveWorkflowWorkspaceDir(job.agentId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const pollingPrompt = buildPollingPrompt(
      job.workflowId,
      job.agentId,
      job.runId,
      agentPersonaInstructions,
    );

    const harnessType = job.harnessType ?? "pi";

    logger.info("Polling round start", context);

    const onSpawn = ({ pid, pgid }: { pid: number; pgid: number }) => {
      inFlightChildren.set(job.id, { pid, pgid, killed: false });
    };

    let output: string;
    if (harnessType === "hermes") {
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

    const metadata = parsePollingRoundMetadata(output);
    const outputSummary = summarizePollingRoundOutput(metadata.assistantOutput || output);

    logger.info("Polling round complete", {
      ...context,
      outcome: outputSummary.outcome,
      outputBytes: outputSummary.bytes,
      outputLines: outputSummary.lines,
      outputPreview: outputSummary.preview,
      outputTruncated: outputSummary.truncated,
      tokenUsage: metadata.tokenUsage,
      metadataFormat: metadata.jsonMetadataDetected ? "json" : "text",
    });

    await attributePollingRoundTokenUsage(context, outputSummary, metadata);

    if (outputSummary.outcome === "work_done") {
      await autoCompleteStepIfRunning(context, metadata);
    } else if (outputSummary.outcome === "other_output") {
      try {
        const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
        const recoveryResult = recoverOrphanedStepsForAgent(
          job.agentId,
          job.runId,
          undefined,
          undefined,
          undefined,
          job.id,
        );
        if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
          logger.info("Orphaned step recovery after clean pi exit (other_output)", {
            ...context,
            recovered: recoveryResult.recovered,
            failed: recoveryResult.failed,
            skipped: recoveryResult.skipped,
          });
        }
      } catch (recoveryErr) {
        logger.error("Orphaned step recovery after clean pi exit failed", {
          ...context,
          error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
        });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorSummary = buildBoundedPreview(errorMessage, MAX_POLLING_ERROR_PREVIEW);

    logger.error("Polling round failed", {
      ...context,
      errorBytes: errorSummary.bytes,
      errorPreview: errorSummary.preview,
      errorTruncated: errorSummary.truncated,
    });

    try {
      const isTimeout = errorMessage.includes("timed out");
      const timeoutRetryReason = isTimeout ? errorMessage : undefined;

      const { recoverOrphanedStepsForAgent } = await import("./step-ops.js");
      const recoveryResult = recoverOrphanedStepsForAgent(
        job.agentId,
        job.runId,
        undefined,
        timeoutRetryReason,
        undefined,
        job.id,
      );
      if (recoveryResult.recovered > 0 || recoveryResult.failed > 0) {
        logger.info("Orphaned step recovery after pi failure", {
          ...context,
          recovered: recoveryResult.recovered,
          failed: recoveryResult.failed,
          skipped: recoveryResult.skipped,
          piExitError: errorMessage,
          isTimeout,
        });
      }
    } catch (recoveryErr) {
      logger.error("Orphaned step recovery failed", {
        ...context,
        error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      });
    }
  } finally {
    inFlightJobs.delete(job.id);
    inFlightChildren.delete(job.id);
  }
}

// ── Public API: run-scoped scheduling ──────────────────────────────

function buildJobId(workflowId: string, runId: string, agentId: string): string {
  // The agent id may already be `${workflowId}_${rawAgentId}` if it was
  // resolved through claimStep paths. Strip the workflow prefix for a clean
  // job id; the full prefixed id is still what we use for DB queries.
  const shortAgent = agentId.startsWith(`${workflowId}_`)
    ? agentId.slice(workflowId.length + 1)
    : agentId;
  return `tamandua-${workflowId}-${runId}-${shortAgent}`;
}

/**
 * Create a single run-scoped polling job (one per (runId, agentId)).
 */
export async function createAgentCronJob(
  params: CreateCronJobParams,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const {
    workflowId,
    runId,
    agent,
    workflow,
    workingDirectoryForHarness,
  } = params;
  const intervalMinutes = params.intervalMinutes ?? 5;
  const staggerMs = params.staggerOffsetMs ?? 0;

  const id = buildJobId(workflowId, runId, agent.id);

  if (jobMetadata.has(id) || activeTimers.has(id) || pendingStartTimers.has(id)) {
    return { ok: true, id };
  }

  const role = agent.role ?? inferRole(agent.id);
  const timeoutSeconds = agent.timeoutSeconds ?? getRoleTimeoutSeconds(role);

  const fullAgentId = agent.id.startsWith(`${workflowId}_`) ? agent.id : `${workflowId}_${agent.id}`;

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

  const jobInfo: CronJobInfo = {
    id,
    workflowId,
    runId,
    agentId: fullAgentId,
    intervalMinutes,
    sessionLabel: `${agent.id}-cron`,
    timeoutSeconds,
    workingDirectoryForHarness,
    harnessType,
    createdAt: new Date().toISOString(),
  };

  jobMetadata.set(id, jobInfo);

  const startPolling = () => {
    pendingStartTimers.delete(id);
    if (!jobMetadata.has(id)) return;
    if (activeTimers.has(id)) return;

    const intervalMs = intervalMinutes * 60 * 1000;
    const timer = setInterval(() => {
      executePollingRound(jobInfo, agent, workflow).catch((err) => {
        logger.error("Unhandled polling error", { jobId: id, runId, error: String(err) });
      });
    }, intervalMs);

    activeTimers.set(id, timer);

    logger.info("Cron job created", {
      id,
      runId,
      agentId: agent.id,
      intervalMinutes,
      staggerMs,
      workingDirectoryForHarness,
    });
  };

  if (staggerMs > 0) {
    const pending = setTimeout(startPolling, staggerMs);
    pendingStartTimers.set(id, pending);
    logger.info("Cron job scheduled with stagger", { id, runId, staggerMs });
  } else {
    startPolling();
  }

  return { ok: true, id };
}

/**
 * Set up polling jobs for every agent in a workflow, scoped to a single run.
 *
 * @param workflow – the workflow spec
 * @param runId    – the run owning these jobs
 * @param options  – workingDirectoryForHarness for the run
 */
export async function setupAgentCrons(
  workflow: WorkflowSpec,
  runId: string,
  options: SetupAgentCronsOptions = {},
): Promise<void> {
  const staggerBaseMs = 60_000; // 1 minute per agent

  for (let i = 0; i < workflow.agents.length; i++) {
    const agent = workflow.agents[i];
    const staggerMs = i * staggerBaseMs;

    const jobId = buildJobId(workflow.id, runId, agent.id);
    if (jobMetadata.has(jobId)) {
      logger.info("Run-scoped cron job already exists; skipping", {
        jobId,
        runId,
        agentId: agent.id,
      });
      continue;
    }

    const intervalMinutes = options.noHurrySaveTokensMode
      ? (workflow.polling?.timeoutSeconds
        ? Math.max(15, Math.ceil(workflow.polling.timeoutSeconds / 60))
        : 15)
      : (workflow.polling?.timeoutSeconds
        ? Math.max(1, Math.ceil(workflow.polling.timeoutSeconds / 60))
        : 5);

    const result = await createAgentCronJob({
      workflowId: workflow.id,
      runId,
      agent,
      workflow,
      intervalMinutes,
      staggerOffsetMs: staggerMs,
      workingDirectoryForHarness: options.workingDirectoryForHarness,
    });

    if (!result.ok) {
      logger.warn("Failed to set up cron for agent", {
        agentId: agent.id,
        runId,
        error: result.error,
      });
    }
  }
}

/**
 * Remove all polling jobs for a given runId. Terminates any in-flight
 * pi process group for the run as well.
 */
export async function removeRunCrons(runId: string): Promise<void> {
  const removed: string[] = [];

  for (const [id, info] of jobMetadata) {
    if (info.runId !== runId) continue;

    const pending = pendingStartTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      pendingStartTimers.delete(id);
    }

    const timer = activeTimers.get(id);
    if (timer) {
      clearInterval(timer);
      activeTimers.delete(id);
    }

    const child = inFlightChildren.get(id);
    if (child && !child.killed) {
      child.killed = true;
      // Terminate the entire process group: SIGTERM, then SIGKILL after 5s.
      if (child.pgid) {
        safeKillPgid(child.pgid, "SIGTERM");
        setTimeout(() => safeKillPgid(child.pgid, "SIGKILL"), 5000).unref();
      }
    }
    inFlightChildren.delete(id);
    inFlightJobs.delete(id);
    jobMetadata.delete(id);
    removed.push(id);
  }

  if (removed.length > 0) {
    logger.info("Removed run-scoped crons", { runId, count: removed.length, jobIds: removed });
  }
}

/**
 * Workflow-wide teardown: remove all jobs for any run of this workflow.
 * Used by tests / shutdown paths. Run-scoped removal is preferred.
 */
export async function removeAgentCrons(workflowId: string): Promise<void> {
  const seenRunIds = new Set<string>();
  for (const info of jobMetadata.values()) {
    if (info.workflowId === workflowId) seenRunIds.add(info.runId);
  }
  for (const runId of seenRunIds) {
    await removeRunCrons(runId);
  }
}

/**
 * @deprecated The new run-scoped scheduler tears down via removeRunCrons.
 * This thin wrapper exists for back-compat with step-ops fire-and-forget calls.
 */
export async function teardownWorkflowCronsIfIdle(workflowId: string): Promise<void> {
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const activeRuns = db
      .prepare("SELECT COUNT(*) AS cnt FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused')")
      .get(workflowId) as { cnt: number } | undefined;

    const count = activeRuns?.cnt ?? 0;
    if (count === 0) {
      logger.info("Workflow idle — tearing down crons", { workflowId });
      await removeAgentCrons(workflowId);
    }
  } catch (err) {
    logger.warn("Failed to check idle status for teardown", {
      workflowId,
      error: String(err),
    });
  }
}

/**
 * List all active cron jobs.
 */
export async function listCronJobs(): Promise<{
  ok: boolean;
  jobs?: Array<{ id: string; runId: string; agentId: string; workingDirectoryForHarness?: string }>;
}> {
  const jobs: Array<{ id: string; runId: string; agentId: string; workingDirectoryForHarness?: string }> = [];
  for (const [id, info] of jobMetadata) {
    jobs.push({
      id,
      runId: info.runId,
      agentId: info.agentId,
      workingDirectoryForHarness: info.workingDirectoryForHarness,
    });
  }
  return { ok: true, jobs };
}

/**
 * Gracefully shut down all cron jobs (and terminate any in-flight pi
 * process groups). Used by tests and daemon SIGTERM.
 */
export function shutdownAllCrons(): void {
  let count = 0;
  for (const [id, timer] of activeTimers) {
    clearInterval(timer);
    activeTimers.delete(id);
    count++;
  }
  for (const [id, timer] of pendingStartTimers) {
    clearTimeout(timer);
    pendingStartTimers.delete(id);
    count++;
  }
  for (const [id, child] of inFlightChildren) {
    if (!child.killed && child.pgid) {
      child.killed = true;
      safeKillPgid(child.pgid, "SIGTERM");
      setTimeout(() => safeKillPgid(child.pgid, "SIGKILL"), 5000).unref();
    }
  }
  inFlightChildren.clear();
  inFlightJobs.clear();
  jobMetadata.clear();
  if (count > 0) {
    logger.info("Shut down all cron jobs", { count });
  }
}

// ── Nudge ─────────────────────────────────────────────────────────────

/**
 * Trigger immediate polling for all scheduled jobs in the given runs.
 *
 * Jobs currently in flight are skipped. Pending-start timers are
 * converted to active interval timers after launch. Active timers are
 * cleared and recreated from now after a launched polling round.
 *
 * The function loads workflow specs from disk via
 * `loadWorkflowSpec(resolveWorkflowDir(…))` to find matching agents.
 */
export async function nudgeScheduledRuns(
  runIds: string[],
  opts?: {
    /** Override for tests — defaults to loadWorkflowSpec from workflow-spec.js. */
    loadWorkflowSpec?: (workflowDir: string) => Promise<WorkflowSpec>;
  },
): Promise<NudgeResult> {
  const runIdSet = new Set(runIds);
  const result: NudgeResult = {
    runIds: [...runIds],
    launched: 0,
    skippedInFlight: 0,
    errors: [],
    jobs: [],
  };

  // Resolve spec loader — lazy-import to avoid circular dep at module
  // init and to allow test overrides.
  const loadSpec: (workflowDir: string) => Promise<WorkflowSpec> =
    opts?.loadWorkflowSpec ??
    (await import("./workflow-spec.js")).loadWorkflowSpec;

  // Collect matching jobs from jobMetadata.
  const matchingJobs: Array<{ info: CronJobInfo; id: string }> = [];
  for (const [id, info] of jobMetadata) {
    if (runIdSet.has(info.runId)) {
      matchingJobs.push({ info, id });
    }
  }

  // Process each job.
  for (const { info, id: jobId } of matchingJobs) {
    // ── In-flight guard ──────────────────────────────────────────
    if (inFlightJobs.has(jobId)) {
      result.skippedInFlight++;
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "skipped_in_flight",
      });
      continue;
    }

    try {
      // Load workflow spec from disk.
      const flowDir = resolveWorkflowDir(info.workflowId);
      const workflow = await loadSpec(flowDir);

      // Find matching agent.
      // jobMetadata stores agentId as the full prefixed form
      //   e.g. "feature-dev-merge-worktree_developer"
      // Workflow agents use the short id (e.g. "developer").
      const shortAgentId = info.agentId.startsWith(`${info.workflowId}_`)
        ? info.agentId.slice(info.workflowId.length + 1)
        : info.agentId;

      const agent = workflow.agents.find(
        (a) =>
          a.id === shortAgentId ||
          `${info.workflowId}_${a.id}` === info.agentId,
      );

      if (!agent) {
        const errMsg = `Agent ${info.agentId} not found in workflow ${info.workflowId}`;
        result.errors.push({
          runId: info.runId,
          agentId: info.agentId,
          error: errMsg,
        });
        result.jobs.push({
          runId: info.runId,
          agentId: info.agentId,
          status: "error",
          error: errMsg,
        });
        continue;
      }

      // ── Launch polling round (fire-and-forget) ────────────────
      // tryMarkJobInFlight inside executePollingRound prevents
      // duplicate launches with near-simultaneous timer ticks.
      executePollingRound(info, agent, workflow).catch((err) => {
        logger.error("Nudge-launched polling round failed", {
          jobId,
          runId: info.runId,
          agentId: info.agentId,
          error: String(err),
        });
      });

      // ── Timer reset ───────────────────────────────────────────
      const activeTimer = activeTimers.get(jobId);
      const pendingTimer = pendingStartTimers.get(jobId);
      const intervalMs = info.intervalMinutes * 60 * 1000;

      if (activeTimer) {
        // Clear existing interval, recreate from now.
        clearInterval(activeTimer);
        activeTimers.delete(jobId);
        const newTimer = setInterval(() => {
          executePollingRound(info, agent, workflow).catch((err) => {
            logger.error("Unhandled polling error", {
              jobId,
              runId: info.runId,
              error: String(err),
            });
          });
        }, intervalMs);
        activeTimers.set(jobId, newTimer);
      } else if (pendingTimer) {
        // Convert pending-start to active interval.
        clearTimeout(pendingTimer);
        pendingStartTimers.delete(jobId);
        const newTimer = setInterval(() => {
          executePollingRound(info, agent, workflow).catch((err) => {
            logger.error("Unhandled polling error", {
              jobId,
              runId: info.runId,
              error: String(err),
            });
          });
        }, intervalMs);
        activeTimers.set(jobId, newTimer);
      }
      // If neither timer exists, the job's own startPolling() already
      // created a timer — we leave it alone.

      result.launched++;
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "launched",
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({
        runId: info.runId,
        agentId: info.agentId,
        error: errorMsg,
      });
      result.jobs.push({
        runId: info.runId,
        agentId: info.agentId,
        status: "error",
        error: errorMsg,
      });
    }
  }

  return result;
}

// ── Internal helpers (exposed for daemon reconciler + tests) ─────────

/** @internal — exposed for daemon reconciler. */
export function _scheduledRunIds(): Set<string> {
  const ids = new Set<string>();
  for (const info of jobMetadata.values()) ids.add(info.runId);
  return ids;
}

/** @internal — exposed for daemon reconciler. */
export function _hasRunScheduled(runId: string): boolean {
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) return true;
  }
  return false;
}

/** @internal — exposed for daemon admission/capacity checks. */
export function _scheduledJobCount(): number {
  return jobMetadata.size;
}

/** @internal — exposed for daemon admission/capacity checks. */
export function _scheduledJobCountForRun(runId: string): number {
  let count = 0;
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) count++;
  }
  return count;
}

/** @internal — exposed for test assertions on interval values. */
export function _getJobIntervalsForRun(runId: string): Array<{ agentId: string; intervalMinutes: number }> {
  const results: Array<{ agentId: string; intervalMinutes: number }> = [];
  for (const info of jobMetadata.values()) {
    if (info.runId === runId) {
      results.push({ agentId: info.agentId, intervalMinutes: info.intervalMinutes });
    }
  }
  return results;
}

/** @internal — exposed for daemon admission safety checks. */
export function _runIdForScheduledHarnessWorkdir(
  workingDirectoryForHarness: string,
  excludingRunId?: string,
): string | null {
  let requested = path.resolve(workingDirectoryForHarness);
  try {
    requested = fs.realpathSync(requested);
  } catch {
    /* admission validates existence before calling this */
  }

  for (const info of jobMetadata.values()) {
    if (excludingRunId && info.runId === excludingRunId) continue;
    if (!info.workingDirectoryForHarness) continue;

    let scheduled = path.resolve(info.workingDirectoryForHarness);
    try {
      scheduled = fs.realpathSync(scheduled);
    } catch {
      /* stale job metadata should not block scheduling by itself */
    }

    if (scheduled === requested) return info.runId;
  }

  return null;
}
