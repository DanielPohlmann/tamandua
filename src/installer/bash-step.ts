import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { windowsShellCommand } from "../lib/posix-shell.js";
import { claimStep, completeBashStep, parseDeclaredContextKeys, recoverOrphanedStepsForAgent, resolveStepContext } from "./step-ops.js";
import { BASH_ENV_KEYS_CONTEXT_KEY, BASH_RUNNER_AGENT_ID, type WorkflowAgent, type WorkflowSpec } from "./types.js";

export const BASH_RUNNER_TIMEOUT_SECONDS = 3600;
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024;
const MAX_ENV_VALUE_CHARS = 4096;
const PIPE_GRACE_MS = 2000;
const STALE_CLAIM_GRACE_SECONDS = 300;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTECTED_ENV_NAMES = new Set([
  "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "HOME", "USERPROFILE", "TEMP", "TMP", "SHELL",
]);
const ENGINE_ENV_KEYS = ["run_id", "repo", "branch", "base_branch", "feature_complete", "task"];

export interface BashResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  /** Set when the shell itself could not be started, as opposed to the command failing. */
  spawnError?: string;
}

export interface BashRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  maxOutputChars?: number;
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
}

function isExcludedFromEnv(key: string, value: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.endsWith("_output") ||
    lower.startsWith("findings_") ||
    lower.startsWith("fix_feedback") ||
    lower.startsWith("minor_findings") ||
    value.length > MAX_ENV_VALUE_CHARS
  );
}

/**
 * Agents write arbitrary KEY: value lines into the run context, so only the
 * keys the workflow declared plus the engine's own keys reach a gate's env.
 */
export function buildBashEnv(context: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set([...ENGINE_ENV_KEYS, ...parseDeclaredContextKeys(context)]);
  allowed.delete(BASH_ENV_KEYS_CONTEXT_KEY);
  for (const key of allowed) {
    if (!Object.hasOwn(context, key)) continue;
    const value = String(context[key]);
    if (!ENV_NAME.test(key) || isExcludedFromEnv(key, value)) continue;
    const name = key.toUpperCase();
    if (PROTECTED_ENV_NAMES.has(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * Kills a process and all its descendants. On Windows this uses taskkill /T;
 * on POSIX it signals the process group (the child must be spawned detached).
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): ChildProcess | undefined {
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {});
      return killer;
    } catch {
      return undefined;
    }
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // group may already be gone
  }
  return undefined;
}

/**
 * PowerShell script that kills what a finished process left behind. Windows
 * keeps no process groups, and taskkill /T cannot walk a tree whose root has
 * exited, so the tree is rebuilt from ParentProcessId. Only processes created
 * after the root started are followed, so a PID reused by an unrelated older
 * process never matches.
 */
export function buildOrphanReapScript(
  rootPid: number,
  startedAtMs: number,
  known: ReadonlyMap<number, number> = new Map(),
): string {
  // Descendants recorded while the root was alive. They are seeds even when the
  // process between them and the root has exited (e.g. `cmd /c npx` dies and
  // leaves npx's node running), but only if PID and creation time still match.
  const knownEntries = [...known].map(([pid, ms]) => `${Math.trunc(pid)} = ${Math.trunc(ms)}`).join("; ");
  return [
    `$root = ${Math.trunc(rootPid)}; $since = ${Math.trunc(startedAtMs)}; $self = $PID; $known = @{ ${knownEntries} }`,
    "$all = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Parent = [int]$_.ParentProcessId; Ms = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | Where-Object { $_.Ms -ge $since })",
    "$set = @{ $root = $true }; $hits = @()",
    "foreach ($p in $all) { if ($known.ContainsKey($p.Id) -and [math]::Abs($known[$p.Id] - $p.Ms) -lt 1000 -and $p.Id -ne $self) { $set[$p.Id] = $true; $hits += $p.Id } }",
    "$grew = $true",
    "while ($grew) { $grew = $false; foreach ($p in $all) { if ($set.ContainsKey($p.Parent) -and -not $set.ContainsKey($p.Id) -and $p.Id -ne $self) { $set[$p.Id] = $true; $hits += $p.Id; $grew = $true } } }",
    "foreach ($id in $hits) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
}

export interface ProcessSample {
  pid: number;
  parentPid: number;
  createdMs: number;
}

/**
 * Descendants of `rootPid` in a process snapshot, following only processes
 * created at or after `sinceMs` (older ones cannot be the root's children, so a
 * reused PID never matches). Already-known descendants are also walked from,
 * which keeps the chain when an intermediate process has exited.
 */
export function collectDescendants(
  snapshot: readonly ProcessSample[],
  rootPid: number,
  sinceMs: number,
  known: ReadonlyMap<number, number> = new Map(),
): Map<number, number> {
  const fresh = snapshot.filter((p) => p.createdMs >= sinceMs);
  const found = new Map<number, number>();
  const set = new Set<number>([rootPid]);
  for (const p of fresh) {
    const ms = known.get(p.pid);
    if (ms !== undefined && Math.abs(ms - p.createdMs) < 1000) {
      set.add(p.pid);
      found.set(p.pid, p.createdMs);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of fresh) {
      if (set.has(p.parentPid) && !set.has(p.pid)) {
        set.add(p.pid);
        found.set(p.pid, p.createdMs);
        grew = true;
      }
    }
  }
  return found;
}

/** Parses `pid parentPid createdMs` lines from the sampler script. */
export function parseProcessSamples(text: string): ProcessSample[] {
  const samples: ProcessSample[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, parentPid, createdMs] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(parentPid) && Number.isFinite(createdMs)) {
      samples.push({ pid, parentPid, createdMs });
    }
  }
  return samples;
}

