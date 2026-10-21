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
const BASELINE_REF_PREFIX = "refs/tamandua/baseline/";
const QUARANTINE_DIR = "tamandua-quarantine";
const RENAMED_SOURCE = "R~";
const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "tamandua",
  GIT_AUTHOR_EMAIL: "tamandua@localhost",
  GIT_COMMITTER_NAME: "tamandua",
  GIT_COMMITTER_EMAIL: "tamandua@localhost",
};

export function isReadOnlyRole(role: string | null | undefined): boolean {
  return !!role && READ_ONLY_ROLES.has(role as AgentRole);
}

export function claudeDisallowedTools(role: string | null | undefined): string[] {
  return isReadOnlyRole(role) ? [...DISALLOWED_EDIT_TOOLS] : [];
}

interface GitOptions {
  timeout?: number;
  input?: string;
  env?: Record<string, string>;
}

function git(cwd: string, args: string[], options: GitOptions = {}): string {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: options.timeout ?? 60_000,
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync("git", ["--literal-pathspecs", ...args], { cwd, stdio: "pipe", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
}

interface StatusEntry {
  line: string;
  untracked: boolean;
  indexCode: string;
}

interface WorktreeSnapshot {
  head: string;
  stash: string;
  entries: Record<string, StatusEntry>;
  hashes: Record<string, string>;
}

function parseStatus(raw: string): Record<string, StatusEntry> {
  const entries: Record<string, StatusEntry> = {};
  const records = raw.split(NUL);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (!(entries[file] && !entries[file].untracked && code === "??")) {
      entries[file] = { line: code, untracked: code === "??", indexCode: code[0] };
    }
    const renamedOrCopied = "RC".includes(code[0]) || "RC".includes(code[1]);
    if (renamedOrCopied) {
      const source = records[++i];
      if (source && (code[0] === "R" || code[1] === "R") && !entries[source]) {
        entries[source] = { line: RENAMED_SOURCE, untracked: false, indexCode: code[0] === "R" ? "D" : " " };
      }
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
  const out = git(cwd, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
    input: regular.join(NEWLINE) + NEWLINE,
    timeout: 30_000,
  });
  out.split(NEWLINE).filter(Boolean).forEach((hash, i) => {
    hashes[regular[i]] = hash.trim();
  });
  return hashes;
}

function currentHead(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { timeout: 30_000 }).trim();
  } catch (err) {
    if ((err as { status?: number }).status === 1) return "";
    throw err;
  }
}

