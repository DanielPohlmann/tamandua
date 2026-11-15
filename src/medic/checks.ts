/**
 * Medic Health Checks
 *
 * Individual health check functions used by the medic module.
 * Each check returns findings that can be reported and optionally remediated.
 */

import { getDb } from "../db.js";
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../lib/home-dir.js";

// ── Types ──────────────────────────────────────────────────────────

export interface StuckRun {
  runId: string;
  workflowId: string;
  status: string;
  idleMinutes: number;
  lastActivity: string;
  totalSteps: number;
  terminalSteps: number;
}

export interface OrphanedCron {
  workflowId: string;
  cronJobId: string;
  activeRuns: number;
  lastRunAt: string | null;
}

export interface IntegrityResult {
  ok: boolean;
  message: string;
}

// ── Constants ──────────────────────────────────────────────────────

const STUCK_THRESHOLD_MINUTES = 30;
const ZOMBIE_THRESHOLD_MINUTES = 60;

// ── Checks ─────────────────────────────────────────────────────────

/**
 * Find runs that are stuck in 'running' state with no step activity
 * for longer than STUCK_THRESHOLD_MINUTES.
 */
export function checkStuckRuns(): StuckRun[] {
  const db = getDb();
  const results: StuckRun[] = [];

  try {
    const rows = db.prepare(`
      SELECT
        r.id AS run_id,
        r.workflow_id,
        r.status,
        CAST((julianday('now') - julianday(r.updated_at)) * 24 * 60 AS INTEGER) AS idle_minutes,
        r.updated_at AS last_activity,
        (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id) AS total_steps,
        (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id AND s.status IN ('done', 'failed')) AS terminal_steps
      FROM runs r
      WHERE r.status = 'running'
        AND (julianday('now') - julianday(r.updated_at)) * 24 * 60 > ?
      ORDER BY idle_minutes DESC
    `).all(STUCK_THRESHOLD_MINUTES);

    for (const row of rows as Array<Record<string, unknown>>) {
      results.push({
        runId: row.run_id as string,
        workflowId: row.workflow_id as string,
        status: row.status as string,
        idleMinutes: row.idle_minutes as number,
        lastActivity: row.last_activity as string,
        totalSteps: row.total_steps as number,
        terminalSteps: row.terminal_steps as number,
      });
    }
  } catch (err) {
    console.error("checkStuckRuns failed:", err);
  }

  return results;
}

/**
 * Find cron jobs for workflows that have no active (running/paused) runs.
 * These are crons polling for work that will never arrive — wasted cycles.
 */
export function checkOrphanedCrons(): OrphanedCron[] {
  const db = getDb();
  const results: OrphanedCron[] = [];

  try {
    // Read cron jobs config
    const cronFile = path.join(homeDir(), ".tamandua", "cron-jobs.json");
    let cronJobs: Array<{ id: string; workflowId: string; name: string }> = [];

    try {
      if (fs.existsSync(cronFile)) {
        const raw = fs.readFileSync(cronFile, "utf-8");
        cronJobs = JSON.parse(raw);
      }
    } catch {
      // No cron jobs file — nothing to check
      return [];
    }

    for (const job of cronJobs) {
      const workflowId = job.workflowId;
      if (!workflowId) continue;

      const row = db.prepare(
        "SELECT COUNT(*) AS cnt, MAX(updated_at) AS last_at FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused')"
      ).get(workflowId) as { cnt: number; last_at: string | null } | undefined;

      const activeRuns = row?.cnt ?? 0;

      if (activeRuns === 0) {
        results.push({
          workflowId,
          cronJobId: job.id,
          activeRuns: 0,
          lastRunAt: row?.last_at ?? null,
        });
      }
    }
  } catch (err) {
    console.error("checkOrphanedCrons failed:", err);
  }

  return results;
}

/**
 * Check SQLite database integrity.
 * Runs PRAGMA integrity_check and returns the result.
 */
export function checkDatabaseIntegrity(): IntegrityResult {
  try {
    const db = getDb();
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;

    if (!row) {
      return { ok: false, message: "No response from integrity_check" };
    }

    const result = row.integrity_check;
    const ok = result === "ok";

    return { ok, message: result };
  } catch (err) {
    return {
      ok: false,
      message: `Database integrity check failed: ${(err as Error).message}`,
    };
  }
}
