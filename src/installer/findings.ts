import crypto from "node:crypto";
import { getDb } from "../db.js";

export type FindingSeverity = "blocking" | "major" | "minor";
export type FindingStatus = "open" | "resolved" | "disputed" | "repeated";

export interface Finding {
  rule: string;
  severity: FindingSeverity;
  file: string;
  line?: number;
  symbol?: string;
  evidence: string;
  expected?: string;
}

export interface StoredFinding extends Finding {
  id: string;
  runId: string;
  gate: string;
  fingerprint: string;
  round: number;
  status: FindingStatus;
  disputeReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FixReport {
  resolved: string[];
  disputed: Array<{ fingerprint: string; reason: string }>;
}

export const ENGINE_FINDING_FILE = ".";

const SEVERITIES = new Set<FindingSeverity>(["blocking", "major", "minor"]);

export function fingerprintFinding(gate: string, finding: Pick<Finding, "rule" | "file" | "symbol">): string {
  return crypto
    .createHash("sha1")
    .update([gate, finding.rule, finding.file, finding.symbol ?? ""].join("|"))
    .digest("hex");
}

export function isActionable(finding: Pick<Finding, "severity">): boolean {
  return finding.severity !== "minor";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!nonEmptyString(r.rule) || !nonEmptyString(r.file) || !nonEmptyString(r.evidence)) return null;
  if (typeof r.severity !== "string" || !SEVERITIES.has(r.severity as FindingSeverity)) return null;
  const finding: Finding = {
    rule: r.rule.trim(),
    severity: r.severity as FindingSeverity,
    file: r.file.trim(),
    evidence: r.evidence,
  };
  if (typeof r.line === "number" && Number.isInteger(r.line)) finding.line = r.line;
  if (nonEmptyString(r.symbol)) finding.symbol = r.symbol.trim();
  if (nonEmptyString(r.expected)) finding.expected = r.expected;
  return finding;
}

const KEY_LINE = /^\s*(?:\*\*)?([A-Z_]+)(?:\*\*)?:(?:\*\*)?(.*)$/;

function tryParse(text: string): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: JSON.parse(text.trim()) };
  } catch {
    return { ok: false };
  }
}

function extractKeyedJson(output: string, key: string): { present: boolean; value?: unknown } {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => KEY_LINE.exec(line)?.[1] === key);
  if (start === -1) return { present: false };
  const rest = KEY_LINE.exec(lines[start])![2];
  const single = tryParse(rest);
  if (single.ok) return { present: true, value: single.value };
  const parts = [rest];
  for (let i = start + 1; i < lines.length; i++) {
    if (KEY_LINE.test(lines[i]) || lines[i].trimStart().startsWith("```")) break;
    parts.push(lines[i]);
  }
  const multi = tryParse(parts.join("\n"));
  return multi.ok ? { present: true, value: multi.value } : { present: true };
}

export function parseFindingsJson(output: string): { present: boolean; malformed: boolean; findings: Finding[] } {
  const block = extractKeyedJson(output, "FINDINGS_JSON");
  if (!block.present) return { present: false, malformed: false, findings: [] };
  if (!Array.isArray(block.value)) return { present: true, malformed: true, findings: [] };
  const findings = block.value.map(normalizeFinding).filter((f): f is Finding => f !== null);
  return { present: true, malformed: false, findings };
}

export function parseResolved(output: string): string[] {
  const block = extractKeyedJson(output, "RESOLVED");
  return Array.isArray(block.value) ? block.value.filter(nonEmptyString) : [];
}

export function parseDisputed(output: string): FixReport["disputed"] {
  const block = extractKeyedJson(output, "DISPUTED_JSON");
  if (!Array.isArray(block.value)) return [];
  return block.value
    .filter((d): d is { fingerprint: string; reason: string } =>
      !!d && typeof d === "object" && nonEmptyString((d as Record<string, unknown>).fingerprint)
        && nonEmptyString((d as Record<string, unknown>).reason))
    .map((d) => ({ fingerprint: d.fingerprint, reason: d.reason }));
}

interface FindingRow {
  id: string;
  run_id: string;
  gate: string;
  fingerprint: string;
  severity: FindingSeverity;
  payload: string;
  round: number;
  status: FindingStatus;
  created_at: string;
  updated_at: string;
}

