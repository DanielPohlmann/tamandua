import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// We test the migration by directly importing getDb, which calls migrate().
// But since getDb() uses a cached connection and resolves DB path from
// env/home, we test the migration logic directly with an isolated DB.
import { getDb, getDbPath, getSystemTokenSpend, incrementSystemTokenSpend, upsertAutoresearchSession, getAutoresearchSessions, getAutoresearchSessionById, deleteAutoresearchSession, closeDb, deleteDbFiles } from "../dist/db.js";

describe("run_worktrees table migration", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "tamandua-db-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    // Isolate DB to temp directory by changing HOME
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  function columnNames(db: DatabaseSync, table: string): Set<string> {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
  }

  function tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    return row !== undefined;
  }

  it("creates run_worktrees table on first migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees table should exist");
  });

  it("all required columns present with correct types", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(run_worktrees)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colMap = new Map(cols.map((c) => [c.name, c]));

    // Check each required column
    const runIdCol = colMap.get("run_id");
    assert.ok(runIdCol, "run_id column should exist");
    assert.equal(runIdCol.type, "TEXT", "run_id should be TEXT");
    assert.equal(runIdCol.pk, 1, "run_id should be PRIMARY KEY");

    const originRepoCol = colMap.get("worktree_origin_repository");
    assert.ok(originRepoCol, "worktree_origin_repository column should exist");
    assert.equal(originRepoCol.type, "TEXT", "worktree_origin_repository should be TEXT");

    const gitCommonDirCol = colMap.get("worktree_origin_git_common_dir");
    assert.ok(gitCommonDirCol, "worktree_origin_git_common_dir column should exist");
    assert.equal(gitCommonDirCol.type, "TEXT", "worktree_origin_git_common_dir should be TEXT");

    const worktreePathCol = colMap.get("worktree_path");
    assert.ok(worktreePathCol, "worktree_path column should exist");
    assert.equal(worktreePathCol.type, "TEXT", "worktree_path should be TEXT");

    const originRefCol = colMap.get("worktree_origin_ref");
    assert.ok(originRefCol, "worktree_origin_ref column should exist");
    assert.equal(originRefCol.type, "TEXT", "worktree_origin_ref should be TEXT");

    const originShaCol = colMap.get("worktree_origin_sha");
    assert.ok(originShaCol, "worktree_origin_sha column should exist");
    assert.equal(originShaCol.type, "TEXT", "worktree_origin_sha should be TEXT");

    const originalBranchCol = colMap.get("original_branch");
    assert.ok(originalBranchCol, "original_branch column should exist");
    assert.equal(originalBranchCol.type, "TEXT", "original_branch should be TEXT");

    const statusCol = colMap.get("status");
    assert.ok(statusCol, "status column should exist");
    assert.equal(statusCol.type, "TEXT", "status should be TEXT");

    const cleanupPolicyCol = colMap.get("cleanup_policy");
    assert.ok(cleanupPolicyCol, "cleanup_policy column should exist");
    assert.equal(cleanupPolicyCol.type, "TEXT", "cleanup_policy should be TEXT");

    const createdAtCol = colMap.get("created_at");
    assert.ok(createdAtCol, "created_at column should exist");
    assert.equal(createdAtCol.type, "TEXT", "created_at should be TEXT");

    const removedAtCol = colMap.get("removed_at");
    assert.ok(removedAtCol, "removed_at column should exist");
    assert.equal(removedAtCol.type, "TEXT", "removed_at should be TEXT");

    const errorCol = colMap.get("error");
    assert.ok(errorCol, "error column should exist");
    assert.equal(errorCol.type, "TEXT", "error should be TEXT");
  });

  it("has index on status column for list queries", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_worktrees'",
    ).all() as Array<{ name: string }>;

    const hasStatusIndex = indexes.some((idx) => idx.name === "idx_run_worktrees_status");
    assert.ok(hasStatusIndex, "should have idx_run_worktrees_status index");
  });

  it("existing DB tables unaffected by migration", () => {
    const db = getDb();
    // All existing tables should still be present
    assert.ok(tableExists(db, "runs"), "runs table should exist");
    assert.ok(tableExists(db, "steps"), "steps table should exist");
    assert.ok(tableExists(db, "stories"), "stories table should exist");
    assert.ok(tableExists(db, "tamandua_stats"), "tamandua_stats table should exist");

    // Core runs columns should still be present
    const runCols = columnNames(db, "runs");
    assert.ok(runCols.has("id"), "runs.id should exist");
    assert.ok(runCols.has("workflow_id"), "runs.workflow_id should exist");
    assert.ok(runCols.has("status"), "runs.status should exist");
    assert.ok(runCols.has("tokens_spent"), "runs.tokens_spent should exist");
    assert.ok(runCols.has("scheduling_status"), "runs.scheduling_status should exist");

    // Core steps columns should still be present
    const stepCols = columnNames(db, "steps");
    assert.ok(stepCols.has("id"), "steps.id should exist");
    assert.ok(stepCols.has("run_id"), "steps.run_id should exist");
    assert.ok(stepCols.has("agent_id"), "steps.agent_id should exist");
    assert.ok(stepCols.has("status"), "steps.status should exist");
    assert.ok(stepCols.has("claim_job_id"), "steps.claim_job_id should exist");

    // Core stories columns should still be present
    const storyCols = columnNames(db, "stories");
    assert.ok(storyCols.has("id"), "stories.id should exist");
    assert.ok(storyCols.has("run_id"), "stories.run_id should exist");
    assert.ok(storyCols.has("story_id"), "stories.story_id should exist");
    assert.ok(storyCols.has("status"), "stories.status should exist");

    // tamandua_stats should still be present
    const statsCols = columnNames(db, "tamandua_stats");
    assert.ok(statsCols.has("system_tokens_spent"), "tamandua_stats.system_tokens_spent should exist");
  });

  it("migration is idempotent (second call does nothing harmful)", () => {
    // Calling getDb() again will re-run migrate() on the same DB
    const db = getDb();

    // Table should still exist with no error
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees should still exist after second migration");

    // Should have exactly the expected columns (no duplicates)
    const cols = db.prepare("PRAGMA table_info(run_worktrees)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    const expectedCols = [
      "run_id",
      "worktree_origin_repository",
      "worktree_origin_git_common_dir",
      "worktree_path",
      "worktree_origin_ref",
      "worktree_origin_sha",
      "original_branch",
      "status",
      "cleanup_policy",
      "created_at",
      "removed_at",
      "error",
    ];
    assert.deepEqual(colNames.sort(), expectedCols.sort(), "columns should match expected after idempotent migrate");
  });

  it("can insert and query a worktree row", () => {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, worktree_origin_ref, worktree_origin_sha,
         original_branch, status, cleanup_policy, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-run-id-001",
      "/home/user/repo",
      "/home/user/repo/.git",
      "/tmp/worktrees/repo-abc/r1-xyz",
      "refs/heads/main",
      "abc1234",
      "main",
      "ready",
      "remove_on_success",
      now,
    );

    const row = db.prepare("SELECT * FROM run_worktrees WHERE run_id = ?").get("test-run-id-001") as {
      run_id: string;
      worktree_origin_repository: string;
      worktree_origin_git_common_dir: string;
      worktree_path: string;
      worktree_origin_ref: string;
      worktree_origin_sha: string;
      original_branch: string;
      status: string;
      cleanup_policy: string;
      created_at: string;
      removed_at: string | null;
      error: string | null;
    };

    assert.ok(row, "should retrieve inserted row");
    assert.equal(row.run_id, "test-run-id-001");
    assert.equal(row.worktree_origin_repository, "/home/user/repo");
    assert.equal(row.worktree_origin_git_common_dir, "/home/user/repo/.git");
    assert.equal(row.worktree_path, "/tmp/worktrees/repo-abc/r1-xyz");
    assert.equal(row.worktree_origin_ref, "refs/heads/main");
    assert.equal(row.worktree_origin_sha, "abc1234");
    assert.equal(row.original_branch, "main");
    assert.equal(row.status, "ready");
    assert.equal(row.cleanup_policy, "remove_on_success");
    assert.equal(row.created_at, now);
    assert.equal(row.removed_at, null);
    assert.equal(row.error, null);
  });

  it("default status is 'creating' when not specified", () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert without specifying status
    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "test-run-id-002",
      "/home/user/repo2",
      "/home/user/repo2/.git",
      "/tmp/worktrees/repo2/r2-xyz",
      now,
    );

    const row = db.prepare("SELECT status, cleanup_policy FROM run_worktrees WHERE run_id = ?").get(
      "test-run-id-002",
    ) as { status: string; cleanup_policy: string };

    assert.equal(row.status, "creating", "default status should be creating");
    assert.equal(row.cleanup_policy, "remove_on_success", "default cleanup_policy should be remove_on_success");
  });

  it("can update status via index-friendly query", () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert with 'creating' status
    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, worktree_origin_sha, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "test-run-id-003",
      "/home/user/repo3",
      "/home/user/repo3/.git",
      "/tmp/worktrees/repo3/r3-xyz",
      "def5678",
      now,
    );

    // Update status to 'ready'
    db.prepare("UPDATE run_worktrees SET status = 'ready' WHERE run_id = ?").run("test-run-id-003");

    const row = db.prepare(
      "SELECT status FROM run_worktrees WHERE run_id = ?",
    ).get("test-run-id-003") as { status: string };

    assert.equal(row.status, "ready");

    // Verify the status index is used (by checking explain query plan doesn't error)
    const explain = db.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM run_worktrees WHERE status = ?",
    ).all("ready");
    assert.ok(explain.length > 0, "query plan should be valid");
  });
});

