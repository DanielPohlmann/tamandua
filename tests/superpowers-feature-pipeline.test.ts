import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useTempTamanduaHome, type TempTamanduaHome } from "./helpers/temp-db.ts";
import { getDb, closeDb } from "../dist/db.js";
import { installWorkflow } from "../dist/installer/install.js";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveWorkflowDir } from "../dist/installer/paths.js";
import { insertRunSteps, buildEngineContextDefaults, resumeBlockedRun } from "../dist/installer/run.js";
import { advancePipeline } from "../dist/installer/step-ops.js";
import { executePollingRound } from "../dist/installer/agent-scheduler.js";
import { schedulableAgents } from "../dist/installer/bash-step.js";
import { listFindings } from "../dist/installer/findings.js";
import { getRunEvents } from "../dist/installer/events.js";
import type { WorkflowSpec } from "../dist/installer/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const WORKFLOW_ID = "superpowers-feature";
const GATES = ["unit", "security-checks", "review-checks", "e2e-checks", "ci-local"];
const READ_ONLY_TOOLS = "--disallowedTools Edit,Write,NotebookEdit";
const PR_URL = "https://github.com/example/repo/pull/1";

const REVIEW_FINDING = JSON.stringify({
  rule: "review/naming", severity: "blocking", file: "src/orders/order-service.ts", symbol: "OrderService", evidence: "unclear name",
});
const MINOR_FINDING = JSON.stringify({
  rule: "review/style", severity: "minor", file: "src/orders/order-service.ts", symbol: "format", evidence: "long method",
});
const PLANNER_REPLY = [
  "STATUS: done",
  "REPO: .",
  "BRANCH: feature/orders",
  "FEATURE_COMPLETE: true",
  "PLAN_SET: docs/superpowers/plans/orders.md",
  "PLAN_SUMMARY: Orders",
  'STORIES_JSON: [{"id":"US-001","title":"Orders","description":"PLAN_FILE: docs/superpowers/plans/orders.md","acceptanceCriteria":["works"]}]',
].join("\n");
type ScriptedReply = string | { reply: string; write?: string; git?: string[] };

/** The setup agent checks out the feature branch, as the real one does; resume validates it. */
const SETUP_REPLY: ScriptedReply = {
  reply: "STATUS: done\nBUILD_CMD: true\nTEST_CMD: true\nFRONTEND_CMD: n/a\nBASELINE: green",
  git: ["checkout", "-q", "-b", "feature/orders"],
};
const IMPLEMENT_REPLY = "STATUS: done\nCHANGES: orders\nTESTS: unit";
const VERIFY_REPLY = "STATUS: done\nVERIFIED: ok";
const CLEAN_GATE_REPLY = "STATUS: done\nFINDINGS_JSON: []\nSUMMARY: 0 findings";
const RESOLVE_FIRST = (changes: string) =>
  `STATUS: done\nCHANGES: ${changes}\nTESTS: unit\nRESOLVED: ["{{FIRST_FINGERPRINT}}"]\nDISPUTED_JSON: []`;

interface Harness {
  runId: string;
  repo: string;
  log: string;
  inputs: string;
  workflow: WorkflowSpec;
}

