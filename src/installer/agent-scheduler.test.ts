import assert from "node:assert/strict";
import { describe, it, afterEach, beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  setupAgentCrons,
  createAgentCronJob,
  _getJobIntervalsForRun,
  removeRunCrons,
  shutdownAllCrons,
  tryMarkJobInFlight,
  nudgeScheduledRuns,
  terminateProcessGroup,
} from "../../dist/installer/agent-scheduler.js";
import type { SetupAgentCronsOptions, NudgeResult } from "../../dist/installer/agent-scheduler.js";
import type { WorkflowSpec } from "../../dist/installer/types.js";

function makeWorkflow(overrides: {
  pollingTimeoutSeconds?: number;
} = {}) {
  return {
    id: "test-workflow",
    agents: [
      {
        id: "test-agent",
        model: "fake",
        workspace: { baseDir: "." },
      },
    ],
    steps: [
      {
        id: "step-1",
        agent: "test-agent",
        input: "do something",
        expects: "STATUS",
      },
    ],
    ...(overrides.pollingTimeoutSeconds !== undefined
      ? { polling: { timeoutSeconds: overrides.pollingTimeoutSeconds } }
      : {}),
  };
}

describe("setupAgentCrons interval calculation", () => {
  afterEach(() => {
    shutdownAllCrons();
  });

  it("uses default interval 5 when no polling.timeoutSeconds is set", async () => {
    const workflow = makeWorkflow();
    const runId = "run-default-test";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 5);

    await removeRunCrons(runId);
  });

  it("uses Math.max(1, ...) floor when polling.timeoutSeconds is set (33s → ceil(33/60)=1)", async () => {
    const workflow = makeWorkflow({ pollingTimeoutSeconds: 33 });
    const runId = "run-floor-test";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 1);

    await removeRunCrons(runId);
  });

  it("ceil works for fractional minutes (120s → ceil(2)=2)", async () => {
    const workflow = makeWorkflow({ pollingTimeoutSeconds: 120 });
    const runId = "run-ceil-test";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 2);

    await removeRunCrons(runId);
  });

  it("works with multiple agents", async () => {
    const workflow = {
      ...makeWorkflow({ pollingTimeoutSeconds: 90 }),
      agents: [
        { id: "agent-a", model: "fake", workspace: { baseDir: "." } },
        { id: "agent-b", model: "fake", workspace: { baseDir: "." } },
      ],
    };
    const runId = "run-multi";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 2);
    // 90s / 60 = 1.5, ceil → 2
    for (const job of intervals) {
      assert.equal(job.intervalMinutes, 2);
    }

    await removeRunCrons(runId);
  });
});

describe("setupAgentCrons noHurrySaveTokensMode", () => {
  afterEach(() => {
    shutdownAllCrons();
  });

  it("save-tokens mode uses default 15 when no polling.timeoutSeconds set", async () => {
    const workflow = makeWorkflow();
    const runId = "run-save-default";

    await setupAgentCrons(workflow, runId, { noHurrySaveTokensMode: true });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 15);

    await removeRunCrons(runId);
  });

  it("save-tokens mode uses Math.max(15, ...) floor (33s → ceil=1 → max(15,1)=15)", async () => {
    const workflow = makeWorkflow({ pollingTimeoutSeconds: 33 });
    const runId = "run-save-floor";

    await setupAgentCrons(workflow, runId, { noHurrySaveTokensMode: true });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 15);

    await removeRunCrons(runId);
  });

  it("save-tokens mode with 1200s timeout → ceil=20 → stays 20 (above floor)", async () => {
    const workflow = makeWorkflow({ pollingTimeoutSeconds: 1200 });
    const runId = "run-save-above-floor";

    await setupAgentCrons(workflow, runId, { noHurrySaveTokensMode: true });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 20);

    await removeRunCrons(runId);
  });

  it("noHurrySaveTokensMode=false uses default 5", async () => {
    const workflow = makeWorkflow();
    const runId = "run-normal-default";

    await setupAgentCrons(workflow, runId, { noHurrySaveTokensMode: false });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 5);

    await removeRunCrons(runId);
  });

  it("noHurrySaveTokensMode=false uses Math.max(1, ...) floor (33s → ceil=1)", async () => {
    const workflow = makeWorkflow({ pollingTimeoutSeconds: 33 });
    const runId = "run-normal-floor";

    await setupAgentCrons(workflow, runId, { noHurrySaveTokensMode: false });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 1);

    await removeRunCrons(runId);
  });

  it("noHurrySaveTokensMode omitted (undefined) uses default 5", async () => {
    const workflow = makeWorkflow();
    const runId = "run-absent-default";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 5);

    await removeRunCrons(runId);
  });

  it("save-tokens mode with multiple agents", async () => {
    const workflow = {
      ...makeWorkflow({ pollingTimeoutSeconds: 90 }),
      agents: [
        { id: "agent-a", model: "fake", workspace: { baseDir: "." } },
        { id: "agent-b", model: "fake", workspace: { baseDir: "." } },
      ],
    };
    const runId = "run-save-multi";

    await setupAgentCrons(workflow, runId, { noHurrySaveTokensMode: true });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 2);
    // 90s / 60 = 1.5, ceil → 2, Math.max(15, 2) → 15
    for (const job of intervals) {
      assert.equal(job.intervalMinutes, 15);
    }

    await removeRunCrons(runId);
  });
});