describe("getDbPath", () => {
  it("returns path ending with .tamandua/tamandua.db under HOME", () => {
    const result = getDbPath();
    assert.ok(result.endsWith(path.join(".tamandua", "tamandua.db")), `expected path ending with .tamandua/tamandua.db, got ${result}`);
  });

  it("respects TAMANDUA_DB_PATH env var", () => {
    const customPath = "/tmp/custom-tamandua.db";
    process.env.TAMANDUA_DB_PATH = customPath;
    try {
      const result = getDbPath();
      assert.equal(result, customPath);
    } finally {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });
});

describe("getSystemTokenSpend", () => {
  let startingSpend: number;

  before(() => {
    // Reset tamandua_stats to a known baseline
    const db = getDb();
    db.prepare("UPDATE tamandua_stats SET system_tokens_spent = 0 WHERE id = 1").run();
    // Also ensure the row exists (migrate() creates it)
    db.prepare("INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)").run();
    startingSpend = getSystemTokenSpend();
  });

  it("returns 0 after reset", () => {
    assert.equal(startingSpend, 0);
  });

  it("returns updated value after incrementSystemTokenSpend", () => {
    incrementSystemTokenSpend(100);
    const result = getSystemTokenSpend();
    assert.equal(result, 100);
  });

  it("accumulates across multiple increments", () => {
    incrementSystemTokenSpend(50);
    incrementSystemTokenSpend(25);
    const result = getSystemTokenSpend();
    assert.equal(result, 175);
  });
});

// ── AutoResearch sessions ──

function writeSessionConfig(cwd: string, config: Record<string, unknown>): void {
  writeFileSync(path.join(cwd, "autoresearch.config.json"), JSON.stringify(config, null, 2) + "\n");
}

function writeSessionLog(cwd: string, lines: Record<string, unknown>[]): void {
  writeFileSync(path.join(cwd, "autoresearch.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("autoresearch_sessions table migration", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-sessions-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  function tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    return row !== undefined;
  }

  it("creates autoresearch_sessions table on migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "autoresearch_sessions"), "autoresearch_sessions table should exist");
  });

  it("all required columns present with correct types", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(autoresearch_sessions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colMap = new Map(cols.map((c) => [c.name, c]));

    const idCol = colMap.get("id");
    assert.ok(idCol, "id column should exist");
    assert.equal(idCol.type, "TEXT", "id should be TEXT");
    assert.equal(idCol.pk, 1, "id should be PRIMARY KEY");

    const cwdCol = colMap.get("cwd");
    assert.ok(cwdCol, "cwd column should exist");
    assert.equal(cwdCol.type, "TEXT", "cwd should be TEXT");

    const goalCol = colMap.get("goal");
    assert.ok(goalCol, "goal column should exist");
    assert.equal(goalCol.type, "TEXT", "goal should be TEXT");

    const metricNameCol = colMap.get("metric_name");
    assert.ok(metricNameCol, "metric_name column should exist");
    assert.equal(metricNameCol.type, "TEXT", "metric_name should be TEXT");

    const metricUnitCol = colMap.get("metric_unit");
    assert.ok(metricUnitCol, "metric_unit column should exist");
    assert.equal(metricUnitCol.type, "TEXT", "metric_unit should be TEXT");

    const directionCol = colMap.get("direction");
    assert.ok(directionCol, "direction column should exist");
    assert.equal(directionCol.type, "TEXT", "direction should be TEXT");

    const commandCol = colMap.get("command");
    assert.ok(commandCol, "command column should exist");
    assert.equal(commandCol.type, "TEXT", "command should be TEXT");

    const createdAtCol = colMap.get("created_at");
    assert.ok(createdAtCol, "created_at column should exist");
    assert.equal(createdAtCol.type, "TEXT", "created_at should be TEXT");

    const updatedAtCol = colMap.get("updated_at");
    assert.ok(updatedAtCol, "updated_at column should exist");
    assert.equal(updatedAtCol.type, "TEXT", "updated_at should be TEXT");

    const lastSeenAtCol = colMap.get("last_seen_at");
    assert.ok(lastSeenAtCol, "last_seen_at column should exist");
    assert.equal(lastSeenAtCol.type, "TEXT", "last_seen_at should be TEXT");

    const lastRunAtCol = colMap.get("last_run_at");
    assert.ok(lastRunAtCol, "last_run_at column should exist");
    assert.equal(lastRunAtCol.type, "TEXT", "last_run_at should be TEXT");

    const totalRunsCol = colMap.get("total_runs");
    assert.ok(totalRunsCol, "total_runs column should exist");
    assert.equal(totalRunsCol.type, "INTEGER", "total_runs should be INTEGER");

    const baselineMetricCol = colMap.get("baseline_metric");
    assert.ok(baselineMetricCol, "baseline_metric column should exist");
    assert.equal(baselineMetricCol.type, "REAL", "baseline_metric should be REAL");

    const bestMetricCol = colMap.get("best_metric");
    assert.ok(bestMetricCol, "best_metric column should exist");
    assert.equal(bestMetricCol.type, "REAL", "best_metric should be REAL");

    const bestRunCol = colMap.get("best_run");
    assert.ok(bestRunCol, "best_run column should exist");
    assert.equal(bestRunCol.type, "INTEGER", "best_run should be INTEGER");

    const filesMissingCol = colMap.get("files_missing");
    assert.ok(filesMissingCol, "files_missing column should exist");
    assert.equal(filesMissingCol.type, "INTEGER", "files_missing should be INTEGER");
  });

  it("has indexes on cwd (unique), updated_at, and last_seen_at", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='autoresearch_sessions'",
    ).all() as Array<{ name: string; sql: string }>;

    const cwdIndex = indexes.find((idx) => idx.name === "idx_autoresearch_sessions_cwd");
    assert.ok(cwdIndex, "should have idx_autoresearch_sessions_cwd index");
    assert.ok(cwdIndex.sql.includes("UNIQUE"), "cwd index should be UNIQUE");

    const updatedAtIndex = indexes.find((idx) => idx.name === "idx_autoresearch_sessions_updated_at");
    assert.ok(updatedAtIndex, "should have idx_autoresearch_sessions_updated_at index");

    const lastSeenAtIndex = indexes.find((idx) => idx.name === "idx_autoresearch_sessions_last_seen_at");
    assert.ok(lastSeenAtIndex, "should have idx_autoresearch_sessions_last_seen_at index");
  });

  it("migration is idempotent (second call does nothing harmful)", () => {
    const db = getDb();

    assert.ok(tableExists(db, "autoresearch_sessions"), "table should still exist after second migration");

    const cols = db.prepare("PRAGMA table_info(autoresearch_sessions)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    const expectedCols = [
      "baseline_metric", "best_metric", "best_run", "command", "created_at",
      "cwd", "direction", "files_missing", "goal", "id",
      "last_run_at", "last_seen_at", "metric_name", "metric_unit",
      "total_runs", "updated_at",
    ].sort();
    assert.deepEqual(colNames, expectedCols, "columns should match expected after idempotent migrate");
  });

  it("existing DB tables unaffected by autoresearch_sessions migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "runs"), "runs table should exist");
    assert.ok(tableExists(db, "steps"), "steps table should exist");
    assert.ok(tableExists(db, "stories"), "stories table should exist");
    assert.ok(tableExists(db, "tamandua_stats"), "tamandua_stats table should exist");
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees table should exist");
  });
});