const SAMPLE_SCRIPT =
  "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
const SAMPLE_INTERVAL_MS = 15_000;
const FIRST_SAMPLE_DELAY_MS = 8_000;

/** Root pid → start time and the descendants seen so far (pid → creation ms). */
const trackedRoots = new Map<number, { startedAtMs: number; seen: Map<number, number> }>();
let samplerTimer: NodeJS.Timeout | undefined;
let sampling = false;

function sampleTrackedRoots(): void {
  if (sampling || trackedRoots.size === 0) return;
  sampling = true;
  let out = "";
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SAMPLE_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf-8"); });
    child.on("error", () => { sampling = false; });
    child.on("close", () => {
      sampling = false;
      const snapshot = parseProcessSamples(out);
      for (const [root, entry] of trackedRoots) {
        for (const [pid, ms] of collectDescendants(snapshot, root, entry.startedAtMs, entry.seen)) {
          entry.seen.set(pid, ms);
        }
      }
    });
  } catch {
    sampling = false;
  }
}

/**
 * Windows only: start recording the descendants of a running agent so
 * reapOrphanedDescendants can still find them after the process between them
 * and the agent has exited. One sampler serves every tracked agent and stops
 * when none is left. No-op on POSIX.
 */
export function trackDescendants(rootPid: number | undefined, startedAtMs: number): void {
  if (process.platform !== "win32" || !rootPid) return;
  trackedRoots.set(rootPid, { startedAtMs, seen: new Map() });
  setTimeout(sampleTrackedRoots, FIRST_SAMPLE_DELAY_MS).unref();
  if (!samplerTimer) {
    samplerTimer = setInterval(sampleTrackedRoots, SAMPLE_INTERVAL_MS);
    samplerTimer.unref();
  }
}

function untrack(rootPid: number): Map<number, number> {
  const seen = trackedRoots.get(rootPid)?.seen ?? new Map<number, number>();
  trackedRoots.delete(rootPid);
  if (trackedRoots.size === 0 && samplerTimer) {
    clearInterval(samplerTimer);
    samplerTimer = undefined;
  }
  return seen;
}

/**
 * Windows only: kill the descendants a process left running after it exited
 * (dev servers, watchers, MCP servers behind `cmd /c npx`), which otherwise
 * keep running and burn CPU. Uses what trackDescendants recorded plus a fresh
 * walk from the root. Fire-and-forget; no-op on POSIX.
 */
export function reapOrphanedDescendants(rootPid: number | undefined, startedAtMs: number): void {
  if (process.platform !== "win32" || !rootPid) return;
  const known = untrack(rootPid);
  try {
    const reaper = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", buildOrphanReapScript(rootPid, startedAtMs, known)],
      { stdio: "ignore", windowsHide: true },
    );
    reaper.on("error", () => {});
  } catch {
    // best effort
  }
}

export function runBashCommand(command: string, options: BashRunOptions): Promise<BashResult> {
  return new Promise((resolve) => {
    const cap = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
    const child = spawn(windowsShellCommand(command), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    if (child.pid && options.onSpawn) {
      try {
        options.onSpawn({ pid: child.pid, pgid: child.pid });
      } catch (err) {
        logger.warn("bash onSpawn callback threw", { error: String(err) });
      }
    }

    let tail = "";
    const attach = (stream: NodeJS.ReadableStream | null) => {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (chunk: Buffer) => {
        tail += decoder.write(chunk);
        if (tail.length > cap) tail = tail.slice(tail.length - cap);
      });
    };
    attach(child.stdout);
    attach(child.stderr);

    let settled = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const marker = timedOut ? `\nCommand timed out after ${options.timeoutSeconds}s` : "";
      const result: BashResult = { exitCode: timedOut ? 124 : code ?? 1, output: tail + marker, timedOut };
      if (spawnError) result.spawnError = spawnError;
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // taskkill must walk the tree before the shell dies, or the descendants are orphaned.
      const killer = child.pid ? killProcessTree(child.pid, "SIGKILL") : undefined;
      if (killer) killer.on("exit", () => child.kill("SIGKILL"));
      else child.kill("SIGKILL");
    }, options.timeoutSeconds * 1000);

    child.on("error", (err) => {
      if (settled) return;
      spawnError = err.message;
      tail += `\n${err.message}`;
      finish(127);
    });
    child.on("exit", (code) => {
      graceTimer = setTimeout(() => finish(code), PIPE_GRACE_MS);
    });
    child.on("close", (code) => finish(code));
  });
}

