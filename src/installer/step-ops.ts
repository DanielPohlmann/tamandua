import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { getDb } from "../db.js";
import { resolveWorkflowDir, resolveTamanduaCli } from "./paths.js";
import { teardownWorkflowCronsIfIdle } from "./agent-scheduler.js";
import { emitEvent } from "./events.js";
import { logger } from "../lib/logger.js";
import { getMaxRoleTimeoutSeconds } from "./install.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { isFrontendChange } from "../lib/frontend-detect.js";
import { BASH_ENV_KEYS_CONTEXT_KEY, type LoopConfig, type Story, type WorkflowStepFailure } from "./types.js";
import { detectRugpull, relaunchRunAfterRugpull } from "./rugpull.js";
import {
  EVIDENCE_LINES,
  bashOutputContextKey,
  blockRunAtStep,
  completeFixStep,
  mergeRunContext,
  parseFixPolicy,
  settleGate,
  tailLines,
} from "./gate-loop.js";
import { parseFindingsJson } from "./findings.js";

// ══════════════════════════════════════════════════════════════════════
// Key-Value Parsing
// ══════════════════════════════════════════════════════════════════════

/**
 * Parse KEY: value lines from step output with support for multi-line values.
 * Accumulates continuation lines until the next KEY: boundary or end of output.
 * Returns a map of lowercase keys to their (trimmed) values.
 * Skips STORIES_JSON keys (handled separately).
 */
export function parseOutputKeyValues(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = output.split("\n");
  let pendingKey: string | null = null;
  let pendingValue = "";

  function commitPending() {
    if (pendingKey && !pendingKey.startsWith("STORIES_JSON")) {
      result[pendingKey.toLowerCase()] = pendingValue.trim();
    }
    pendingKey = null;
    pendingValue = "";
  }

  for (const line of lines) {
    const match = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (match) {
      commitPending();
      pendingKey = match[1];
      pendingValue = match[2];
    } else if (pendingKey) {
      pendingValue += "\n" + line;
    }
  }
  commitPending();

  return result;
}

/**
 * Reserved context keys that must not be overwritten by step output parsing.
 * These are structural keys that define the harness/repo/environment and should
 * only be set during run creation, not by agent-generated KEY:value output.
 */
const RESERVED_CONTEXT_KEYS = new Set([
  "repo",
  "working_directory_for_harness",
  "task",
  "run_id",
  "workspace_mode",
  "worktree_path",
  "worktree_origin_repository",
  "worktree_origin_ref",
  "worktree_origin_sha",
  "original_branch",
  BASH_ENV_KEYS_CONTEXT_KEY,
]);

// ══════════════════════════════════════════════════════════════════════
// Template Resolution
// ══════════════════════════════════════════════════════════════════════

/**
 * Resolve {{key}} placeholders in a template against a context object.
 */
export function resolveTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    if (key in context) return context[key];
    const lower = key.toLowerCase();
    if (lower in context) return context[lower];
    return `[missing: ${key}]`;
  });
}

/**
 * Find missing template placeholders for a given context object.
 */
export function findMissingTemplateKeys(template: string, context: Record<string, string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    const lower = key.toLowerCase();
    const hasExact = Object.prototype.hasOwnProperty.call(context, key);
    const hasLower = Object.prototype.hasOwnProperty.call(context, lower);
    if (!hasExact && !hasLower && !seen.has(lower)) {
      seen.add(lower);
      missing.push(lower);
    }
    return "";
  });
  return missing;
}

// ══════════════════════════════════════════════════════════════════════
// Cron Teardown & Run Lookup
// ══════════════════════════════════════════════════════════════════════

/**
 * Fire-and-forget cron teardown when a run ends.
 * Looks up the workflow_id for the run and tears down crons if no other active runs.
 */
export function scheduleRunCronTeardown(runId: string): void {
  try {
    const db = getDb();
    const run = db.prepare("SELECT workflow_id, status FROM runs WHERE id = ?").get(runId) as { workflow_id: string; status: string } | undefined;
    if (!run) return;

    // Terminal runs never carry a scheduling_status. Any path that lands a
    // run in completed/failed/canceled should also wipe the scheduling
    // fields so the daemon reconciler stops considering it.
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      try {
        db.prepare(
          "UPDATE runs SET scheduling_status = NULL, updated_at = datetime('now') WHERE id = ?",
        ).run(runId);
      } catch {
        // best-effort
      }
    }

    // Run-scoped teardown is preferred (daemon-owned timers are
    // run-scoped). The workflow-wide idle check remains as a back-compat
    // safety net for legacy callers / tests that still rely on it.
    import("./agent-scheduler.js")
      .then((m) => m.removeRunCrons(runId))
      .catch(() => {});
    import("../server/control-client.js")
      .then((m) => m.terminateRunWithDaemon(runId))
      .catch(() => {});
    teardownWorkflowCronsIfIdle(run.workflow_id).catch(() => {});
  } catch {
    // best-effort
  }
}

/**
 * Look up the workflow_id for a given run.
 */
export function getWorkflowId(runId: string): string | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
    return row?.workflow_id;
  } catch {
    return undefined;
  }
}

function getRunTokenSpend(runId: string): number | undefined {
  try {
    const db = getDb();
    const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as { tokens_spent: number } | undefined;
    return row?.tokens_spent;
  } catch {
    return undefined;
  }
}

function emitRunTerminalEvent(params: {
  event: "run.completed" | "run.failed";
  runId: string;
  workflowId?: string;
  detail?: string;
}): void {
  emitEvent({
    ts: new Date().toISOString(),
    event: params.event,
    runId: params.runId,
    workflowId: params.workflowId,
    detail: params.detail,
    tokensSpent: getRunTokenSpend(params.runId),
  });
}

// ══════════════════════════════════════════════════════════════════════
// Agent Workspace
// ══════════════════════════════════════════════════════════════════════

/**
 * Get the workspace path for a Tamandua agent by its id.
 * Reads from ~/.tamandua/agents.json (a JSON array of agent configs with workspace paths).
 */