describe("upsertAutoresearchSession", () => {
  let tempHome: string;
  let tempSessionDir: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-upsert-test-"));
    tempSessionDir = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-session-"));
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempSessionDir, { recursive: true, force: true });
  });

  it("inserts a new row when cwd has valid autoresearch.config.json", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "optimize something",
      metricName: "latency_ms",
      metricUnit: "ms",
      direction: "lower",
      command: "npm test",
    });
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 100.5 },
      { type: "run", run: 2, status: "keep", metric: 95.3 },
      { type: "run", run: 3, status: "discard", metric: 102.0 },
    ]);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.id, realpathSync(tempSessionDir));
    assert.equal(session!.cwd, realpathSync(tempSessionDir));
    assert.equal(session!.goal, "optimize something");
    assert.equal(session!.metric_name, "latency_ms");
    assert.equal(session!.metric_unit, "ms");
    assert.equal(session!.direction, "lower");
    assert.equal(session!.command, "npm test");
    assert.equal(session!.total_runs, 3);
    assert.equal(session!.baseline_metric, 100.5);
    assert.equal(session!.best_metric, 95.3);
    assert.equal(session!.best_run, 2);
    assert.equal(session!.files_missing, 0);
  });

  it("updates an existing row when cwd already has a registry entry", () => {
    // First upsert
    writeSessionConfig(tempSessionDir, {
      goal: "optimize something",
      metricName: "latency_ms",
      metricUnit: "ms",
      direction: "lower",
      command: "npm test",
    });
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 100.5 },
    ]);

    upsertAutoresearchSession(tempSessionDir);

    // Add more runs and re-upsert
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 100.5 },
      { type: "run", run: 2, status: "keep", metric: 90.0 },
      { type: "run", run: 3, status: "keep", metric: 85.0 },
    ]);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.total_runs, 3);
    assert.equal(session!.baseline_metric, 100.5);
    assert.equal(session!.best_metric, 85.0);
    assert.equal(session!.best_run, 3);
    assert.equal(session!.files_missing, 0);

    // Verify there is exactly one row for this session
    const db = getDb();
    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM autoresearch_sessions WHERE id = ?",
    ).get(session!.id) as { cnt: number };
    assert.equal(count.cnt, 1, "should have exactly one row");
  });

  it("sets files_missing=1 when config does not exist", () => {
    const nonexistentDir = path.join(tempHome, "nonexistent");

    const session = upsertAutoresearchSession(nonexistentDir);
    assert.ok(session, "should return a session row even for missing files");
    assert.equal(session!.files_missing, 1);
    assert.equal(session!.goal, null);
    assert.equal(session!.metric_name, null);
    assert.equal(session!.total_runs, 0);
  });

  it("counts runs correctly with mixed statuses", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "test",
      metricName: "score",
      direction: "higher",
      command: "echo test",
    });
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 50 },
      { type: "run", run: 2, status: "keep", metric: 60 },
      { type: "run", run: 3, status: "discard", metric: 55 },
      { type: "run", run: 4, status: "crash", metric: null },
      { type: "run", run: 5, status: "checks_failed", metric: null },
    ]);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.total_runs, 5);
    assert.equal(session!.baseline_metric, 50);
    assert.equal(session!.best_metric, 60);
    assert.equal(session!.best_run, 2);
  });

  it("handles direction=higher correctly for best_metric", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "maximize",
      metricName: "accuracy",
      direction: "higher",
      command: "echo test",
    });
    writeSessionLog(tempSessionDir, [
      { type: "run", run: 1, status: "baseline", metric: 0.75 },
      { type: "run", run: 2, status: "keep", metric: 0.80 },
      { type: "run", run: 3, status: "keep", metric: 0.77 },
    ]);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.best_metric, 0.80);
    assert.equal(session!.best_run, 2);
  });

  it("handles empty log file", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "test",
      metricName: "score",
      direction: "lower",
      command: "echo test",
    });
    writeSessionLog(tempSessionDir, []);

    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    assert.equal(session!.total_runs, 0);
    assert.equal(session!.baseline_metric, null);
    assert.equal(session!.best_metric, null);
    assert.equal(session!.best_run, null);
    assert.equal(session!.files_missing, 0);
  });

  it("uses realpath(cwd) as stable id", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "test",
      metricName: "score",
      direction: "lower",
      command: "echo test",
    });
    writeSessionLog(tempSessionDir, []);

    // Pass a symlink or relative path to verify realpath is used
    const session = upsertAutoresearchSession(tempSessionDir);
    assert.ok(session, "should return a session row");
    const expectedId = realpathSync(tempSessionDir);
    assert.equal(session!.id, expectedId);
    // Also test that the cwd field uses the resolved path
    assert.equal(session!.cwd, expectedId);
  });

  it("handles cwd that does not exist", () => {
    const nonexistent = path.join(tempHome, "ghost-dir");
    const session = upsertAutoresearchSession(nonexistent);
    assert.ok(session, "should return a session row for nonexistent cwd");
    assert.equal(session!.files_missing, 1);
    // id should use resolved path (which won't exist but path.resolve handles)
    assert.ok(session!.id.length > 0);
  });
});