describe("tryMarkJobInFlight race guard", () => {
  afterEach(() => {
    shutdownAllCrons();
  });

  it("returns true on first call for a given jobId", () => {
    const result = tryMarkJobInFlight("job-001");
    assert.equal(result, true);
  });

  it("returns false on second call for same jobId", () => {
    tryMarkJobInFlight("job-002");
    const result = tryMarkJobInFlight("job-002");
    assert.equal(result, false);
  });

  it("returns true for different jobIds", () => {
    const r1 = tryMarkJobInFlight("job-a");
    const r2 = tryMarkJobInFlight("job-b");
    assert.equal(r1, true);
    assert.equal(r2, true);
  });

  it("subsequent call after first returns false (three calls)", () => {
    assert.equal(tryMarkJobInFlight("job-003"), true);
    assert.equal(tryMarkJobInFlight("job-003"), false);
    assert.equal(tryMarkJobInFlight("job-003"), false);
  });

  it("is idempotent — check-and-add happens synchronously", () => {
    // Simulate two concurrent calls that would race without the
    // atomic check-and-add. Since JS is single-threaded we verify
    // the fundamental contract: first call wins, second loses.
    const wins: boolean[] = [];
    for (let i = 0; i < 2; i++) {
      wins.push(tryMarkJobInFlight("job-concurrent"));
    }
    assert.deepEqual(wins, [true, false]);
  });

  it("different jobIds are independent", () => {
    // job-004 should not prevent job-005 from being marked
    tryMarkJobInFlight("job-004");
    assert.equal(tryMarkJobInFlight("job-005"), true);
    // job-004 is still in flight
    assert.equal(tryMarkJobInFlight("job-004"), false);
  });

  it("shutdown clears in-flight state", () => {
    tryMarkJobInFlight("job-006");
    shutdownAllCrons();
    // After shutdown, a fresh call should succeed
    assert.equal(tryMarkJobInFlight("job-006"), true);
  });
});

// ── nudgeScheduledRuns tests ────────────────────────────────────────

