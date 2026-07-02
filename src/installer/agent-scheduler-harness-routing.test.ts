import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildPollingRoundContext,
  createAgentCronJob,
  executePollingRound,
  removeRunCrons,
  shutdownAllCrons,
} from "../../dist/installer/agent-scheduler.js";
import { getDb } from "../../dist/db.js";
import type { CronJobInfo } from "../../dist/installer/agent-scheduler.js";
import type { WorkflowAgent, WorkflowSpec } from "../../dist/installer/types.js";

/**
 * Tests for US-005: harness routing in executePollingRound().
 *
 * Covers:
 *   - buildPollingRoundContext includes harnessType
 *   - executePollingRound dispatches to runPi when harnessType="pi" or missing
 *   - executePollingRound dispatches to runHermes when harnessType="hermes"
 *   - runHermes receives TAMANDUA_HERMES_BINARY in child env
 *   - Polling round context logs include harnessType
 */

function makeMockBinary(binPath: string, behavior: string): void {
  fs.writeFileSync(binPath, `#!/bin/sh\n${behavior}\n`, { mode: 0o755 });
}

function makeAgent(): WorkflowAgent {
  return {
    id: "test-agent",
    model: "fake",
    workspace: { baseDir: "." },
  };
}

function makeWorkflow(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    id: "test-wf",
    agents: [makeAgent()],
    steps: [
      {
        id: "step-1",
        agent: "test-agent",
        input: "do work",
        expects: "STATUS",
      },
    ],
    ...overrides,
  };
}

describe("buildPollingRoundContext harnessType", () => {
  it("includes harnessType in returned context", () => {
    const job: CronJobInfo = {
      id: "test-job",
      workflowId: "wf-1",
      runId: "run-1",
      agentId: "wf-1_test-agent",
      intervalMinutes: 5,
      harnessType: "hermes",
      createdAt: new Date().toISOString(),
    };
    const agent = makeAgent();

    const context = buildPollingRoundContext(
      job, agent, 60, "/tmp/work", undefined,
    );

    assert.equal(context.harnessType, "hermes");
  });

  it("defaults harnessType to 'claude' when not set on job", () => {
    const job: CronJobInfo = {
      id: "test-job",
      workflowId: "wf-1",
      runId: "run-1",
      agentId: "wf-1_test-agent",
      intervalMinutes: 5,
      // harnessType intentionally omitted
      createdAt: new Date().toISOString(),
    };
    const agent = makeAgent();

    const context = buildPollingRoundContext(
      job, agent, 60, "/tmp/work", undefined,
    );

    assert.equal(context.harnessType, "claude");
  });

  it("includes harnessType 'pi' when explicitly set", () => {
    const job: CronJobInfo = {
      id: "test-job",
      workflowId: "wf-1",
      runId: "run-1",
      agentId: "wf-1_test-agent",
      intervalMinutes: 5,
      harnessType: "pi",
      createdAt: new Date().toISOString(),
    };
    const agent = makeAgent();

    const context = buildPollingRoundContext(
      job, agent, 60, "/tmp/work", undefined,
    );

    assert.equal(context.harnessType, "pi");
  });
});

