import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../../dist/db.js";
import { useTempTamanduaHome, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

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
