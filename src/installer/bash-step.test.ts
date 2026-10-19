import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, closeDb } from "../../dist/db.js";
import {
  buildBashEnv,
  runBashCommand,
  schedulableAgents,
  executeBashRound,
  recoverStaleBashSteps,
  bashRunnerAgent,
  BASH_RUNNER_TIMEOUT_SECONDS,
} from "../../dist/installer/bash-step.js";
import { executePollingRound } from "../../dist/installer/agent-scheduler.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

describe("buildBashEnv", () => {
  it("uppercases context keys and drops keys that are not valid env names", () => {
    const env = buildBashEnv({ base_branch: "develop", feature_complete: "false", run_id: "r", "bad-key": "x" });
    assert.deepEqual(env, { BASE_BRANCH: "develop", FEATURE_COMPLETE: "false", RUN_ID: "r" });
  });
});

describe("buildBashEnv allowlist", () => {
  it("exports workflow-declared and engine keys, uppercased", () => {
    const env = buildBashEnv({
      __env_keys: JSON.stringify(["dotnet_configuration"]),
      dotnet_configuration: "Release",
      run_id: "r", repo: "/repo", branch: "feat/x", base_branch: "develop", feature_complete: "true", task: "t",
    });
    assert.deepEqual(env, {
      DOTNET_CONFIGURATION: "Release",
      RUN_ID: "r", REPO: "/repo", BRANCH: "feat/x", BASE_BRANCH: "develop", FEATURE_COMPLETE: "true", TASK: "t",
    });
  });

  it("does not export keys an agent added to the run context", () => {
    const env = buildBashEnv({
      __env_keys: JSON.stringify(["base_branch"]),
      node_options: "--require /tmp/evil.js",
      git_dir: "/elsewhere",
      bash_env: "/tmp/evil.sh",
      ld_preload: "/tmp/evil.so",
      npm_config_registry: "http://evil",
      base_branch: "develop",
    });
    assert.deepEqual(env, { BASE_BRANCH: "develop" });
  });

  it("never exports the allowlist itself", () => {
    const env = buildBashEnv({ __env_keys: JSON.stringify(["__env_keys"]) });
    assert.deepEqual(env, {});
  });
});

