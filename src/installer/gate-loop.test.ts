import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../../dist/db.js";
import {
  settleGate,
  completeFixStep,
  parseFixPolicy,
  serializeFixPolicy,
  prepareBlockedRunResume,
  bashOutputContextKey,
  tailLines,
} from "../../dist/installer/gate-loop.js";
import { listFindings } from "../../dist/installer/findings.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

const POLICY = { fix_step: "fix", max_rounds: 2 };
const FINDING = {
  rule: "review/naming", severity: "blocking", file: "src/A.cs", symbol: "A", evidence: "bad name",
} as const;

function stepRow(stepId: string) {
  return getDb().prepare("SELECT id, run_id, step_id, status, output, fix_rounds, invoked_by FROM steps WHERE run_id = 'run-1' AND step_id = ?").get(stepId) as {
    id: string; run_id: string; step_id: string; status: string; output: string | null; fix_rounds: number; invoked_by: string | null;
  };
}

function runRow() {
  return getDb().prepare("SELECT status, context, fix_rounds, max_fix_rounds, max_rounds_override FROM runs WHERE id = 'run-1'").get() as {
    status: string; context: string; fix_rounds: number; max_fix_rounds: number | null; max_rounds_override: number | null;
  };
}

describe("fix policy (de)serialization", () => {
  it("defaults max_rounds and ignores steps without fix_step", () => {
    assert.equal(serializeFixPolicy(undefined), null);
    assert.equal(serializeFixPolicy({ escalate_to: "human" }), null);
    assert.deepEqual(parseFixPolicy(serializeFixPolicy({ fix_step: "fix" })), { fix_step: "fix", max_rounds: 3 });
    assert.deepEqual(
      parseFixPolicy(serializeFixPolicy({ fix_step: "fix", max_rounds: 1, return_step: "gate-ci-local" })),
      { fix_step: "fix", max_rounds: 1, return_step: "gate-ci-local" },
    );
  });

  it("derives context keys and tails output", () => {
    assert.equal(bashOutputContextKey("gate-security-checks"), "gate_security_checks_output");
    assert.equal(tailLines("a\nb\nc", 2), "b\nc");
  });
});

describe("settleGate", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-gate-loop-");
    seedRun(getDb(), { id: "run-1", maxFixRounds: 8 }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "running", onFail: POLICY },
      { id: "s-pr", stepId: "pr", index: 1 },
      { id: "s-fix", stepId: "fix", index: 2, agentId: "wf_developer" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  const gate = () => stepRow("gate-review");

  it("sends a failing gate to the fix step with fix_feedback and fix_origin", () => {
    const result = settleGate(gate(), POLICY, { failed: true, findings: [FINDING as never], output: "STATUS: retry" });
    assert.equal(result?.status, "fixing");
    assert.equal(stepRow("gate-review").status, "waiting");
    assert.equal(stepRow("gate-review").fix_rounds, 1);
    assert.equal(stepRow("fix").status, "pending");
    assert.equal(stepRow("fix").invoked_by, "gate-review");
    const context = JSON.parse(runRow().context);
    assert.equal(context.fix_origin, "gate-review");
    const feedback = JSON.parse(context.fix_feedback);
    assert.equal(feedback.length, 1);
    assert.match(feedback[0].fingerprint, /^[0-9a-f]{40}$/);
    assert.equal(runRow().fix_rounds, 1);
    assert.match(JSON.parse(runRow().context).findings_gate_review, /review\/naming/);
  });

  it("synthesizes a gate/<id> finding when a gate fails without actionable findings", () => {
    settleGate(gate(), POLICY, { failed: true, findings: [], output: "line1\nboom" });
    const [finding] = listFindings("run-1");
    assert.equal(finding.rule, "gate/gate-review");
    assert.equal(finding.file, ".");
    assert.equal(finding.severity, "blocking");
    assert.equal(finding.evidence, "line1\nboom");
  });

  it("fails the gate when STATUS: done still carries blocking findings, passes with minors only", () => {
    assert.equal(settleGate(gate(), POLICY, { failed: false, findings: [{ ...FINDING, severity: "minor" } as never], output: "STATUS: done" }), null);
    assert.match(JSON.parse(runRow().context).minor_findings, /review\/naming/);
    assert.equal(settleGate(gate(), POLICY, { failed: false, findings: [FINDING as never], output: "STATUS: done" })?.status, "fixing");
  });

  it("blocks once the gate has used max_rounds fix rounds", () => {
    getDb().prepare("UPDATE steps SET fix_rounds = 2 WHERE id = 's-review'").run();
    const result = settleGate(gate(), POLICY, { failed: true, findings: [FINDING as never], output: "STATUS: retry" });
    assert.equal(result?.status, "blocked");
    assert.equal(runRow().status, "blocked");
    const context = JSON.parse(runRow().context);
    assert.equal(context.blocked_step, "gate-review");
    assert.match(context.blocked_reason, /after 2 fix round/);
  });

  it("honours the run's max_rounds_override", () => {
    getDb().prepare("UPDATE steps SET fix_rounds = 2 WHERE id = 's-review'").run();
    getDb().prepare("UPDATE runs SET max_rounds_override = 5 WHERE id = 'run-1'").run();
    assert.equal(settleGate(gate(), POLICY, { failed: true, findings: [FINDING as never], output: "x" })?.status, "fixing");
  });

  it("blocks when the run-wide fix budget is spent", () => {
    getDb().prepare("UPDATE runs SET fix_rounds = 8 WHERE id = 'run-1'").run();
    const result = settleGate(gate(), POLICY, { failed: true, findings: [FINDING as never], output: "x" });
    assert.equal(result?.status, "blocked");
    assert.match(JSON.parse(runRow().context).blocked_reason, /fix budget exhausted/);
  });

  it("blocks immediately when a disputed finding is raised again", () => {
    settleGate(gate(), POLICY, { failed: true, findings: [FINDING as never], output: "x" });
    const fingerprint = listFindings("run-1")[0].fingerprint;
    completeFixStep({ ...stepRow("fix"), invoked_by: "gate-review" },
      `STATUS: done\nDISPUTED_JSON: [{"fingerprint":"${fingerprint}","reason":"intended"}]`);
    const result = settleGate(gate(), POLICY, { failed: true, findings: [FINDING as never], output: "x" });
    assert.equal(result?.status, "blocked");
    assert.match(JSON.parse(runRow().context).blocked_reason, /disputed/);
  });

  it("blocks without a fix round when the verdict carries a blocked reason", () => {
    const result = settleGate(gate(), POLICY, { failed: true, blockedReason: "gh not authenticated", findings: [], output: "x" });
    assert.equal(result?.status, "blocked");
    assert.equal(stepRow("fix").status, "waiting");
  });

  it("resolves the gate's findings when it passes", () => {
    settleGate(gate(), POLICY, { failed: true, findings: [FINDING as never], output: "x" });
    assert.equal(settleGate(gate(), POLICY, { failed: false, findings: [], output: "STATUS: done" }), null);
    assert.equal(listFindings("run-1")[0].status, "resolved");
  });
});

