import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
});
