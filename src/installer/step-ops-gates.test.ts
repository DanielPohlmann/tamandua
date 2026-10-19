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
});