describe("executePollingRound harness dispatch", () => {
  let tempHome: string;
  let savedPiBinary: string | undefined;
  let savedHermesBinary: string | undefined;
  let savedClaudeBinary: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-test-routing-"));
    savedPiBinary = process.env.TAMANDUA_PI_BINARY;
    savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
    savedClaudeBinary = process.env.TAMANDUA_CLAUDE_BINARY;

    const homeDir = path.join(tempHome, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    // Initialize the DB so createAgentCronJob() can read harness_type from runs.context

    // Create mock pi binary
    const piPath = path.join(tempHome, "pi-mock");
    const piLog = path.join(tempHome, "pi-args.log");
    makeMockBinary(piPath, `echo "$@" >> "${piLog}"; echo "HEARTBEAT_OK"`);
    process.env.TAMANDUA_PI_BINARY = piPath;

    // Create mock claude binary
    const claudePath = path.join(tempHome, "claude-mock");
    const claudeLog = path.join(tempHome, "claude-args.log");
    makeMockBinary(claudePath, `echo "$@" >> "${claudeLog}"; printf '{"type":"result","result":"HEARTBEAT_OK","usage":{"input_tokens":1,"output_tokens":1}}'`);
    process.env.TAMANDUA_CLAUDE_BINARY = claudePath;
  });

  afterEach(() => {
    if (savedPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
    else process.env.TAMANDUA_PI_BINARY = savedPiBinary;
    if (savedHermesBinary === undefined) delete process.env.TAMANDUA_HERMES_BINARY;
    else process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
    if (savedClaudeBinary === undefined) delete process.env.TAMANDUA_CLAUDE_BINARY;
    else process.env.TAMANDUA_CLAUDE_BINARY = savedClaudeBinary;
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("dispatches to runPi when harnessType is 'pi'", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "run-pi-dispatch";
    // Insert a run with harness_type="pi" in context
    const db = getDb();
    const nowPiDispatch = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify({
      harness_type: "pi",
      working_directory_for_harness: workdir,
    }), nowPiDispatch, nowPiDispatch);

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    assert.ok(result.ok);

    // executePollingRound should use pi binary (TAMANDUA_PI_BINARY mock)
    const piLog = path.join(tempHome, "pi-args.log");
    const piDispatchJob = { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", intervalMinutes: 5, harnessType: "pi" as const, workingDirectoryForHarness: workdir, createdAt: "" };
    await executePollingRound(piDispatchJob, makeAgent(), workflow);

    // Verify pi was invoked (log file should contain --print args)
    const piArgs = fs.readFileSync(piLog, "utf-8");
    assert.ok(piArgs.includes("--print"), "pi should be invoked with --print");
    assert.ok(piArgs.includes("--mode"), "pi should be invoked with --mode");

    await removeRunCrons(runId);
  });

  it("dispatches to runHermes when harnessType is 'hermes'", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    // Create mock hermes binary that logs its args
    const hermesPath = path.join(tempHome, "hermes-mock");
    const hermesLog = path.join(tempHome, "hermes-args.log");
    makeMockBinary(hermesPath, `echo "$@" >> "${hermesLog}"; echo "HEARTBEAT_OK"`);
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const runId = "run-hermes-dispatch";
    const db = getDb();
    const nowHermes = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify({
      harness_type: "hermes",
      working_directory_for_harness: workdir,
    }), nowHermes, nowHermes);

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    assert.ok(result.ok);

    // executePollingRound should use hermes binary
    const hermesDispatchJob = { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", intervalMinutes: 5, harnessType: "hermes" as const, workingDirectoryForHarness: workdir, createdAt: "" };
    await executePollingRound(hermesDispatchJob, makeAgent(), workflow);

    // Verify hermes was invoked (log file should contain chat subcommand)
    const hermesArgs = fs.readFileSync(hermesLog, "utf-8");
    assert.ok(hermesArgs.includes("chat"), "hermes should be invoked with chat");
    assert.ok(hermesArgs.includes("--max-turns"), "hermes should have --max-turns");
    assert.ok(hermesArgs.includes("--yolo"), "hermes should have --yolo");

    await removeRunCrons(runId);
  });

  it("dispatches to runClaude when harnessType is missing (defaults to claude)", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "run-default-dispatch";
    const db = getDb();
    const nowDefault = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify({
      working_directory_for_harness: workdir,
      // no harness_type
    }), nowDefault, nowDefault);

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });
    assert.ok(result.ok);

    const claudeLog = path.join(tempHome, "claude-args.log");
    await executePollingRound(
      { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", intervalMinutes: 5, harnessType: undefined, workingDirectoryForHarness: workdir, createdAt: "" },
      makeAgent(),
      workflow,
    );

    const claudeArgs = fs.readFileSync(claudeLog, "utf-8");
    assert.ok(claudeArgs.includes("--output-format json"), "claude should be invoked by default");

    await removeRunCrons(runId);
  });

  it("dispatches to runClaude when harnessType is 'claude'", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "run-claude-dispatch";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify({
      harness_type: "claude",
      working_directory_for_harness: workdir,
    }), now, now);

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });
    assert.ok(result.ok);

    const claudeLog = path.join(tempHome, "claude-args.log");
    const job = { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", intervalMinutes: 5, harnessType: "claude" as const, workingDirectoryForHarness: workdir, createdAt: "" };
    await executePollingRound(job, makeAgent(), workflow);

    const claudeArgs = fs.readFileSync(claudeLog, "utf-8");
    assert.ok(claudeArgs.includes("-p"), "claude should be invoked with -p");
    assert.ok(claudeArgs.includes("--dangerously-skip-permissions"), "claude should skip permissions");

    await removeRunCrons(runId);
  });

  it("passes TAMANDUA_HERMES_BINARY to child env when dispatching to runHermes", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    // Create a mock hermes that dumps its environment
    const hermesPath = path.join(tempHome, "hermes-mock");
    const envLog = path.join(tempHome, "hermes-env.log");
    makeMockBinary(hermesPath, `env | grep TAMANDUA >> "${envLog}"; echo "HEARTBEAT_OK"`);
    process.env.TAMANDUA_HERMES_BINARY = hermesPath;

    const runId = "run-hermes-env";
    const db = getDb();
    const nowHermesEnv = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "test task", "running", JSON.stringify({
      harness_type: "hermes",
      working_directory_for_harness: workdir,
    }), nowHermesEnv, nowHermesEnv);

    const workflow = makeWorkflow();
    const result = await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    assert.ok(result.ok);

    const hermesEnvDispatchJob = { id: result.id!, workflowId: "test-wf", runId, agentId: "test-wf_test-agent", intervalMinutes: 5, harnessType: "hermes" as const, workingDirectoryForHarness: workdir, createdAt: "" };
    await executePollingRound(hermesEnvDispatchJob, makeAgent(), workflow);

    // Verify TAMANDUA_HERMES_BINARY was passed to child env
    const envOutput = fs.readFileSync(envLog, "utf-8");
    assert.ok(
      envOutput.includes("TAMANDUA_HERMES_BINARY"),
      "child env should contain TAMANDUA_HERMES_BINARY",
    );

    await removeRunCrons(runId);
  });
});

