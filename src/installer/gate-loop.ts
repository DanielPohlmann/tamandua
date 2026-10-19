import { getDb } from "../db.js";
import { emitEvent } from "./events.js";
import { logger } from "../lib/logger.js";
import {
  ENGINE_FINDING_FILE,
  applyFixReport,
  formatMinorFindings,
  isActionable,
  listFindings,
  parseDisputed,
  parseResolved,
  recordGateFindings,
  resolveGateFindings,
  type Finding,
  type StoredFinding,
} from "./findings.js";
import type { WorkflowStepFailure } from "./types.js";

export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_MAX_FIX_ROUNDS = 8;
export const EVIDENCE_LINES = 200;

export interface FixPolicy {
  fix_step: string;
  max_rounds: number;
  return_step?: string;
}

export interface GateStepRow {
  id: string;
  run_id: string;
  step_id: string;
  fix_rounds: number;
}

export interface GateVerdict {
  failed: boolean;
  blockedReason?: string;
  findings: Finding[];
  output: string;
}

export type GateSettlement = { status: "fixing" | "blocked"; detail: string } | null;

export interface BudgetOverrides {
  maxRounds?: number;
  maxFixRounds?: number;
}

export function serializeFixPolicy(onFail: WorkflowStepFailure | undefined): string | null {
  if (!onFail?.fix_step) return null;
  const policy: FixPolicy = { fix_step: onFail.fix_step, max_rounds: onFail.max_rounds ?? DEFAULT_MAX_ROUNDS };
  if (onFail.return_step) policy.return_step = onFail.return_step;
  return JSON.stringify(policy);
}

export function parseFixPolicy(json: string | null): FixPolicy | null {
  if (!json) return null;
  const parsed = JSON.parse(json) as Partial<FixPolicy>;
  if (!parsed.fix_step) return null;
  const policy: FixPolicy = { fix_step: parsed.fix_step, max_rounds: parsed.max_rounds ?? DEFAULT_MAX_ROUNDS };
  if (parsed.return_step) policy.return_step = parsed.return_step;
  return policy;
}

export function tailLines(text: string, count: number): string {
  return text.split(/\r?\n/).slice(-count).join("\n");
}

export function contextKeyFor(prefix: string, stepId: string): string {
  return `${prefix}_${stepId.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}`;
}

export function bashOutputContextKey(stepId: string): string {
  return `${stepId.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}_output`;
}

let transactionDepth = 0;

function inTransaction<T>(fn: () => T): T {
  const db = getDb();
  if (transactionDepth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  transactionDepth++;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    transactionDepth--;
  }
}

export function mergeRunContext(runId: string, patch: Record<string, string>): void {
  const db = getDb();
  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!row) return;
  const context = { ...(JSON.parse(row.context) as Record<string, string>), ...patch };
  db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), runId);
}

function workflowIdOf(runId: string): string | undefined {
  const row = getDb().prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
  return row?.workflow_id;
}

function publishFindingsContext(runId: string, gate: string): void {
  const summary = listFindings(runId, { gate }).map((f) => ({
    fingerprint: f.fingerprint,
    rule: f.rule,
    severity: f.severity,
    file: f.file,
    symbol: f.symbol,
    status: f.status,
  }));
  mergeRunContext(runId, {
    [contextKeyFor("findings", gate)]: JSON.stringify(summary),
    minor_findings: formatMinorFindings(runId),
  });
}

function engineFinding(gate: string, output: string): Finding {
  return {
    rule: `gate/${gate}`,
    severity: "blocking",
    file: ENGINE_FINDING_FILE,
    evidence: tailLines(output, EVIDENCE_LINES),
  };
}

function toFixFeedback(findings: StoredFinding[]): string {
  return JSON.stringify(findings.map((f) => ({
    fingerprint: f.fingerprint,
    rule: f.rule,
    severity: f.severity,
    file: f.file,
    line: f.line,
    symbol: f.symbol,
    evidence: f.evidence,
    expected: f.expected,
  })));
}

