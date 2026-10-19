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
  recordReadOnlyBaseline,
  enforceReadOnly,
} from "../../dist/installer/read-only.js";
import { claimStep, completeStep, failStep } from "../../dist/installer/step-ops.js";
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
  const quarantineDir = () => path.join(repo, ".git", "tamandua-quarantine", "run-1", "s-review");
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
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "a");
    fs.writeFileSync(path.join(repo, "a.txt"), "a-staged\n");
    git("add", "a.txt");
    claim();
    fs.writeFileSync(path.join(repo, name), "g\n");
    git("add", "--", name);
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("a.txt"), "a-staged\n");
    assert.equal(git("show", ":a.txt"), "a-staged\n");
    assert.equal(fs.existsSync(path.join(repo, name)), false);
    assert.equal(fs.readFileSync(path.join(quarantineDir(), name), "utf-8"), "g\n");
  });

  it("restores a tracked file whose index entry was removed while the file stayed (D + ??)", () => {
    claim();
    git("rm", "--cached", "-q", "tracked.txt");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("tracked.txt"), "v1\n");
    assert.equal(git("status", "--porcelain", "--", "tracked.txt"), "");
  });

  it("never loses an ignored file that the step force-added", () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
    git("add", ".gitignore");
    git("commit", "-qm", "ignore");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    claim();
    git("add", "-f", ".env");
    assert.equal(violation()?.status, "blocked");
    const survivors = [path.join(repo, ".env"), path.join(quarantineDir(), ".env")].filter(fs.existsSync);
    assert.equal(survivors.length, 1);
    assert.equal(fs.readFileSync(survivors[0], "utf-8"), "SECRET=1\n");
    assert.equal(git("status", "--porcelain").includes(".env"), false);
  });

  it("keeps an untracked file when the step edits .gitignore to hide it", () => {
    claim();
    fs.writeFileSync(path.join(repo, ".gitignore"), "preexisting.txt\n");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("preexisting.txt"), "mine\n");
    assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
    assert.equal(fs.readFileSync(path.join(quarantineDir(), ".gitignore"), "utf-8"), "preexisting.txt\n");
  });

  it("restores the baseline content of an untracked file and quarantines the step version", () => {
    claim();
    fs.writeFileSync(path.join(repo, "preexisting.txt"), "step version\n");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("preexisting.txt"), "mine\n");
    assert.equal(fs.readFileSync(path.join(quarantineDir(), "preexisting.txt"), "utf-8"), "step version\n");
    const [finding] = listFindings("run-1");
    assert.match(finding.evidence, /tamandua-quarantine/);
  });

  it("restores both index and worktree of a baseline MM file", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "staged\n");
    git("add", "tracked.txt");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "worktree\n");
    claim();
    git("checkout", "HEAD", "--", "tracked.txt");
    assert.equal(violation()?.status, "blocked");
    assert.equal(read("tracked.txt"), "worktree\n");
    assert.equal(git("status", "--porcelain", "--", "tracked.txt").slice(0, 2), "MM");
    assert.equal(git("show", ":tracked.txt"), "staged\n");
  });

  const ref = "refs/tamandua/baseline/s-review";
  const refExists = () => {
    try {
      git("rev-parse", "--verify", "-q", ref);
      return true;
    } catch {
      return false;
    }
  };

  it("blocks without resetting anything when HEAD moved, keeping the baseline ref for recovery", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
    recordReadOnlyBaseline("s-review", "verification", repo);
    const stash = git("rev-parse", ref).trim();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "committed by step\n");
    git("commit", "-qam", "step commit");
    const moved = git("rev-parse", "HEAD").trim();
    assert.equal(violation()?.status, "blocked");
    assert.equal(git("rev-parse", "HEAD").trim(), moved);
    assert.equal(read("tracked.txt"), "committed by step\n");
    const [finding] = listFindings("run-1");
    assert.match(finding.evidence, /HEAD moved from [0-9a-f]{40} to [0-9a-f]{40}/);
    assert.ok(finding.evidence.includes(stash));
    assert.ok(finding.evidence.includes(ref));
    assert.equal(refExists(), true);
  });

  it("keeps the baseline ref and names it when the worktree cannot be read", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
    recordReadOnlyBaseline("s-review", "verification", repo);
    fs.writeFileSync(path.join(repo, ".git", "index.lock"), "");
    assert.equal(violation()?.status, "blocked");
    const [finding] = listFindings("run-1");
    assert.ok(finding.evidence.includes(ref));
    assert.equal(refExists(), true);
  });

  it("does not block on baselines recorded without a HEAD sha", () => {
    claim();
    const row = stepRow("s-review") as { worktree_baseline: string };
    const { head: _head, ...legacy } = JSON.parse(row.worktree_baseline);
    getDb().prepare("UPDATE steps SET worktree_baseline = ? WHERE id = 's-review'").run(JSON.stringify(legacy));
    fs.writeFileSync(path.join(repo, "other.txt"), "o\n");
    git("add", "other.txt");
    git("commit", "-qm", "moved");
    assert.equal(violation(), null);
  });

  it("drops the baseline ref on an unparseable baseline and still stores the baseline when pinning fails", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
    recordReadOnlyBaseline("s-review", "verification", repo);
    assert.equal(refExists(), true);
    getDb().prepare("UPDATE steps SET worktree_baseline = 'garbage' WHERE id = 's-review'").run();
    assert.equal(violation(), null);
    assert.equal(refExists(), false);

    fs.rmSync(path.join(repo, ".git", "refs", "tamandua"), { recursive: true, force: true });
    fs.writeFileSync(path.join(repo, ".git", "refs", "tamandua"), "not a directory");
    getDb().prepare("UPDATE steps SET worktree_baseline = NULL WHERE id = 's-review'").run();
    recordReadOnlyBaseline("s-review", "verification", repo);
    assert.notEqual((stepRow("s-review") as { worktree_baseline: string | null }).worktree_baseline, null);
  });

  it("does not report a second, misleading violation when recording the HEAD-moved block throws", () => {
    claim();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n");
    git("commit", "-qam", "step commit");
    getDb().exec("CREATE TRIGGER fail_block BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'boom'); END");
    assert.throws(() => violation(), /boom/);
    assert.equal(listFindings("run-1").length, 1);
  });

  it("quarantines under the common git dir so it survives removing a linked worktree", () => {
    const linked = path.join(home.dir, "linked");
    git("worktree", "add", "-q", "-b", "side", linked);
    getDb().prepare("UPDATE runs SET context = ? WHERE id = 'run-1'").run(JSON.stringify({ repo: linked }));
    getDb().prepare("UPDATE steps SET worktree_baseline = ? WHERE id = 's-review'").run(snapshotWorktree(linked));
    fs.writeFileSync(path.join(linked, "created.txt"), "keep me\n");
    assert.equal(violation()?.status, "blocked");
    const kept = path.join(repo, ".git", "tamandua-quarantine", "run-1", "s-review", "created.txt");
    assert.equal(fs.readFileSync(kept, "utf-8"), "keep me\n");
    git("worktree", "remove", "--force", linked);
    assert.equal(fs.readFileSync(kept, "utf-8"), "keep me\n");
  });

  it("refuses to write through a symlinked ancestor directory", () => {
    const outside = path.join(home.dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "outside content\n");
    fs.mkdirSync(path.join(repo, "sub"));
    fs.writeFileSync(path.join(repo, "sub", "keep.txt"), "baseline\n");
    claim();
    fs.rmSync(path.join(repo, "sub"), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, "sub"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(violation()?.status, "blocked");
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf-8"), "outside content\n");
    const [finding] = listFindings("run-1");
    assert.match(finding.evidence, /unsafe path/);
  });

  it("quarantines a dangling symlink the step created", (t) => {
    claim();
    try {
      fs.symlinkSync("does-not-exist", path.join(repo, "dangling"), "file");
    } catch {
      t.skip("symlinks not permitted on this machine");
      return;
    }
    assert.equal(violation()?.status, "blocked");
    assert.equal(fs.lstatSync(path.join(quarantineDir(), "dangling")).isSymbolicLink(), true);
    assert.throws(() => fs.lstatSync(path.join(repo, "dangling")));
    const [finding] = listFindings("run-1");
    assert.match(finding.evidence, /dangling/);
  });

  it("pins the baseline stash at claim time and drops the ref after enforcement", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
    recordReadOnlyBaseline("s-review", "verification", repo);
    const ref = "refs/tamandua/baseline/s-review";
    assert.match(git("rev-parse", "--verify", ref).trim(), /^[0-9a-f]{40}$/);
    enforceReadOnly(stepRow("s-review"), "STATUS: done");
    assert.throws(() => git("rev-parse", "--verify", "-q", ref));
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
    assert.match(finding.evidence, /Nothing was discarded/);
    const run = getDb().prepare("SELECT status FROM runs WHERE id = 'run-1'").get() as { status: string };
    assert.equal(run.status, "blocked");
  });

  it("ignores coding roles even when the worktree changed", () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
    assert.equal(enforceReadOnly(stepRow("s-dev"), "STATUS: done"), null);
  });
});

