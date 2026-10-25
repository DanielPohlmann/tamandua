import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb, inTransaction } from "../dist/db.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../tests/helpers/temp-db.ts";

describe("inTransaction", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-db-tx-");
    seedRun(getDb(), { id: "run-1" }, []);
  });
  afterEach(() => { closeDb(); home.restore(); });

  const runStatus = () => (getDb().prepare("SELECT status FROM runs WHERE id = 'run-1'").get() as { status: string }).status;
  const setStatus = (status: string) => getDb().prepare("UPDATE runs SET status = ? WHERE id = 'run-1'").run(status);

  it("joins an outer transaction instead of issuing a second BEGIN", () => {
    const result = inTransaction(() => {
      setStatus("paused");
      return inTransaction(() => {
        assert.equal(getDb().isTransaction, true);
        setStatus("blocked");
        return "inner";
      });
    });
    assert.equal(result, "inner");
    assert.equal(getDb().isTransaction, false);
    assert.equal(runStatus(), "blocked");
  });

  it("rolls back the whole outer transaction when a nested call throws", () => {
    assert.throws(() => inTransaction(() => {
      setStatus("paused");
      inTransaction(() => {
        setStatus("blocked");
        throw new Error("boom");
      });
    }), /boom/);
    assert.equal(getDb().isTransaction, false);
    assert.equal(runStatus(), "running");
  });

  it("joins a transaction opened directly on the connection", () => {
    const db = getDb();
    db.exec("BEGIN");
    inTransaction(() => setStatus("blocked"));
    assert.equal(db.isTransaction, true);
    db.exec("ROLLBACK");
    assert.equal(runStatus(), "running");
  });
});
