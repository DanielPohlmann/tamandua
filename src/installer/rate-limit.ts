import { getDb } from "../db.js";
import { emitEvent } from "./events.js";
import { mergeRunContext } from "./gate-loop.js";
import { clearReadOnlyBaseline } from "./read-only.js";

const RESET_AT = /reset at (\d{1,2}:\d{2}\s*[AP]M)/i;
const MINUTE_PATTERNS = [/wait (\d+) minutes?/i, /try again in (\d+)/i];
const MIN_WAIT_MS = 60_000;
export const RATE_LIMIT_RESUME_KEY = "rate_limit_resume_at";

export class RateLimitError extends Error {
  constructor(readonly waitMs: number, message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export function parseRateLimitWait(text: string, now: Date = new Date()): number | null {
  const resetMatch = text.match(RESET_AT);
  if (resetMatch) {
    const [time, meridiem] = resetMatch[1].trim().split(/\s+/);
    const [rawHours, minutes] = time.split(":").map(Number);
    let hours = rawHours;
    if (meridiem.toUpperCase() === "PM" && hours !== 12) hours += 12;
    if (meridiem.toUpperCase() === "AM" && hours === 12) hours = 0;
    const reset = new Date(now);
    reset.setHours(hours, minutes, 0, 0);
    if (reset <= now) reset.setDate(reset.getDate() + 1);
    return Math.max(reset.getTime() - now.getTime(), MIN_WAIT_MS);
  }
  for (const pattern of MINUTE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return Math.max(parseInt(match[1], 10) * 60_000, MIN_WAIT_MS);
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

export function requeueClaimedSteps(runId: string, agentId: string, jobId: string): number {
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
    clearReadOnlyBaseline(step.id, runId);
    requeued++;
  }
  return requeued;
}

export function pauseRunForRateLimit(runId: string, resumeAt: Date, detail: string): void {
  mergeRunContext(runId, { [RATE_LIMIT_RESUME_KEY]: resumeAt.toISOString() });
  getDb().prepare(
    "UPDATE runs SET status = 'paused', scheduling_status = 'paused', updated_at = datetime('now') WHERE id = ? AND status = 'running'",
  ).run(runId);
  emitEvent({ ts: new Date().toISOString(), event: "run.paused", runId, detail: `${detail}; resuming at ${resumeAt.toISOString()}` });
}

export function resumeDueRateLimitedRuns(now: Date = new Date()): string[] {
  const db = getDb();
  const paused = db.prepare("SELECT id, context FROM runs WHERE status = 'paused'").all() as Array<{ id: string; context: string }>;
  const resumed: string[] = [];
  for (const run of paused) {
    const context = JSON.parse(run.context) as Record<string, string>;
    const resumeAt = context[RATE_LIMIT_RESUME_KEY];
    if (!resumeAt || new Date(resumeAt) > now) continue;
    delete context[RATE_LIMIT_RESUME_KEY];
    db.prepare(
      `UPDATE runs SET status = 'running', context = ?, scheduling_status = 'pending_register',
              scheduling_requested_at = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(context), now.toISOString(), run.id);
    emitEvent({ ts: now.toISOString(), event: "run.resumed", runId: run.id, detail: "Usage limit reset" });
    resumed.push(run.id);
  }
  return resumed;
}