export function getAgentWorkspacePath(agentId: string): string | null {
  try {
    const configPath = path.join(os.homedir(), ".tamandua", "agents.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const agents: Array<{ id: string; workspace?: string }> = Array.isArray(config) ? config : [];
    const agent = agents.find((a) => a.id === agentId);
    return agent?.workspace ?? null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Progress File
// ══════════════════════════════════════════════════════════════════════

/**
 * Read progress.txt from the loop step's agent workspace.
 */
export function readProgressFile(runId: string): string {
  const db = getDb();
  const loopStep = db.prepare(
    "SELECT agent_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
  ).get(runId) as { agent_id: string } | undefined;
  if (!loopStep) return "(no progress file)";
  const workspace = getAgentWorkspacePath(loopStep.agent_id);
  if (!workspace) return "(no progress file)";
  try {
    const scopedPath = path.join(workspace, `progress-${runId}.txt`);
    const legacyPath = path.join(workspace, "progress.txt");
    const filePath = fs.existsSync(scopedPath) ? scopedPath : legacyPath;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "(no progress yet)";
  }
}

/**
 * Build a '## Story Plan' markdown section from an array of stories.
 * Exported for testability.
 */
export function buildStoryPlanSection(stories: Pick<Story, "storyId" | "title" | "description" | "acceptanceCriteria">[]): string {
  let section = "## Story Plan\n\n";
  for (const story of stories) {
    section += `### ${story.storyId}: ${story.title}\n\n`;
    section += `**Description:** ${story.description}\n\n`;
    section += "**Acceptance Criteria:**\n";
    for (const ac of story.acceptanceCriteria) {
      section += `- ${ac}\n`;
    }
    section += "\n";
  }
  return section;
}

/**
 * Merge a '## Story Plan' section into existing progress file content.
 * If a Story Plan section already exists, it is replaced. Otherwise it is
 * inserted after the first heading line (or at the top).
 * Exported for testability.
 */
export function mergeStoryPlanIntoProgress(existingContent: string, storyPlanSection: string): string {
  const storyPlanStart = "\n## Story Plan\n";
  const idx = existingContent.indexOf(storyPlanStart);
  if (idx !== -1) {
    // Find the next ## heading after the Story Plan start (or end of string)
    const afterStart = idx + storyPlanStart.length;
    const nextHeadingIdx = existingContent.indexOf("\n## ", afterStart);
    const endIdx = nextHeadingIdx !== -1 ? nextHeadingIdx : existingContent.length;
    return (
      existingContent.slice(0, idx) +
      "\n" +
      storyPlanSection.trimEnd() +
      (nextHeadingIdx !== -1 ? "" : "\n") +
      existingContent.slice(endIdx)
    );
  }

  if (existingContent.trim()) {
    // Insert after the first heading line, preserving existing content
    const headerMatch = existingContent.match(/^(# .+?\n)/);
    if (headerMatch) {
      return headerMatch[1] + "\n" + storyPlanSection + existingContent.slice(headerMatch[1].length);
    }
    return storyPlanSection + "\n" + existingContent;
  }

  return `# Progress Log\n\n${storyPlanSection}`;
}

/**
 * Write the full story plan to the progress log after STORIES_JSON is parsed.
 * Finds the loop step's agent workspace and writes/updates the '## Story Plan'
 * section in progress-{runId}.txt, preserving any existing Codebase Patterns or
 * other sections. Emits a 'stories.planned' event on success.
 */
export function writeStoryPlanToProgress(runId: string): void {
  if (!runHasStories(runId)) return;

  try {
    const db = getDb();
    const loopStep = db.prepare(
      "SELECT agent_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
    ).get(runId) as { agent_id: string } | undefined;

    if (!loopStep) {
      logger.warn("writeStoryPlanToProgress: no loop step found for run", { runId });
      return;
    }

    const workspace = getAgentWorkspacePath(loopStep.agent_id);
    if (!workspace) {
      logger.warn("writeStoryPlanToProgress: no workspace configured for loop agent", { runId, agentId: loopStep.agent_id });
      return;
    }

    const stories = getStories(runId);
    if (stories.length === 0) return;

    const storyPlanSection = buildStoryPlanSection(stories);
    const scopedPath = path.join(workspace, `progress-${runId}.txt`);

    // Read existing content if any
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(scopedPath, "utf-8");
    } catch {
      // File doesn't exist yet — that's fine
    }

    const newContent = mergeStoryPlanIntoProgress(existingContent, storyPlanSection);

    fs.mkdirSync(path.dirname(scopedPath), { recursive: true });
    fs.writeFileSync(scopedPath, newContent, "utf-8");

    const wfId = getWorkflowId(runId);
    emitEvent({
      ts: new Date().toISOString(),
      event: "stories.planned",
      runId,
      workflowId: wfId,
      detail: `Wrote ${stories.length} stories to progress file`,
    });

    logger.info("Story plan written to progress file", { runId, storyCount: stories.length });
  } catch (err) {
    logger.warn("writeStoryPlanToProgress: failed to write progress file", {
      runId,
      error: (err as Error).message,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════
// Stories
// ══════════════════════════════════════════════════════════════════════

/**
 * Get all stories for a run, ordered by story_index.
 */
export function getStories(runId: string): Story[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM stories WHERE run_id = ? ORDER BY story_index ASC"
  ).all(runId) as any[];
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    storyIndex: r.story_index,
    storyId: r.story_id,
    title: r.title,
    description: r.description,
    acceptanceCriteria: JSON.parse(r.acceptance_criteria),
    status: r.status,
    output: r.output ?? undefined,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
  }));
}

/**
 * Get the story currently being worked on by a loop step.
 */
export function getCurrentStory(stepId: string): Story | null {
  const db = getDb();
  const step = db.prepare(
    "SELECT current_story_id FROM steps WHERE id = ?"
  ).get(stepId) as { current_story_id: string | null } | undefined;
  if (!step?.current_story_id) return null;
  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get(step.current_story_id) as any;
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    storyIndex: row.story_index,
    storyId: row.story_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    status: row.status,
    output: row.output ?? undefined,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
  };
}

/**
 * Format a single story for template interpolation.
 */
export function formatStoryForTemplate(story: Story): string {
  const ac = story.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  return `Story ${story.storyId}: ${story.title}\n\n${story.description}\n\nAcceptance Criteria:\n${ac}`;
}

/**
 * Format completed stories as a summary bullet list.
 */
export function formatCompletedStories(stories: Story[]): string {
  const done = stories.filter((s) => s.status === "done");
  if (done.length === 0) return "(none yet)";
  return done.map((s) => `- ${s.storyId}: ${s.title}`).join("\n");
}

// ══════════════════════════════════════════════════════════════════════
// STORIES_JSON Parsing
// ══════════════════════════════════════════════════════════════════════

/**
 * Parse STORIES_JSON from step output and insert stories into the DB.
 */
export function parseAndInsertStories(output: string, runId: string): void {
  const lines = output.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("STORIES_JSON:"));
  if (startIdx === -1) return;

  const firstLine = lines[startIdx].slice("STORIES_JSON:".length).trim();
  const jsonLines = [firstLine];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^[A-Z_]+:\s/.test(lines[i])) break;
    jsonLines.push(lines[i]);
  }

  const jsonText = jsonLines.join("\n").trim();
  let stories: any[];
  try {
    stories = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Failed to parse STORIES_JSON: ${(e as Error).message}`);
  }

  if (!Array.isArray(stories)) {
    throw new Error("STORIES_JSON must be an array");
  }
  if (stories.length > 20) {
    throw new Error(`STORIES_JSON has ${stories.length} stories, max is 20`);
  }

  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 4, ?, ?)"
  );

  const seenIds = new Set<string>();
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const ac = s.acceptanceCriteria ?? s.acceptance_criteria;
    if (!s.id || !s.title || !s.description || !Array.isArray(ac) || ac.length === 0) {
      throw new Error(`STORIES_JSON story at index ${i} missing required fields (id, title, description, acceptanceCriteria)`);
    }
    if (seenIds.has(s.id)) {
      throw new Error(`STORIES_JSON has duplicate story id "${s.id}"`);
    }
    seenIds.add(s.id);
    insert.run(crypto.randomUUID(), runId, i, s.id, s.title, s.description, JSON.stringify(ac), now, now);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Abandoned Step Cleanup
// ══════════════════════════════════════════════════════════════════════

const ABANDONED_THRESHOLD_MS = (getMaxRoleTimeoutSeconds() + 5 * 60) * 1000;
const MAX_ABANDON_RESETS = 5;

/**
 * Find steps that have been "running" for too long and reset them to pending.
 * This catches cases where an agent claimed a step but never completed/failed it.
 * Exported so it can be called from medic/health-check crons independently of claimStep.
 */
export function cleanupAbandonedSteps(): void {
  const db = getDb();
  const thresholdMs = ABANDONED_THRESHOLD_MS;

  const abandonedSteps = db.prepare(
    "SELECT id, step_id, run_id, retry_count, max_retries, type, current_story_id, loop_config, abandoned_count FROM steps WHERE status = 'running' AND type != 'bash' AND (julianday('now') - julianday(updated_at)) * 86400000 > ?"
  ).all(thresholdMs) as {
    id: string; step_id: string; run_id: string; retry_count: number; max_retries: number;
    type: string; current_story_id: string | null; loop_config: string | null; abandoned_count: number;
  }[];

  for (const step of abandonedSteps) {
    // Skip loop steps waiting on verify_each (verify step still pending/running)
    if (step.type === "loop" && !step.current_story_id && step.loop_config) {
      try {
        const loopConfig: LoopConfig = JSON.parse(step.loop_config);
        const lcVerifyEach = loopConfig.verifyEach ?? loopConfig.verify_each;
        const lcVerifyStep = loopConfig.verifyStep ?? loopConfig.verify_step;
        if (lcVerifyEach && lcVerifyStep) {
          const verifyStatus = db.prepare(
            "SELECT status FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
          ).get(step.run_id, lcVerifyStep) as { status: string } | undefined;
          if (verifyStatus?.status === "pending" || verifyStatus?.status === "running") {
            continue;
          }
        }
      } catch {
        // If loop config is malformed, fall through to abandonment handling.
      }
    }

    // Loop steps: apply per-story retry, not per-step retry
    if (step.type === "loop" && step.current_story_id) {
      const story = db.prepare(
        "SELECT id, retry_count, max_retries, story_id, title FROM stories WHERE id = ?"
      ).get(step.current_story_id) as {
        id: string; retry_count: number; max_retries: number; story_id: string; title: string;
      } | undefined;

      if (story) {
        const newRetry = story.retry_count + 1;
        const wfId = getWorkflowId(step.run_id);
        if (newRetry > story.max_retries) {
          db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
          db.prepare("UPDATE steps SET status = 'failed', output = 'Story abandoned and retries exhausted', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: "Abandoned — retries exhausted" });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Story abandoned and retries exhausted" });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Story abandoned and retries exhausted" });
          scheduleRunCronTeardown(step.run_id);
        } else {
          db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
          db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Story ${story.story_id} abandoned — reset to pending (story retry ${newRetry})` });
          logger.info(`Abandoned step reset to pending (story retry ${newRetry})`, { runId: step.run_id, stepId: step.step_id });
        }
        continue;
      }
    }

    // Single steps (or loop steps without a current story): use abandoned_count, not retry_count
    const newAbandonCount = (step.abandoned_count ?? 0) + 1;
    if (newAbandonCount >= MAX_ABANDON_RESETS) {
      db.prepare(
        "UPDATE steps SET status = 'failed', output = 'Agent abandoned step without completing (' || ? || ' times)', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newAbandonCount, newAbandonCount, step.id);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      const wfId = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: `Retries exhausted — step failed` });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent abandoned step without completing" });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step abandoned and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
    } else {
      db.prepare(
        "UPDATE steps SET status = 'pending', abandoned_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newAbandonCount, step.id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, detail: `Reset to pending (abandon ${newAbandonCount}/${MAX_ABANDON_RESETS})` });
    }
  }

  // Reset running stories that are abandoned — don't touch "done" stories
  const abandonedStories = db.prepare(
    "SELECT id, retry_count, max_retries, run_id FROM stories WHERE status = 'running' AND (julianday('now') - julianday(updated_at)) * 86400000 > ?"
  ).all(thresholdMs) as { id: string; retry_count: number; max_retries: number; run_id: string }[];

  for (const story of abandonedStories) {
    db.prepare("UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(story.id);
  }

  // Recover stuck pipelines: loop step done but no subsequent step pending/running
  const stuckLoops = db.prepare(`
    SELECT s.id, s.run_id, s.step_index FROM steps s
    JOIN runs r ON r.id = s.run_id
    WHERE s.type = 'loop' AND s.status = 'done' AND r.status = 'running'
    AND NOT EXISTS (
      SELECT 1 FROM steps s2 WHERE s2.run_id = s.run_id
      AND s2.step_index > s.step_index
      AND s2.status IN ('pending', 'running')
    )
    AND EXISTS (
      SELECT 1 FROM steps s3 WHERE s3.run_id = s.run_id
      AND s3.step_index > s.step_index
      AND s3.status = 'waiting'
    )
  `).all() as { id: string; run_id: string; step_index: number }[];

  for (const stuck of stuckLoops) {
    logger.info(`Recovering stuck pipeline after loop completion`, { runId: stuck.run_id, stepId: stuck.id });
    advancePipeline(stuck.run_id);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Orphaned Step Recovery (post-SIGKILL)
// ══════════════════════════════════════════════════════════════════════

/**
 * Recover orphaned running steps for a specific agent.
 * Called when pi exits abnormally (SIGKILL, non-zero exit) to prevent
 * steps from being permanently stuck at status='running' — peekStep only
 * matches pending/waiting, so an orphaned running step is invisible to
 * the polling cron and the run wedges silently.
 *
 * @param agentId - The agent ID whose running steps to recover
 * @param staleThresholdMs - Optional: only recover steps whose updated_at
 *   is older than this many milliseconds. When omitted, all running steps
 *   for the agent are recovered (use in post-exit handlers where we KNOW
 *   the agent just died).
 * @param timeoutRetryReason - Optional: human-readable reason for the
 *   timeout (e.g. "pi timed out after 1800000ms"). When provided, each
 *   recovered step's run context is augmented with `timeout_retry` so the
 *   retry prompt includes a signal that the prior attempt was interrupted
 *   and uncommitted work may exist on disk.
 */
export function recoverOrphanedStepsForAgent(
  agentId: string,
  runId: string,
  staleThresholdMs?: number,
  timeoutRetryReason?: string,
  failureReason?: string,
  workerJobId?: string,
): { recovered: number; failed: number; skipped: number } {
  const db = getDb();

  // Run-scoped query. Every caller (polling round, control plane,
  // shutdown paths) supplies a runId so concurrent runs of the same
  // workflow + agent are isolated.
  const clauses: string[] = ["agent_id = ?", "status = 'running'", "run_id = ?"];
  const params: (string | number)[] = [agentId, runId];
  if (staleThresholdMs !== undefined) {
    clauses.push("(julianday('now') - julianday(updated_at)) * 86400000 > ?");
    params.push(staleThresholdMs);
  }
  // Ownership-aware filter: when workerJobId is provided, skip steps
  // claimed by a different worker (claim_job_id mismatch). Steps with
  // NULL claim_job_id (legacy, pre-ownership) are always recovered.
  if (workerJobId !== undefined) {
    clauses.push("(claim_job_id IS NULL OR claim_job_id = ?)");
    params.push(workerJobId);
  }
  const query = `SELECT id, step_id, run_id, retry_count, max_retries, type, current_story_id, loop_config
       FROM steps
       WHERE ${clauses.join(" AND ")}`;

  const steps = db.prepare(query).all(...params) as {
    id: string; step_id: string; run_id: string; retry_count: number; max_retries: number;
    type: string; current_story_id: string | null; loop_config: string | null;
  }[];

  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (const step of steps) {
    // Skip loop steps waiting on verify_each (mid-iteration pause, not orphaned)
    if (step.type === "loop" && !step.current_story_id && step.loop_config) {
      try {
        const loopConfig: LoopConfig = JSON.parse(step.loop_config);
        const lcVerifyEach = loopConfig.verifyEach ?? loopConfig.verify_each;
        const lcVerifyStep = loopConfig.verifyStep ?? loopConfig.verify_step;
        if (lcVerifyEach && lcVerifyStep) {
          const verifyStatus = db.prepare(
            "SELECT status FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
          ).get(step.run_id, lcVerifyStep) as { status: string } | undefined;
          if (verifyStatus?.status === "pending" || verifyStatus?.status === "running") {
            skipped++;
            continue;
          }
        }
      } catch {
        // If loop config is malformed, fall through to recovery.
      }
    }

    // Loop steps with current_story_id: handle story-level retry
    if (step.type === "loop" && step.current_story_id) {
      const story = db.prepare(
        "SELECT id, retry_count, max_retries, story_id, title FROM stories WHERE id = ?"
      ).get(step.current_story_id) as {
        id: string; retry_count: number; max_retries: number; story_id: string; title: string;
      } | undefined;

      if (story) {
        const newRetry = story.retry_count + 1;
        const wfId = getWorkflowId(step.run_id);
        if (newRetry > story.max_retries) {
          db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
          db.prepare("UPDATE steps SET status = 'failed', output = 'Agent terminated without completing story; retries exhausted', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, storyId: story.story_id, storyTitle: story.title, detail: "Agent terminated — retries exhausted" });
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing story; retries exhausted" });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Agent terminated without completing story; retries exhausted" });
          scheduleRunCronTeardown(step.run_id);
          failed++;
        } else {
          db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
          db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(step.id);
          const storyRecoveryEvent = workerJobId !== undefined ? "step.worker_lost" : "step.timeout";
          const storyRecoveryDetail = workerJobId !== undefined
            ? `Worker ${workerJobId} exited without completing story ${story.story_id}; reset to pending (story retry ${newRetry}/${story.max_retries})`
            : `Agent terminated; story ${story.story_id} reset to pending (story retry ${newRetry}/${story.max_retries})`;
          emitEvent({ ts: new Date().toISOString(), event: storyRecoveryEvent, runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: storyRecoveryDetail });
          logger.info(`Orphaned step recovery: story ${story.story_id} reset to pending (retry ${newRetry}/${story.max_retries})`, { runId: step.run_id, stepId: step.step_id, agentId });
          if (timeoutRetryReason) {
            setRunContextKey(step.run_id, "timeout_retry", timeoutRetryReason);
          }
          recovered++;
        }
        continue;
      }
    }

    // Single steps (or loop steps without a current story): use step retry_count
    const newRetry = step.retry_count + 1;
    const wfId = getWorkflowId(step.run_id);
    if (newRetry > step.max_retries) {
      db.prepare(
        "UPDATE steps SET status = 'failed', retry_count = ?, output = 'Agent terminated without completing step; retries exhausted', updated_at = datetime('now') WHERE id = ?"
      ).run(newRetry, step.id);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.timeout", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing step; retries exhausted" });
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: "Agent terminated without completing step; retries exhausted" });
      emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Step terminated and retries exhausted" });
      scheduleRunCronTeardown(step.run_id);
      logger.warn(`Orphaned step retries exhausted`, { runId: step.run_id, stepId: step.step_id, agentId, retryCount: newRetry, maxRetries: step.max_retries });
      failed++;
    } else {
      // Persist failureReason into step.output so the next claimStep surfaces
      // it as `retry_feedback` to the retried agent. claimStep at line ~847
      // populates context.retry_feedback from step.output when retry_count>0.
      if (failureReason) {
        db.prepare(
          "UPDATE steps SET status = 'pending', retry_count = ?, output = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newRetry, failureReason, step.id);
      } else {
        db.prepare(
          "UPDATE steps SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newRetry, step.id);
      }
      const stepRecoveryEvent = workerJobId !== undefined ? "step.worker_lost" : "step.timeout";
      const stepRecoveryDetail = workerJobId !== undefined
        ? `Worker ${workerJobId} exited without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`
        : `Agent terminated without completing step; reset to pending (retry ${newRetry}/${step.max_retries})`;
      emitEvent({ ts: new Date().toISOString(), event: stepRecoveryEvent, runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: stepRecoveryDetail });
      logger.info(`Orphaned step reset to pending (retry ${newRetry}/${step.max_retries})`, { runId: step.run_id, stepId: step.step_id, agentId });
      if (timeoutRetryReason) {
        setRunContextKey(step.run_id, "timeout_retry", timeoutRetryReason);
      }
      recovered++;
    }
  }

  return { recovered, failed, skipped };
}

