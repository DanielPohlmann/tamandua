import { execFileSync } from "node:child_process";
import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { ENGINE_FINDING_FILE, recordGateFindings } from "./findings.js";
import { blockRunAtStep } from "./gate-loop.js";
import type { AgentRole } from "./types.js";

export const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["verification", "analysis", "testing", "scanning"]);
const DISALLOWED_EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

export function isReadOnlyRole(role: string | null | undefined): boolean {
  return !!role && READ_ONLY_ROLES.has(role as AgentRole);
}

export function claudeDisallowedTools(role: string | null | undefined): string[] {
  return isReadOnlyRole(role) ? [...DISALLOWED_EDIT_TOOLS] : [];
}

function git(cwd: string, args: string[], timeout = 60_000): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe", timeout });
}

export function snapshotWorktree(cwd: string): string {
  return git(cwd, ["status", "--porcelain", "-uall"], 30_000);
}

interface ChangedPath {
  untracked: boolean;
  added: boolean;
  path: string;
}

function unquote(p: string): string {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

function changedSince(baseline: string, current: string): ChangedPath[] {
  const known = new Set(baseline.split("\n"));
  const changes: ChangedPath[] = [];
  for (const line of current.split("\n")) {
    if (!line || known.has(line)) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const target = code.startsWith("R") || code.startsWith("C") ? rest.split(" -> ").pop()! : rest;
    changes.push({ untracked: code === "??", added: code.startsWith("A"), path: unquote(target) });
  }
  return changes;
}

/** Reverts only what changed since the baseline; pre-existing untracked files are never touched. */
export function discardWorktreeChanges(cwd: string, baseline: string): void {
  for (const change of changedSince(baseline, snapshotWorktree(cwd))) {
    if (change.untracked) git(cwd, ["clean", "-fd", "--", change.path]);
    else if (change.added) git(cwd, ["rm", "-rf", "--", change.path]);
    else git(cwd, ["checkout", "HEAD", "--", change.path]);
  }
}

function worktreeOf(runId: string): string | undefined {
  const row = getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  return row ? (JSON.parse(row.context) as Record<string, string>).repo : undefined;
}

export function recordReadOnlyBaseline(stepDbId: string, role: string | null, worktree: string | undefined): void {
  if (!isReadOnlyRole(role) || !worktree) return;
  try {
    getDb().prepare("UPDATE steps SET worktree_baseline = ? WHERE id = ?").run(snapshotWorktree(worktree), stepDbId);
  } catch (err) {
    logger.warn("Read-only baseline unavailable", { stepDbId, error: String(err) });
  }
}

export function enforceReadOnly(
  step: { id: string; run_id: string; step_id: string; agent_role: string | null; worktree_baseline: string | null; fix_rounds: number },
  output: string,
): { status: "blocked"; detail: string } | null {
  if (!isReadOnlyRole(step.agent_role) || step.worktree_baseline === null) return null;
  const worktree = worktreeOf(step.run_id);
  if (!worktree) return null;

  const current = snapshotWorktree(worktree);
  if (current === step.worktree_baseline) return null;

  const changed = changedSince(step.worktree_baseline, current).map((c) => c.path).join("\n");
  discardWorktreeChanges(worktree, step.worktree_baseline);
  const evidence = `Read-only step "${step.step_id}" (role ${step.agent_role}) modified the worktree; changes were discarded:\n${changed}`;
  recordGateFindings({
    runId: step.run_id,
    gate: step.step_id,
    round: step.fix_rounds + 1,
    findings: [{ rule: "gate/read-only-violation", severity: "blocking", file: ENGINE_FINDING_FILE, evidence }],
  });
  return blockRunAtStep({
    runId: step.run_id,
    stepDbId: step.id,
    stepName: step.step_id,
    reason: `Read-only violation in ${step.step_id}`,
    output,
  });
}