function toStored(row: FindingRow): StoredFinding {
  const payload = JSON.parse(row.payload) as Finding & { disputeReason?: string };
  return {
    ...payload,
    id: row.id,
    runId: row.run_id,
    gate: row.gate,
    fingerprint: row.fingerprint,
    severity: row.severity,
    round: row.round,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getFindingRow(runId: string, fingerprint: string): FindingRow | undefined {
  return getDb()
    .prepare("SELECT * FROM findings WHERE run_id = ? AND fingerprint = ?")
    .get(runId, fingerprint) as FindingRow | undefined;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { blocking: 2, major: 1, minor: 0 };

function dedupeByFingerprint(gate: string, findings: Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const finding of findings) {
    const fingerprint = fingerprintFinding(gate, finding);
    const kept = byFingerprint.get(fingerprint);
    if (!kept) {
      byFingerprint.set(fingerprint, { ...finding });
      continue;
    }
    const winner = SEVERITY_RANK[finding.severity] > SEVERITY_RANK[kept.severity] ? finding : kept;
    const other = winner === kept ? finding : kept;
    byFingerprint.set(fingerprint, { ...winner, evidence: `${winner.evidence}\n---\n${other.evidence}` });
  }
  return [...byFingerprint.values()];
}

export function recordGateFindings(params: {
  runId: string;
  gate: string;
  round: number;
  findings: Finding[];
}): { stored: StoredFinding[]; actionable: StoredFinding[]; disputedReRaised: StoredFinding[] } {
  const db = getDb();
  const now = new Date().toISOString();
  const stored: StoredFinding[] = [];
  const disputedReRaised: StoredFinding[] = [];

  for (const finding of dedupeByFingerprint(params.gate, params.findings)) {
    const fingerprint = fingerprintFinding(params.gate, finding);
    const existing = getFindingRow(params.runId, fingerprint);
    if (!existing) {
      db.prepare(
        `INSERT INTO findings (id, run_id, gate, fingerprint, severity, payload, round, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(crypto.randomUUID(), params.runId, params.gate, fingerprint, finding.severity,
        JSON.stringify(finding), params.round, now, now);
    } else {
      const previous = JSON.parse(existing.payload) as { disputeReason?: string };
      const nextStatus: FindingStatus = existing.status === "disputed" ? "disputed" : "repeated";
      const payload = JSON.stringify({ ...finding, ...(previous.disputeReason ? { disputeReason: previous.disputeReason } : {}) });
      db.prepare(
        "UPDATE findings SET severity = ?, payload = ?, round = ?, status = ?, updated_at = ? WHERE id = ?",
      ).run(finding.severity, payload, params.round, nextStatus, now, existing.id);
    }
    const row = toStored(getFindingRow(params.runId, fingerprint)!);
    stored.push(row);
    if (row.status === "disputed" && isActionable(row)) disputedReRaised.push(row);
  }

  const actionable = stored.filter((f) => isActionable(f) && f.status !== "disputed");
  return { stored, actionable, disputedReRaised };
}

export function resolveGateFindings(runId: string, gate: string): void {
  getDb().prepare(
    `UPDATE findings SET status = 'resolved', updated_at = ?
     WHERE run_id = ? AND gate = ? AND severity != 'minor' AND status IN ('open', 'repeated')`,
  ).run(new Date().toISOString(), runId, gate);
}

export function applyFixReport(runId: string, report: FixReport): void {
  const db = getDb();
  const now = new Date().toISOString();
  for (const fingerprint of report.resolved) {
    db.prepare(
      "UPDATE findings SET status = 'resolved', updated_at = ? WHERE run_id = ? AND fingerprint = ? AND status IN ('open', 'repeated')",
    ).run(now, runId, fingerprint);
  }
  for (const dispute of report.disputed) {
    const row = getFindingRow(runId, dispute.fingerprint);
    if (!row || (row.status !== "open" && row.status !== "repeated")) continue;
    const payload = { ...(JSON.parse(row.payload) as object), disputeReason: dispute.reason };
    db.prepare("UPDATE findings SET status = 'disputed', payload = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(payload), now, row.id);
  }
}

export function listFindings(
  runId: string,
  filter: { status?: FindingStatus; gate?: string; severity?: FindingSeverity } = {},
): StoredFinding[] {
  const clauses = ["run_id = ?"];
  const params: string[] = [runId];
  if (filter.status) { clauses.push("status = ?"); params.push(filter.status); }
  if (filter.gate) { clauses.push("gate = ?"); params.push(filter.gate); }
  if (filter.severity) { clauses.push("severity = ?"); params.push(filter.severity); }
  const rows = getDb()
    .prepare(`SELECT * FROM findings WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, gate ASC`)
    .all(...params) as unknown as FindingRow[];
  return rows.map(toStored);
}

export function formatMinorFindings(runId: string): string {
  const minors = listFindings(runId, { severity: "minor" });
  if (minors.length === 0) return "(none)";
  return minors
    .map((f) => `- [${f.gate}] ${f.rule} — ${f.file}${f.line ? `:${f.line}` : ""} — ${f.evidence.split("\n")[0]}`)
    .join("\n");
}

export function deleteRunFindings(runId: string): void {
  getDb().prepare("DELETE FROM findings WHERE run_id = ?").run(runId);
}