export function blockRunAtStep(params: {
  runId: string;
  stepDbId: string;
  stepName: string;
  reason: string;
  output: string;
}): { status: "blocked"; detail: string } {
  const db = getDb();
  inTransaction(() => {
    db.prepare("UPDATE steps SET status = 'waiting', output = ?, updated_at = datetime('now') WHERE id = ?")
      .run(params.output, params.stepDbId);
    mergeRunContext(params.runId, { blocked_step: params.stepName, blocked_reason: params.reason });
    db.prepare("UPDATE runs SET status = 'blocked', updated_at = datetime('now') WHERE id = ?").run(params.runId);
  });
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.blocked",
    runId: params.runId,
    workflowId: workflowIdOf(params.runId),
    stepId: params.stepName,
    detail: params.reason,
  });
  logger.warn("Run blocked", { runId: params.runId, stepId: params.stepName, reason: params.reason });
  return { status: "blocked", detail: params.reason };
}

function effectiveMaxRounds(runId: string, policy: FixPolicy): number {
  const row = getDb().prepare("SELECT max_rounds_override FROM runs WHERE id = ?").get(runId) as
    { max_rounds_override: number | null } | undefined;
  return row?.max_rounds_override ?? policy.max_rounds;
}

function startFixRound(gate: GateStepRow, policy: FixPolicy, actionable: StoredFinding[], output: string): GateSettlement {
  const db = getDb();
  const fixStep = db.prepare("SELECT id FROM steps WHERE run_id = ? AND step_id = ?").get(gate.run_id, policy.fix_step) as
    { id: string } | undefined;
  if (!fixStep) {
    return blockRunAtStep({ runId: gate.run_id, stepDbId: gate.id, stepName: gate.step_id,
      reason: `Fix step "${policy.fix_step}" not found in run`, output });
  }
  inTransaction(() => {
    db.prepare("UPDATE steps SET status = 'waiting', output = ?, fix_rounds = fix_rounds + 1, retry_count = 0, updated_at = datetime('now') WHERE id = ?")
      .run(output, gate.id);
    db.prepare("UPDATE runs SET fix_rounds = fix_rounds + 1, updated_at = datetime('now') WHERE id = ?").run(gate.run_id);
    mergeRunContext(gate.run_id, { fix_feedback: toFixFeedback(actionable), fix_origin: gate.step_id });
    db.prepare("UPDATE steps SET status = 'pending', invoked_by = ?, retry_count = 0, output = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(gate.step_id, fixStep.id);
  });
  const workflowId = workflowIdOf(gate.run_id);
  const detail = `${actionable.length} finding(s) sent to ${policy.fix_step} (round ${gate.fix_rounds + 1})`;
  emitEvent({ ts: new Date().toISOString(), event: "gate.failed", runId: gate.run_id, workflowId, stepId: gate.step_id, detail });
  emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId: gate.run_id, workflowId, stepId: policy.fix_step });
  return { status: "fixing", detail };
}

export function settleGate(gate: GateStepRow, policy: FixPolicy, verdict: GateVerdict): GateSettlement {
  const block = (reason: string) =>
    blockRunAtStep({ runId: gate.run_id, stepDbId: gate.id, stepName: gate.step_id, reason, output: verdict.output });

  if (verdict.blockedReason) return block(verdict.blockedReason);

  const reportedActionable = verdict.findings.some(isActionable);
  const failed = verdict.failed || reportedActionable;
  const findings = failed && !reportedActionable
    ? [...verdict.findings, engineFinding(gate.step_id, verdict.output)]
    : verdict.findings;

  const recorded = recordGateFindings({ runId: gate.run_id, gate: gate.step_id, round: gate.fix_rounds + 1, findings });
  publishFindingsContext(gate.run_id, gate.step_id);

  if (recorded.disputedReRaised.length > 0) {
    const fingerprints = recorded.disputedReRaised.map((f) => f.fingerprint).join(", ");
    return block(`Gate ${gate.step_id} raised disputed finding(s) again: ${fingerprints}`);
  }

  if (!failed) {
    resolveGateFindings(gate.run_id, gate.step_id);
    publishFindingsContext(gate.run_id, gate.step_id);
    return null;
  }

  const maxRounds = effectiveMaxRounds(gate.run_id, policy);
  if (gate.fix_rounds >= maxRounds) {
    return block(`Gate ${gate.step_id} still failing after ${maxRounds} fix round(s)`);
  }

  const budget = getDb().prepare("SELECT fix_rounds, max_fix_rounds FROM runs WHERE id = ?").get(gate.run_id) as
    { fix_rounds: number; max_fix_rounds: number | null };
  const maxFixRounds = budget.max_fix_rounds ?? DEFAULT_MAX_FIX_ROUNDS;
  if (budget.fix_rounds >= maxFixRounds) {
    return block(`Run fix budget exhausted (${maxFixRounds} fix rounds)`);
  }

  return startFixRound(gate, policy, recorded.actionable, verdict.output);
}

