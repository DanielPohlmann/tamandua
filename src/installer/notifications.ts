import { getDb } from "../db.js";
import type { TamanduaEvent } from "./events.js";

export type NotifyFormat = "json" | "ntfy";

const NTFY_EVENTS = new Set(["run.blocked", "run.pr_opened", "run.failed", "run.completed"]);

function asFormat(value: string | undefined): NotifyFormat | undefined {
  return value === "ntfy" || value === "json" ? value : undefined;
}

function isNtfyHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "ntfy.sh" || host.endsWith(".ntfy.sh");
  } catch {
    return false;
  }
}

/** A header-safe (percent-encoded) URL, or undefined when the value does not parse as one. */
function asHeaderUrl(value: string | undefined): string | undefined {
  try {
    return value ? new URL(value).href : undefined;
  } catch {
    return undefined;
  }
}

export function resolveNotifyTarget(params: {
  explicitUrl?: string;
  explicitFormat?: NotifyFormat;
  workflow?: { notifications?: { url?: string; format?: string } };
}): { url: string | null; format: NotifyFormat } {
  const url = params.explicitUrl
    || process.env.TAMANDUA_NOTIFY_URL?.trim()
    || params.workflow?.notifications?.url
    || null;
  if (!url) return { url: null, format: "json" };
  const declared = params.explicitFormat
    ?? asFormat(process.env.TAMANDUA_NOTIFY_FORMAT?.trim())
    ?? asFormat(params.workflow?.notifications?.format);
  return { url, format: declared ?? (isNtfyHost(url) ? "ntfy" : "json") };
}

export function detectOpenedPr(previousPr: string | undefined, nextPr: string | undefined): string | null {
  const next = nextPr?.trim();
  if (!next || !/^https?:\/\/\S+$/.test(next)) return null;
  return next === previousPr?.trim() ? null : next;
}

export function buildNtfyRequest(evt: TamanduaEvent): { body: string; headers: Record<string, string> } | null {
  if (!NTFY_EVENTS.has(evt.event)) return null;
  const db = getDb();
  const run = db.prepare("SELECT run_number, workflow_id, context FROM runs WHERE id = ?").get(evt.runId) as
    { run_number: number | null; workflow_id: string; context: string } | undefined;
  const label = `${run?.workflow_id ?? evt.workflowId ?? "run"} #${run?.run_number ?? evt.runId.slice(0, 8)}`;

  if (evt.event === "run.blocked") {
    const context = run ? (JSON.parse(run.context) as Record<string, string>) : {};
    const step = db.prepare("SELECT fix_rounds FROM steps WHERE run_id = ? AND step_id = ?").get(evt.runId, evt.stepId ?? "") as
      { fix_rounds: number } | undefined;
    const open = db.prepare("SELECT COUNT(*) AS cnt FROM findings WHERE run_id = ? AND status IN ('open', 'repeated', 'disputed') AND severity != 'minor'")
      .get(evt.runId) as { cnt: number };
    return {
      headers: { Title: `Run blocked: ${label}`, Tags: "warning", Priority: "high" },
      body: [
        evt.detail ?? "Run blocked",
        `Run: ${evt.runId}`,
        `Gate: ${evt.stepId ?? "-"}`,
        `Round: ${step?.fix_rounds ?? 0}`,
        `Open findings: ${open.cnt}`,
        `Worktree: ${context.worktree_path ?? context.repo ?? "-"}`,
      ].join("\n"),
    };
  }
  if (evt.event === "run.pr_opened") {
    const click = asHeaderUrl(evt.detail);
    return {
      headers: { Title: `PR opened: ${label}`, Tags: "rocket", Priority: "default", ...(click ? { Click: click } : {}) },
      body: evt.detail ?? "PR opened",
    };
  }
  const failed = evt.event === "run.failed";
  return {
    headers: { Title: `${failed ? "Run failed" : "Run completed"}: ${label}`, Tags: failed ? "x" : "white_check_mark", Priority: "default" },
    body: evt.detail ?? evt.event,
  };
}