describe("nudgeScheduledRuns", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-nudge-"));
    process.env.TAMANDUA_STATE_DIR = path.join(tempHome, ".tamandua");
  });

  afterEach(() => {
    shutdownAllCrons();
    delete process.env.TAMANDUA_STATE_DIR;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function createWorkflowDir(workflowId: string, agentIds: string[]) {
    const wfDir = path.join(
      process.env.TAMANDUA_STATE_DIR!,
      "workflows",
      workflowId,
    );
    fs.mkdirSync(wfDir, { recursive: true });
    const agentsYaml = agentIds
      .map(
        (id) =>
          `  - id: ${id}\n    model: fake\n    workspace:\n      baseDir: "."`,
      )
      .join("\n");
    const yml =
      `id: ${workflowId}\n` +
      `agents:\n${agentsYaml}\n` +
      `steps:\n` +
      `  - id: step-1\n` +
      `    agent: ${agentIds[0]}\n` +
      `    input: "do"\n` +
      `    expects: STATUS\n`;
    fs.writeFileSync(path.join(wfDir, "workflow.yml"), yml);
  }

  function makeWorkflowSpec(
    workflowId: string,
    agentIds: string[],
  ): WorkflowSpec {
    return {
      id: workflowId,
      agents: agentIds.map((id) => ({
        id,
        model: "fake",
        workspace: { baseDir: "." },
      })),
      steps: [
        {
          id: "s1",
          agent: agentIds[0],
          input: "do",
          expects: "STATUS",
        },
      ],
    } as WorkflowSpec;
  }

  it("returns empty result for empty runIds", async () => {
    const result = await nudgeScheduledRuns([]);
    assert.deepStrictEqual(result.runIds, []);
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it("returns empty result for non-existent runIds", async () => {
    const result = await nudgeScheduledRuns(["no-such-run"]);
    assert.equal(result.runIds.length, 1);
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 0);
  });

  it("skips jobs that are in flight", async () => {
    createWorkflowDir("wf-skip", ["dev"]);
    const workflow = makeWorkflowSpec("wf-skip", ["dev"]);
    await setupAgentCrons(workflow, "run-skip", {
      workingDirectoryForHarness: tempHome,
    });

    // Compute the job id (same format as buildJobId) and mark in-flight
    const jobId = "tamandua-wf-skip-run-skip-dev";
    tryMarkJobInFlight(jobId);

    const result = await nudgeScheduledRuns(["run-skip"]);
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "skipped_in_flight");
    assert.equal(result.jobs[0].agentId, "wf-skip_dev");
    assert.equal(result.jobs[0].runId, "run-skip");
  });

  it("launches for non-in-flight scheduled jobs", async () => {
    createWorkflowDir("wf-launch", ["dev"]);
    const workflow = makeWorkflowSpec("wf-launch", ["dev"]);
    await setupAgentCrons(workflow, "run-launch", {
      workingDirectoryForHarness: tempHome,
    });

    const result = await nudgeScheduledRuns(["run-launch"]);
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "launched");
    assert.equal(result.jobs[0].runId, "run-launch");
    assert.equal(result.jobs[0].agentId, "wf-launch_dev");
  });

  it("nudges only matching runs, ignoring others", async () => {
    createWorkflowDir("wf-multi", ["dev"]);
    const workflow = makeWorkflowSpec("wf-multi", ["dev"]);
    await setupAgentCrons(workflow, "run-a", {
      workingDirectoryForHarness: tempHome,
    });
    await setupAgentCrons(workflow, "run-b", {
      workingDirectoryForHarness: tempHome,
    });

    // Nudge only run-a
    const result = await nudgeScheduledRuns(["run-a"]);
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].runId, "run-a");
  });

  it("converts pending-start timer to active interval on nudge", async () => {
    createWorkflowDir("wf-pending", ["dev"]);
    const workflow = makeWorkflowSpec("wf-pending", ["dev"]);

    // Create job with stagger to get a pending-start timer
    await createAgentCronJob({
      workflowId: "wf-pending",
      runId: "run-pending",
      agent: { id: "dev", model: "fake", workspace: { baseDir: "." } },
      workflow,
      intervalMinutes: 5,
      staggerOffsetMs: 60_000,
      workingDirectoryForHarness: tempHome,
    });

    await nudgeScheduledRuns(["run-pending"]);

    // After nudge, the job should have an active interval (was pending)
    const intervals = _getJobIntervalsForRun("run-pending");
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 5);
  });

  it("preserves job metadata (harness type) through nudge", async () => {
    createWorkflowDir("wf-harness", ["dev"]);
    const workflow = makeWorkflowSpec("wf-harness", ["dev"]);

    await setupAgentCrons(workflow, "run-harness", {
      workingDirectoryForHarness: tempHome,
    });

    // Nudge should succeed without errors
    const result = await nudgeScheduledRuns(["run-harness"]);
    assert.equal(result.launched, 1);
    assert.equal(result.errors.length, 0);
  });

  it("returns errors for jobs whose workflow is missing from disk", async () => {
    // Set up a job that references a workflow NOT on disk
    const workflow = makeWorkflowSpec("wf-missing", ["dev"]);
    await setupAgentCrons(workflow, "run-err", {
      workingDirectoryForHarness: tempHome,
    });

    // Don't create the workflow dir — so loadWorkflowSpec will fail
    const result = await nudgeScheduledRuns(["run-err"]);
    assert.equal(result.launched, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "error");
  });

  it("handles mixed in-flight and launchable jobs", async () => {
    createWorkflowDir("wf-mixed", ["dev", "qa"]);
    const workflow = makeWorkflowSpec("wf-mixed", ["dev", "qa"]);
    await setupAgentCrons(workflow, "run-mixed", {
      workingDirectoryForHarness: tempHome,
    });

    // Mark dev as in-flight, qa should still launch
    const devJobId = "tamandua-wf-mixed-run-mixed-dev";
    tryMarkJobInFlight(devJobId);

    const result = await nudgeScheduledRuns(["run-mixed"]);
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 1);
    assert.equal(result.jobs.length, 2);

    const launched = result.jobs.filter((j) => j.status === "launched");
    const skipped = result.jobs.filter((j) => j.status === "skipped_in_flight");
    assert.equal(launched.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(launched[0].agentId, "wf-mixed_qa");
    assert.equal(skipped[0].agentId, "wf-mixed_dev");
  });
});

describe("terminateProcessGroup", () => {
  function recorder(platform: NodeJS.Platform) {
    const signals: string[] = [];
    const scheduled: Array<() => void> = [];
    terminateProcessGroup(4242, {
      platform,
      kill: (pgid, signal) => signals.push(`${pgid}:${signal}`),
      schedule: (fn) => { scheduled.push(fn); },
    });
    return { signals, scheduled };
  }

  it("sends SIGTERM and follows up with SIGKILL on POSIX", () => {
    const { signals, scheduled } = recorder("linux");
    assert.deepEqual(signals, ["4242:SIGTERM"]);
    assert.equal(scheduled.length, 1);
    scheduled[0]();
    assert.deepEqual(signals, ["4242:SIGTERM", "4242:SIGKILL"]);
  });

  it("kills once on Windows, where taskkill /F is already forceful and a later retry could hit a reused PID", () => {
    const { signals, scheduled } = recorder("win32");
    assert.deepEqual(signals, ["4242:SIGTERM"]);
    assert.equal(scheduled.length, 0);
  });
});