interface LoggedInvocation {
  argv: string[];
  prompt: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function initRepo(repo: string): void {
  fs.mkdirSync(path.join(repo, "scripts", "gates"), { recursive: true });
  for (const gate of GATES) {
    fs.copyFileSync(path.join(FIXTURES, "fake-gate.mjs"), path.join(repo, "scripts", "gates", `${gate}.mjs`));
  }
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
}

async function startRun(
  home: TempTamanduaHome,
  replies: Record<string, ScriptedReply[]>,
  gateExits: Record<string, number[]>,
): Promise<Harness> {
  const repo = path.join(home.dir, "repo");
  initRepo(repo);

  const bin = path.join(home.dir, "claude.cjs");
  fs.copyFileSync(path.join(FIXTURES, "fake-claude.cjs"), bin);
  const log = path.join(home.dir, "prompts.jsonl");
  fs.writeFileSync(log, "");
  const inputs = path.join(home.dir, "inputs.jsonl");
  fs.writeFileSync(inputs, "");
  fs.writeFileSync(path.join(home.dir, "script.json"), JSON.stringify(replies));
  fs.writeFileSync(path.join(home.dir, "gates.json"), JSON.stringify(gateExits));
  Object.assign(process.env, {
    TAMANDUA_CLAUDE_BINARY: bin,
    FAKE_CLAUDE_SCRIPT: path.join(home.dir, "script.json"),
    FAKE_CLAUDE_STATE: path.join(home.dir, "state.json"),
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_INPUTS: inputs,
    FAKE_TAMANDUA_CLI_JS: path.join(ROOT, "dist", "cli", "cli.js"),
    FAKE_GATES_STATE: path.join(home.dir, "gates.json"),
    // Every fake round spawns the tamandua CLI up to three times; caching compiled modules keeps that bearable.
    NODE_COMPILE_CACHE: path.join(home.dir, "node-compile-cache"),
  });

  await installWorkflow({ workflowId: WORKFLOW_ID });
  const workflow = await loadWorkflowSpec(resolveWorkflowDir(WORKFLOW_ID));
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const context = {
    task: "docs/superpowers/specs/orders-design.md",
    ...buildEngineContextDefaults(workflow),
    repo,
    working_directory_for_harness: repo,
    workspace_mode: "direct",
    harness_type: "claude",
  };
  getDb().prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, max_fix_rounds, created_at, updated_at)
     VALUES (?, 1, ?, ?, 'running', ?, 0, ?, ?, ?)`,
  ).run(runId, WORKFLOW_ID, context.task, JSON.stringify(context), workflow.budgets?.max_fix_rounds ?? 8, now, now);
  insertRunSteps(workflow, runId, now);
  advancePipeline(runId);
  return { runId, repo, log, inputs, workflow };
}

function runStatus(runId: string): string {
  return (getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
}

async function pollOnce(h: Harness, agentShortId: string): Promise<void> {
  const agent = schedulableAgents(h.workflow).find((a) => a.id === agentShortId);
  assert.ok(agent, `agent ${agentShortId} is schedulable`);
  await executePollingRound({
    id: `job-${agent.id}`, workflowId: h.workflow.id, runId: h.runId, agentId: `${h.workflow.id}_${agent.id}`,
    intervalMinutes: 5, sessionLabel: agent.id, timeoutSeconds: 600, workingDirectoryForHarness: h.repo,
    harnessType: "claude", createdAt: new Date().toISOString(),
  }, agent, h.workflow);
}

/** Polls every agent that has claimable work, one round at a time, until the run leaves `running`. */
async function drive(h: Harness, maxRounds = 80): Promise<string> {
  for (let round = 0; round < maxRounds; round++) {
    const pending = new Set((getDb().prepare("SELECT agent_id FROM steps WHERE run_id = ? AND status = 'pending'")
      .all(h.runId) as Array<{ agent_id: string }>).map((row) => row.agent_id));
    if (pending.size === 0) return runStatus(h.runId);
    for (const agent of schedulableAgents(h.workflow)) {
      if (!pending.has(`${h.workflow.id}_${agent.id}`)) continue;
      await pollOnce(h, agent.id);
      const status = runStatus(h.runId);
      if (status !== "running") return status;
    }
  }
  return runStatus(h.runId);
}

function stepStatus(runId: string, stepId: string): string {
  return (getDb().prepare("SELECT status FROM steps WHERE run_id = ? AND step_id = ?").get(runId, stepId) as { status: string }).status;
}

/** What a failed drive leaves behind: every step's state and the run's event trail. */
function diagnose(runId: string): string {
  const steps = getDb().prepare("SELECT step_id, status, retry_count, fix_rounds, output FROM steps WHERE run_id = ? ORDER BY step_index")
    .all(runId) as Array<{ step_id: string; status: string; retry_count: number; fix_rounds: number; output: string | null }>;
  return [
    ...steps.map((s) => `${s.step_id} ${s.status} retries=${s.retry_count} fix=${s.fix_rounds} ${(s.output ?? "").slice(0, 300)}`),
    ...getRunEvents(runId).map((e) => `${e.event} ${e.stepId ?? ""} ${e.detail ?? ""}`),
  ].join("\n");
}

async function driveTo(h: Harness, expected: string): Promise<void> {
  const status = await drive(h);
  assert.equal(status, expected, `run ended ${status}, expected ${expected}:\n${diagnose(h.runId)}`);
}

function runContext(runId: string): Record<string, string> {
  return JSON.parse((getDb().prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string }).context);
}

function invocations(log: string): LoggedInvocation[] {
  return fs.readFileSync(log, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as LoggedInvocation);
}

function invocationFor(log: string, agentShortId: string): LoggedInvocation {
  const found = invocations(log).find((p) => p.prompt.includes(`step peek "${WORKFLOW_ID}_${agentShortId}"`));
  assert.ok(found, `claude was invoked for ${agentShortId}`);
  return found;
}

function claimedInputs(inputs: string, agentShortId: string): string[] {
  return fs.readFileSync(inputs, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { agent: string; input: string })
    .filter((entry) => entry.agent === agentShortId)
    .map((entry) => entry.input);
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("superpowers-feature pipeline with a fake claude", { timeout: 2_400_000 }, () => {
  let home: TempTamanduaHome;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    home = useTempTamanduaHome("tamandua-pipeline-e2e-");
  });

  afterEach(() => {
    closeDb();
    process.env = savedEnv;
    home.restore();
  });

  it("loops a failing bash gate and a twice-failing review through fix, then opens the PR with read-only verifiers", async () => {
    const h = await startRun(home, {
      planner: [PLANNER_REPLY],
      setup: [SETUP_REPLY],
      developer: [IMPLEMENT_REPLY, RESOLVE_FIRST("fixed scan"), RESOLVE_FIRST("renamed"), RESOLVE_FIRST("renamed again")],
      verifier: [VERIFY_REPLY],
      security: [CLEAN_GATE_REPLY],
      reviewer: [
        `STATUS: retry\nFINDINGS_JSON: [${REVIEW_FINDING}]\nREVIEWED_SHA: aaa\nSUMMARY: 1 finding`,
        `STATUS: retry\nFINDINGS_JSON: [${REVIEW_FINDING}]\nREVIEWED_SHA: bbb\nSUMMARY: 1 finding`,
        `STATUS: done\nFINDINGS_JSON: [${MINOR_FINDING}]\nREVIEWED_SHA: ccc\nSUMMARY: 1 finding`,
      ],
      tester: [CLEAN_GATE_REPLY],
      pr: [`STATUS: done\nPR: ${PR_URL}`],
    }, { "security-checks": [1, 0] });

    await driveTo(h, "completed");

    const context = runContext(h.runId);
    assert.equal(context.pr, PR_URL);
    assert.equal(context.reviewed_sha, "ccc");
    assert.match(context.minor_findings, /review\/style/);
    assert.match(context.gate_security_checks_output, /security-checks exit=0 base=develop complete=true/);

    const findings = listFindings(h.runId);
    const scan = findings.find((f) => f.gate === "gate-security-checks");
    assert.ok(scan, "the failing bash gate recorded an engine finding");
    assert.equal(scan.rule, "gate/gate-security-checks");
    assert.equal(scan.status, "resolved");
    const review = findings.find((f) => f.rule === "review/naming");
    assert.ok(review, "the review finding was recorded");
    assert.equal(review.status, "resolved");
    assert.equal(review.round, 2);
    assert.equal(findings.find((f) => f.rule === "review/style")?.status, "open", "minor findings are never fixed by the loop");

    const rounds = getDb().prepare("SELECT step_id, fix_rounds FROM steps WHERE run_id = ? AND fix_rounds > 0 ORDER BY step_index")
      .all(h.runId) as Array<{ step_id: string; fix_rounds: number }>;
    assert.deepEqual(rounds.map((r) => ({ ...r })), [
      { step_id: "gate-security-checks", fix_rounds: 1 },
      { step_id: "gate-review", fix_rounds: 2 },
    ]);
    const events = getRunEvents(h.runId);
    assert.equal(events.filter((e) => e.event === "run.pr_opened").length, 1);
    assert.equal(events.find((e) => e.event === "run.pr_opened")?.detail, PR_URL);

    for (const readOnly of ["planner", "verifier", "security", "reviewer", "tester"]) {
      assert.ok(invocationFor(h.log, readOnly).argv.join(" ").includes(READ_ONLY_TOOLS), `${readOnly} cannot edit files`);
    }
    for (const writer of ["setup", "developer", "pr"]) {
      assert.ok(!invocationFor(h.log, writer).argv.includes("--disallowedTools"), `${writer} keeps its edit tools`);
    }
    const launcher = path.join(ROOT, "bin", "tamandua");
    for (const { prompt } of invocations(h.log)) {
      assert.ok(prompt.includes("STEP OUTPUT CONTRACT"), "the prompt embeds the step output contract");
      assert.ok(prompt.includes(`"${launcher}" step peek`), "the prompt calls the launcher directly");
      assert.doesNotMatch(prompt, /\bnode\s+"[^"]*tamandua"/, "the launcher is not prefixed with node");
    }
    assert.match(invocationFor(h.log, "reviewer").prompt, /# Review Verifier/, "the persona reaches claude through the prompt");
  });

  it("blocks the run when the review re-raises a disputed finding, and resumes the gate", async () => {
    const h = await startRun(home, {
      planner: [PLANNER_REPLY],
      setup: [SETUP_REPLY],
      developer: [
        IMPLEMENT_REPLY,
        'STATUS: done\nCHANGES: none\nTESTS: none\nRESOLVED: []\nDISPUTED_JSON: [{"fingerprint":"{{FIRST_FINGERPRINT}}","reason":"the name is the domain term"}]',
      ],
      verifier: [VERIFY_REPLY],
      security: [CLEAN_GATE_REPLY],
      reviewer: [
        `STATUS: retry\nFINDINGS_JSON: [${REVIEW_FINDING}]\nREVIEWED_SHA: aaa\nSUMMARY: 1 finding`,
        `STATUS: retry\nFINDINGS_JSON: [${REVIEW_FINDING}]\nREVIEWED_SHA: bbb\nSUMMARY: 1 finding`,
        `STATUS: done\nFINDINGS_JSON: []\nREVIEWED_SHA: ccc\nSUMMARY: 0 findings`,
      ],
      tester: [CLEAN_GATE_REPLY],
      pr: [`STATUS: done\nPR: ${PR_URL}`],
    }, {});

    await driveTo(h, "blocked");
    const context = runContext(h.runId);
    assert.equal(context.blocked_step, "gate-review");
    assert.match(context.blocked_reason, /disputed/);
    const [finding] = listFindings(h.runId, { gate: "gate-review" });
    assert.equal(finding.status, "disputed");
    assert.equal(finding.disputeReason, "the name is the domain term");
    assert.ok(getRunEvents(h.runId).some((e) => e.event === "run.blocked"));

    let registered = "";
    const resumed = await resumeBlockedRun(h.runId, {}, {
      ensureDaemon: async () => {},
      register: async (runId: string) => {
        registered = runId;
        return { status: 200, body: {} };
      },
    });
    assert.deepEqual({ ...resumed }, { status: "resumed", runId: h.runId, workflowId: WORKFLOW_ID, stepId: "gate-review" });
    assert.equal(registered, h.runId);
    assert.equal(runStatus(h.runId), "running");
    const gate = getDb().prepare("SELECT status, fix_rounds FROM steps WHERE run_id = ? AND step_id = 'gate-review'")
      .get(h.runId) as { status: string; fix_rounds: number };
    assert.deepEqual({ ...gate }, { status: "pending", fix_rounds: 0 });
    assert.equal(runContext(h.runId).blocked_step, undefined);
    assert.ok(getRunEvents(h.runId).some((e) => e.event === "run.resumed"));

    await pollOnce(h, "reviewer");
    assert.equal(stepStatus(h.runId, "gate-review"), "done", "the resumed gate runs again and passes");
    assert.equal(stepStatus(h.runId, "gate-e2e-checks"), "pending");
  });

  it("retries implement with the verifier's issues, then blocks a bash gate that keeps failing after max_rounds fix rounds", async () => {
    const h = await startRun(home, {
      planner: [PLANNER_REPLY],
      setup: [SETUP_REPLY],
      developer: [IMPLEMENT_REPLY, IMPLEMENT_REPLY],
      verifier: ["STATUS: retry\nISSUES:\n- missing unit test for OrderService", VERIFY_REPLY],
    }, { unit: [1, 1, 1, 1] });

    await driveTo(h, "blocked");
    const [firstImplement, secondImplement] = claimedInputs(h.inputs, "developer");
    assert.doesNotMatch(firstImplement, /missing unit test for OrderService/);
    assert.match(secondImplement, /missing unit test for OrderService/, "implement receives the verify feedback");
    assert.ok(getRunEvents(h.runId).some((e) => e.event === "story.retry"));
    assert.equal(claimedInputs(h.inputs, "verifier").length, 2);
    const context = runContext(h.runId);
    assert.equal(context.blocked_step, "gate-unit");
    assert.match(context.blocked_reason, /after 3 fix round/);
    assert.match(context.gate_unit_output, /unit exit=1 base=develop complete=true/);
    const gate = getDb().prepare("SELECT fix_rounds FROM steps WHERE run_id = ? AND step_id = 'gate-unit'")
      .get(h.runId) as { fix_rounds: number };
    assert.equal(gate.fix_rounds, 3);
  });

  it("blocks a verifier that writes into the worktree and quarantines what it wrote", async () => {
    const h = await startRun(home, {
      planner: [PLANNER_REPLY],
      setup: [SETUP_REPLY],
      developer: [IMPLEMENT_REPLY],
      verifier: [{ reply: VERIFY_REPLY, write: "notes.txt" }],
    }, {});

    await driveTo(h, "blocked");
    const context = runContext(h.runId);
    assert.equal(context.blocked_step, "verify");
    assert.match(context.blocked_reason, /Read-only violation in verify/);
    const [violation] = listFindings(h.runId, { gate: "verify" });
    assert.equal(violation.rule, "gate/read-only-violation");
    assert.match(violation.evidence, /notes\.txt/);

    assert.ok(!fs.existsSync(path.join(h.repo, "notes.txt")), "the write is reverted in the worktree");
    const quarantined = filesUnder(path.join(h.repo, ".git", "tamandua-quarantine", h.runId))
      .filter((file) => path.basename(file) === "notes.txt");
    assert.equal(quarantined.length, 1, "the written file is moved to the quarantine, not deleted");
    assert.equal(fs.readFileSync(quarantined[0], "utf-8"), "written by a read-only agent\n");
  });
});