describe("buildBashEnv exclusions", () => {
  it("drops output, findings and feedback keys and oversized values", () => {
    const context = {
      gate_unit_output: "x",
      findings_open: "y",
      fix_feedback: "z",
      fix_feedback_extra: "z",
      minor_findings: "m",
      big: "a".repeat(4097),
      ok: "a".repeat(4096),
    };
    const env = buildBashEnv({ ...context, __env_keys: JSON.stringify(Object.keys(context)) });
    assert.deepEqual(env, { OK: "a".repeat(4096) });
  });

  it("never overrides protected names, case-insensitively", () => {
    const context = { path: "x", Path: "x", comspec: "x", home: "x", Temp: "x", shell: "x", repo: "r" };
    const env = buildBashEnv({ ...context, __env_keys: JSON.stringify(Object.keys(context)) });
    assert.deepEqual(env, { REPO: "r" });
  });
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("runBashCommand", () => {
  let fixtures: string;
  beforeEach(() => { fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-bash-fx-")); });
  afterEach(() => { fs.rmSync(fixtures, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

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

  it("kills the whole process tree on timeout so a grandchild cannot hold the step", async () => {
    const grandchild = path.join(fixtures, "grandchild.cjs");
    const parent = path.join(fixtures, "parent.mjs");
    const pidFile = path.join(fixtures, "grandchild.pid");
    fs.writeFileSync(grandchild, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);");
    fs.writeFileSync(
      parent,
      `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(grandchild)}, ${JSON.stringify(pidFile)}], { stdio: "inherit" });
setTimeout(() => {}, 60000);
`,
    );
    const started = Date.now();
    const result = await runBashCommand(`node "${parent}"`, { cwd: process.cwd(), env: {}, timeoutSeconds: 2 });
    const elapsedMs = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.match(result.output, /timed out/);
    assert.ok(elapsedMs < 12_000, `took ${elapsedMs}ms`);
    const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isAlive(grandchildPid)) await new Promise((r) => setTimeout(r, 100));
    assert.equal(isAlive(grandchildPid), false);
  });

  it("keeps the tail of the output when it exceeds the cap", async () => {
    const script = path.join(fixtures, "lines.mjs");
    fs.writeFileSync(script, "for (let i = 1; i <= 2000; i++) console.log('line-' + i);\n");
    const result = await runBashCommand(`node "${script}"`, { cwd: fixtures, env: {}, timeoutSeconds: 30, maxOutputChars: 200 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.length, 200);
    assert.match(result.output, /line-2000/);
    assert.doesNotMatch(result.output, /line-1(?![0-9])/);
  });

  it("preserves multibyte characters split across chunks", async () => {
    const script = path.join(fixtures, "utf8.mjs");
    fs.writeFileSync(
      script,
      "const b = Buffer.from('ééé'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50);\n",
    );
    const result = await runBashCommand(`node "${script}"`, { cwd: fixtures, env: {}, timeoutSeconds: 30 });
    assert.equal(result.output, "ééé");
  });

  it("reports a failure when the working directory does not exist", async () => {
    const result = await runBashCommand("node -e 0", { cwd: path.join(fixtures, "missing"), env: {}, timeoutSeconds: 10 });
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

  it("fails the step when the engine throws after the claim", async () => {
    const outcome = await executeBashRound(
      { id: "job-1", runId: "run-1", agentId: "wf_bash-runner", workingDirectoryForHarness: home.dir },
      30,
      { run: async () => { throw new Error("boom"); } },
    );
    assert.equal(outcome, "completed");
    const row = getDb().prepare("SELECT status, output FROM steps WHERE id = 's-unit'").get() as { status: string; output: string };
    assert.notEqual(row.status, "running");
    assert.notEqual(row.status, "done");
    assert.match(row.output, /engine error: boom/);
  });

  it("fails the step when it has no run command", async () => {
    getDb().prepare("UPDATE steps SET run_command = NULL WHERE id = 's-unit'").run();
    await executeBashRound({ id: "job-1", runId: "run-1", agentId: "wf_bash-runner", workingDirectoryForHarness: home.dir }, 30);
    const row = getDb().prepare("SELECT status, output FROM steps WHERE id = 's-unit'").get() as { status: string; output: string };
    assert.notEqual(row.status, "done");
    assert.match(row.output, /no run command/);
  });

  it("fails the step when the command cannot start in the given directory", async () => {
    await executeBashRound(
      { id: "job-1", runId: "run-1", agentId: "wf_bash-runner", workingDirectoryForHarness: path.join(home.dir, "missing") },
      30,
    );
    const row = getDb().prepare("SELECT status FROM steps WHERE id = 's-unit'").get() as { status: string };
    assert.notEqual(row.status, "done");
    assert.notEqual(row.status, "running");
  });

  it("reports no_work when nothing is pending", async () => {
    getDb().prepare("UPDATE steps SET status = 'done' WHERE id = 's-unit'").run();
    const outcome = await executeBashRound({ id: "job-1", runId: "run-1", agentId: "wf_bash-runner", workingDirectoryForHarness: home.dir }, 30);
    assert.equal(outcome, "no_work");
  });
});

describe("executeBashRound on a gated step", () => {
  let home: TempTamanduaHome;
  const JOB = () => ({ id: "job-1", runId: "run-1", agentId: "wf_bash-runner", workingDirectoryForHarness: home.dir });
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-bash-gated-");
    seedRun(getDb(), { id: "run-1", maxFixRounds: 8, context: { fix_feedback: "", fix_origin: "" } }, [
      { id: "s-unit", stepId: "gate-unit", index: 0, status: "pending", type: "bash", agentId: "wf_bash-runner",
        runCommand: "node gate.mjs", onFail: { fix_step: "fix", max_rounds: 3 } },
      { id: "s-fix", stepId: "fix", index: 1, status: "waiting", agentId: "wf_developer" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  function blockedState() {
    const run = getDb().prepare("SELECT status, context, fix_rounds FROM runs WHERE id = 'run-1'").get() as
      { status: string; context: string; fix_rounds: number };
    const fix = getDb().prepare("SELECT status FROM steps WHERE id = 's-fix'").get() as { status: string };
    return { run: run.status, reason: JSON.parse(run.context).blocked_reason as string | undefined, fixRounds: run.fix_rounds, fix: fix.status };
  }

  it("blocks the run instead of starting a fix round when the engine throws", async () => {
    await executeBashRound(JOB(), 30, { run: async () => { throw new Error("boom"); } });
    const state = blockedState();
    assert.equal(state.run, "blocked");
    assert.match(state.reason ?? "", /^engine error: boom/);
    assert.equal(state.fix, "waiting");
    assert.equal(state.fixRounds, 0);
  });

  it("blocks the run when the command cannot be spawned", async () => {
    await executeBashRound(JOB(), 30, {
      run: async () => ({ exitCode: 127, output: "spawn failed", timedOut: false, spawnError: "spawn ENOENT" }),
    });
    const state = blockedState();
    assert.equal(state.run, "blocked");
    assert.match(state.reason ?? "", /^engine error: spawn ENOENT/);
    assert.equal(state.fix, "waiting");
  });

  it("blocks the run when the working directory does not exist", async () => {
    await executeBashRound({ ...JOB(), workingDirectoryForHarness: path.join(home.dir, "missing") }, 30);
    const state = blockedState();
    assert.equal(state.run, "blocked");
    assert.match(state.reason ?? "", /^engine error: .*missing/);
    assert.equal(state.fix, "waiting");
  });

  it("blocks the run when the step has no run command", async () => {
    getDb().prepare("UPDATE steps SET run_command = NULL WHERE id = 's-unit'").run();
    await executeBashRound(JOB(), 30);
    const state = blockedState();
    assert.equal(state.run, "blocked");
    assert.match(state.reason ?? "", /^engine error: .*no run command/);
  });

  it("blocks the run when the command times out", async () => {
    await executeBashRound(JOB(), 30, {
      run: async () => ({ exitCode: 124, output: "slow\nCommand timed out after 30s", timedOut: true }),
    });
    const state = blockedState();
    assert.equal(state.run, "blocked");
    assert.equal(state.reason, "timed out after 30s");
    assert.equal(state.fix, "waiting");
  });

  it("still starts a fix round for an ordinary non-zero exit", async () => {
    await executeBashRound(JOB(), 30, {
      run: async () => ({ exitCode: 1, output: "error CS1002: ; expected", timedOut: false }),
    });
    const state = blockedState();
    assert.equal(state.run, "running");
    assert.equal(state.fix, "pending");
    assert.equal(state.fixRounds, 1);
  });
});

describe("bash step recovery after a daemon crash", () => {
  let home: TempTamanduaHome;
  const JOB = () => ({ id: "job-1", runId: "run-1", agentId: "wf_bash-runner", workingDirectoryForHarness: home.dir });
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-bash-recovery-");
    fs.writeFileSync(path.join(home.dir, "gate.mjs"), "console.log('ok'); process.exit(0);\n");
    seedRun(getDb(), { id: "run-1" }, [
      { id: "s-unit", stepId: "gate-unit", index: 0, status: "running", type: "bash", agentId: "wf_bash-runner", runCommand: "node gate.mjs" },
      { id: "s-next", stepId: "next", index: 1, status: "waiting" },
    ]);
  });
  afterEach(() => { closeDb(); home.restore(); });

  function ageStep(seconds: number): void {
    getDb().prepare(`UPDATE steps SET updated_at = datetime('now', '-${seconds} seconds') WHERE id = 's-unit'`).run();
  }

  function unitStep() {
    return getDb().prepare("SELECT status, retry_count, claim_pgid FROM steps WHERE id = 's-unit'").get() as
      { status: string; retry_count: number; claim_pgid: number | null };
  }

  it("resets a bash step left running past the timeout to pending", () => {
    ageStep(BASH_RUNNER_TIMEOUT_SECONDS + 600);
    const result = recoverStaleBashSteps(JOB(), BASH_RUNNER_TIMEOUT_SECONDS);
    assert.equal(result.recovered, 1);
    assert.equal(unitStep().status, "pending");
    assert.equal(unitStep().retry_count, 1);
  });

  it("leaves a bash step that is still within its timeout alone", () => {
    ageStep(60);
    const result = recoverStaleBashSteps(JOB(), BASH_RUNNER_TIMEOUT_SECONDS);
    assert.equal(result.recovered, 0);
    assert.equal(unitStep().status, "running");
  });

  it("the bash branch of the polling round recovers the stale step and runs it again", async () => {
    ageStep(BASH_RUNNER_TIMEOUT_SECONDS + 600);
    const job = { ...JOB(), workflowId: "wf", intervalMinutes: 1, createdAt: new Date().toISOString() };
    await executePollingRound(job as never, bashRunnerAgent());
    assert.equal(unitStep().status, "done");
    assert.equal(unitStep().retry_count, 1);
    assert.equal((getDb().prepare("SELECT status FROM steps WHERE id = 's-next'").get() as { status: string }).status, "pending");
  });

  it("records the spawned process group on the claimed step", async () => {
    getDb().prepare("UPDATE steps SET status = 'pending' WHERE id = 's-unit'").run();
    await executeBashRound(JOB(), 30, {
      run: async (_command, options) => {
        options.onSpawn?.({ pid: 4242, pgid: 4242 });
        return { exitCode: 0, output: "ok", timedOut: false };
      },
    });
    assert.equal(unitStep().claim_pgid, 4242);
  });
});
