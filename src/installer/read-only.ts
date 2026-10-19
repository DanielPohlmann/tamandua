import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

function git(cwd: string, args: string[], options: { timeout?: number; input?: string } = {}): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: options.timeout ?? 60_000,
    input: options.input,
  });
}

interface StatusEntry {
  line: string;
  untracked: boolean;
  indexCode: string;
}

interface WorktreeSnapshot {
  stash: string;
  entries: Record<string, StatusEntry>;
  hashes: Record<string, string>;
}

const RENAMED_SOURCE = "R~";
const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);

function parseStatus(raw: string): Record<string, StatusEntry> {
  const entries: Record<string, StatusEntry> = {};
  const records = raw.split(NUL);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    entries[file] = { line: code, untracked: code === "??", indexCode: code[0] };
    if (code[0] === "R" || code[0] === "C") {
      const source = records[++i];
      if (source && code[0] === "R") entries[source] = { line: RENAMED_SOURCE, untracked: false, indexCode: "D" };
    }
  }
  return entries;
}

function hashFiles(cwd: string, files: string[]): Record<string, string> {
  const regular = files.filter((file) => {
    try {
      return fs.lstatSync(path.join(cwd, file)).isFile();
    } catch {
      return false;
    }
  });
  const hashes: Record<string, string> = {};
  if (regular.length === 0) return hashes;
  const out = git(cwd, ["hash-object", "--no-filters", "--stdin-paths"], {
    input: regular.join(NEWLINE) + NEWLINE,
    timeout: 30_000,
  });
  out.split(NEWLINE).filter(Boolean).forEach((hash, i) => {
    hashes[regular[i]] = hash.trim();
  });
  return hashes;
}

function takeSnapshot(cwd: string): WorktreeSnapshot {
  const entries = parseStatus(git(cwd, ["status", "--porcelain=v1", "-z", "-uall"], { timeout: 30_000 }));
  return {
    stash: git(cwd, ["stash", "create"], { timeout: 30_000 }).trim(),
    entries,
    hashes: hashFiles(cwd, Object.keys(entries)),
  };
}

export function snapshotWorktree(cwd: string): string {
  return JSON.stringify(takeSnapshot(cwd));
}

function parseSnapshot(json: string): WorktreeSnapshot | null {
  try {
    const parsed = JSON.parse(json) as WorktreeSnapshot;
    return parsed && typeof parsed === "object" && parsed.entries ? parsed : null;
  } catch {
    return null;
  }
}

function violatingPaths(baseline: WorktreeSnapshot, current: WorktreeSnapshot): string[] {
  const paths = new Set([...Object.keys(baseline.entries), ...Object.keys(current.entries)]);
  return [...paths].filter((file) =>
    baseline.entries[file]?.line !== current.entries[file]?.line || baseline.hashes[file] !== current.hashes[file]);
}

function revertPath(cwd: string, file: string, baseline: WorktreeSnapshot, current: WorktreeSnapshot): string | null {
  const before = baseline.entries[file];
  const now = current.entries[file];
  const ref = baseline.stash || "HEAD";
  const absolute = path.join(cwd, file);

  if (!before) {
    if (!now || now.untracked) fs.rmSync(absolute, { force: true, recursive: true });
    else if (["A", "R", "C"].includes(now.indexCode)) git(cwd, ["rm", "-rf", "-q", "--", file]);
    else git(cwd, ["checkout", ref, "--", file]);
    return null;
  }
  if (before.untracked) {
    if (now && !now.untracked) git(cwd, ["reset", "-q", "--", file]);
    return baseline.hashes[file] === current.hashes[file] ? null : `${file} (untracked before the step; content cannot be restored)`;
  }
  if (baseline.hashes[file] === undefined) {
    fs.rmSync(absolute, { force: true });
    git(cwd, ["reset", "-q", "--", file]);
    return null;
  }
  git(cwd, ["checkout", ref, "--", file]);
  if (before.line[0] === " ") git(cwd, ["reset", "-q", "--", file]);
  return null;
}

/** Reverts only what differs from the baseline; returns the paths it could not restore. */
export function discardWorktreeChanges(cwd: string, baselineJson: string, currentJson: string): string[] {
  const baseline = parseSnapshot(baselineJson);
  const current = parseSnapshot(currentJson);
  if (!baseline || !current) return [];
  const failures: string[] = [];
  for (const file of violatingPaths(baseline, current)) {
    try {
      const problem = revertPath(cwd, file, baseline, current);
      if (problem) failures.push(problem);
    } catch (err) {
      failures.push(`${file} (${String(err).split(NEWLINE)[0]})`);
    }
  }
  return failures;
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
  const baseline = parseSnapshot(step.worktree_baseline);
  if (!baseline) return null;

  let changed: string[];
  let failures: string[];
  try {
    const currentJson = snapshotWorktree(worktree);
    changed = violatingPaths(baseline, JSON.parse(currentJson) as WorktreeSnapshot);
    if (changed.length === 0) return null;
    failures = discardWorktreeChanges(worktree, step.worktree_baseline, currentJson);
  } catch (err) {
    changed = ["(worktree state unreadable)"];
    failures = [`worktree (${String(err).split(NEWLINE)[0]})`];
  }
  const evidence = [
    `Read-only step "${step.step_id}" (role ${step.agent_role}) modified the worktree; changes were discarded:`,
    ...changed,
    ...(failures.length ? ["Could not restore:", ...failures] : []),
  ].join(NEWLINE);
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
