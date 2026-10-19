import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../../dist/db.js";
import { claimStep, completeStep, completeBashStep, advancePipeline } from "../../dist/installer/step-ops.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

const GATE_EXPECTS = "regex:^STATUS: (done|retry|blocked)$";
const POLICY = { fix_step: "fix", max_rounds: 3 };

function status(stepId: string): string {
  return (getDb().prepare("SELECT status FROM steps WHERE run_id = 'run-1' AND step_id = ?").get(stepId) as { status: string }).status;
}

describe("gate loop through step-ops", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-step-ops-gates-");
    seedRun(getDb(), { id: "run-1", context: { fix_feedback: "", fix_origin: "" } }, [
      { id: "s-impl", stepId: "implement", index: 0, status: "done" },
      { id: "s-unit", stepId: "gate-unit", index: 1, status: "waiting", type: "bash", runCommand: "exit 1", agentId: "wf_bash-runner", onFail: POLICY },
      { id: "s-review", stepId: "gate-review", index: 2, status: "waiting", agentId: "wf_reviewer", expects: GATE_EXPECTS, onFail: POLICY },
      { id: "s-pr", stepId: "pr", index: 3, status: "waiting", agentId: "wf_pr" },
      { id: "s-fix", stepId: "fix", index: 4, status: "waiting", agentId: "wf_developer" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("advancePipeline skips the fix step and completes the run after the last gate", () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id IN ('gate-unit', 'gate-review', 'pr')").run();
    const result = advancePipeline("run-1");
    assert.equal(result.runCompleted, true);
    assert.equal(status("fix"), "waiting");
  });

  it("advancePipeline does not advance a blocked run", () => {
    getDb().prepare("UPDATE runs SET status = 'blocked' WHERE id = 'run-1'").run();
    const result = advancePipeline("run-1");
    assert.deepEqual(result, { advanced: false, runCompleted: false });
    assert.equal(status("gate-unit"), "waiting");
  });

  it("a failing bash gate invokes fix, which is claimable while later steps still wait", async () => {
    advancePipeline("run-1");
    assert.equal(status("gate-unit"), "pending");
    const claim = claimStep("wf_bash-runner", "run-1");
    assert.equal(claim.found, true);

    const result = await completeBashStep(claim.stepId!, 1, "compiling\nerror CS1002: ; expected");
    assert.equal(result.status, "fixing");
    assert.equal(status("gate-unit"), "waiting");

    const fixClaim = claimStep("wf_developer", "run-1");
    assert.equal(fixClaim.found, true);
    assert.match(fixClaim.resolvedInput ?? "", /^$/);
    const context = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);
    assert.equal(context.gate_unit_output, "compiling\nerror CS1002: ; expected");
    assert.equal(context.fix_origin, "gate-unit");

    completeStep(fixClaim.stepId!, "STATUS: done\nRESOLVED: []");
    assert.equal(status("gate-unit"), "pending");
    assert.equal(status("fix"), "waiting");
  });

  it("a passing bash gate advances the pipeline", async () => {
    advancePipeline("run-1");
    const claim = claimStep("wf_bash-runner", "run-1");
    const result = await completeBashStep(claim.stepId!, 0, "all green");
    assert.equal(result.status, "advanced");
    assert.equal(status("gate-unit"), "done");
    assert.equal(status("gate-review"), "pending");
  });

  it("an agent gate replying STATUS: retry with findings invokes fix", () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    const finding = { rule: "review/naming", severity: "major", file: "src/A.cs", evidence: "x" };
    const result = completeStep("s-review", `STATUS: retry\nFINDINGS_JSON: [${JSON.stringify(finding)}]`);
    assert.equal(result.status, "fixing");
    assert.equal(status("fix"), "pending");
  });

  it("malformed FINDINGS_JSON retries the gate agent instead of invoking fix", () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    const result = completeStep("s-review", "STATUS: retry\nFINDINGS_JSON: [nope");
    assert.equal(result.status, "retrying");
    assert.equal(status("gate-review"), "pending");
    assert.equal(status("fix"), "waiting");
  });

  it("a fix round after a malformed retry resets the gate's retry_count", () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    completeStep("s-review", "STATUS: retry\nFINDINGS_JSON: [nope");
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    const finding = { rule: "review/naming", severity: "major", file: "src/A.cs", evidence: "x" };
    const result = completeStep("s-review", `STATUS: retry\nFINDINGS_JSON: [${JSON.stringify(finding)}]`);
    assert.equal(result.status, "fixing");
    const gate = getDb().prepare("SELECT retry_count FROM steps WHERE id = 's-review'").get() as { retry_count: number };
    assert.equal(gate.retry_count, 0);
  });

  it("an agent gate replying STATUS: done advances normally", () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    const result = completeStep("s-review", "STATUS: done");
    assert.equal(result.status, "advanced");
    assert.equal(status("gate-review"), "done");
    assert.equal(status("pr"), "pending");
  });

  it("a bash step without a fix policy fails through the normal retry path", async () => {
    getDb().prepare("UPDATE steps SET on_fail = NULL, status = 'running' WHERE step_id = 'gate-unit'").run();
    const result = await completeBashStep("s-unit", 2, "boom");
    assert.equal(result.status, "retrying");
  });

  it("a paused run still advances when its running step completes", () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = 'run-1'").run();
    completeStep("s-review", "STATUS: done");
    assert.equal(status("pr"), "pending");
  });

  it("a failing gate does not store findings_json in the run context", () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    const finding = { rule: "review/naming", severity: "major", file: "src/A.cs", evidence: "x" };
    completeStep("s-review", `STATUS: retry\nFINDINGS_JSON: [${JSON.stringify(finding)}]`);
    const context = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);
    assert.equal("findings_json" in context, false);
  });

  it("a fix step replying STATUS: blocked blocks the run at the fix step", () => {
    getDb().prepare("UPDATE steps SET status = 'running', invoked_by = 'gate-unit' WHERE step_id = 'fix'").run();
    const result = completeStep("s-fix", "STATUS: blocked\nREASON: needs a human");
    assert.equal(result.status, "blocked");
    const run = getDb().prepare("SELECT status, context FROM runs WHERE id = 'run-1'").get() as { status: string; context: string };
    assert.equal(run.status, "blocked");
    const context = JSON.parse(run.context);
    assert.equal(context.blocked_step, "fix");
    assert.equal(context.blocked_reason, "needs a human");
  });

  it("a fix step replying STATUS: blocked without REASON does not reuse an earlier step's reason", () => {
    getDb().prepare("UPDATE runs SET context = ? WHERE id = 'run-1'").run(JSON.stringify({ reason: "stale reason", status: "done" }));
    getDb().prepare("UPDATE steps SET status = 'running', invoked_by = 'gate-unit' WHERE step_id = 'fix'").run();
    completeStep("s-fix", "STATUS: blocked");
    const context = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);
    assert.equal(context.blocked_reason, "Fix step reported STATUS: blocked");
  });

  it("a gate replying STATUS: blocked without REASON does not reuse an earlier step's reason", () => {
    getDb().prepare("UPDATE runs SET context = ? WHERE id = 'run-1'").run(JSON.stringify({ reason: "stale reason" }));
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    const result = completeStep("s-review", "STATUS: blocked");
    assert.equal(result.status, "blocked");
    const context = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);
    assert.equal(context.blocked_reason, "Step reported STATUS: blocked");
  });

  it("a gate without a STATUS line does not inherit a stale STATUS: retry from the run context", () => {
    getDb().prepare("UPDATE runs SET context = ? WHERE id = 'run-1'").run(JSON.stringify({ status: "retry" }));
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running', expects = '' WHERE step_id = 'gate-review'").run();
    const result = completeStep("s-review", "VERDICT: fine");
    assert.equal(result.status, "advanced");
    assert.equal(status("fix"), "waiting");
  });

  it("a fix step replying STATUS: retry is retried and stays claimable", () => {
    getDb().prepare("UPDATE steps SET status = 'running', invoked_by = 'gate-unit' WHERE step_id = 'fix'").run();
    const result = completeStep("s-fix", "STATUS: retry");
    assert.equal(result.status, "retrying");
    assert.equal(status("fix"), "pending");
    assert.equal(status("gate-unit"), "waiting");
  });
});

