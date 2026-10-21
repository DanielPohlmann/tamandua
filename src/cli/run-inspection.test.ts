import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../../dist/db.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";
import {
  buildRunStatusJson,
  loadRunContext,
  parseFindingsArgs,
  formatFindingsText,
  parseResumeOverrides,
  hasOverrides,
} from "../../dist/cli/run-inspection.js";

const DETAIL = {
  id: "11111111-2222-3333-4444-555555555555",
  workflowId: "superpowers-feature",
  task: "t",
  status: "running",
  createdAt: "c",
  updatedAt: "u",
  tokensSpent: 1234,
  steps: [
    { stepId: "gate-review", agentId: "wf_reviewer", status: "waiting", type: "single", retryCount: 0 },
    { stepId: "pr", agentId: "wf_pr", status: "waiting", type: "single", retryCount: 0 },
    { stepId: "fix", agentId: "wf_developer", status: "pending", type: "single", retryCount: 0 },
  ],
};

describe("buildRunStatusJson", () => {
  it("reports the pending step and the PR url", () => {
    const json = buildRunStatusJson(DETAIL as never, { pr: "https://github.com/o/r/pull/3", fix_feedback: "[]" });
    assert.deepEqual(json, {
      id: DETAIL.id,
      status: "running",
      currentStepId: "fix",
      blockedStep: null,
      blockedReason: null,
      pausedUntil: null,
      tokensSpent: 1234,
      context: { pr: "https://github.com/o/r/pull/3" },
    });
  });

  it("falls back to the blocked step and omits an absent PR", () => {
    const blocked = { ...DETAIL, status: "blocked", steps: DETAIL.steps.map((s) => ({ ...s, status: "waiting" })) };
    const json = buildRunStatusJson(blocked as never, { blocked_step: "gate-review", blocked_reason: "disputed" });
    assert.equal(json.currentStepId, "gate-review");
    assert.equal(json.blockedReason, "disputed");
    assert.deepEqual(json.context, {});
  });

  it("exposes the rate-limit resume time as pausedUntil", () => {
    const at = "2026-10-21T12:00:00.000Z";
    assert.equal(buildRunStatusJson(DETAIL as never, { rate_limit_resume_at: at }).pausedUntil, at);
  });
});

describe("loadRunContext", () => {
  let home: TempTamanduaHome;
  beforeEach(() => { home = useTempTamanduaHome("tamandua-run-inspection-"); });
  afterEach(() => { closeDb(); home.restore(); });

  it("returns the stored context, or an empty one for an unknown run", () => {
    seedRun(getDb(), { id: "run-1", context: { pr: "u" } }, []);
    assert.deepEqual(loadRunContext("run-1"), { pr: "u" });
    assert.deepEqual(loadRunContext("nope"), {});
  });
});

describe("flag parsing", () => {
  it("parses findings flags", () => {
    assert.deepEqual(parseFindingsArgs(["--json", "--status", "open", "--gate", "gate-review"]), { json: true, status: "open", gate: "gate-review" });
    assert.deepEqual(parseFindingsArgs([]), { json: false });
    assert.throws(() => parseFindingsArgs(["--status", "closed"]), /--status must be one of open, resolved, disputed, repeated/);
  });

  it("parses resume budget overrides", () => {
    assert.deepEqual(parseResumeOverrides(["--max-rounds", "5", "--max-fix-rounds=12", "--max-tokens", "6000000"]),
      { maxRounds: 5, maxFixRounds: 12, maxTokens: 6000000 });
    assert.equal(hasOverrides(parseResumeOverrides([])), false);
    assert.throws(() => parseResumeOverrides(["--max-rounds", "0"]), /--max-rounds must be a positive integer/);
    assert.throws(() => parseResumeOverrides(["--max-tokens"]), /--max-tokens must be a positive integer/);
  });
});

describe("formatFindingsText", () => {
  it("prints one line per finding and a placeholder when empty", () => {
    const text = formatFindingsText([{
      fingerprint: "abcdef0123456789abcdef0123456789abcdef01", gate: "gate-review", rule: "review/naming",
      severity: "major", status: "open", file: "src/A.cs", line: 3, evidence: "bad\nmore", round: 2,
    } as never]);
    assert.equal(text, "[open     ] major    gate-review  review/naming  src/A.cs:3  abcdef01  bad");
    assert.equal(formatFindingsText([]), "No findings.");
  });
});
