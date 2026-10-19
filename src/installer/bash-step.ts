import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { claimStep, completeBashStep, resolveStepContext } from "./step-ops.js";
import { BASH_ENV_KEYS_CONTEXT_KEY, BASH_RUNNER_AGENT_ID, type WorkflowAgent, type WorkflowSpec } from "./types.js";

export const BASH_RUNNER_TIMEOUT_SECONDS = 3600;
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024;
const MAX_ENV_VALUE_CHARS = 4096;
const PIPE_GRACE_MS = 2000;
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

function workflowDeclaredEnvKeys(context: Record<string, string>): string[] {
  const raw = context[BASH_ENV_KEYS_CONTEXT_KEY];
  if (!raw) return [];
  try {
    const keys: unknown = JSON.parse(raw);
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Agents write arbitrary KEY: value lines into the run context, so only the
 * keys the workflow declared plus the engine's own keys reach a gate's env.
 */
export function buildBashEnv(context: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set([...ENGINE_ENV_KEYS, ...workflowDeclaredEnvKeys(context)]);
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

export function runBashCommand(command: string, options: BashRunOptions): Promise<BashResult> {
  return new Promise((resolve) => {
    const cap = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
    const child = spawn(command, {
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
    const result = await run(step.run_command, { cwd, env: buildBashEnv(context), timeoutSeconds, onSpawn: hooks.onSpawn });
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