describe("gate loop with the fix step in the middle of the pipeline", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-step-ops-gates-mid-");
    seedRun(getDb(), { id: "run-1", context: { fix_feedback: "", fix_origin: "" } }, [
      { id: "s-impl", stepId: "implement", index: 0, status: "done" },
      { id: "s-unit", stepId: "gate-unit", index: 1, status: "waiting", type: "bash", runCommand: "exit 1", agentId: "wf_bash-runner", onFail: POLICY },
      { id: "s-fix", stepId: "fix", index: 2, status: "waiting", agentId: "wf_developer" },
      { id: "s-review", stepId: "gate-review", index: 3, status: "waiting", agentId: "wf_reviewer" },
      { id: "s-pr", stepId: "pr", index: 4, status: "waiting", agentId: "wf_pr" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("a passing gate promotes the step after the idle fix step and it is claimable", async () => {
    advancePipeline("run-1");
    const claim = claimStep("wf_bash-runner", "run-1");
    await completeBashStep(claim.stepId!, 0, "ok");
    assert.equal(status("fix"), "waiting");
    assert.equal(status("gate-review"), "pending");
    assert.equal(claimStep("wf_reviewer", "run-1").found, true);
  });

  it("a failing gate routes to the mid-positioned fix step and back", async () => {
    advancePipeline("run-1");
    const claim = claimStep("wf_bash-runner", "run-1");
    const result = await completeBashStep(claim.stepId!, 1, "boom");
    assert.equal(result.status, "fixing");
    const fixClaim = claimStep("wf_developer", "run-1");
    assert.equal(fixClaim.found, true);
    completeStep(fixClaim.stepId!, "STATUS: done\nRESOLVED: []");
    assert.equal(status("gate-unit"), "pending");
    assert.equal(status("fix"), "waiting");
  });
});