describe("getAutoresearchSessions", () => {
  let tempHome: string;
  let tempSessionDir: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-list-test-"));
    tempSessionDir = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-session2-"));
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempSessionDir, { recursive: true, force: true });
  });

  it("returns empty array when no sessions exist", () => {
    const sessions = getAutoresearchSessions();
    assert.deepEqual(sessions, []);
  });

  it("returns all non-missing sessions ordered by updated_at DESC", () => {
    // Create two sessions
    const dir1 = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-a-"));
    const dir2 = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-b-"));

    try {
      writeSessionConfig(dir1, {
        goal: "session A",
        metricName: "latency",
        direction: "lower",
        command: "test A",
      });
      writeSessionLog(dir1, [{ type: "run", run: 1, status: "baseline", metric: 100 }]);

      writeSessionConfig(dir2, {
        goal: "session B",
        metricName: "throughput",
        direction: "higher",
        command: "test B",
      });
      writeSessionLog(dir2, [{ type: "run", run: 1, status: "baseline", metric: 50 }]);

      // Insert B first, then A (so B has older updated_at)
      upsertAutoresearchSession(dir2);
      // Small delay to ensure different timestamps
      const start = Date.now();
      while (Date.now() - start < 10) { /* busy wait for timestamp difference */ }
      upsertAutoresearchSession(dir1);

      const sessions = getAutoresearchSessions();
      assert.equal(sessions.length, 2);
      // A was inserted last, should be first
      assert.equal(sessions[0].goal, "session A");
      assert.equal(sessions[1].goal, "session B");
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("excludes missing sessions by default", () => {
    const nonexistent = path.join(tempHome, "ghost-session");
    upsertAutoresearchSession(nonexistent);

    const sessions = getAutoresearchSessions();
    // The missing session should be excluded
    const missingSessions = sessions.filter((s) => s.files_missing === 1);
    assert.equal(missingSessions.length, 0, "default should exclude missing sessions");
  });

  it("includeMissing option returns missing sessions", () => {
    const nonexistent = path.join(tempHome, "ghost-session2");
    upsertAutoresearchSession(nonexistent);

    const sessions = getAutoresearchSessions({ includeMissing: true });
    const missingSessions = sessions.filter((s) => s.files_missing === 1);
    assert.ok(missingSessions.length >= 1, "should include missing sessions when requested");
  });
});

describe("getAutoresearchSessionById", () => {
  let tempHome: string;
  let tempSessionDir: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-getbyid-test-"));
    tempSessionDir = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-session3-"));
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempSessionDir, { recursive: true, force: true });
  });

  it("returns a session by id", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "find me",
      metricName: "score",
      direction: "lower",
      command: "test",
    });
    writeSessionLog(tempSessionDir, [{ type: "run", run: 1, status: "baseline", metric: 42 }]);

    const upserted = upsertAutoresearchSession(tempSessionDir);
    assert.ok(upserted, "should upsert successfully");

    const session = getAutoresearchSessionById(upserted!.id);
    assert.ok(session, "should find session by id");
    assert.equal(session!.goal, "find me");
    assert.equal(session!.metric_name, "score");
    assert.equal(session!.total_runs, 1);
  });

  it("returns undefined for nonexistent id", () => {
    const session = getAutoresearchSessionById("/nonexistent/path");
    assert.equal(session, undefined);
  });
});

