import { getDb } from "../db.js";
import type { RunDetail } from "../installer/status.js";
import type { FindingStatus, StoredFinding } from "../installer/findings.js";
import type { BudgetOverrides } from "../installer/gate-loop.js";
import type { ResumeResult } from "../installer/run.js";
import { RATE_LIMIT_RESUME_KEY } from "../installer/rate-limit.js";

export interface RunStatusJson {
  id: string;
  status: string;
  currentStepId: string | null;
  blockedStep: string | null;
  blockedReason: string | null;
  pausedUntil: string | null;
  tokensSpent: number;
  context: { pr?: string };
}

export interface FindingsOptions {
  json: boolean;
  status?: FindingStatus;
  gate?: string;
}

const FINDING_STATUSES: FindingStatus[] = ["open", "resolved", "disputed", "repeated"];

export function loadRunContext(runId: string): Record<string, string> {
  const row = getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  return row ? (JSON.parse(row.context) as Record<string, string>) : {};
}

export function buildRunStatusJson(detail: RunDetail, context: Record<string, string>): RunStatusJson {
  const active = detail.steps.find((s) => s.status === "running") ?? detail.steps.find((s) => s.status === "pending");
  const pr = context.pr?.trim();
  return {
    id: detail.id,
    status: detail.status,
    currentStepId: active?.stepId ?? context.blocked_step ?? null,
    blockedStep: context.blocked_step ?? null,
    blockedReason: context.blocked_reason ?? null,
    pausedUntil: context[RATE_LIMIT_RESUME_KEY] ?? null,
    tokensSpent: detail.tokensSpent,
    context: pr ? { pr } : {},
  };
}

/** The status check saw the run blocked, so a not_found result means it left that state in the meantime. */
export function describeBlockedResume(result: ResumeResult, target: string): { ok: boolean; message: string } {
  if (result.status === "not_found") {
    return { ok: false, message: `Run "${target}" is no longer blocked; check it with: tamandua workflow status ${target}` };
  }
  return {
    ok: true,
    message: `Resumed run ${result.runId!.slice(0, 8)} (${result.workflowId}), re-running step: ${result.stepId}`,
  };
}

function flagValue(args: string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1] ?? "";
}

export function parseFindingsArgs(args: string[]): FindingsOptions {
  const result: FindingsOptions = { json: args.includes("--json") };
  const status = flagValue(args, "--status");
  if (status !== undefined) {
    if (!FINDING_STATUSES.includes(status as FindingStatus)) {
      throw new Error(`--status must be one of ${FINDING_STATUSES.join(", ")}`);
    }
    result.status = status as FindingStatus;
  }
  const gate = flagValue(args, "--gate");
  if (gate) result.gate = gate;
  return result;
}

export function formatFindingsText(findings: StoredFinding[]): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map((f) => {
      const location = `${f.file}${f.line ? `:${f.line}` : ""}`;
      const columns = [f.gate, f.rule, location, f.fingerprint.slice(0, 8), f.evidence.split("\n")[0]];
      return `[${f.status.padEnd(9)}] ${f.severity.padEnd(8)} ${columns.join("  ")}`;
    })
    .join("\n");
}

function positiveInteger(args: string[], name: string): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parseResumeOverrides(args: string[]): BudgetOverrides {
  const overrides: BudgetOverrides = {};
  const maxRounds = positiveInteger(args, "--max-rounds");
  const maxFixRounds = positiveInteger(args, "--max-fix-rounds");
  const maxTokens = positiveInteger(args, "--max-tokens");
  if (maxRounds !== undefined) overrides.maxRounds = maxRounds;
  if (maxFixRounds !== undefined) overrides.maxFixRounds = maxFixRounds;
  if (maxTokens !== undefined) overrides.maxTokens = maxTokens;
  return overrides;
}

export function hasOverrides(overrides: BudgetOverrides): boolean {
  return Object.keys(overrides).length > 0;
}