// ══════════════════════════════════════════════════════════════════════
// Frontend Change Detection
// ══════════════════════════════════════════════════════════════════════

/**
 * Compute whether a branch has frontend changes relative to main.
 * Returns 'true' or 'false' as a string for template context.
 */
export function computeHasFrontendChanges(repo: string, branch: string): string {
  try {
    const output = execFileSync("git", ["diff", "--name-only", `main..${branch}`], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const files = output.trim().split("\n").filter((f) => f.length > 0);
    return isFrontendChange(files) ? "true" : "false";
  } catch {
    return "false";
  }
}

// ══════════════════════════════════════════════════════════════════════
// Internal Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Set a key-value pair in a run's context JSON field.
 * Reads existing context, sets the key, and writes back.
 */
function setRunContextKey(runId: string, key: string, value: string): void {
  const db = getDb();
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  if (!run) return;
  const context: Record<string, string> = JSON.parse(run.context);
  context[key] = value;
  db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), runId);
}

function runHasStories(runId: string): boolean {
  const db = getDb();
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?"
  ).get(runId) as { cnt: number } | undefined;
  return (total?.cnt ?? 0) > 0;
}

// ══════════════════════════════════════════════════════════════════════
// Peek (Lightweight Work Check)
// ══════════════════════════════════════════════════════════════════════

