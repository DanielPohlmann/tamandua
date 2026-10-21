import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../../dist/db.js";
import { claimStep, completeStep, completeBashStep, advancePipeline, resolveStepContext } from "../../dist/installer/step-ops.js";
import { getRunEvents } from "../../dist/installer/events.js";
import { resumeBlockedRun } from "../../dist/installer/run.js";
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

  it("a late bash result for a step that is no longer running is ignored", async () => {
    getDb().prepare("UPDATE steps SET status = 'pending' WHERE step_id = 'gate-unit'").run();
    const result = await completeBashStep("s-unit", 1, "late failure");
    assert.equal(result.status, "ignored");
    assert.equal(status("gate-unit"), "pending");
    assert.equal(status("fix"), "waiting");
    const context = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);
    assert.equal(context.gate_unit_output, undefined);
  });

  it("an engine failure on a gated bash step blocks the run without a fix round", async () => {
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-unit'").run();
    const result = await completeBashStep("s-unit", 1, "<no output>", "engine error: spawn ENOENT");
    assert.equal(result.status, "blocked");
    assert.equal(status("fix"), "waiting");
    const run = getDb().prepare("SELECT status, context, fix_rounds FROM runs WHERE id = 'run-1'").get() as
      { status: string; context: string; fix_rounds: number };
    assert.equal(run.status, "blocked");
    assert.equal(run.fix_rounds, 0);
    assert.equal(JSON.parse(run.context).blocked_reason, "engine error: spawn ENOENT");
  });

  it("an engine failure on an ungated bash step keeps the ordinary failure path", async () => {
    getDb().prepare("UPDATE steps SET on_fail = NULL, status = 'running' WHERE step_id = 'gate-unit'").run();
    const result = await completeBashStep("s-unit", 1, "<no output>", "engine error: spawn ENOENT");
    assert.equal(result.status, "retrying");
    const step = getDb().prepare("SELECT output FROM steps WHERE id = 's-unit'").get() as { output: string };
    assert.match(step.output, /engine error: spawn ENOENT/);
  });

  it("an agent cannot rewrite the bash environment allowlist", () => {
    getDb().prepare("UPDATE runs SET context = ? WHERE id = 'run-1'").run(JSON.stringify({ __env_keys: "[\"base_branch\"]" }));
    getDb().prepare("UPDATE steps SET status = 'done' WHERE step_id = 'gate-unit'").run();
    getDb().prepare("UPDATE steps SET status = 'running' WHERE step_id = 'gate-review'").run();
    completeStep("s-review", "STATUS: done\n__ENV_KEYS: [\"node_options\"]");
    const context = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);
    assert.equal(context.__env_keys, "[\"base_branch\"]");
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

describe("pr opened event", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-pr-opened-");
    seedRun(getDb(), { id: "run-1" }, [
      { id: "s-pr", stepId: "pr", index: 0, status: "running" },
      { id: "s-pr2", stepId: "pr-again", index: 1, status: "running" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("emits run.pr_opened when a step reports a new PR url", () => {
    completeStep("s-pr", "STATUS: done\nPR: https://github.com/o/r/pull/12");
    const events = getRunEvents("run-1").filter((e) => e.event === "run.pr_opened");
    assert.equal(events.length, 1);
    assert.equal(events[0].detail, "https://github.com/o/r/pull/12");
  });

  it("does not emit again when the same PR url is reported twice", () => {
    completeStep("s-pr", "STATUS: done\nPR: https://github.com/o/r/pull/12");
    completeStep("s-pr2", "STATUS: done\nPR: https://github.com/o/r/pull/12");
    assert.equal(getRunEvents("run-1").filter((e) => e.event === "run.pr_opened").length, 1);
  });
});

describe("blocking while a drain-pause is in progress", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-step-ops-drain-block-");
    seedRun(getDb(), { id: "run-1", context: { working_directory_for_harness: home.dir } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "running", agentId: "wf_reviewer", expects: GATE_EXPECTS, onFail: POLICY },
      { id: "s-fix", stepId: "fix", index: 1, status: "waiting", agentId: "wf_developer" },
    ]);
    getDb().prepare("UPDATE runs SET scheduling_status = 'draining_pause' WHERE id = 'run-1'").run();
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("keeps the run blocked instead of finalizing the pause, and it stays resumable", async () => {
    assert.equal(completeStep("s-review", "STATUS: blocked\nREASON: needs a human").status, "blocked");
    const run = getDb().prepare("SELECT status FROM runs WHERE id = 'run-1'").get() as { status: string };
    assert.equal(run.status, "blocked");
    assert.equal(getRunEvents("run-1").some((e) => e.event === "run.paused"), false);

    const deps = { ensureDaemon: async () => {}, register: async () => ({ status: 200, body: {} }) };
    const resumed = await resumeBlockedRun("run-1", {}, deps as never);
    assert.equal(resumed.status, "resumed");
    assert.equal(status("gate-review"), "pending");
  });
});

describe("engine-owned context keys", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-step-ops-reserved-");
    seedRun(getDb(), { id: "run-1", context: { blocked_reason: "engine" } }, [
      { id: "s-plan", stepId: "plan", index: 0, status: "running", agentId: "wf_planner" },
      { id: "s-next", stepId: "next", index: 1, status: "waiting", agentId: "wf_developer" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("ignores agent output lines that would overwrite them", () => {
    completeStep("s-plan", [
      "STATUS: done",
      "RATE_LIMIT_RESUME_AT: 2099-01-01T00:00:00.000Z",
      "RATE_LIMIT_PAUSES: {\"plan\":0}",
      "BLOCKED_STEP: next",
      "BLOCKED_REASON: forged",
    ].join("\n"));
    const context = JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);
    assert.equal(context.rate_limit_resume_at, undefined);
    assert.equal(context.rate_limit_pauses, undefined);
    assert.equal(context.blocked_step, undefined);
    assert.equal(context.blocked_reason, "engine");
    assert.equal(context.status, "done");
  });
});

describe("gate environment inputs in the run context", () => {
  let home: TempTamanduaHome;
  const runContext = () =>
    JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = 'run-1'").get() as { context: string }).context);

  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-step-ops-gate-env-");
    seedRun(getDb(), {
      id: "run-1",
      context: {
        base_branch: "develop",
        reviewed_sha: "",
        deploy_target: "staging",
        __env_keys: JSON.stringify(["base_branch", "reviewed_sha", "deploy_target"]),
      },
    }, [
      { id: "s-plan", stepId: "load-plan", index: 0, status: "running", agentId: "wf_planner" },
      { id: "s-review", stepId: "gate-review", index: 1, status: "waiting", agentId: "wf_reviewer" },
      { id: "s-pr", stepId: "pr", index: 2, status: "waiting", agentId: "wf_pr" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("lets the plan step set the branch and feature flag while they are still empty", () => {
    completeStep("s-plan", "STATUS: done\nBRANCH: feature/orders\nFEATURE_COMPLETE: true");
    const context = runContext();
    assert.equal(context.branch, "feature/orders");
    assert.equal(context.feature_complete, "true");
  });

  it("keeps declared keys, base_branch, branch and feature_complete when a later step prints them", () => {
    completeStep("s-plan", "STATUS: done\nBRANCH: feature/orders\nFEATURE_COMPLETE: true");
    getDb().prepare("UPDATE steps SET status = 'running' WHERE id = 's-review'").run();
    completeStep("s-review", [
      "STATUS: done",
      "BASE_BRANCH: HEAD",
      "FEATURE_COMPLETE: false",
      "BRANCH: x",
      "DEPLOY_TARGET: production",
      "REVIEWED_SHA: abc123",
    ].join("\n"));

    const context = runContext();
    assert.equal(context.base_branch, "develop");
    assert.equal(context.feature_complete, "true");
    assert.equal(context.branch, "feature/orders");
    assert.equal(context.deploy_target, "staging");
    assert.equal(context.reviewed_sha, "abc123", "the review verifier still records what it reviewed");

    const resolved = resolveStepContext("run-1", 2);
    assert.equal(resolved.base_branch, "develop");
    assert.equal(resolved.feature_complete, "true");
    assert.equal(resolved.branch, "feature/orders");
    assert.equal(resolved.deploy_target, "staging");
    assert.equal(resolved.reviewed_sha, "abc123");
  });

  it("protects base_branch even when the workflow declares no context keys", () => {
    getDb().prepare("UPDATE runs SET context = ? WHERE id = 'run-1'").run(JSON.stringify({ base_branch: "main" }));
    completeStep("s-plan", "STATUS: done\nBASE_BRANCH: HEAD");
    assert.equal(runContext().base_branch, "main");
  });
});