describe("deleteAutoresearchSession", () => {
  let tempHome: string;
  let tempSessionDir: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-delete-test-"));
    tempSessionDir = mkdtempSync(path.join(os.tmpdir(), "tamandua-ar-session4-"));
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempSessionDir, { recursive: true, force: true });
  });

  it("removes a row by id and returns true", () => {
    writeSessionConfig(tempSessionDir, {
      goal: "delete me",
      metricName: "score",
      direction: "lower",
      command: "test",
    });
    writeSessionLog(tempSessionDir, [{ type: "run", run: 1, status: "baseline", metric: 99 }]);

    const upserted = upsertAutoresearchSession(tempSessionDir);
    assert.ok(upserted, "should upsert successfully");

    const result = deleteAutoresearchSession(upserted!.id);
    assert.equal(result, true, "should return true on successful delete");

    // Verify it's gone
    const session = getAutoresearchSessionById(upserted!.id);
    assert.equal(session, undefined, "should be gone after delete");
  });

  it("returns false for nonexistent id", () => {
    const result = deleteAutoresearchSession("/nonexistent/id");
    assert.equal(result, false, "should return false for nonexistent id");
  });
});

describe("deleteDbFiles", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "tamandua-deletedb-"));
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = tempHome;
    process.env.TAMANDUA_DB_PATH = path.join(tempHome, ".tamandua", "tamandua.db");
  });

  afterEach(() => {
    if (origHome) process.env.HOME = origHome; else delete process.env.HOME;
    if (origDbPath) process.env.TAMANDUA_DB_PATH = origDbPath; else delete process.env.TAMANDUA_DB_PATH;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("removes the db file plus its WAL and SHM sidecars", () => {
    const dbPath = getDbPath();
    // Force creation of the db (and WAL sidecars via a write in WAL mode).
    getDb();
    assert.equal(existsSync(dbPath), true, "db file should exist after getDb()");

    const removed = deleteDbFiles();

    assert.ok(removed.includes(dbPath), "should report the db file as removed");
    assert.equal(existsSync(dbPath), false, "db file should be gone");
    assert.equal(existsSync(`${dbPath}-wal`), false, "WAL sidecar should be gone");
    assert.equal(existsSync(`${dbPath}-shm`), false, "SHM sidecar should be gone");
  });

  it("is a no-op that returns empty when no db exists", () => {
    closeDb();
    const dbPath = getDbPath();
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(dbPath, { force: true });

    const removed = deleteDbFiles();

    assert.deepEqual(removed, [], "should return empty array when nothing to remove");
  });
});