function takeSnapshot(cwd: string): WorktreeSnapshot {
  const entries = parseStatus(git(cwd, ["status", "--porcelain=v1", "-z", "-uall"], { timeout: 30_000 }));
  return {
    head: currentHead(cwd),
    stash: git(cwd, ["stash", "create"], { timeout: 30_000, env: IDENTITY_ENV }).trim(),
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

function quarantineRootOf(cwd: string, runId: string, stepDbId: string): string {
  const commonDir = git(cwd, ["rev-parse", "--git-common-dir"], { timeout: 30_000 }).trim();
  return path.join(path.resolve(cwd, commonDir), QUARANTINE_DIR, runId, stepDbId);
}

function quarantineBaseOf(quarantineRoot: string): string {
  return path.resolve(quarantineRoot, "..", "..", "..");
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** Refuses targets that reach outside `base` through a symlinked ancestor. */
function assertInside(base: string, target: string): void {
  const relative = path.relative(base, path.dirname(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`unsafe path outside ${base}: ${target}`);
  let probe = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    probe = path.join(probe, part);
    const stat = lstatOrNull(probe);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`unsafe path through symlink ${probe}`);
  }
  let existing = path.dirname(target);
  while (!lstatOrNull(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const inside = path.relative(fs.realpathSync(base), fs.realpathSync(existing));
  if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`unsafe path outside ${base}: ${target}`);
}

class Quarantine {
  readonly saved: string[] = [];
  private readonly base: string;
  constructor(private readonly cwd: string, readonly root: string) {
    this.base = quarantineBaseOf(root);
  }

  private destinationFor(file: string): string {
    const dest = path.join(this.root, file);
    assertInside(this.base, dest);
    return lstatOrNull(dest) ? `${dest}.${Date.now()}` : dest;
  }

  /** Moves the step's version of a path out of the worktree; nothing is deleted. */
  move(file: string): void {
    const source = path.join(this.cwd, file);
    if (!lstatOrNull(source)) return;
    assertInside(this.cwd, source);
    const dest = this.destinationFor(file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(source, dest);
    this.saved.push(file);
  }

  /** Keeps a copy of the step's version before the path is overwritten. */
  copy(file: string): void {
    const source = path.join(this.cwd, file);
    if (!lstatOrNull(source)?.isFile()) return;
    assertInside(this.cwd, source);
    const dest = this.destinationFor(file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    this.saved.push(file);
  }
}

function restoreUntracked(cwd: string, file: string, hash: string, quarantine: Quarantine): void {
  const blob = gitBuffer(cwd, ["cat-file", "blob", hash]);
  const target = path.join(cwd, file);
  assertInside(cwd, target);
  if (lstatOrNull(target)?.isFile() && fs.readFileSync(target).equals(blob)) return;
  quarantine.move(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, blob);
}

function restoreTracked(cwd: string, file: string, before: StatusEntry, baseline: WorktreeSnapshot, quarantine: Quarantine): void {
  quarantine.copy(file);
  const { stash } = baseline;
  if (!stash) {
    git(cwd, ["checkout", "HEAD", "--", file]);
    return;
  }
  if (before.indexCode === " ") git(cwd, ["reset", "-q", "--", file]);
  else if (before.indexCode === "D") git(cwd, ["rm", "--cached", "-q", "--ignore-unmatch", "--", file]);
  else git(cwd, ["checkout", `${stash}^2`, "--", file]);

  if (baseline.hashes[file] === undefined) quarantine.move(file);
  else git(cwd, ["restore", `--source=${stash}`, "--worktree", "--", file]);
}

function revertPath(cwd: string, file: string, baseline: WorktreeSnapshot, current: WorktreeSnapshot, quarantine: Quarantine): void {
  const before = baseline.entries[file];
  const now = current.entries[file];

  if (!before) {
    if (!now) return;
    if (now.untracked) {
      quarantine.move(file);
    } else if (["A", "R", "C"].includes(now.indexCode)) {
      quarantine.move(file);
      git(cwd, ["reset", "-q", "--", file]);
    } else {
      quarantine.copy(file);
      git(cwd, ["checkout", baseline.stash || "HEAD", "--", file]);
    }
    return;
  }
  if (before.untracked) {
    if (now && !now.untracked) git(cwd, ["reset", "-q", "--", file]);
    const hash = baseline.hashes[file];
    if (hash) restoreUntracked(cwd, file, hash, quarantine);
    return;
  }
  restoreTracked(cwd, file, before, baseline, quarantine);
}

export interface DiscardResult {
  failures: string[];
  quarantined: string[];
  quarantineDir: string;
}

/** Reverts only what differs from the baseline. Nothing is deleted: the step's versions are moved to a quarantine directory. */
export function discardWorktreeChanges(
  cwd: string,
  baselineJson: string,
  currentJson: string,
  quarantineRoot: string,
): DiscardResult {
  const quarantine = new Quarantine(cwd, quarantineRoot);
  const failures: string[] = [];
  const baseline = parseSnapshot(baselineJson);
  const current = parseSnapshot(currentJson);
  if (baseline && current) {
    for (const file of violatingPaths(baseline, current)) {
      try {
        revertPath(cwd, file, baseline, current, quarantine);
      } catch (err) {
        failures.push(`${file} (${String(err).split(NEWLINE)[0]})`);
      }
    }
  }
  return { failures, quarantined: quarantine.saved, quarantineDir: quarantineRoot };
}

function worktreeOf(runId: string): string | undefined {
  const row = getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  return row ? (JSON.parse(row.context) as Record<string, string>).repo : undefined;
}

export function recordReadOnlyBaseline(stepDbId: string, role: string | null, worktree: string | undefined): void {
  if (!isReadOnlyRole(role) || !worktree) return;
  try {
    const snapshot = takeSnapshot(worktree);
    getDb().prepare("UPDATE steps SET worktree_baseline = ? WHERE id = ?").run(JSON.stringify(snapshot), stepDbId);
    if (snapshot.stash) {
      try {
        git(worktree, ["update-ref", baselineRef(stepDbId), snapshot.stash]);
      } catch (err) {
        logger.warn("Could not pin read-only baseline", { stepDbId, error: String(err) });
      }
    }
  } catch (err) {
    logger.warn("Read-only baseline unavailable", { stepDbId, error: String(err) });
  }
}

function baselineRef(stepDbId: string): string {
  return `${BASELINE_REF_PREFIX}${stepDbId}`;
}

function dropBaselineRef(worktree: string, stepDbId: string): void {
  try {
    git(worktree, ["update-ref", "-d", baselineRef(stepDbId)], { timeout: 30_000 });
  } catch (err) {
    logger.warn("Could not drop read-only baseline ref", { stepDbId, error: String(err) });
  }
}

function violation(
  step: { id: string; run_id: string; step_id: string; fix_rounds: number },
  evidenceLines: string[],
  output: string,
): { status: "blocked"; detail: string } {
  recordGateFindings({
    runId: step.run_id,
    gate: step.step_id,
    round: step.fix_rounds + 1,
    findings: [{ rule: "gate/read-only-violation", severity: "blocking", file: ENGINE_FINDING_FILE, evidence: evidenceLines.join(NEWLINE) }],
  });
  return blockRunAtStep({
    runId: step.run_id,
    stepDbId: step.id,
    stepName: step.step_id,
    reason: `Read-only violation in ${step.step_id}`,
    output,
  });
}

export function enforceReadOnly(
  step: { id: string; run_id: string; step_id: string; agent_role: string | null; worktree_baseline: string | null; fix_rounds: number },
  output: string,
): { status: "blocked"; detail: string } | null {
  if (!isReadOnlyRole(step.agent_role) || step.worktree_baseline === null) return null;
  const worktree = worktreeOf(step.run_id);
  if (!worktree) return null;
  let keepRef = false;

  try {
    const baseline = parseSnapshot(step.worktree_baseline);
    if (!baseline) return null;
    const header = `Read-only step "${step.step_id}" (role ${step.agent_role}) modified the worktree`;
    const recovery = baseline.stash
      ? [`Recover the claim-time state from ${baseline.stash} (pinned as ${baselineRef(step.id)}), e.g. git checkout ${baseline.stash} -- <path>.`]
      : [];

    let head = "";
    let currentJson = "";
    let changed: string[] = [];
    let unreadable: string | null = null;
    const headMoved = () => typeof baseline.head === "string" && head !== baseline.head;
    try {
      head = currentHead(worktree);
      if (!headMoved()) {
        currentJson = snapshotWorktree(worktree);
        changed = violatingPaths(baseline, JSON.parse(currentJson) as WorktreeSnapshot);
      }
    } catch (err) {
      unreadable = String(err).split(NEWLINE)[0];
    }

    if (unreadable !== null) {
      keepRef = true;
      return violation(step, [
        `${header}, or the worktree state could not be read (${unreadable}).`,
        "Nothing was discarded; inspect the worktree manually.",
        ...recovery,
      ], output);
    }
    if (headMoved()) {
      keepRef = true;
      return violation(step, [
        `${header}: HEAD moved from ${baseline.head || "(none)"} to ${head || "(none)"}.`,
        "Nothing was reset or discarded automatically; a human must review the branch.",
        ...recovery,
      ], output);
    }
    if (changed.length === 0) return null;

    let result: DiscardResult;
    try {
      result = discardWorktreeChanges(worktree, step.worktree_baseline, currentJson, quarantineRootOf(worktree, step.run_id, step.id));
    } catch (err) {
      result = { failures: [`quarantine (${String(err).split(NEWLINE)[0]})`], quarantined: [], quarantineDir: "" };
    }
    return violation(step, [
      `${header}; the changes were reverted:`,
      ...changed,
      ...(result.quarantined.length
        ? [`The step's versions were moved (not deleted) to ${result.quarantineDir}:`, ...result.quarantined]
        : []),
      ...(result.failures.length ? ["Could not restore:", ...result.failures] : []),
    ], output);
  } finally {
    getDb().prepare("UPDATE steps SET worktree_baseline = NULL WHERE id = ?").run(step.id);
    if (!keepRef) dropBaselineRef(worktree, step.id);
  }
}
