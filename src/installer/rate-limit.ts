import { getDb, inTransaction } from "../db.js";
import { emitEvent } from "./events.js";

const RESET_AT = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([AP]M)/i;
const EPOCH_SUFFIX = /\|\s*(\d{9,11})\b/;
const WAIT_PATTERNS: Array<{ pattern: RegExp; defaultUnit?: string }> = [
  { pattern: /wait\s+(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i },
  { pattern: /try again in\s+(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)?\b/i, defaultUnit: "minutes" },
];
const LIMIT_KEYWORD = /limit/i;
const MIN_WAIT_MS = 60_000;
export const RATE_LIMIT_RESUME_KEY = "rate_limit_resume_at";
export const RATE_LIMIT_PAUSES_KEY = "rate_limit_pauses";
export const MAX_CONSECUTIVE_RATE_LIMIT_PAUSES = 5;

export class RateLimitError extends Error {
  constructor(readonly waitMs: number, message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

function unitMs(unit: string): number {
  const first = unit.toLowerCase()[0];
  if (first === "h") return 3_600_000;
  if (first === "s") return 1_000;
  return 60_000;
}

/** Reads a usage-limit wait from `text`; a time pattern only counts when the same text mentions a limit. */
export function parseRateLimitWait(text: string, now: Date = new Date()): number | null {
  if (!LIMIT_KEYWORD.test(text)) return null;
  const resetMatch = text.match(RESET_AT);
  if (resetMatch) {
    const meridiem = resetMatch[3].toUpperCase();
    let hours = Number(resetMatch[1]);
    const minutes = Number(resetMatch[2] ?? 0);
    if (meridiem === "PM" && hours !== 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;
    const reset = new Date(now);
    reset.setHours(hours, minutes, 0, 0);
    if (reset <= now) reset.setDate(reset.getDate() + 1);
    return Math.max(reset.getTime() - now.getTime(), MIN_WAIT_MS);
  }
  const epochMatch = text.match(EPOCH_SUFFIX);
  if (epochMatch) return Math.max(Number(epochMatch[1]) * 1000 - now.getTime(), MIN_WAIT_MS);
  for (const { pattern, defaultUnit } of WAIT_PATTERNS) {
    const match = text.match(pattern);
    if (match) return Math.max(parseInt(match[1], 10) * unitMs(match[2] ?? defaultUnit ?? "minutes"), MIN_WAIT_MS);
  }
  return null;
}

export function rateLimitFromClaudeResult(rawStdout: string, now: Date = new Date()): number | null {
  try {
    const parsed = JSON.parse(rawStdout) as { is_error?: unknown; result?: unknown };
    if (parsed.is_error !== true || typeof parsed.result !== "string") return null;
    return parseRateLimitWait(parsed.result, now);
  } catch {
    return null;
  }
}

/** A failed run is rate limited only by its stderr or by an `is_error` JSON result, never by prose in stdout. */
export function rateLimitFromFailedRun(stderr: string, stdout: string, now: Date = new Date()): number | null {
  return parseRateLimitWait(stderr, now) ?? rateLimitFromClaudeResult(stdout.trim(), now);
}

function readContext(raw: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function requeueClaimedSteps(runId: string, agentId: string, jobId: string): number {
  return inTransaction(() => {
    const db = getDb();
    const steps = db.prepare(
      `SELECT id, type, current_story_id FROM steps
       WHERE run_id = ? AND agent_id = ? AND status = 'running' AND (claim_job_id IS NULL OR claim_job_id = ?)`,
    ).all(runId, agentId, jobId) as Array<{ id: string; type: string; current_story_id: string | null }>;
    let requeued = 0;
    for (const step of steps) {
      if (step.type === "loop" && !step.current_story_id) continue;
      if (step.current_story_id) {
        db.prepare("UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(step.current_story_id);
      }
      db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
      requeued++;
    }
    return requeued;
  });
}

/** Pauses only a plainly running run; a run a human is pausing or has paused never gets an auto-resume marker. */
export function pauseRunForRateLimit(runId: string, resumeAt: Date, detail: string): void {
  const effective = inTransaction(() => {
    const db = getDb();
    const result = db.prepare(
      `UPDATE runs SET status = 'paused', scheduling_status = 'paused', updated_at = datetime('now')
       WHERE id = ? AND status = 'running' AND COALESCE(scheduling_status, '') <> 'draining_pause'`,
    ).run(runId);
    if (Number(result.changes) !== 1) return null;
    const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const context = readContext(row.context);
    const existing = context[RATE_LIMIT_RESUME_KEY];
    const later = existing && new Date(existing) > resumeAt ? new Date(existing) : resumeAt;
    context[RATE_LIMIT_RESUME_KEY] = later.toISOString();
    db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(JSON.stringify(context), runId);
    return later;
  });
  if (!effective) return;
  emitEvent({ ts: new Date().toISOString(), event: "run.paused", runId, detail: `${detail}; resuming at ${effective.toISOString()}` });
}

function readPauseCounts(context: Record<string, string>): Record<string, number> {
  try {
    const parsed = JSON.parse(context[RATE_LIMIT_PAUSES_KEY] ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function updateRunContext(runId: string, update: (context: Record<string, string>) => boolean): void {
  const db = getDb();
  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!row) return;
  const context = readContext(row.context);
  if (update(context)) db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(JSON.stringify(context), runId);
}

/** Counts one more rate-limit pause for each claimed step; false (and nothing counted) once a step reached the cap. */
function countRateLimitPauses(runId: string, agentId: string, jobId: string): boolean {
  const steps = getDb().prepare(
    `SELECT step_id FROM steps
     WHERE run_id = ? AND agent_id = ? AND status = 'running' AND (claim_job_id IS NULL OR claim_job_id = ?)`,
  ).all(runId, agentId, jobId) as Array<{ step_id: string }>;
  let withinCap = true;
  updateRunContext(runId, (context) => {
    const counts = readPauseCounts(context);
    withinCap = steps.every((step) => (counts[step.step_id] ?? 0) < MAX_CONSECUTIVE_RATE_LIMIT_PAUSES);
    if (!withinCap || steps.length === 0) return false;
    for (const step of steps) counts[step.step_id] = (counts[step.step_id] ?? 0) + 1;
    context[RATE_LIMIT_PAUSES_KEY] = JSON.stringify(counts);
    return true;
  });
  return withinCap;
}

/** Forgets a step's consecutive rate-limit pauses once it completed or failed on its own. */
export function resetRateLimitPauses(runId: string, stepName: string): void {
  updateRunContext(runId, (context) => {
    const counts = readPauseCounts(context);
    if (!(stepName in counts)) return false;
    delete counts[stepName];
    context[RATE_LIMIT_PAUSES_KEY] = JSON.stringify(counts);
    return true;
  });
}

/**
 * Re-queues the claimed steps and pauses the run atomically. Returns null, changing nothing, when a step
 * already paused MAX_CONSECUTIVE_RATE_LIMIT_PAUSES times without progress: the caller treats it as a failure.
 */
export function suspendRunForRateLimit(runId: string, agentId: string, jobId: string, resumeAt: Date, detail: string): number | null {
  return inTransaction(() => {
    if (!countRateLimitPauses(runId, agentId, jobId)) return null;
    const requeued = requeueClaimedSteps(runId, agentId, jobId);
    pauseRunForRateLimit(runId, resumeAt, detail);
    return requeued;
  });
}

export function clearRateLimitMarker(runId: string): void {
  updateRunContext(runId, (context) => {
    if (!(RATE_LIMIT_RESUME_KEY in context)) return false;
    delete context[RATE_LIMIT_RESUME_KEY];
    return true;
  });
}

export function resumeDueRateLimitedRuns(now: Date = new Date()): string[] {
  const db = getDb();
  const paused = db.prepare("SELECT id, context FROM runs WHERE status = 'paused'").all() as Array<{ id: string; context: unknown }>;
  const resumed: string[] = [];
  for (const run of paused) {
    try {
      const context = readContext(run.context);
      const resumeAt = context[RATE_LIMIT_RESUME_KEY];
      if (!resumeAt) continue;
      const due = new Date(resumeAt);
      if (!Number.isNaN(due.getTime()) && due > now) continue;
      delete context[RATE_LIMIT_RESUME_KEY];
      const result = db.prepare(
        `UPDATE runs SET status = 'running', context = ?, scheduling_status = 'pending_register',
                scheduling_requested_at = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'paused' AND json_extract(context, '$.${RATE_LIMIT_RESUME_KEY}') IS NOT NULL`,
      ).run(JSON.stringify(context), now.toISOString(), run.id);
      if (Number(result.changes) !== 1) continue;
      emitEvent({ ts: now.toISOString(), event: "run.resumed", runId: run.id, detail: "Usage limit reset" });
      resumed.push(run.id);
    } catch {
      continue;
    }
  }
  return resumed;
}
