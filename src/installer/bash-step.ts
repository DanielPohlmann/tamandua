import { spawn } from "node:child_process";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { claimStep, completeBashStep, resolveStepContext } from "./step-ops.js";
import { BASH_RUNNER_AGENT_ID, type WorkflowAgent, type WorkflowSpec } from "./types.js";

export const BASH_RUNNER_TIMEOUT_SECONDS = 3600;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BashResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export function buildBashEnv(context: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (ENV_NAME.test(key)) env[key.toUpperCase()] = String(value);
  }
  return env;
}

export function runBashCommand(
  command: string,
  options: { cwd: string; env: Record<string, string>; timeoutSeconds: number },
): Promise<BashResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    let bytes = 0;
    const collect = (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      bytes += chunk.length;
      chunks.push(chunk.toString("utf-8"));
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutSeconds * 1000);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: `${chunks.join("")}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = chunks.join("") + (timedOut ? `\nCommand timed out after ${options.timeoutSeconds}s` : "");
      resolve({ exitCode: timedOut ? 124 : code ?? 1, output, timedOut });
    });
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

export async function executeBashRound(
  job: { id: string; runId: string; agentId: string; workingDirectoryForHarness?: string },
  timeoutSeconds: number,
): Promise<"no_work" | "completed"> {
  const claim = claimStep(job.agentId, job.runId, { jobId: job.id, pid: process.pid });
  if (!claim.found || !claim.stepId) return "no_work";

  const step = getDb().prepare("SELECT step_id, step_index, run_command FROM steps WHERE id = ?").get(claim.stepId) as
    { step_id: string; step_index: number; run_command: string | null };
  const context = resolveStepContext(job.runId, step.step_index);
  const cwd = job.workingDirectoryForHarness ?? context["repo"] ?? process.cwd();

  logger.info("bash step launched", { runId: job.runId, stepId: step.step_id, cwd });
  const result = step.run_command
    ? await runBashCommand(step.run_command, { cwd, env: buildBashEnv(context), timeoutSeconds })
    : { exitCode: 1, output: `Bash step ${step.step_id} has no run command`, timedOut: false };
  logger.info("bash step finished", { runId: job.runId, stepId: step.step_id, exitCode: result.exitCode, timedOut: result.timedOut });

  await completeBashStep(claim.stepId, result.exitCode, result.output);
  return "completed";
}