export function completeFixStep(
  fixStep: { id: string; run_id: string; step_id: string; invoked_by: string },
  output: string,
): { status: "advanced" } {
  const db = getDb();
  const resumeAt = inTransaction(() => {
    applyFixReport(fixStep.run_id, { resolved: parseResolved(output), disputed: parseDisputed(output) });
    publishFindingsContext(fixStep.run_id, fixStep.invoked_by);

    const origin = db.prepare("SELECT on_fail FROM steps WHERE run_id = ? AND step_id = ?").get(fixStep.run_id, fixStep.invoked_by) as
      { on_fail: string | null } | undefined;
    const policy = parseFixPolicy(origin?.on_fail ?? null);
    const target = policy?.return_step ?? fixStep.invoked_by;

    db.prepare("UPDATE steps SET status = 'waiting', output = ?, invoked_by = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(output, fixStep.id);
    const resumed = db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE run_id = ? AND step_id = ?")
      .run(fixStep.run_id, target);
    if (Number(resumed.changes) === 0) {
      throw new Error(`Run ${fixStep.run_id} has no step "${target}" to resume after fix step "${fixStep.step_id}"`);
    }
    mergeRunContext(fixStep.run_id, { fix_feedback: "", fix_origin: "" });
    return target;
  });

  const workflowId = workflowIdOf(fixStep.run_id);
  emitEvent({ ts: new Date().toISOString(), event: "fix.done", runId: fixStep.run_id, workflowId, stepId: fixStep.step_id,
    detail: `Returning to ${resumeAt}` });
  emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId: fixStep.run_id, workflowId, stepId: resumeAt });
  return { status: "advanced" };
}

export function prepareBlockedRunResume(
  runId: string,
  overrides: BudgetOverrides = {},
): { stepId: string; workflowId: string } {
  const db = getDb();
  const run = db.prepare("SELECT status, context, workflow_id FROM runs WHERE id = ?").get(runId) as
    { status: string; context: string; workflow_id: string } | undefined;
  if (!run || run.status !== "blocked") throw new Error(`Run ${runId} is not blocked`);
  const context = JSON.parse(run.context) as Record<string, string>;
  const stepId = context.blocked_step;
  if (!stepId) throw new Error(`Run ${runId} has no recorded blocked step`);

  inTransaction(() => {
    const requeued = db.prepare("UPDATE steps SET status = 'pending', fix_rounds = 0, updated_at = datetime('now') WHERE run_id = ? AND step_id = ?")
      .run(runId, stepId);
    if (Number(requeued.changes) === 0) throw new Error(`Run ${runId} has no step "${stepId}" to resume`);
    if (overrides.maxRounds !== undefined) {
      db.prepare("UPDATE runs SET max_rounds_override = ? WHERE id = ?").run(overrides.maxRounds, runId);
    }
    if (overrides.maxFixRounds !== undefined) {
      db.prepare("UPDATE runs SET max_fix_rounds = ? WHERE id = ?").run(overrides.maxFixRounds, runId);
    }
    delete context.blocked_step;
    delete context.blocked_reason;
    db.prepare(
      `UPDATE runs SET status = 'running', context = ?, scheduling_status = 'pending_register',
              scheduling_requested_at = ?, scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(context), new Date().toISOString(), runId);
  });
  emitEvent({ ts: new Date().toISOString(), event: "run.resumed", runId, workflowId: run.workflow_id, stepId,
    detail: "Resumed after block" });
  return { stepId, workflowId: run.workflow_id };
}
