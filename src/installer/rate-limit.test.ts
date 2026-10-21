import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb } from "../../dist/db.js";
import {
  parseRateLimitWait,
  rateLimitFromClaudeResult,
  requeueClaimedSteps,
  pauseRunForRateLimit,
  resumeDueRateLimitedRuns,
} from "../../dist/installer/rate-limit.js";
import { executePollingRound } from "../../dist/installer/agent-scheduler.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

describe("parseRateLimitWait", () => {
  const now = new Date(2026, 9, 19, 14, 0, 0);

  it("waits until the next h:mm AM/PM reset", () => {
    assert.equal(parseRateLimitWait("5-hour limit reached ∙ reset at 3:30 PM", now), 90 * 60_000);
    assert.equal(parseRateLimitWait("reset at 1:00 PM", now), 23 * 60 * 60_000);
    assert.equal(parseRateLimitWait("reset at 12:00 AM", now), 10 * 60 * 60_000);
  });

  it("handles minute based messages with a 60s floor", () => {
    assert.equal(parseRateLimitWait("Please wait 7 minutes", now), 7 * 60_000);
    assert.equal(parseRateLimitWait("try again in 0", now), 60_000);
  });

  it("returns null for unrelated text", () => {
    assert.equal(parseRateLimitWait("all tests passed", now), null);
  });

  it("reads only error results of claude JSON output", () => {
    assert.equal(rateLimitFromClaudeResult('{"type":"result","is_error":true,"result":"Usage limit reached, try again in 5"}', now), 5 * 60_000);
    assert.equal(rateLimitFromClaudeResult('{"type":"result","is_error":false,"result":"I will wait 5 minutes"}', now), null);
    assert.equal(rateLimitFromClaudeResult("not json", now), null);
  });
});

describe("pause and resume", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-rate-limit-");
    seedRun(getDb(), { id: "run-1" }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "running", agentId: "wf_reviewer" },
    ]);
    getDb().prepare("UPDATE steps SET claim_job_id = 'job-1', retry_count = 1 WHERE id = 's-review'").run();
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("re-queues the claimed step without spending a retry", () => {
    assert.equal(requeueClaimedSteps("run-1", "wf_reviewer", "job-1"), 1);
    const row = getDb().prepare("SELECT status, retry_count FROM steps WHERE id = 's-review'").get() as { status: string; retry_count: number };
    assert.deepEqual({ ...row }, { status: "pending", retry_count: 1 });
  });

  it("clears the read-only baseline of a re-queued step so the next claim starts fresh", () => {
    getDb().prepare("UPDATE steps SET worktree_baseline = '{\"stale\":true}' WHERE id = 's-review'").run();
    requeueClaimedSteps("run-1", "wf_reviewer", "job-1");
    const row = getDb().prepare("SELECT worktree_baseline FROM steps WHERE id = 's-review'").get() as { worktree_baseline: string | null };
    assert.equal(row.worktree_baseline, null);
  });

  it("pauses the run until the reset and resumes it once due", () => {
    const resumeAt = new Date(Date.now() + 60_000);
    pauseRunForRateLimit("run-1", resumeAt, "rate limited");
    let run = getDb().prepare("SELECT status, scheduling_status, context FROM runs WHERE id = 'run-1'").get() as { status: string; scheduling_status: string; context: string };
    assert.equal(run.status, "paused");
    assert.equal(JSON.parse(run.context).rate_limit_resume_at, resumeAt.toISOString());

    assert.deepEqual(resumeDueRateLimitedRuns(new Date()), []);
    assert.deepEqual(resumeDueRateLimitedRuns(new Date(resumeAt.getTime() + 1)), ["run-1"]);
    run = getDb().prepare("SELECT status, scheduling_status, context FROM runs WHERE id = 'run-1'").get() as never;
    assert.equal(run.status, "running");
    assert.equal(run.scheduling_status, "pending_register");
    assert.equal(JSON.parse(run.context).rate_limit_resume_at, undefined);
  });

  it("does not resume runs paused by an operator", () => {
    getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = 'run-1'").run();
    assert.deepEqual(resumeDueRateLimitedRuns(new Date(Date.now() + 10 * 60 * 60_000)), []);
  });
});

describe("executePollingRound on a usage limit", { skip: process.platform === "win32" ? "needs a #!/bin/sh fake claude" : false }, () => {
  let home: TempTamanduaHome;
  let savedBinary: string | undefined;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-rate-limit-round-");
    savedBinary = process.env.TAMANDUA_CLAUDE_BINARY;
    const bin = path.join(home.dir, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\necho 'Claude usage limit reached. Your limit will reset at 3:00 PM' >&2\nexit 1\n", { mode: 0o755 });
    process.env.TAMANDUA_CLAUDE_BINARY = bin;
    seedRun(getDb(), { id: "run-1", context: { harness_type: "claude" } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "running", agentId: "wf_reviewer" },
    ]);
    getDb().prepare("UPDATE steps SET claim_job_id = 'job-1' WHERE id = 's-review'").run();
  });
  afterEach(() => {
    if (savedBinary === undefined) delete process.env.TAMANDUA_CLAUDE_BINARY;
    else process.env.TAMANDUA_CLAUDE_BINARY = savedBinary;
    closeDb();
    home.restore();
  });

  it("pauses the run and puts the step back to pending with no retry spent", async () => {
    await executePollingRound(
      { id: "job-1", workflowId: "wf", runId: "run-1", agentId: "wf_reviewer", intervalMinutes: 5, sessionLabel: "x",
        timeoutSeconds: 30, workingDirectoryForHarness: home.dir, harnessType: "claude", createdAt: new Date().toISOString() } as never,
      { id: "reviewer", role: "verification", workspace: { baseDir: "x", files: {} } } as never,
    );
    const step = getDb().prepare("SELECT status, retry_count FROM steps WHERE id = 's-review'").get() as { status: string; retry_count: number };
    assert.deepEqual({ ...step }, { status: "pending", retry_count: 0 });
    const run = getDb().prepare("SELECT status, context FROM runs WHERE id = 'run-1'").get() as { status: string; context: string };
    assert.equal(run.status, "paused");
    assert.ok(JSON.parse(run.context).rate_limit_resume_at);
  });
});
