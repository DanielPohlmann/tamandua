import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb } from "../../dist/db.js";
import {
  buildBashEnv,
  runBashCommand,
  schedulableAgents,
  executeBashRound,
} from "../../dist/installer/bash-step.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

describe("buildBashEnv", () => {
  it("uppercases context keys and drops keys that are not valid env names", () => {
    const env = buildBashEnv({ base_branch: "develop", feature_complete: "false", run_id: "r", "bad-key": "x" });
    assert.deepEqual(env, { BASE_BRANCH: "develop", FEATURE_COMPLETE: "false", RUN_ID: "r" });
  });
});

describe("runBashCommand", () => {
  it("captures combined output and the exit code", async () => {
    const result = await runBashCommand(
      `node -e "console.log('out:' + process.env.BASE_BRANCH); console.error('err'); process.exit(3)"`,
      { cwd: process.cwd(), env: { BASE_BRANCH: "develop" }, timeoutSeconds: 30 },
    );
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /out:develop/);
    assert.match(result.output, /err/);
    assert.equal(result.timedOut, false);
  });

  it("kills a command that exceeds its timeout", async () => {
    const result = await runBashCommand(`node -e "setTimeout(() => {}, 60000)"`, { cwd: process.cwd(), env: {}, timeoutSeconds: 1 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  });
});

describe("schedulableAgents", () => {
  it("adds the bash runner only when the workflow has bash steps", () => {
    const base = { id: "wf", agents: [{ id: "dev", workspace: { baseDir: "x" } }] };
    assert.equal(schedulableAgents({ ...base, steps: [{ id: "s", agent: "dev", input: "", expects: "" }] } as never).length, 1);
    const withBash = schedulableAgents({ ...base, steps: [{ id: "g", agent: "bash-runner", type: "bash", run: "true", input: "", expects: "" }] } as never);
    assert.deepEqual(withBash.map((a) => a.id), ["dev", "bash-runner"]);
  });
});

describe("executeBashRound", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-bash-round-");
    fs.writeFileSync(path.join(home.dir, "gate.mjs"), "console.log('branch=' + process.env.BASE_BRANCH); process.exit(0);\n");
    seedRun(getDb(), { id: "run-1", context: { base_branch: "develop" } }, [
      { id: "s-unit", stepId: "gate-unit", index: 0, status: "pending", type: "bash", agentId: "wf_bash-runner", runCommand: "node gate.mjs" },
      { id: "s-next", stepId: "next", index: 1, status: "waiting" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("claims the pending bash step, runs it in the worktree and completes it", async () => {
    const outcome = await executeBashRound(
      { id: "job-1", runId: "run-1", agentId: "wf_bash-runner", workingDirectoryForHarness: home.dir },
      30,
    );
    assert.equal(outcome, "completed");
    const row = getDb().prepare("SELECT status, output FROM steps WHERE id = 's-unit'").get() as { status: string; output: string };
    assert.equal(row.status, "done");
    assert.match(row.output, /branch=develop/);
    assert.equal((getDb().prepare("SELECT status FROM steps WHERE id = 's-next'").get() as { status: string }).status, "pending");
  });

  it("reports no_work when nothing is pending", async () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE id = 's-unit'").run();
    const outcome = await executeBashRound({ id: "job-1", runId: "run-1", agentId: "wf_bash-runner", workingDirectoryForHarness: home.dir }, 30);
    assert.equal(outcome, "no_work");
  });
});