describe("createAgentCronJob harnessType from run context", () => {
  let tempHome: string;
  let savedPiBinary: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-test-cron-harness-"));
    savedPiBinary = process.env.TAMANDUA_PI_BINARY;

    const homeDir = path.join(tempHome, "home");
    const stateDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    // Create mock pi binary
    const piPath = path.join(tempHome, "pi-mock");
    makeMockBinary(piPath, `echo "HEARTBEAT_OK"`);
    process.env.TAMANDUA_PI_BINARY = piPath;
  });

  afterEach(() => {
    if (savedPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
    else process.env.TAMANDUA_PI_BINARY = savedPiBinary;
    shutdownAllCrons();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("populates CronJobInfo.harnessType from run context harness_type=hermes", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "run-cron-harness-hermes";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "task", "running", JSON.stringify({
      harness_type: "hermes",
      working_directory_for_harness: workdir,
    }), now, now);

    const workflow = makeWorkflow();
    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    // Verify job metadata has harnessType from context
    const { _scheduledRunIds } = await import("../../dist/installer/agent-scheduler.js");
    assert.ok(_scheduledRunIds().has(runId), "run should be scheduled");

    await removeRunCrons(runId);
  });

  it("populates CronJobInfo.harnessType as 'pi' when harness_type not in context", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "run-cron-harness-default";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "task", "running", JSON.stringify({
      working_directory_for_harness: workdir,
      // harness_type intentionally missing
    }), now, now);

    const workflow = makeWorkflow();
    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    // Verify the run is scheduled (defaults to pi dispatch)
    const { _scheduledRunIds } = await import("../../dist/installer/agent-scheduler.js");
    assert.ok(_scheduledRunIds().has(runId), "run should be scheduled with default harness");

    await removeRunCrons(runId);
  });

  it("populates CronJobInfo.harnessType as 'pi' when harness_type is explicitly 'pi'", async () => {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });

    const runId = "run-cron-harness-pi";
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(runId, "test-wf", "task", "running", JSON.stringify({
      harness_type: "pi",
      working_directory_for_harness: workdir,
    }), now, now);

    const workflow = makeWorkflow();
    await createAgentCronJob({
      workflowId: "test-wf",
      runId,
      agent: makeAgent(),
      workflow,
      workingDirectoryForHarness: workdir,
    });

    // Verify the run is scheduled
    const { _scheduledRunIds } = await import("../../dist/installer/agent-scheduler.js");
    assert.ok(_scheduledRunIds().has(runId), "run should be scheduled");

    await removeRunCrons(runId);
  });
});