describe("read-only enforcement through the step lifecycle", () => {
  let home: TempTamanduaHome;
  let repo: string;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-read-only-ops-");
    repo = path.join(home.dir, "worktree");
    fs.mkdirSync(repo);
    initRepo(repo);
    seedRun(getDb(), { id: "run-1", context: { repo } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "pending", agentId: "wf_reviewer", agentRole: "verification" },
      { id: "s-next", stepId: "pr", index: 1, status: "waiting" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("snapshots at claim and blocks at complete when the verifier wrote a file", () => {
    const claim = claimStep("wf_reviewer", "run-1");
    assert.equal(claim.found, true);
    fs.writeFileSync(path.join(repo, "sneaky.txt"), "x\n");
    const result = completeStep(claim.stepId!, "STATUS: done");
    assert.equal(result.status, "blocked");
    assert.equal(fs.existsSync(path.join(repo, "sneaky.txt")), false);
    const next = getDb().prepare("SELECT status FROM steps WHERE id = 's-next'").get() as { status: string };
    assert.equal(next.status, "waiting");
  });

  it("snapshots and blocks read-only loop/story steps too", () => {
    const db = getDb();
    db.prepare("UPDATE steps SET type = 'loop', loop_config = ? WHERE id = 's-review'").run(JSON.stringify({ over: "stories", completion: "all_done" }));
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES ('st-1', 'run-1', 0, 'US-1', 't', 'd', '[]', 'pending', 0, 4, datetime('now'), datetime('now'))",
    ).run();
    const claim = claimStep("wf_reviewer", "run-1");
    assert.equal(claim.found, true);
    const baseline = db.prepare("SELECT worktree_baseline FROM steps WHERE id = 's-review'").get() as { worktree_baseline: string | null };
    assert.ok(baseline.worktree_baseline);
    fs.writeFileSync(path.join(repo, "loop-sneaky.txt"), "x\n");
    const result = completeStep(claim.stepId!, "STATUS: done");
    assert.equal(result.status, "blocked");
    assert.equal(fs.existsSync(path.join(repo, "loop-sneaky.txt")), false);
    const quarantine = path.join(repo, ".git", "tamandua-quarantine", "run-1", "s-review", "loop-sneaky.txt");
    assert.equal(fs.existsSync(quarantine), true);
  });

  it("also blocks when the verifier fails the step after writing", async () => {
    const claim = claimStep("wf_reviewer", "run-1");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
    const result = await failStep(claim.stepId!, "gave up");
    assert.equal(result.status, "blocked");
  });
});