export type PeekResult = "HAS_WORK" | "NO_WORK";

/**
 * Lightweight check: does this agent have any pending/waiting steps in active runs?
 * Unlike claimStep(), this runs a single cheap COUNT query — no cleanup, no context resolution.
 * Returns "HAS_WORK" if any pending/waiting steps exist, "NO_WORK" otherwise.
 */
export function peekStep(agentId: string, runId: string): PeekResult {
  const db = getDb();
  // Match 'pending' only — 'waiting' steps are still upstream-blocked, so
  // reporting them as work would cause spurious claim attempts.
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.agent_id = ? AND s.run_id = ?
       AND s.status = 'pending'
       AND r.status = 'running'`,
  ).get(agentId, runId) as { cnt: number };
  return row.cnt > 0 ? "HAS_WORK" : "NO_WORK";
}

// ══════════════════════════════════════════════════════════════════════
// Claim
// ══════════════════════════════════════════════════════════════════════

export interface WorkerOwnership {
  jobId: string;
  pid: number;
  pgid?: number;
}

interface ClaimResult {
  found: boolean;
  stepId?: string;
  runId?: string;
  resolvedInput?: string;
}

/**
 * Throttle cleanupAbandonedSteps: run at most once every 5 minutes.
 */
let lastCleanupTime = 0;
const CLEANUP_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Find and claim a pending step for an agent, returning the resolved input.
 */
export function claimStep(agentId: string, runId: string, workerOwnership?: WorkerOwnership): ClaimResult {
  // Throttle cleanup: run at most once every 5 minutes across all agents
  const now = Date.now();
  if (now - lastCleanupTime >= CLEANUP_THROTTLE_MS) {
    cleanupAbandonedSteps();
    lastCleanupTime = now;
  }
  const db = getDb();

  // Notes on the prev-step filter:
  //  - `prev.status NOT IN ('done', 'skipped')` enforces serial pipeline progression.
  //  - The extra exception lets verify_each work: while the loop step is "paused"
  //    waiting for verify (status = 'running' but current_story_id IS NULL), the
  //    verify step needs to be claimable. Without this exception, completeStep's
  //    verify_each branch sets verify=pending while the loop stays running, but
  //    claimStep refuses to claim verify because the loop isn't done — deadlock.
  // Run-scoped claim: concurrent runs of the same workflow + agent never
  // cross-claim because the WHERE clause pins to a specific run_id.
  const step = db.prepare(
    `SELECT s.id, s.step_id, s.run_id, s.input_template, s.type, s.loop_config, s.step_index, s.retry_count, s.output
     FROM steps s
     JOIN runs r ON r.id = s.run_id
     WHERE s.agent_id = ? AND s.run_id = ? AND s.status = 'pending'
       AND r.status = 'running'
       AND (s.invoked_by IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM steps prev
         WHERE prev.run_id = s.run_id
           AND prev.step_index < s.step_index
           AND prev.status NOT IN ('done', 'skipped')
           AND NOT (prev.invoked_by IS NULL AND prev.step_id IN (
             SELECT json_extract(g.on_fail, '$.fix_step') FROM steps g
             WHERE g.run_id = s.run_id AND g.on_fail IS NOT NULL
           ))
           AND NOT (prev.type = 'loop'
                    AND prev.status = 'running'
                    AND prev.current_story_id IS NULL)
       ))
    ORDER BY s.step_index ASC, s.step_id ASC
     LIMIT 1`,
  ).get(agentId, runId) as {
    id: string; step_id: string; run_id: string; input_template: string; type: string;
    loop_config: string | null;
    step_index: number;
    retry_count: number;
    output: string | null;
  } | undefined;

  if (!step) return { found: false };

  // Guard: don't claim work for a terminal/paused run
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(step.run_id) as { status: string } | undefined;
  if (runStatus?.status !== "running") return { found: false };

  // Build context via resolveStepContext
  const context = resolveStepContext(step.run_id, step.step_index);

  // If this is a retry, surface the previous failure detail to the agent so
  // the second attempt can be more targeted than the first. The retry path
  // (e.g. the no-STORIES_JSON guard in completeStep) writes a human-readable
  // explanation into step.output before resetting the step to pending; pull
  // it into context as `retry_feedback` so workflow prompts can include it.
  context["retry_feedback"] =
    step.retry_count > 0 && step.output ? step.output : "";

  // Compute has_frontend_changes from git diff when repo and branch are available
  if (context["repo"] && context["branch"]) {
    context["has_frontend_changes"] = computeHasFrontendChanges(context["repo"], context["branch"]);
  } else {
    context["has_frontend_changes"] = "false";
  }

  // Loop step claim logic
  if (step.type === "loop") {
    const loopConfig: LoopConfig | null = step.loop_config ? JSON.parse(step.loop_config) : null;
    if (loopConfig?.over === "stories") {
      const claim = db.prepare(
        workerOwnership
          ? "UPDATE steps SET status = 'running', claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
          : "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(
        ...(workerOwnership ? [workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [step.id])
      );
      if ((claim.changes ?? 0) <= 0) return { found: false };

      if (!runHasStories(step.run_id)) {
        const message = "Loop cannot run because planning did not produce STORIES_JSON.";
        db.prepare(
          "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(message, step.id);
        db.prepare(
          "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
        ).run(step.run_id);
        const wfId = getWorkflowId(step.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId, detail: message });
        emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: message });
        scheduleRunCronTeardown(step.run_id);
        return { found: false };
      }

      // Find next pending story
      const nextStory = db.prepare(
        "SELECT * FROM stories WHERE run_id = ? AND status = 'pending' ORDER BY story_index ASC LIMIT 1"
      ).get(step.run_id) as any | undefined;

      if (!nextStory) {
        const failedStory = db.prepare(
          "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' LIMIT 1"
        ).get(step.run_id) as { id: string } | undefined;

        if (failedStory) {
          db.prepare(
            "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
          ).run("Loop cannot continue because one or more stories failed", step.id);
          db.prepare(
            "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
          ).run(step.run_id);
          const wfId = getWorkflowId(step.run_id);
          emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.id, agentId, detail: "Loop has failed stories and no pending stories" });
          emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Loop has failed stories and no pending stories" });
          scheduleRunCronTeardown(step.run_id);
          return { found: false };
        }

        // No pending or failed stories — mark step done and advance
        db.prepare(
          "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, agentId });
        advancePipeline(step.run_id);
        return { found: false };
      }

      // Claim the story. If another duplicate poller won it first, undo this
      // loop claim and let the next polling round inspect current state.
      const storyClaim = db.prepare(
        "UPDATE stories SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).run(nextStory.id);
      if ((storyClaim.changes ?? 0) <= 0) {
        db.prepare(
          "UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        return { found: false };
      }
      db.prepare(
        workerOwnership
          ? "UPDATE steps SET status = 'running', current_story_id = ?, claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          : "UPDATE steps SET status = 'running', current_story_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(
        ...(workerOwnership ? [nextStory.id, workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [nextStory.id, step.id])
      );

      const wfId = getWorkflowId(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId });
      emitEvent({ ts: new Date().toISOString(), event: "story.started", runId: step.run_id, workflowId: wfId, stepId: step.step_id, agentId, storyId: nextStory.story_id, storyTitle: nextStory.title });
      logger.info(`Story started: ${nextStory.story_id} — ${nextStory.title}`, { runId: step.run_id, stepId: step.step_id });

      // Build story template vars
      const story: Story = {
        id: nextStory.id,
        runId: nextStory.run_id,
        storyIndex: nextStory.story_index,
        storyId: nextStory.story_id,
        title: nextStory.title,
        description: nextStory.description,
        acceptanceCriteria: JSON.parse(nextStory.acceptance_criteria),
        status: nextStory.status,
        output: nextStory.output ?? undefined,
        retryCount: nextStory.retry_count,
        maxRetries: nextStory.max_retries,
      };

      const allStories = getStories(step.run_id);
      const pendingCount = allStories.filter((s) => s.status === "pending" || s.status === "running").length;

      context["current_story"] = formatStoryForTemplate(story);
      context["current_story_id"] = story.storyId;
      context["current_story_title"] = story.title;
      context["completed_stories"] = formatCompletedStories(allStories);
      context["stories_remaining"] = String(pendingCount);
      context["progress"] = readProgressFile(step.run_id);

      if (!context["verify_feedback"]) {
        context["verify_feedback"] = "";
      }

      const missingKeys = findMissingTemplateKeys(step.input_template, context);
      if (missingKeys.length > 0) {
        logger.warn(
          `Step ${step.step_id} claimed with missing template key(s): ${missingKeys.join(", ")} — substituting [missing: <key>] and letting the agent decide`,
          { runId: step.run_id, stepId: step.step_id, missingKeys },
        );
      }

      // Clear one-shot timeout_retry so it doesn't leak into subsequent stories.
      // The resolved template must capture it first; delete only after resolution.
      const hasTimeoutRetryLoop = Boolean(context["timeout_retry"]);

      // Persist story context vars to DB so verify_each steps can access them
      db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), step.run_id);

      const resolvedInput = resolveTemplate(step.input_template, context);

      if (hasTimeoutRetryLoop) {
        delete context["timeout_retry"];
        db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), step.run_id);
      }

      return { found: true, stepId: step.id, runId: step.run_id, resolvedInput };
    }
  }

  // Single step: existing logic
  const claim = db.prepare(
    workerOwnership
      ? "UPDATE steps SET status = 'running', claim_job_id = ?, claim_pid = ?, claim_pgid = ?, claim_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
      : "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(
    ...(workerOwnership ? [workerOwnership.jobId, workerOwnership.pid, workerOwnership.pgid ?? null, step.id] : [step.id])
  );
  if ((claim.changes ?? 0) <= 0) return { found: false };
  emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, agentId });
  logger.info(`Step claimed by ${agentId}`, { runId: step.run_id, stepId: step.step_id });

  // Inject progress for any step in a run that has stories
  const hasStories = db.prepare(
    "SELECT COUNT(*) as cnt FROM stories WHERE run_id = ?"
  ).get(step.run_id) as { cnt: number };
  if (hasStories.cnt > 0) {
    context["progress"] = readProgressFile(step.run_id);
  }

  // Clear one-shot timeout_retry after the template has captured it.
  // For single (non-loop) steps the context isn't persisted here, so
  // remove the key from the DB explicitly to prevent it from leaking
  // into downstream steps.
  const hasTimeoutRetry = Boolean(context["timeout_retry"]);

  const missingKeys = findMissingTemplateKeys(step.input_template, context);
  if (missingKeys.length > 0) {
    logger.warn(
      `Step ${step.step_id} claimed with missing template key(s): ${missingKeys.join(", ")} — substituting [missing: <key>] and letting the agent decide`,
      { runId: step.run_id, stepId: step.step_id, missingKeys },
    );
  }

  const resolvedInput = resolveTemplate(step.input_template, context);

  if (hasTimeoutRetry) {
    delete context["timeout_retry"];
    setRunContextKey(step.run_id, "timeout_retry", "");
  }

  return {
    found: true,
    stepId: step.id,
    runId: step.run_id,
    resolvedInput,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Expects Validation
// ══════════════════════════════════════════════════════════════════════

/**
 * Validate step output against the `expects` specification.
 *
 * Supports two kinds of lines:
 *   - Literal lines: the exact text must appear as a substring in the output.
 *   - Regex lines: prefixed with `regex:`, the rest is a pattern tested
 *     against the output (flags: m for multiline).
 *
 * Returns null if output satisfies all expects lines, or an error message
 * describing the first failing line.
 */
export function validateExpects(output: string, expects: string): string | null {
  if (!expects || expects.trim() === "") return null;

  const lines = expects.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("regex:")) {
      const pattern = trimmed.slice("regex:".length);
      try {
        const re = new RegExp(pattern, "m");
        if (!re.test(output)) {
          return `Output does not match expects regex: ${pattern}`;
        }
      } catch {
        return `Invalid expects regex pattern: ${pattern}`;
      }
    } else {
      if (!output.includes(trimmed)) {
        return `Output missing expects string: "${trimmed}"`;
      }
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════
// Draining Pause Finalization
// ══════════════════════════════════════════════════════════════════════

/**
 * When a run's scheduling_status is 'draining_pause', check whether all
 * running steps have completed; if so, finalize the pause by clearing
 * scheduler timers and setting status to 'paused'.
 */
export function finalizeDrainingPause(runId: string): void {
  const db = getDb();
  const run = db
    .prepare("SELECT scheduling_status, workflow_id FROM runs WHERE id = ?")
    .get(runId) as { scheduling_status: string; workflow_id: string } | undefined;
  if (!run || run.scheduling_status !== "draining_pause") return;

  const runningSteps = db
    .prepare("SELECT type, current_story_id, loop_config FROM steps WHERE run_id = ? AND status = 'running'")
    .all(runId) as Array<{ type: string; current_story_id: string | null; loop_config: string | null }>;
  const hasInFlightStep = runningSteps.some((step) => {
    if (step.type !== "loop" || step.current_story_id || !step.loop_config) return true;
    try {
      const loopConfig = JSON.parse(step.loop_config) as LoopConfig;
      return !(loopConfig.verifyEach ?? loopConfig.verify_each);
    } catch {
      return true;
    }
  });
  if (hasInFlightStep) return;

  // Finalize the pause: clear timers and set status to paused.
  import("./agent-scheduler.js")
    .then((m) => m.removeRunCrons(runId))
    .catch((err) => {
      logger.warn("finalizeDrainingPause: removeRunCrons failed", { runId, error: String(err) });
    });

  db.prepare(
    "UPDATE runs SET status = 'paused', scheduling_status = 'paused', updated_at = datetime('now') WHERE id = ?",
  ).run(runId);

  emitEvent({
    ts: new Date().toISOString(),
    event: "run.paused",
    runId,
    workflowId: run.workflow_id,
  });

  logger.info("Drain-before-pause completed — run now paused", { runId });
}

// ══════════════════════════════════════════════════════════════════════
// Complete Step
// ══════════════════════════════════════════════════════════════════════

/**
 * Complete a step: validate expects, save output, merge context, advance pipeline.
 */
export function completeStep(stepId: string, output: string): { status: string; detail?: string } {
  const db = getDb();

  const step = db.prepare(
    "SELECT id, run_id, step_id, step_index, type, loop_config, current_story_id, expects, input_template, on_fail, invoked_by, fix_rounds FROM steps WHERE id = ?"
  ).get(stepId) as {
    id: string; run_id: string; step_id: string; step_index: number; type: string;
    loop_config: string | null; current_story_id: string | null; expects: string;
    input_template: string | null; on_fail: string | null; invoked_by: string | null; fix_rounds: number;
  } | undefined;

  if (!step) throw new Error(`Step not found: ${stepId}`);

  // Guard: don't process completions for failed runs
  const runId = step.run_id;
  const runCheck = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (runCheck?.status === "failed" || runCheck?.status === "canceled") {
    return { status: "blocked" };
  }

  // Validate output against the expects column before accepting the step
  const validationError = validateExpects(output, step.expects);
  if (validationError) {
    const meta = db.prepare(
      "SELECT retry_count, max_retries FROM steps WHERE id = ?"
    ).get(stepId) as { retry_count: number; max_retries: number } | undefined;
    const newRetry = (meta?.retry_count ?? 0) + 1;
    const maxRetries = meta?.max_retries ?? 0;
    const wfId = getWorkflowId(step.run_id);

    if (newRetry > maxRetries) {
      db.prepare(
        "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(validationError, newRetry, stepId);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: validationError });
      emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Expects validation failed and retries exhausted" });
      scheduleRunCronTeardown(runId);
      finalizeDrainingPause(runId);
      return { status: "failed" };
    }

    db.prepare(
      "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(validationError, newRetry, stepId);
    emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId, workflowId: wfId, stepId: step.step_id, detail: validationError });
    logger.warn(validationError, { runId, stepId: step.step_id });
    finalizeDrainingPause(runId);
    return { status: "retrying", detail: validationError };
  }

  // Merge KEY: value lines into run context
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
  const context: Record<string, string> = JSON.parse(run.context);

  const isGate = parseFixPolicy(step.on_fail) !== null && step.type === "single";
  const parsed = parseOutputKeyValues(output);
  for (const [key, value] of Object.entries(parsed)) {
    if (RESERVED_CONTEXT_KEYS.has(key)) continue;
    if (isGate && key === "findings_json") continue;
    context[key] = value;
  }

  db.prepare(
    "UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(context), runId);

  // Parse STORIES_JSON from output (any step, typically the planner)
  parseAndInsertStories(output, runId);

  // Write story plan to progress log after STORIES_JSON is parsed
  writeStoryPlanToProgress(runId);

  // Robustness: if there is a downstream loop-over-stories and this run still
  // has no stories, the story-producing step's output is incomplete. For steps
  // whose input template mentions STORIES_JSON (planners/story-producers),
  // search the entire downstream pipeline for a loop-over-stories, because an
  // intermediate step like setup may sit between the planner and the loop (as
  // in feature-dev-merge: plan → setup → implement). For other steps, only
  // check the immediately-following step to avoid blaming a non-producing step
  // when a later intermediate step is supposed to generate stories (e.g.
  // security-audit: scan → prioritize(produces stories) → fix(loop)).
  // Honor max_retries so a permanently-broken planner still escalates.
  if (step.type !== "loop") {
    const stepMentionsStories = step.input_template?.includes("STORIES_JSON");
    let downstreamLoopExpectingStories: { id: string; step_id: string; loop_config: string | null } | undefined;

    // Always check the immediately-following step first
    downstreamLoopExpectingStories = db.prepare(
      "SELECT id, step_id, loop_config FROM steps WHERE run_id = ? AND step_index = ? AND type = 'loop'"
    ).get(step.run_id, step.step_index + 1) as { id: string; step_id: string; loop_config: string | null } | undefined;

    // If this step is a story producer and the immediate next is NOT a loop,
    // search further downstream — an intermediate step like setup may sit between
    if (!downstreamLoopExpectingStories && stepMentionsStories) {
      downstreamLoopExpectingStories = db.prepare(
        "SELECT id, step_id, loop_config FROM steps WHERE run_id = ? AND step_index > ? AND type = 'loop' ORDER BY step_index ASC LIMIT 1"
      ).get(step.run_id, step.step_index) as { id: string; step_id: string; loop_config: string | null } | undefined;
    }
    if (downstreamLoopExpectingStories?.loop_config) {
      try {
        const lc = JSON.parse(downstreamLoopExpectingStories.loop_config) as LoopConfig;
        if (lc.over === "stories" && !runHasStories(step.run_id)) {
          const meta = db.prepare(
            "SELECT retry_count, max_retries FROM steps WHERE id = ?"
          ).get(step.id) as { retry_count: number; max_retries: number } | undefined;
          const newRetry = (meta?.retry_count ?? 0) + 1;
          const maxRetries = meta?.max_retries ?? 0;
          const errorDetail =
            `Step output had no STORIES_JSON block, but the next step (${downstreamLoopExpectingStories.step_id}) is a loop over stories. ` +
            `The agent must emit a literal "STORIES_JSON: [ ... ]" line with at least one story. Resetting to pending for retry ${newRetry}/${maxRetries}.`;
          const wfId = getWorkflowId(step.run_id);
          if (newRetry > maxRetries) {
            db.prepare(
              "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(errorDetail, newRetry, step.id);
            db.prepare(
              "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
            ).run(step.run_id);
            emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: errorDetail });
            emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Plan step never produced STORIES_JSON" });
            scheduleRunCronTeardown(step.run_id);
            finalizeDrainingPause(step.run_id);
            return { status: "failed" };
          }
          db.prepare(
            "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(errorDetail, newRetry, step.id);
          logger.warn(errorDetail, { runId: step.run_id, stepId: step.step_id });
          finalizeDrainingPause(step.run_id);
          return { status: "retrying", detail: errorDetail };
        }
      } catch {
        // best-effort: if loop_config can't be parsed, don't block completion
      }
    }
  }

  if (step.invoked_by) {
    const fixStatus = parsed["status"]?.toLowerCase();
    if (fixStatus === "blocked") {
      const blocked = blockRunAtStep({
        runId, stepDbId: step.id, stepName: step.step_id,
        reason: parsed["reason"] || "Fix step reported STATUS: blocked", output,
      });
      finalizeDrainingPause(runId);
      return blocked;
    }
    if (fixStatus === "retry") {
      return retryWithFeedback(step, parsed["reason"] || "Fix step reported STATUS: retry");
    }
    const fixResult = completeFixStep({ ...step, invoked_by: step.invoked_by }, output);
    finalizeDrainingPause(runId);
    return fixResult;
  }

  const fixPolicy = parseFixPolicy(step.on_fail);
  if (fixPolicy && step.type === "single") {
    const reported = parseFindingsJson(output);
    if (reported.malformed) {
      return retryWithFeedback(step, "FINDINGS_JSON could not be parsed. Emit a single-line JSON array after 'FINDINGS_JSON: '.");
    }
    const statusValue = parsed["status"]?.toLowerCase();
    const settlement = settleGate(step, fixPolicy, {
      failed: statusValue === "retry",
      blockedReason: statusValue === "blocked" ? (parsed["reason"] || "Step reported STATUS: blocked") : undefined,
      findings: reported.findings,
      output,
    });
    if (settlement) {
      finalizeDrainingPause(runId);
      return settlement;
    }
  }

  // Loop step completion
  if (step.type === "loop" && step.current_story_id) {
    const storyRow = db.prepare("SELECT story_id, title FROM stories WHERE id = ?").get(step.current_story_id) as { story_id: string; title: string } | undefined;

    // Mark current story done
    db.prepare(
      "UPDATE stories SET status = 'done', output = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(output, step.current_story_id);
    emitEvent({ ts: new Date().toISOString(), event: "story.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id, storyId: storyRow?.story_id, storyTitle: storyRow?.title });
    logger.info(`Story done: ${storyRow?.story_id} — ${storyRow?.title}`, { runId: step.run_id, stepId: step.step_id });

    // Clear current_story_id, save output
    db.prepare(
      "UPDATE steps SET current_story_id = NULL, output = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(output, step.id);

    const loopConfig: LoopConfig | null = step.loop_config ? JSON.parse(step.loop_config) : null;

    // verify_each flow — set verify step to pending. YAML uses snake_case;
    // accept both casings for back-compat with the camelCase types.
    const verifyEachOn = loopConfig?.verifyEach ?? loopConfig?.verify_each;
    const verifyStepId = loopConfig?.verifyStep ?? loopConfig?.verify_step;
    if (verifyEachOn && verifyStepId) {
      const verifyStep = db.prepare(
        "SELECT id FROM steps WHERE run_id = ? AND step_id = ? LIMIT 1"
      ).get(step.run_id, verifyStepId) as { id: string } | undefined;

      if (verifyStep) {
        db.prepare(
          "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
        ).run(verifyStep.id);
        // Loop step stays 'running'
        db.prepare(
          "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?"
        ).run(step.id);
        return { status: "advanced" };
      }
    }

    // No verify_each: check for more stories
    const loopResult = checkLoopContinuation(step.run_id, step.id);
    return { status: loopResult.runCompleted ? "completed" : "advanced" };
  }

  // Check if this is a verify step triggered by verify-each
  const loopStepRow = db.prepare(
    "SELECT id, loop_config, run_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
  ).get(step.run_id) as { id: string; loop_config: string | null; run_id: string } | undefined;

  if (loopStepRow?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStepRow.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep === step.step_id) {
      const verifyResult = handleVerifyEachCompletion(step, loopStepRow.id, output, context);
      return { status: verifyResult.runCompleted ? "completed" : "advanced" };
    }
  }

  // Single step: mark done and advance
  db.prepare(
    "UPDATE steps SET status = 'done', output = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(output, stepId);
  emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id });
  logger.info(`Step completed: ${step.step_id}`, { runId: step.run_id, stepId: step.step_id });

  const pipelineResult = advancePipeline(step.run_id);
  finalizeDrainingPause(step.run_id);
  return { status: pipelineResult.runCompleted ? "completed" : "advanced" };
}

/**
 * Handle verify-each completion: pass or fail the story.
 */
function handleVerifyEachCompletion(
  verifyStep: { id: string; run_id: string; step_id: string; step_index: number },
  loopStepId: string,
  output: string,
  context: Record<string, string>
): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();
  const status = context["status"]?.toLowerCase();

  // Reset verify step to waiting for next use
  db.prepare(
    "UPDATE steps SET status = 'waiting', output = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(output, verifyStep.id);

  if (status !== "retry") {
    emitEvent({ ts: new Date().toISOString(), event: "story.verified", runId: verifyStep.run_id, workflowId: getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id });
  }

  if (status === "retry") {
    const lastDoneStory = db.prepare(
      "SELECT id, retry_count, max_retries FROM stories WHERE run_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1"
    ).get(verifyStep.run_id) as { id: string; retry_count: number; max_retries: number } | undefined;

    if (lastDoneStory) {
      const newRetry = lastDoneStory.retry_count + 1;
      if (newRetry > lastDoneStory.max_retries) {
        db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, lastDoneStory.id);
        db.prepare("UPDATE steps SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
        db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(verifyStep.run_id);
        const wfId = getWorkflowId(verifyStep.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: verifyStep.run_id, workflowId: wfId, stepId: verifyStep.step_id });
        emitRunTerminalEvent({ event: "run.failed", runId: verifyStep.run_id, workflowId: wfId, detail: "Verification retries exhausted" });
        scheduleRunCronTeardown(verifyStep.run_id);
        finalizeDrainingPause(verifyStep.run_id);
        return { advanced: false, runCompleted: false };
      }

      db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, lastDoneStory.id);

      const issues = context["issues"] ?? output;
      context["verify_feedback"] = issues;
      emitEvent({ ts: new Date().toISOString(), event: "story.retry", runId: verifyStep.run_id, workflowId: getWorkflowId(verifyStep.run_id), stepId: verifyStep.step_id, detail: issues });
      db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), verifyStep.run_id);
    }

    db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
    return { advanced: false, runCompleted: false };
  }

  // Verify passed — clear feedback and continue
  delete context["verify_feedback"];
  db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), verifyStep.run_id);

  try {
    return checkLoopContinuation(verifyStep.run_id, loopStepId);
  } catch (err) {
    logger.error(`checkLoopContinuation failed, recovering: ${String(err)}`, { runId: verifyStep.run_id });
    db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(loopStepId);
    return { advanced: false, runCompleted: false };
  }
}

/**
 * Check if the loop has more stories; if so set loop step pending, otherwise done + advance.
 */
function checkLoopContinuation(runId: string, loopStepId: string): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();
  const pendingStory = db.prepare(
    "SELECT id FROM stories WHERE run_id = ? AND status = 'pending' LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  const loopStatus = db.prepare(
    "SELECT status FROM steps WHERE id = ?"
  ).get(loopStepId) as { status: string } | undefined;

  if (pendingStory) {
    if (loopStatus?.status === "failed") {
      return { advanced: false, runCompleted: false };
    }
    db.prepare(
      "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
    ).run(loopStepId);
    return { advanced: false, runCompleted: false };
  }

  const failedStory = db.prepare(
    "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  if (failedStory) {
    db.prepare(
      "UPDATE steps SET status = 'failed', output = ?, updated_at = datetime('now') WHERE id = ?"
    ).run("Loop cannot continue because one or more stories failed", loopStepId);
    db.prepare(
      "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
    ).run(runId);
    const wfId = getWorkflowId(runId);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId, workflowId: wfId, stepId: loopStepId, detail: "Loop has failed stories and no pending stories" });
    emitRunTerminalEvent({ event: "run.failed", runId, workflowId: wfId, detail: "Loop has failed stories and no pending stories" });
    scheduleRunCronTeardown(runId);
    finalizeDrainingPause(runId);
    return { advanced: false, runCompleted: false };
  }

  // All stories done — mark loop step done
  db.prepare(
    "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE id = ?"
  ).run(loopStepId);

  // Also mark verify step done if it exists
  const loopStep = db.prepare("SELECT loop_config, run_id FROM steps WHERE id = ?").get(loopStepId) as { loop_config: string | null; run_id: string } | undefined;
  if (loopStep?.loop_config) {
    const lc: LoopConfig = JSON.parse(loopStep.loop_config);
    const lcVerifyEach = lc.verifyEach ?? lc.verify_each;
    const lcVerifyStep = lc.verifyStep ?? lc.verify_step;
    if (lcVerifyEach && lcVerifyStep) {
      db.prepare(
        "UPDATE steps SET status = 'done', updated_at = datetime('now') WHERE run_id = ? AND step_id = ?"
      ).run(runId, lcVerifyStep);
    }
  }

  return advancePipeline(runId);
}

function retryWithFeedback(
  step: { id: string; run_id: string; step_id: string },
  message: string,
): { status: string; detail?: string } {
  const db = getDb();
  const meta = db.prepare("SELECT retry_count, max_retries FROM steps WHERE id = ?").get(step.id) as
    { retry_count: number; max_retries: number };
  const newRetry = meta.retry_count + 1;
  const wfId = getWorkflowId(step.run_id);
  if (newRetry > meta.max_retries) {
    db.prepare("UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?")
      .run(message, newRetry, step.id);
    db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: message });
    emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: message });
    scheduleRunCronTeardown(step.run_id);
    finalizeDrainingPause(step.run_id);
    return { status: "failed" };
  }
  db.prepare("UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?")
    .run(message, newRetry, step.id);
  emitEvent({ ts: new Date().toISOString(), event: "step.retry", runId: step.run_id, workflowId: wfId, stepId: step.step_id, detail: message });
  finalizeDrainingPause(step.run_id);
  return { status: "retrying", detail: message };
}

/**
 * Complete a `type: bash` step from its exit code and combined output.
 * Bash output is never merged as KEY: value lines; agents read it from `<step>_output`.
 *
 * `blockedReason` marks a failure the fix agent cannot act on (engine error,
 * timeout): a gated step blocks the run instead of starting a fix round, and an
 * ungated step fails through the ordinary retry path with that reason.
 */
export async function completeBashStep(
  stepId: string,
  exitCode: number,
  output: string,
  blockedReason?: string,
): Promise<{ status: string; detail?: string }> {
  const db = getDb();
  const step = db.prepare("SELECT id, run_id, step_id, on_fail, fix_rounds FROM steps WHERE id = ?").get(stepId) as
    { id: string; run_id: string; step_id: string; on_fail: string | null; fix_rounds: number } | undefined;
  if (!step) throw new Error(`Step not found: ${stepId}`);
  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(step.run_id) as { status: string } | undefined;
  if (run?.status !== "running") return { status: "blocked" };

  const evidence = tailLines(output, EVIDENCE_LINES);
  mergeRunContext(step.run_id, { [bashOutputContextKey(step.step_id)]: evidence });

  const policy = parseFixPolicy(step.on_fail);
  if (blockedReason) {
    if (!policy) return failStep(stepId, `${blockedReason}\n${evidence}`);
    const blocked = blockRunAtStep({ runId: step.run_id, stepDbId: step.id, stepName: step.step_id, reason: blockedReason, output: evidence });
    finalizeDrainingPause(step.run_id);
    return blocked;
  }
  if (policy) {
    const settlement = settleGate(step, policy, {
      failed: exitCode !== 0,
      findings: parseFindingsJson(output).findings,
      output: evidence,
    });
    if (settlement) {
      finalizeDrainingPause(step.run_id);
      return settlement;
    }
  } else if (exitCode !== 0) {
    return failStep(stepId, `Command exited with code ${exitCode}\n${evidence}`);
  }

  db.prepare("UPDATE steps SET status = 'done', output = ?, updated_at = datetime('now') WHERE id = ?").run(evidence, stepId);
  emitEvent({ ts: new Date().toISOString(), event: "step.done", runId: step.run_id, workflowId: getWorkflowId(step.run_id), stepId: step.step_id });
  const pipelineResult = advancePipeline(step.run_id);
  finalizeDrainingPause(step.run_id);
  return { status: pipelineResult.runCompleted ? "completed" : "advanced" };
}

// ══════════════════════════════════════════════════════════════════════
// Advance Pipeline
// ══════════════════════════════════════════════════════════════════════

/**
 * Advance the pipeline: find the next waiting step and make it pending, or complete the run.
 * Respects terminal run states — a failed run cannot be advanced or completed.
 */
export function advancePipeline(runId: string): { advanced: boolean; runCompleted: boolean } {
  const db = getDb();

  // Guard: don't advance or complete a run that's already failed/cancelled
  const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (runStatus?.status === "failed" || runStatus?.status === "canceled"
    || runStatus?.status === "blocked") {
    return { advanced: false, runCompleted: false };
  }

  const runningStep = db.prepare(
    "SELECT id FROM steps WHERE run_id = ? AND status = 'running' LIMIT 1"
  ).get(runId) as { id: string } | undefined;
  if (runningStep) {
    return { advanced: false, runCompleted: false };
  }

  const next = db.prepare(
    `SELECT id, step_id FROM steps
     WHERE run_id = ? AND status = 'waiting'
       AND step_id NOT IN (
         SELECT json_extract(on_fail, '$.fix_step') FROM steps
         WHERE run_id = ? AND on_fail IS NOT NULL AND json_extract(on_fail, '$.fix_step') IS NOT NULL
       )
     ORDER BY step_index ASC LIMIT 1`
  ).get(runId, runId) as { id: string; step_id: string } | undefined;

  const incomplete = db.prepare(
    "SELECT id FROM steps WHERE run_id = ? AND status IN ('failed', 'pending', 'running') LIMIT 1"
  ).get(runId) as { id: string } | undefined;

  if (!next && incomplete) {
    return { advanced: false, runCompleted: false };
  }

  const wfId = getWorkflowId(runId);
  if (next) {
    db.prepare(
      "UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
    ).run(next.id);
    emitEvent({ ts: new Date().toISOString(), event: "pipeline.advanced", runId, workflowId: wfId, stepId: next.step_id });
    emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId, workflowId: wfId, stepId: next.step_id });
    return { advanced: true, runCompleted: false };
  } else {
    db.prepare(
      "UPDATE runs SET status = 'completed', updated_at = datetime('now') WHERE id = ?"
    ).run(runId);
    emitRunTerminalEvent({ event: "run.completed", runId, workflowId: wfId });
    logger.info("Run completed", { runId, workflowId: wfId });
    archiveRunProgress(runId);
    scheduleRunCronTeardown(runId);
    finalizeDrainingPause(runId);
    return { advanced: false, runCompleted: true };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Progress Archiving
// ══════════════════════════════════════════════════════════════════════

/**
 * Archive the run's progress file to the agent workspace archive directory.
 */
export function archiveRunProgress(runId: string): void {
  const db = getDb();
  const loopStep = db.prepare(
    "SELECT agent_id FROM steps WHERE run_id = ? AND type = 'loop' LIMIT 1"
  ).get(runId) as { agent_id: string } | undefined;
  if (!loopStep) return;

  const workspace = getAgentWorkspacePath(loopStep.agent_id);
  if (!workspace) return;

  const scopedPath = path.join(workspace, `progress-${runId}.txt`);
  const legacyPath = path.join(workspace, "progress.txt");
  const progressPath = fs.existsSync(scopedPath) ? scopedPath : legacyPath;
  if (!fs.existsSync(progressPath)) return;

  const archiveDir = path.join(workspace, "archive", runId);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.copyFileSync(progressPath, path.join(archiveDir, "progress.txt"));
  fs.unlinkSync(progressPath);
}

// ══════════════════════════════════════════════════════════════════════
// Fail Step
// ══════════════════════════════════════════════════════════════════════

function resolveEscalationTarget(policy: WorkflowStepFailure | null): string | null {
  const escalateTo = policy?.on_exhausted?.escalate_to || policy?.escalate_to;
  if (!escalateTo) return null;

  const normalized = escalateTo.trim().toLowerCase();
  if (normalized === "human" || normalized === "main") return "agent:main:main";
  if (normalized.startsWith("agent:")) return escalateTo;
  return null;
}

async function getOnFailPolicy(runId: string, stepId: string): Promise<WorkflowStepFailure | null> {
  try {
    const db = getDb();
    const run = db.prepare("SELECT workflow_id FROM runs WHERE id = ?").get(runId) as { workflow_id: string } | undefined;
    if (!run) return null;

    const workflowDir = resolveWorkflowDir(run.workflow_id);
    const workflow = await loadWorkflowSpec(workflowDir);
    const step = workflow.steps.find((s) => s.id === stepId);
    return step?.on_fail ?? null;
  } catch {
    return null;
  }
}

/**
 * Fail a step, with retry logic. For loop steps, applies per-story retry.
 * Handles escalate_on_failure by logging the escalation target.
 */
export async function failStep(stepId: string, error: string): Promise<{ status: string }> {
  const db = getDb();

  const step = db.prepare(
    "SELECT run_id, step_id, retry_count, max_retries, type, current_story_id FROM steps WHERE id = ?"
  ).get(stepId) as {
    run_id: string;
    step_id: string;
    retry_count: number;
    max_retries: number;
    type: string;
    current_story_id: string | null;
  } | undefined;

  if (!step) throw new Error(`Step not found: ${stepId}`);

  // Loop step failure — per-story retry
  if (step.type === "loop" && step.current_story_id) {
    const story = db.prepare(
      "SELECT id, retry_count, max_retries FROM stories WHERE id = ?"
    ).get(step.current_story_id) as { id: string; retry_count: number; max_retries: number } | undefined;

    if (story) {
      const storyRow = db.prepare("SELECT story_id, title FROM stories WHERE id = ?").get(step.current_story_id!) as { story_id: string; title: string } | undefined;
      const newRetry = story.retry_count + 1;
      if (newRetry > story.max_retries) {
        db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
        db.prepare("UPDATE steps SET status = 'failed', output = ?, current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(error, stepId);
        db.prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(step.run_id);
        const wfId = getWorkflowId(step.run_id);
        emitEvent({ ts: new Date().toISOString(), event: "story.failed", runId: step.run_id, workflowId: wfId, stepId, storyId: storyRow?.story_id, storyTitle: storyRow?.title, detail: error });
        emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId, stepId, detail: error });
        emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId, detail: "Story retries exhausted" });
        scheduleRunCronTeardown(step.run_id);
        finalizeDrainingPause(step.run_id);

        // Escalation: log the target if configured
        try {
          const policy = await getOnFailPolicy(step.run_id, step.step_id);
          const target = resolveEscalationTarget(policy);
          if (target) {
            logger.warn(`Step failure exhausted — escalation target: ${target}`, { runId: step.run_id, stepId: step.step_id, error });
          }
        } catch {
          // escalation logging is best-effort
        }

        return { status: "failed" };
      }

      // Retry the story
      db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
      db.prepare("UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?").run(stepId);
      finalizeDrainingPause(step.run_id);
      return { status: "retrying" };
    }
  }

  // Single step: existing logic
  const newRetryCount = step.retry_count + 1;

  if (newRetryCount > step.max_retries) {
    db.prepare(
      "UPDATE steps SET status = 'failed', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(error, newRetryCount, stepId);
    db.prepare(
      "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
    ).run(step.run_id);
    const wfId2 = getWorkflowId(step.run_id);
    emitEvent({ ts: new Date().toISOString(), event: "step.failed", runId: step.run_id, workflowId: wfId2, stepId, detail: error });
    emitRunTerminalEvent({ event: "run.failed", runId: step.run_id, workflowId: wfId2, detail: "Step retries exhausted" });
    scheduleRunCronTeardown(step.run_id);
    finalizeDrainingPause(step.run_id);

    // Escalation: log the target if configured
    try {
      const policy = await getOnFailPolicy(step.run_id, step.step_id);
      const target = resolveEscalationTarget(policy);
      if (target) {
        logger.warn(`Step failure exhausted — escalation target: ${target}`, { runId: step.run_id, stepId: step.step_id, error });
      }
    } catch {
      // escalation logging is best-effort
    }

    // Rugpull detection: for single step failures, check if the base branch
    // moved under the run and launch a replacement. Fire-and-forget via
    // setImmediate so errors never block step failure completion.
    if (step.type !== "loop") {
      setImmediate(async () => {
        try {
          const rugResult = detectRugpull(step.run_id);
          if (rugResult.isRugpull) {
            emitEvent({
              ts: new Date().toISOString(),
              event: "run.rugpull_detected",
              runId: step.run_id,
              workflowId: wfId2,
              detail: rugResult.reason,
            });
            const relaunchResult = await relaunchRunAfterRugpull(step.run_id);
            if (!relaunchResult.relaunched) {
              // The function itself emits events for all failure/suppression paths,
              // but log a warning so the failure is visible in system logs as well.
              logger.warn("Rugpull relaunch did not launch a replacement run", {
                runId: step.run_id,
                result: relaunchResult,
              });
            }
          }
        } catch (err) {
          // fire-and-forget — errors must not prevent step failure from completing
          logger.error("Rugpull detection/relaunch threw unexpectedly", {
            runId: step.run_id,
            error: String(err),
          });
        }
      });
    }

    return { status: "failed" };
  } else {
    db.prepare(
      "UPDATE steps SET status = 'pending', output = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(error, newRetryCount, stepId);
    finalizeDrainingPause(step.run_id);
    return { status: "retrying" };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Resolve Step Context
// ══════════════════════════════════════════════════════════════════════

/**
 * Resolve the full template context for a step in a run.
 * Collects context from the run's saved context, previous steps' KEY: value output,
 * and computed values like branch info, PR info, and frontend detection.
 * Optionally adds story context for loop steps.
 */
export function resolveStepContext(
  runId: string,
  stepIndex: number,
  loopConfig?: LoopConfig,
  story?: Story
): Record<string, string> {
  const db = getDb();

  // Start with the run's stored context
  const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
  const context: Record<string, string> = run ? JSON.parse(run.context) : {};

  // Always inject run_id so templates can use {{run_id}}
  context["run_id"] = runId;

  // Collect output from previous completed steps
  const prevSteps = db.prepare(
    "SELECT id, output, step_id, type FROM steps WHERE run_id = ? AND step_index < ? AND status IN ('done', 'skipped') ORDER BY step_index ASC"
  ).all(runId, stepIndex) as { id: string; output: string | null; step_id: string; type: string }[];

  for (const prev of prevSteps) {
    if (prev.type === "bash") continue;
    if (prev.output) {
      const parsed = parseOutputKeyValues(prev.output);
      for (const [key, value] of Object.entries(parsed)) {
        if (!RESERVED_CONTEXT_KEYS.has(key)) {
          context[key] = value;
        }
      }
    }
  }

  // Add branch info and PR detection context (extracted from previous step outputs)
  if (context["repo"] && context["branch"]) {
    context["has_frontend_changes"] = computeHasFrontendChanges(context["repo"], context["branch"]);
  }

  // Add PR info if available from context
  if (context["pr_url"]) {
    context["has_pr"] = "true";
  }

  // Add story context for loop steps
  if (story && loopConfig) {
    context["current_story"] = formatStoryForTemplate(story);
    context["current_story_id"] = story.storyId;
    context["current_story_title"] = story.title;

    const allStories = getStories(runId);
    context["completed_stories"] = formatCompletedStories(allStories);
    const pendingCount = allStories.filter((s) => s.status === "pending" || s.status === "running").length;
    context["stories_remaining"] = String(pendingCount);
    context["progress"] = readProgressFile(runId);

    if (!context["verify_feedback"]) {
      context["verify_feedback"] = "";
    }
  }

  return context;
}
