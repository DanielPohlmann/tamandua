import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "./helpers/test-env.ts";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "./helpers/temp-db.ts";
import { getDb, closeDb } from "../dist/db.js";
import { recordGateFindings } from "../dist/installer/findings.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "cli.js");
const RUN_ID = "abcd1234-0000-4000-8000-000000000001";

function cli(args: string[], home: string): string {
  return execFileSync(process.execPath, ["--no-warnings", CLI, ...args], {
    env: cleanChildEnv({ HOME: home }),
    encoding: "utf-8",
  });
}

function cliResult(args: string[], home: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], {
    env: cleanChildEnv({ HOME: home }),
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("workflow findings / status --json", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-cli-findings-");
    seedRun(getDb(), { id: RUN_ID, status: "blocked", context: { blocked_step: "gate-review", blocked_reason: "disputed", pr: "" } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "waiting" },
    ]);
    recordGateFindings({ runId: RUN_ID, gate: "gate-review", round: 1, findings: [
      { rule: "review/naming", severity: "major", file: "src/A.cs", evidence: "bad" },
      { rule: "review/style", severity: "minor", file: "src/B.cs", evidence: "nit" },
    ] });
    closeDb();
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("lists findings as JSON with filters", () => {
    const all = JSON.parse(cli(["workflow", "findings", "abcd1234", "--json"], home.dir));
    assert.equal(all.length, 2);
    const majors = JSON.parse(cli(["workflow", "findings", "abcd1234", "--json", "--status", "open", "--gate", "gate-review"], home.dir));
    assert.equal(majors.length, 2);
    assert.match(cli(["workflow", "findings", "abcd1234"], home.dir), /review\/naming/);
  });

  it("prints machine-readable status", () => {
    const status = JSON.parse(cli(["workflow", "status", "abcd1234", "--json"], home.dir));
    assert.equal(status.id, RUN_ID);
    assert.equal(status.status, "blocked");
    assert.equal(status.currentStepId, "gate-review");
    assert.equal(status.pausedUntil, null);
    assert.deepEqual(status.context, {});
  });

  it("documents the new subcommand", () => {
    assert.match(cli(["workflow", "findings", "--help"], home.dir), /tamandua workflow findings <query>/);
  });

  it("status --json fails with empty stdout for an unknown run", () => {
    const r = cliResult(["workflow", "status", "ffffffff", "--json"], home.dir);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /No run found/);
  });
});

describe("workflow resume budget overrides on a running run", () => {
  const RUNNING_ID = "beef0000-0000-4000-8000-000000000002";
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-cli-resume-budget-");
    seedRun(getDb(), { id: RUNNING_ID, status: "running" }, []);
    closeDb();
  });
  afterEach(() => { closeDb(); home.restore(); });

  const storedMaxTokens = () => {
    const value = (getDb().prepare("SELECT max_tokens FROM runs WHERE id = ?").get(RUNNING_ID) as { max_tokens: number | null }).max_tokens;
    closeDb();
    return value;
  };

  it("stores --max-tokens and exits 0", () => {
    const r = cliResult(["workflow", "resume", "beef0000", "--max-tokens", "5000"], home.dir);
    assert.equal(r.status, 0);
    assert.equal(storedMaxTokens(), 5000);
  });

  it("rejects invalid values without writing anything", () => {
    for (const value of ["0", "abc"]) {
      const r = cliResult(["workflow", "resume", "beef0000", "--max-tokens", value], home.dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--max-tokens must be a positive integer/);
    }
    assert.equal(storedMaxTokens(), null);
  });
});
