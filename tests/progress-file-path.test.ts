import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-progress-path-"));
// os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.TAMANDUA_DB_PATH = path.join(tempHome, "tamandua.db");

const { progressFilePath } = await import("../dist/installer/step-ops.js");
const { getDb, closeDb } = await import("../dist/db.js");

const AGENT = "test-wf_developer";
const workspace = path.join(tempHome, "workspaces", AGENT);
fs.mkdirSync(path.join(tempHome, ".tamandua"), { recursive: true });
fs.writeFileSync(path.join(tempHome, ".tamandua", "agents.json"), JSON.stringify([{ id: AGENT, workspace }]));

function seedLoopRun(): string {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'loop', 'running', '{}', ?, ?)",
  ).run(runId, now, now);
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
      status, retry_count, max_retries, type, loop_config, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 0, 'test', 'STATUS: done', 'pending', 0, 2, 'loop', '{"over":"stories"}', ?, ?)`,
  ).run(crypto.randomUUID(), runId, AGENT, now, now);
  return runId;
}

describe("progress file location", () => {
  after(() => {
    closeDb();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("is an absolute path in the loop agent's workspace", () => {
    const runId = seedLoopRun();
    const file = progressFilePath(runId);
    assert.equal(file, path.join(workspace, `progress-${runId}.txt`));
    assert.ok(path.isAbsolute(file!));
  });

  it("is unknown for a run without a loop step", () => {
    assert.equal(progressFilePath(crypto.randomUUID()), null);
  });

  it("is handed to superpowers-feature agents by absolute path, never relative to the worktree", () => {
    // A relative progress file lands in the run's git worktree: it dirties the tree the
    // ci-local gate certifies, and the engine never reads the agent's rewrites back.
    const workflow = fs.readFileSync(path.join(ROOT, "workflows", "superpowers-feature", "workflow.yml"), "utf8");
    assert.doesNotMatch(workflow, /progress-\{\{run_id\}\}\.txt/);
    assert.match(workflow, /\{\{progress_file\}\}/);
  });
});
