import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../../dist/db.js";
import { claimStep } from "../../dist/installer/step-ops.js";
import { prepareBlockedRunResume } from "../../dist/installer/gate-loop.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

describe("token budget", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-token-budget-");
    seedRun(getDb(), { id: "run-1" }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "pending", agentId: "wf_reviewer" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("lets work through while under budget", () => {
    getDb().prepare("UPDATE runs SET tokens_spent = 999, max_tokens = 1000 WHERE id = 'run-1'").run();
    assert.equal(claimStep("wf_reviewer", "run-1").found, true);
  });

  it("blocks the run before the next step once the budget is spent", () => {
    getDb().prepare("UPDATE runs SET tokens_spent = 1000, max_tokens = 1000 WHERE id = 'run-1'").run();
    assert.equal(claimStep("wf_reviewer", "run-1").found, false);
    const run = getDb().prepare("SELECT status, context FROM runs WHERE id = 'run-1'").get() as { status: string; context: string };
    assert.equal(run.status, "blocked");
    assert.match(JSON.parse(run.context).blocked_reason, /Token budget exhausted \(1000\/1000\)/);
    assert.equal(JSON.parse(run.context).blocked_step, "gate-review");
  });

  it("ignores runs without a budget", () => {
    getDb().prepare("UPDATE runs SET tokens_spent = 10000000 WHERE id = 'run-1'").run();
    assert.equal(claimStep("wf_reviewer", "run-1").found, true);
  });

  it("blocks bash steps too, since they claim through the same path", () => {
    seedRun(getDb(), { id: "run-2" }, [
      { id: "s-bash", stepId: "build", index: 0, status: "pending", agentId: "wf_bash", type: "bash", runCommand: "echo hi" },
    ]);
    getDb().prepare("UPDATE runs SET tokens_spent = 50, max_tokens = 50 WHERE id = 'run-2'").run();
    assert.equal(claimStep("wf_bash", "run-2").found, false);
    const run = getDb().prepare("SELECT status FROM runs WHERE id = 'run-2'").get() as { status: string };
    assert.equal(run.status, "blocked");
  });

  it("raises the budget on resume", () => {
    getDb().prepare("UPDATE runs SET tokens_spent = 1000, max_tokens = 1000 WHERE id = 'run-1'").run();
    claimStep("wf_reviewer", "run-1");
    prepareBlockedRunResume("run-1", { maxTokens: 5000 });
    const run = getDb().prepare("SELECT status, max_tokens FROM runs WHERE id = 'run-1'").get() as { status: string; max_tokens: number };
    assert.deepEqual({ ...run }, { status: "running", max_tokens: 5000 });
    assert.equal(claimStep("wf_reviewer", "run-1").found, true);
  });
});
