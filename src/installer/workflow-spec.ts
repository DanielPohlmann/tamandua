import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { BASH_RUNNER_AGENT_ID, type WorkflowSpec } from "./types.js";

/**
 * Load and parse a workflow.yml file from a workflow directory.
 * Returns a validated WorkflowSpec.
 */
export async function loadWorkflowSpec(
  workflowDir: string,
): Promise<WorkflowSpec> {
  const ymlPath = path.join(workflowDir, "workflow.yml");
  let raw: string;
  try {
    raw = await fs.readFile(ymlPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `No workflow.yml found in ${workflowDir}. Expected a workflow specification file.`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse workflow.yml in ${workflowDir}: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `workflow.yml in ${workflowDir} did not parse to an object`,
    );
  }

  const spec = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof spec.id !== "string" || !spec.id) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: id`);
  }
  if (!Array.isArray(spec.agents) || spec.agents.length === 0) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: agents (must be a non-empty array)`);
  }
  if (!Array.isArray(spec.steps)) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: steps (must be an array)`);
  }

  // Validate each agent has required fields
  for (let i = 0; i < spec.agents.length; i++) {
    const agent = spec.agents[i] as Record<string, unknown>;
    if (typeof agent.id !== "string" || !agent.id) {
      throw new Error(
        `workflow.yml agent[${i}] in ${workflowDir} is missing required field: id`,
      );
    }
    if (!agent.workspace || typeof agent.workspace !== "object") {
      throw new Error(
        `workflow.yml agent[${i}] ("${agent.id}") in ${workflowDir} is missing required field: workspace`,
      );
    }
    const ws = agent.workspace as Record<string, unknown>;
    if (typeof ws.baseDir !== "string") {
      throw new Error(
        `workflow.yml agent[${i}] ("${agent.id}") workspace in ${workflowDir} is missing required field: baseDir`,
      );
    }
    if (agent.id === BASH_RUNNER_AGENT_ID) {
      throw new Error(
        `workflow.yml in ${workflowDir}: agent id "${BASH_RUNNER_AGENT_ID}" is reserved for bash steps`,
      );
    }
  }

  const steps = spec.steps as Array<Record<string, unknown>>;
  const seenStepIds = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (typeof step.id !== "string" || !step.id) {
      throw new Error(`workflow.yml step[${i}] in ${workflowDir} is missing required field: id`);
    }
    if (seenStepIds.has(step.id)) {
      throw new Error(`workflow.yml step[${i}] in ${workflowDir} has a duplicate step id "${step.id}"`);
    }
    seenStepIds.add(step.id);
    if (step.type === "bash") {
      if (typeof step.run !== "string" || !step.run.trim()) {
        throw new Error(
          `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} is a bash step and is missing required field: run`,
        );
      }
      step.agent = BASH_RUNNER_AGENT_ID;
      step.input = "";
      step.expects = "";
      continue;
    }
    if (typeof step.agent !== "string" || !step.agent) {
      throw new Error(
        `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} is missing required field: agent`,
      );
    }
  }

  validateFixPolicies(steps, workflowDir);
  validateBudgets(spec.budgets, workflowDir);

  // Validate run.workspace if present
  if (spec.run && typeof spec.run === "object") {
    const runCfg = spec.run as Record<string, unknown>;
    if (runCfg.workspace !== undefined) {
      if (runCfg.workspace !== "direct" && runCfg.workspace !== "worktree") {
        throw new Error(
          `workflow.yml in ${workflowDir} has invalid run.workspace value: ` +
          `"${String(runCfg.workspace)}". Must be "direct" or "worktree".`,
        );
      }
    }
  }

  return spec as unknown as WorkflowSpec;
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateFixPolicies(steps: Array<Record<string, unknown>>, workflowDir: string): void {
  const indexById = new Map(steps.map((s, i) => [s.id as string, i]));
  const fixStepIds = new Set(
    steps.map((s) => (s.on_fail as Record<string, unknown> | undefined)?.fix_step).filter((id) => id !== undefined),
  );
  steps.forEach((step, i) => {
    const onFail = step.on_fail as Record<string, unknown> | undefined;
    if (!onFail || onFail.fix_step === undefined) return;
    const where = `workflow.yml step "${String(step.id)}" in ${workflowDir}`;
    const gateType = step.type ?? "single";
    if (gateType !== "single" && gateType !== "bash") {
      throw new Error(`${where}: only single agent steps and bash steps can declare on_fail.fix_step`);
    }
    const fixStepId = onFail.fix_step;
    if (typeof fixStepId !== "string" || !indexById.has(fixStepId)) {
      throw new Error(`${where}: on_fail.fix_step "${String(fixStepId)}" does not match any step`);
    }
    if (fixStepId === step.id) {
      throw new Error(`${where}: on_fail.fix_step cannot point at the step itself`);
    }
    const fixStep = steps[indexById.get(fixStepId)!];
    const fixType = fixStep.type ?? "single";
    const fixOnFail = fixStep.on_fail as Record<string, unknown> | undefined;
    if (fixType !== "single" || fixOnFail?.fix_step !== undefined) {
      throw new Error(
        `${where}: fix step "${fixStepId}" must be a single agent step without its own on_fail.fix_step`,
      );
    }
    if (onFail.max_rounds !== undefined && !isPositiveInteger(onFail.max_rounds)) {
      throw new Error(`${where}: on_fail.max_rounds must be a positive integer`);
    }
    if (onFail.return_step !== undefined) {
      const returnIndex = indexById.get(onFail.return_step as string);
      if (returnIndex === undefined || returnIndex >= i) {
        throw new Error(`${where}: on_fail.return_step "${String(onFail.return_step)}" must name an earlier step`);
      }
      if (fixStepIds.has(onFail.return_step)) {
        throw new Error(`${where}: on_fail.return_step "${String(onFail.return_step)}" names a fix step`);
      }
    }
  });
}

function validateBudgets(budgets: unknown, workflowDir: string): void {
  if (budgets === undefined) return;
  if (!budgets || typeof budgets !== "object") {
    throw new Error(`workflow.yml in ${workflowDir}: budgets must be a mapping`);
  }
  for (const key of ["max_fix_rounds", "max_tokens"] as const) {
    const value = (budgets as Record<string, unknown>)[key];
    if (value !== undefined && !isPositiveInteger(value)) {
      throw new Error(`workflow.yml in ${workflowDir}: budgets.${key} must be a positive integer`);
    }
  }
}