describe("completeFixStep", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-fix-step-");
    seedRun(getDb(), { id: "run-1", context: { fix_origin: "pr", fix_feedback: "[]" } }, [
      { id: "s-ci", stepId: "gate-ci-local", index: 0, status: "done", type: "bash" },
      { id: "s-pr", stepId: "pr", index: 1, status: "waiting", onFail: { fix_step: "fix", max_rounds: 2, return_step: "gate-ci-local" } },
      { id: "s-fix", stepId: "fix", index: 2, status: "running", invokedBy: "pr" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("re-queues the return_step, parks the fix step and clears fix context", () => {
    const result = completeFixStep({ ...stepRow("fix"), invoked_by: "pr" }, "STATUS: done\nRESOLVED: []");
    assert.equal(result.status, "advanced");
    assert.equal(stepRow("gate-ci-local").status, "pending");
    assert.equal(stepRow("pr").status, "waiting");
    assert.equal(stepRow("fix").status, "waiting");
    assert.equal(stepRow("fix").invoked_by, null);
    const context = JSON.parse(runRow().context);
    assert.equal(context.fix_feedback, "");
    assert.equal(context.fix_origin, "");
  });
});

describe("prepareBlockedRunResume", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-resume-blocked-");
    seedRun(getDb(), { id: "run-1", status: "blocked", context: { blocked_step: "gate-review", blocked_reason: "x" } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "waiting", fixRounds: 3, onFail: POLICY },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("re-queues the blocked step, resets its round counter and applies budget overrides", () => {
    const result = prepareBlockedRunResume("run-1", { maxRounds: 6, maxFixRounds: 12 });
    assert.equal(result.stepId, "gate-review");
    assert.equal(stepRow("gate-review").status, "pending");
    assert.equal(stepRow("gate-review").fix_rounds, 0);
    const run = runRow();
    assert.equal(run.status, "running");
    assert.equal(run.max_rounds_override, 6);
    assert.equal(run.max_fix_rounds, 12);
    assert.equal(JSON.parse(run.context).blocked_step, undefined);
  });

  it("refuses runs that are not blocked", () => {
    getDb().prepare("UPDATE runs SET status = 'running' WHERE id = 'run-1'").run();
    assert.throws(() => prepareBlockedRunResume("run-1"), /is not blocked/);
  });
});