export function bashRunnerAgent(): WorkflowAgent {
  return {
    id: BASH_RUNNER_AGENT_ID,
    name: "Bash Runner",
    role: "coding",
    timeoutSeconds: BASH_RUNNER_TIMEOUT_SECONDS,
    workspace: { baseDir: "", files: {} },
  };
}

export function schedulableAgents(workflow: WorkflowSpec): WorkflowAgent[] {
  const hasBashSteps = workflow.steps.some((step) => step.type === "bash");
  return hasBashSteps ? [...workflow.agents, bashRunnerAgent()] : workflow.agents;
}

/**
 * Re-queues bash steps of this run that a dead daemon left `running`. A live
 * round is protected by the in-flight guard and finishes within the timeout,
 * so anything older than timeout + grace has no owner. On POSIX the detached
 * process group recorded at spawn is killed first; on Windows a PID may be
 * reused by then, so taskkill /T is not risked.
 */
export function recoverStaleBashSteps(
  job: { runId: string; agentId: string },
  timeoutSeconds: number,
): { recovered: number; failed: number; skipped: number } {
  const staleThresholdMs = (timeoutSeconds + STALE_CLAIM_GRACE_SECONDS) * 1000;
  if (process.platform !== "win32") {
    const orphans = getDb().prepare(
      `SELECT claim_pgid FROM steps WHERE agent_id = ? AND run_id = ? AND status = 'running' AND claim_pgid IS NOT NULL
         AND (julianday('now') - julianday(updated_at)) * 86400000 > ?`,
    ).all(job.agentId, job.runId, staleThresholdMs) as { claim_pgid: number }[];
    for (const orphan of orphans) killProcessTree(orphan.claim_pgid);
  }
  return recoverOrphanedStepsForAgent(job.agentId, job.runId, staleThresholdMs);
}

export interface BashRoundHooks {
  onSpawn?: BashRunOptions["onSpawn"];
  run?: typeof runBashCommand;
}

function engineError(detail: string): string {
  return `engine error: ${detail}`;
}

/** Why a finished command must block rather than reach the fix agent, if it must. */
function blockedReasonFor(result: BashResult, timeoutSeconds: number): string | undefined {
  if (result.spawnError) return engineError(result.spawnError);
  if (result.timedOut) return `timed out after ${timeoutSeconds}s`;
  return undefined;
}

export async function executeBashRound(
  job: { id: string; runId: string; agentId: string; workingDirectoryForHarness?: string },
  timeoutSeconds: number,
  hooks: BashRoundHooks = {},
): Promise<"no_work" | "completed"> {
  const claim = claimStep(job.agentId, job.runId, { jobId: job.id, pid: process.pid });
  if (!claim.found || !claim.stepId) return "no_work";
  const stepId = claim.stepId;

  try {
    const step = getDb().prepare("SELECT step_id, step_index, run_command FROM steps WHERE id = ?").get(stepId) as
      { step_id: string; step_index: number; run_command: string | null };
    const context = resolveStepContext(job.runId, step.step_index);
    const cwd = job.workingDirectoryForHarness ?? context["repo"] ?? process.cwd();
    const run = hooks.run ?? runBashCommand;

    if (!step.run_command) {
      const reason = engineError(`bash step ${step.step_id} has no run command`);
      await completeBashStep(stepId, 1, reason, reason);
      return "completed";
    }
    if (!fs.existsSync(cwd)) {
      const reason = engineError(`working directory does not exist: ${cwd}`);
      await completeBashStep(stepId, 1, reason, reason);
      return "completed";
    }

    logger.info("bash step launched", { runId: job.runId, stepId: step.step_id, cwd });
    const onSpawn: BashRunOptions["onSpawn"] = (handle) => {
      getDb().prepare("UPDATE steps SET claim_pgid = ? WHERE id = ?").run(handle.pgid, stepId);
      hooks.onSpawn?.(handle);
    };
    const result = await run(step.run_command, { cwd, env: buildBashEnv(context), timeoutSeconds, onSpawn });
    logger.info("bash step finished", { runId: job.runId, stepId: step.step_id, exitCode: result.exitCode, timedOut: result.timedOut });

    await completeBashStep(stepId, result.exitCode, result.output, blockedReasonFor(result, timeoutSeconds));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("bash step engine error", { runId: job.runId, stepId, error: message });
    try {
      const reason = engineError(message);
      await completeBashStep(stepId, 1, `<${reason}>`, reason);
    } catch (completeErr) {
      logger.error("bash step could not be failed after engine error", {
        runId: job.runId,
        stepId,
        error: completeErr instanceof Error ? completeErr.message : String(completeErr),
      });
    }
  }
  return "completed";
}
