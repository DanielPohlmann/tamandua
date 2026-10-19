import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDb, closeDb } from "../../dist/db.js";
import {
  isReadOnlyRole,
  claudeDisallowedTools,
  snapshotWorktree,
  enforceReadOnly,
} from "../../dist/installer/read-only.js";
import { listFindings } from "../../dist/installer/findings.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

function initRepo(dir: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "init");
}

describe("read-only role policy", () => {
  it("restricts edit tools only for read-only roles", () => {
    for (const role of ["verification", "analysis", "testing", "scanning"]) {
      assert.equal(isReadOnlyRole(role), true, role);
      assert.deepEqual(claudeDisallowedTools(role), ["Edit", "Write", "NotebookEdit"]);
    }
    for (const role of ["coding", "pr", null, undefined]) {
      assert.equal(isReadOnlyRole(role), false, String(role));
      assert.deepEqual(claudeDisallowedTools(role), []);
    }
  });
});

describe("enforceReadOnly", () => {
  let home: TempTamanduaHome;
  let repo: string;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-read-only-");
    repo = path.join(home.dir, "worktree");
    fs.mkdirSync(repo);
    initRepo(repo);
    fs.writeFileSync(path.join(repo, "preexisting.txt"), "mine\n");
    seedRun(getDb(), { id: "run-1", context: { repo } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "running", agentRole: "verification", worktreeBaseline: snapshotWorktree(repo) },
      { id: "s-dev", stepId: "fix", index: 1, status: "running", agentRole: "coding", worktreeBaseline: null },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  const stepRow = (id: string) =>
    getDb().prepare("SELECT id, run_id, step_id, agent_role, worktree_baseline, fix_rounds FROM steps WHERE id = ?").get(id) as never;

  it("passes when the worktree is unchanged", () => {
    assert.equal(enforceReadOnly(stepRow("s-review"), "STATUS: done"), null);
  });

  it("reverts only what changed since the baseline, records the finding and blocks the run", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "x\n");
    const result = enforceReadOnly(stepRow("s-review"), "STATUS: done");
    assert.equal(result?.status, "blocked");
    assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf-8"), "v1\n");
    assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
    assert.equal(fs.readFileSync(path.join(repo, "preexisting.txt"), "utf-8"), "mine\n");
    const [finding] = listFindings("run-1");
    assert.equal(finding.rule, "gate/read-only-violation");
    assert.equal(finding.file, ".");
    assert.match(finding.evidence, /tracked\.txt/);
    const run = getDb().prepare("SELECT status, context FROM runs WHERE id = 'run-1'").get() as { status: string; context: string };
    assert.equal(run.status, "blocked");
    assert.equal(JSON.parse(run.context).blocked_step, "gate-review");
  });

  it("keeps a pre-existing untracked file when the step wrote something else", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "x\n");
    enforceReadOnly(stepRow("s-review"), "STATUS: done");
    assert.equal(fs.existsSync(path.join(repo, "preexisting.txt")), true);
  });

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf-8" });
  const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf-8");
  const claim = () =>
    getDb().prepare("UPDATE steps SET worktree_baseline = ? WHERE id = 's-review'").run(snapshotWorktree(repo));
  const violation = () => enforceReadOnly(stepRow("s-review"), "STATUS: done");

  it("never removes a pre-existing untracked file that the step staged", () => {
    claim();
    git("add", "preexisting.txt");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("preexisting.txt"), "mine\n");
    assert.match(git("status", "--porcelain", "--", "preexisting.txt"), /^\?\? /);
  });

  it("keeps a staged-new baseline file that the step modifies", () => {
    fs.writeFileSync(path.join(repo, "staged.txt"), "s1\n");
    git("add", "staged.txt");
    claim();
    fs.writeFileSync(path.join(repo, "staged.txt"), "s2\n");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("staged.txt"), "s1\n");
  });

  it("restores uncommitted pre-claim edits instead of HEAD when the step stages or deletes them", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "baseline edit\n");
    claim();
    git("add", "tracked.txt");
    fs.rmSync(path.join(repo, "tracked.txt"));
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("tracked.txt"), "baseline edit\n");
  });

  it("detects further edits to a file that was already dirty at claim time", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "baseline edit\n");
    claim();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "step edit\n");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("tracked.txt"), "baseline edit\n");
  });

  it("treats glob characters in file names literally", () => {
    const name = process.platform === "win32" ? "[ab].txt" : "*";
    fs.writeFileSync(path.join(repo, name), "g1\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", name, "a.txt");
    git("commit", "-qm", "globs");
    fs.writeFileSync(path.join(repo, "a.txt"), "a-dirty\n");
    claim();
    fs.writeFileSync(path.join(repo, name), "g2\n");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read(name), "g1\n");
    assert.equal(read("a.txt"), "a-dirty\n");
  });

  it("reverts files with unicode names", () => {
    fs.writeFileSync(path.join(repo, "café.txt"), "c1\n");
    git("add", "café.txt");
    git("commit", "-qm", "unicode");
    claim();
    fs.writeFileSync(path.join(repo, "café.txt"), "c2\n");
    fs.writeFileSync(path.join(repo, "naïve.txt"), "n\n");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("café.txt"), "c1\n");
    assert.equal(fs.existsSync(path.join(repo, "naïve.txt")), false);
  });

  it("reverts a rename", () => {
    claim();
    git("mv", "tracked.txt", "renamed.txt");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("tracked.txt"), "v1\n");
    assert.equal(fs.existsSync(path.join(repo, "renamed.txt")), false);
  });

  it("records the finding and blocks the run when a revert command fails", () => {
    claim();
    const row = stepRow("s-review") as { worktree_baseline: string };
    const tampered = { ...JSON.parse(row.worktree_baseline), stash: "0123456789abcdef0123456789abcdef01234567" };
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
    getDb().prepare("UPDATE steps SET worktree_baseline = ? WHERE id = 's-review'").run(JSON.stringify({
      ...tampered, entries: { "tracked.txt": { line: " M", untracked: false, indexCode: " " } }, hashes: { "tracked.txt": "x" },
    }));
    assert.equal(violation()?.status, "blocked");
    const [finding] = listFindings("run-1");
    assert.equal(finding.rule, "gate/read-only-violation");
    assert.match(finding.evidence, /Could not restore/);
    const run = getDb().prepare("SELECT status FROM runs WHERE id = 'run-1'").get() as { status: string };
    assert.equal(run.status, "blocked");
  });

  it("records the finding and blocks the run when the worktree cannot be read", () => {
    claim();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
    fs.writeFileSync(path.join(repo, ".git", "index.lock"), "");
    assert.equal(violation()?.status, "blocked");
    const [finding] = listFindings("run-1");
    assert.equal(finding.rule, "gate/read-only-violation");
    assert.match(finding.evidence, /Could not restore/);
    const run = getDb().prepare("SELECT status FROM runs WHERE id = 'run-1'").get() as { status: string };
    assert.equal(run.status, "blocked");
  });

  it("ignores coding roles even when the worktree changed", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
    assert.equal(enforceReadOnly(stepRow("s-dev"), "STATUS: done"), null);
  });
});
