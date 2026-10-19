import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../../dist/db.js";
import { insertRunSteps, buildEngineContextDefaults, resumeBlockedRun } from "../../dist/installer/run.js";
import { prepareBlockedRunResume } from "../../dist/installer/gate-loop.js";
import { claimStep } from "../../dist/installer/step-ops.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

const WORKFLOW = {
  id: "wf",
  agents: [],
  context: { base_branch: "develop" },
  budgets: { max_fix_rounds: 5 },
  steps: [
    { id: "gate-unit", agent: "bash-runner", type: "bash", run: "node scripts/gates/unit.mjs", input: "", expects: "",
      on_fail: { fix_step: "fix", max_rounds: 2 } },
    { id: "gate-review", agent: "reviewer", input: "review", expects: "STATUS: done", on_fail: { fix_step: "fix" } },
    { id: "fix", agent: "developer", input: "fix {{fix_feedback}}", expects: "STATUS: done" },
  ],
};

describe("insertRunSteps", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-run-steps-");
    seedRun(getDb(), { id: "run-1" }, []);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("persists run_command, on_fail and the scoped agent ids", () => {
    insertRunSteps(WORKFLOW as never, "run-1", new Date().toISOString());
    const rows = getDb().prepare("SELECT step_id, agent_id, type, run_command, on_fail FROM steps WHERE run_id = 'run-1' ORDER BY step_index").all() as Array<{
      step_id: string; agent_id: string; type: string; run_command: string | null; on_fail: string | null;
    }>;
    assert.deepEqual(rows.map((r) => r.agent_id), ["wf_bash-runner", "wf_reviewer", "wf_developer"]);
    assert.equal(rows[0].type, "bash");
    assert.equal(rows[0].run_command, "node scripts/gates/unit.mjs");
    assert.deepEqual(JSON.parse(rows[0].on_fail!), { fix_step: "fix", max_rounds: 2 });
    assert.deepEqual(JSON.parse(rows[1].on_fail!), { fix_step: "fix", max_rounds: 3 });
    assert.equal(rows[2].on_fail, null);
  });

  it("seeds engine and workflow context defaults", () => {
    const defaults = buildEngineContextDefaults(WORKFLOW as never);
    assert.equal(defaults.base_branch, "develop");
    assert.equal(defaults.fix_feedback, "");
    assert.equal(defaults.fix_origin, "");
    assert.equal(defaults.findings_gate_review, "[]");
    assert.equal(defaults.findings_gate_unit, "[]");
    assert.equal(defaults.gate_unit_output, "");
    assert.equal(defaults.minor_findings, "(none)");
  });
});

