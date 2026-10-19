import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../../dist/db.js";
import {
  fingerprintFinding,
  parseFindingsJson,
  parseResolved,
  parseDisputed,
  recordGateFindings,
  resolveGateFindings,
  applyFixReport,
  listFindings,
  formatMinorFindings,
  deleteRunFindings,
} from "../../dist/installer/findings.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

describe("findings schema", () => {
  let home: TempTamanduaHome;
  beforeEach(() => { home = useTempTamanduaHome("tamandua-findings-"); });
  afterEach(() => { closeDb(); home.restore(); });

  it("creates the findings table and the gate-loop columns", () => {
    const db = getDb();
    const columns = (table: string) =>
      new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    assert.deepEqual(
      [...columns("findings")].sort(),
      ["created_at", "fingerprint", "gate", "id", "payload", "round", "run_id", "severity", "status", "updated_at"],
    );
    for (const name of ["run_command", "on_fail", "invoked_by", "fix_rounds"]) {
      assert.ok(columns("steps").has(name), `steps.${name}`);
    }
    for (const name of ["fix_rounds", "max_fix_rounds", "max_rounds_override"]) {
      assert.ok(columns("runs").has(name), `runs.${name}`);
    }
  });
});

const BLOCKING = {
  rule: "ddd/cross-context-import",
  severity: "blocking",
  file: "src/Scheduling/BookAppointmentHandler.cs",
  line: 42,
  symbol: "BookAppointmentHandler",
  evidence: "uses Payments.Domain.Charge",
};

describe("finding parsing", () => {
  it("fingerprints ignore the line number", () => {
    const a = fingerprintFinding("gate-review", { ...BLOCKING });
    const b = fingerprintFinding("gate-review", { rule: BLOCKING.rule, file: BLOCKING.file, symbol: BLOCKING.symbol });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{40}$/);
    assert.notEqual(a, fingerprintFinding("gate-security", BLOCKING));
  });

  it("parses FINDINGS_JSON and drops findings without file, rule, evidence or a known severity", () => {
    const output = [
      "STATUS: retry",
      `FINDINGS_JSON: [${JSON.stringify(BLOCKING)}, {"rule":"x","severity":"major","evidence":"no file"}, {"rule":"y","severity":"weird","file":"a.cs","evidence":"e"}]`,
    ].join("\n");
    const parsed = parseFindingsJson(output);
    assert.equal(parsed.present, true);
    assert.equal(parsed.malformed, false);
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].line, 42);
  });

  it("parses a multi-line FINDINGS_JSON block until the next KEY: line", () => {
    const output = `FINDINGS_JSON: [\n${JSON.stringify(BLOCKING)}\n]\nSUMMARY: 1 finding`;
    assert.equal(parseFindingsJson(output).findings.length, 1);
  });

  it("flags malformed JSON and reports absence", () => {
    assert.deepEqual(parseFindingsJson("FINDINGS_JSON: [oops"), { present: true, malformed: true, findings: [] });
    assert.deepEqual(parseFindingsJson("STATUS: done"), { present: false, malformed: false, findings: [] });
  });

  it("parses RESOLVED and DISPUTED_JSON", () => {
    const output = 'STATUS: done\nRESOLVED: ["aa", "bb"]\nDISPUTED_JSON: [{"fingerprint":"cc","reason":"false positive"},{"fingerprint":"dd"}]';
    assert.deepEqual(parseResolved(output), ["aa", "bb"]);
    assert.deepEqual(parseDisputed(output), [{ fingerprint: "cc", reason: "false positive" }]);
    assert.deepEqual(parseResolved("STATUS: done"), []);
  });
});

describe("finding block tolerance", () => {
  const json = JSON.stringify([BLOCKING]);
  const cases: Record<string, string> = {
    "trailing prose": `FINDINGS_JSON: ${json}
Done.`,
    "trailing fence": `FINDINGS_JSON: ${json}
\`\`\``,
    "bold key": `**FINDINGS_JSON:** ${json}`,
    "bold key colon outside": `**FINDINGS_JSON**: ${json}`,
    "indented key": `  FINDINGS_JSON: ${json}`,
    "CRLF": `STATUS: retry
FINDINGS_JSON: ${json}
SUMMARY: x`,
  };
  for (const [name, output] of Object.entries(cases)) {
    it(`parses with ${name}`, () => {
      const parsed = parseFindingsJson(output);
      assert.equal(parsed.malformed, false);
      assert.equal(parsed.findings.length, 1);
    });
  }
});

