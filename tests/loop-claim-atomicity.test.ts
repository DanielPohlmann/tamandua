import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const savedStateDir = process.env.TAMANDUA_STATE_DIR;
const savedDbPath = process.env.TAMANDUA_DB_PATH;
const isolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-loop-claim-"));
process.env.TAMANDUA_STATE_DIR = isolationDir;
process.env.TAMANDUA_DB_PATH = path.join(isolationDir, "tamandua.db");

const { claimStep } = await import("../dist/installer/step-ops.js");
const { getDb, closeDb } = await import("../dist/db.js");

const LOOP_AGENT = "test_loop-claim-agent";

function seedLoopRun(): { runId: string; stepId: string; storyId: string } {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const storyId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'loop', 'running', '{}', ?, ?)",
  ).run(runId, now, now);
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
      status, retry_count, max_retries, type, loop_config, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 0, 'test', 'STATUS: done', 'pending', 0, 2, 'loop', '{"over":"stories"}', ?, ?)`,
  ).run(stepId, runId, LOOP_AGENT, now, now);
  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
     VALUES (?, ?, 0, 'US-001', 'Story', 'A story', '["Works"]', 'pending', 0, 4, ?, ?)`,
  ).run(storyId, runId, now, now);
  return { runId, stepId, storyId };
}

describe("loop step claim", () => {
  after(() => {
    closeDb();
    if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = savedStateDir;
    if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = savedDbPath;
    fs.rmSync(isolationDir, { recursive: true, force: true });
  });

  it("leaves the loop step pending when claiming its story fails", () => {
    const { runId, stepId, storyId } = seedLoopRun();
    const db = getDb();
    // Stands in for a concurrent writer making the story update fail with SQLITE_BUSY.
    db.exec(`CREATE TRIGGER fail_story_claim BEFORE UPDATE OF status ON stories
             WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
    try {
      assert.throws(() => claimStep(LOOP_AGENT, runId), /database is locked/);
    } finally {
      db.exec("DROP TRIGGER fail_story_claim");
    }

    const step = db.prepare("SELECT status, current_story_id FROM steps WHERE id = ?").get(stepId) as
      { status: string; current_story_id: string | null };
    const story = db.prepare("SELECT status FROM stories WHERE id = ?").get(storyId) as { status: string };
    assert.equal(step.status, "pending", "a half-claimed loop step would look like it is waiting for verify");
    assert.equal(step.current_story_id, null);
    assert.equal(story.status, "pending");
  });

  it("claims the step and its story together once the story can be claimed", () => {
    const { runId, stepId, storyId } = seedLoopRun();
    const result = claimStep(LOOP_AGENT, runId);
    assert.ok(result.found);
    const step = getDb().prepare("SELECT status, current_story_id FROM steps WHERE id = ?").get(stepId) as
      { status: string; current_story_id: string | null };
    assert.equal(step.status, "running");
    assert.equal(step.current_story_id, storyId);
  });

  it("waits for a concurrent writer instead of failing immediately", () => {
    const busyTimeout = getDb().prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.ok(busyTimeout.timeout >= 5000, `busy_timeout is ${busyTimeout.timeout} ms`);
  });
});