describe("blocked run resume", () => {
  let home: TempTamanduaHome;
  const POLICY = { fix_step: "fix", max_rounds: 3 };
  beforeEach(() => { home = useTempTamanduaHome("tamandua-run-resume-"); });
  afterEach(() => { closeDb(); home.restore(); });

  function stepStatus(stepId: string): string {
    return (getDb().prepare("SELECT status FROM steps WHERE run_id = 'run-1' AND step_id = ?").get(stepId) as { status: string }).status;
  }

  it("resumeBlockedRun reports not_found for a run that is not blocked", async () => {
    seedRun(getDb(), { id: "run-1", status: "running" }, []);
    assert.deepEqual(await resumeBlockedRun("run-1"), { status: "not_found" });
  });

  it("makes a gate blocked step claimable again", () => {
    seedRun(getDb(), { id: "run-1", status: "blocked", context: { blocked_step: "gate-review" } }, [
      { id: "s-impl", stepId: "implement", index: 0, status: "done" },
      { id: "s-review", stepId: "gate-review", index: 1, status: "waiting", agentId: "wf_reviewer", onFail: POLICY, fixRounds: 3 },
      { id: "s-fix", stepId: "fix", index: 2, status: "waiting", agentId: "wf_developer" },
    ]);
    const resumed = prepareBlockedRunResume("run-1");
    assert.equal(resumed.stepId, "gate-review");
    assert.equal(stepStatus("gate-review"), "pending");
    assert.ok(claimStep("wf_reviewer", "run-1").found);
  });

  it("resets fix rounds, clears block markers and keeps findings context", () => {
    seedRun(getDb(), { id: "run-1", status: "blocked", context: {
      blocked_step: "gate-review", blocked_reason: "budget", findings_gate_review: "[{\"id\":1}]" } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "waiting", agentId: "wf_reviewer", onFail: POLICY, fixRounds: 3 },
    ]);
    prepareBlockedRunResume("run-1");
    const step = getDb().prepare("SELECT fix_rounds FROM steps WHERE step_id = 'gate-review'").get() as { fix_rounds: number };
    const ctx = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);
    assert.equal(step.fix_rounds, 0);
    assert.equal(ctx.blocked_step, undefined);
    assert.equal(ctx.blocked_reason, undefined);
    assert.equal(ctx.findings_gate_review, "[{\"id\":1}]");
  });

  function seedBlockedGate(): void {
    seedRun(getDb(), { id: "run-1", status: "blocked", maxFixRounds: 8,
      context: { blocked_step: "gate-review", blocked_reason: "budget", working_directory_for_harness: home.dir } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "waiting", agentId: "wf_reviewer", onFail: POLICY, fixRounds: 3 },
    ]);
  }
  const okDeps = (status: number) => ({
    ensureDaemon: async () => {},
    register: async () => ({ status, body: status >= 300 ? { error: "daemon down" } : {} }),
  });

  it("resumeBlockedRun resumes the run when registration succeeds", async () => {
    seedBlockedGate();
    const result = await resumeBlockedRun("run-1", {}, okDeps(200) as never);
    assert.deepEqual(result, { status: "resumed", runId: "run-1", workflowId: "wf", stepId: "gate-review" });
    const run = getDb().prepare("SELECT status, scheduling_status FROM runs WHERE id = 'run-1'").get() as
      { status: string; scheduling_status: string };
    assert.deepEqual({ ...run }, { status: "running", scheduling_status: "pending_register" });
  });

  it("restores the blocked state exactly when registration fails, so a retry succeeds", async () => {
    seedBlockedGate();
    await assert.rejects(resumeBlockedRun("run-1", { maxFixRounds: 20 }, okDeps(503) as never), /daemon down/);
    const run = getDb().prepare("SELECT status, context, max_fix_rounds FROM runs WHERE id = 'run-1'").get() as
      { status: string; context: string; max_fix_rounds: number };
    const ctx = JSON.parse(run.context);
    assert.equal(run.status, "blocked");
    assert.equal(run.max_fix_rounds, 8);
    assert.equal(ctx.blocked_step, "gate-review");
    assert.equal(ctx.blocked_reason, "budget");
    const step = getDb().prepare("SELECT status, fix_rounds FROM steps WHERE step_id = 'gate-review'").get() as
      { status: string; fix_rounds: number };
    assert.deepEqual({ ...step }, { status: "waiting", fix_rounds: 3 });
    assert.equal((await resumeBlockedRun("run-1", {}, okDeps(200) as never)).status, "resumed");
  });

  it("makes a blocked fix step claimable again", () => {
    seedRun(getDb(), { id: "run-1", status: "blocked", context: { blocked_step: "fix" } }, [
      { id: "s-impl", stepId: "implement", index: 0, status: "done" },
      { id: "s-review", stepId: "gate-review", index: 1, status: "waiting", agentId: "wf_reviewer", onFail: POLICY },
      { id: "s-fix", stepId: "fix", index: 2, status: "waiting", agentId: "wf_developer", invokedBy: "gate-review" },
    ]);
    prepareBlockedRunResume("run-1");
    assert.equal(stepStatus("fix"), "pending");
    assert.ok(claimStep("wf_developer", "run-1").found);
  });

  it("surfaces an error when the blocked step no longer exists", () => {
    seedRun(getDb(), { id: "run-1", status: "blocked", context: { blocked_step: "ghost" } }, []);
    assert.throws(() => prepareBlockedRunResume("run-1"), /no step "ghost"/);
  });
});