describe("finding persistence", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-findings-db-");
    seedRun(getDb(), { id: "run-1" }, []);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("inserts new findings as open and marks a re-raised one as repeated", () => {
    const first = recordGateFindings({ runId: "run-1", gate: "gate-review", round: 1, findings: [BLOCKING as never] });
    assert.equal(first.stored[0].status, "open");
    assert.equal(first.actionable.length, 1);

    const second = recordGateFindings({ runId: "run-1", gate: "gate-review", round: 2, findings: [{ ...BLOCKING, line: 50 } as never] });
    assert.equal(second.stored[0].status, "repeated");
    assert.equal(second.stored[0].round, 2);
    assert.equal(listFindings("run-1").length, 1);
  });

  it("never treats minor findings as actionable", () => {
    const result = recordGateFindings({
      runId: "run-1", gate: "gate-review", round: 1,
      findings: [{ ...BLOCKING, severity: "minor" } as never],
    });
    assert.equal(result.actionable.length, 0);
    assert.match(formatMinorFindings("run-1"), /gate-review.*ddd\/cross-context-import.*BookAppointmentHandler\.cs:42/);
  });

  it("applies a fix report and detects a disputed finding raised again", () => {
    const { stored } = recordGateFindings({ runId: "run-1", gate: "gate-review", round: 1, findings: [BLOCKING as never] });
    applyFixReport("run-1", { resolved: [], disputed: [{ fingerprint: stored[0].fingerprint, reason: "validated upstream" }] });
    const disputed = listFindings("run-1", { status: "disputed" });
    assert.equal(disputed.length, 1);
    assert.equal(disputed[0].disputeReason, "validated upstream");

    const again = recordGateFindings({ runId: "run-1", gate: "gate-review", round: 2, findings: [BLOCKING as never] });
    assert.equal(again.disputedReRaised.length, 1);
    assert.equal(again.actionable.length, 0);
  });

  it("resolves a gate's open findings when the gate passes, leaving minors open", () => {
    recordGateFindings({
      runId: "run-1", gate: "gate-review", round: 1,
      findings: [BLOCKING as never, { ...BLOCKING, symbol: "Other", severity: "minor" } as never],
    });
    resolveGateFindings("run-1", "gate-review");
    assert.equal(listFindings("run-1", { status: "resolved" }).length, 1);
    assert.equal(listFindings("run-1", { status: "open", severity: "minor" }).length, 1);
  });

  it("marks RESOLVED fingerprints and deletes all findings of a run", () => {
    const { stored } = recordGateFindings({ runId: "run-1", gate: "gate-unit", round: 1, findings: [BLOCKING as never] });
    applyFixReport("run-1", { resolved: [stored[0].fingerprint], disputed: [] });
    assert.equal(listFindings("run-1", { gate: "gate-unit" })[0].status, "resolved");
    deleteRunFindings("run-1");
    assert.equal(listFindings("run-1").length, 0);
  });

  it("dedupes same-fingerprint findings within one batch", () => {
    const result = recordGateFindings({
      runId: "run-1", gate: "gate-review", round: 1,
      findings: [
        { ...BLOCKING, symbol: undefined, severity: "major", evidence: "first" } as never,
        { ...BLOCKING, symbol: undefined, severity: "blocking", evidence: "second" } as never,
      ],
    });
    assert.equal(result.stored.length, 1);
    assert.equal(result.actionable.length, 1);
    assert.equal(result.stored[0].status, "open");
    assert.equal(result.stored[0].severity, "blocking");
    assert.match(result.stored[0].evidence, /second\n---\nfirst/);
    assert.equal(listFindings("run-1").length, 1);
  });

  it("does not dispute a finding that is already resolved", () => {
    const { stored } = recordGateFindings({ runId: "run-1", gate: "gate-review", round: 1, findings: [BLOCKING as never] });
    applyFixReport("run-1", { resolved: [stored[0].fingerprint], disputed: [] });
    applyFixReport("run-1", { resolved: [], disputed: [{ fingerprint: stored[0].fingerprint, reason: "late" }] });
    assert.equal(listFindings("run-1")[0].status, "resolved");
  });
});
