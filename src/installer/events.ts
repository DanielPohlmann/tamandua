import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePiStateDir } from "./paths.js";
import { logger } from "../lib/logger.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TamanduaEvent {
  ts: string;
  event: string;
  runId: string;
  workflowId?: string;
  stepId?: string;
  storyId?: string;
  storyTitle?: string;
  agentId?: string;
  detail?: string;
  tokenDelta?: number;
  tokensSpent?: number;
}

export type EventCursorSource =
  | { kind: "global" }
  | { kind: "run"; runId: string };

export interface EventCursorReadResult {
  events: TamanduaEvent[];
  nextOffset: number;
}

// ── Paths ────────────────────────────────────────────────────────────

function getEventsDir(): string {
  return path.join(resolvePiStateDir(), "events");
}

function getEventsFile(runId: string): string {
  return path.join(getEventsDir(), `${runId}.jsonl`);
}

function getGlobalEventsFile(): string {
  return path.join(getEventsDir(), "all.jsonl");
}

function getEventsFileForSource(source: EventCursorSource): string {
  if (source.kind === "global") return getGlobalEventsFile();
  return getEventsFile(source.runId);
}

// ── Event Emission ───────────────────────────────────────────────────

/**
 * Emit a Tamandua event.
 *
 * Writes:
 * 1. To the run-specific JSONL file (~/.tamandua/events/<runId>.jsonl)
 * 2. To the global JSONL file (~/.tamandua/events/all.jsonl)
 * 3. Fires a webhook if a notify URL is configured for the run (fire-and-forget)
 */
export function emitEvent(evt: TamanduaEvent): void {
  const line = JSON.stringify(evt) + "\n";

  // Ensure events directory exists
  const eventsDir = getEventsDir();
  fs.mkdirSync(eventsDir, { recursive: true });

  // Write to run-specific events file
  const runFile = getEventsFile(evt.runId);
  try {
    fs.appendFileSync(runFile, line, "utf-8");
  } catch (err) {
    logger.warn("Failed to write run event", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  }

  // Write to global events file
  const globalFile = getGlobalEventsFile();
  try {
    fs.appendFileSync(globalFile, line, "utf-8");
  } catch (err) {
    logger.warn("Failed to write global event", {
      event: evt.event,
      error: String(err),
    });
  }

  // Fire-and-forget webhook if applicable
  fireWebhook(evt).catch((err) => {
    logger.warn("Webhook delivery failed", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  });
}

// ── Event Reading ────────────────────────────────────────────────────

/**
 * Read events appended after a byte offset from either:
 * - ~/.tamandua/events/all.jsonl (global)
 * - ~/.tamandua/events/<runId>.jsonl (per-run)
 *
 * Returns only complete newline-terminated records and the next cursor offset.
 * Malformed JSON lines are skipped safely.
 */
export function readEventsFromCursor(source: EventCursorSource, offset = 0): EventCursorReadResult {
  const eventsFile = getEventsFileForSource(source);
  const safeOffset = Math.max(0, Math.floor(offset));

  let fileBuffer: Buffer;
  try {
    fileBuffer = fs.readFileSync(eventsFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { events: [], nextOffset: 0 };

    logger.warn("Failed to read event cursor source", {
      source: source.kind,
      runId: source.kind === "run" ? source.runId : undefined,
      error: String(err),
    });
    return { events: [], nextOffset: safeOffset };
  }

  const startOffset = safeOffset > fileBuffer.length ? 0 : safeOffset;
  let cursor = startOffset;
  const events: TamanduaEvent[] = [];

  while (cursor < fileBuffer.length) {
    const newlineIndex = fileBuffer.indexOf(0x0A, cursor);
    if (newlineIndex === -1) break; // trailing partial line

    const lineBuffer = fileBuffer.subarray(cursor, newlineIndex);
    cursor = newlineIndex + 1;

    if (lineBuffer.length === 0) continue;

    const line = lineBuffer.toString("utf-8").replace(/\r$/, "");
    if (!line) continue;

    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        events.push(parsed as TamanduaEvent);
      }
    } catch {
      // Ignore malformed JSONL rows so later valid events still stream.
    }
  }

  return { events, nextOffset: cursor };
}

/**
 * Read the most recent N events from the global events file.
 */
export function getRecentEvents(limit = 50): TamanduaEvent[] {
  const globalFile = getGlobalEventsFile();
  try {
    const content = fs.readFileSync(globalFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const recent = lines.slice(-limit);
    return recent.map((line) => {
      try {
        return JSON.parse(line) as TamanduaEvent;
      } catch {
        return null;
      }
    }).filter((e): e is TamanduaEvent => e !== null);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logger.warn("Failed to read global events", { error: String(err) });
    return [];
  }
}

/**
 * Read all events for a specific run.
 */
export function getRunEvents(runId: string): TamanduaEvent[] {
  const runFile = getEventsFile(runId);
  try {
    const content = fs.readFileSync(runFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      try {
        return JSON.parse(line) as TamanduaEvent;
      } catch {
        return null;
      }
    }).filter((e): e is TamanduaEvent => e !== null);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logger.warn("Failed to read run events", { runId, error: String(err) });
    return [];
  }
}

/**
 * Get the path to the events directory.
 */
export function getEventsPath(): string {
  return getEventsDir();
}

// ── Webhook Support ──────────────────────────────────────────────────

function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid url)";
  }
}

/**
 * Fire-and-forget POST to the webhook URL configured for a run.
 * Looks up the notify_url from the runs table.
 * Does not throw — webhook failures are logged and swallowed.
 */
async function fireWebhook(evt: TamanduaEvent): Promise<void> {
  // Only notify on significant events to avoid flooding
  const significantEvents = new Set([
    "run.started",
    "run.completed",
    "run.failed",
    "step.failed",
    "step.worker_lost",
    "pipeline.advanced",
    "run.blocked",
    "run.pr_opened",
  ]);

  if (!significantEvents.has(evt.event)) return;

  let notifyUrl: string | undefined;
  let notifyFormat: string | null = null;

  // Try to look up notify_url from the DB
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT notify_url, notify_format FROM runs WHERE id = ?")
      .get(evt.runId) as { notify_url: string | null; notify_format: string | null } | undefined;
    notifyUrl = row?.notify_url ?? undefined;
    notifyFormat = row?.notify_format ?? null;
  } catch {
    // DB might not be available — skip webhook
    return;
  }

  if (!notifyUrl) return;

  // Use global fetch (Node 18+)
  try {
    let body = JSON.stringify(evt);
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    if (notifyFormat === "ntfy") {
      const { buildNtfyRequest } = await import("./notifications.js");
      const request = buildNtfyRequest(evt);
      if (!request) return;
      body = request.body;
      headers = { "Content-Type": "text/plain; charset=utf-8", ...request.headers };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      await fetch(notifyUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // Fire-and-forget: log and move on. Only the origin is logged: the path may hold a secret topic or token.
    logger.warn("Webhook POST failed", {
      url: urlOrigin(notifyUrl),
      event: evt.event,
      runId: evt.runId,
      error: String(err),
    });
  }
}
