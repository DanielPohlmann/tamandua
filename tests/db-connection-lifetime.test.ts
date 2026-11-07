import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const savedDbPath = process.env.TAMANDUA_DB_PATH;
const isolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-db-lifetime-"));
process.env.TAMANDUA_DB_PATH = path.join(isolationDir, "first.db");

const { getDb, closeDb } = await import("../dist/db.js");

describe("getDb connection lifetime", () => {
  after(() => {
    closeDb();
    if (savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = savedDbPath;
    fs.rmSync(isolationDir, { recursive: true, force: true });
  });

  it("keeps a handle usable however long the caller holds it", () => {
    const held = getDb();
    // Slow work between two getDb() calls (git on a large repo, a loaded machine)
    // must not close the handle a caller is still using.
    const realNow = Date.now.bind(Date);
    const nowMock = mock.method(Date, "now", () => realNow() + 60_000);
    try {
      getDb();
    } finally {
      nowMock.mock.restore();
    }
    assert.doesNotThrow(() => held.prepare("SELECT 1").get());
  });

  it("opens the database at the new path when TAMANDUA_DB_PATH changes", () => {
    const first = getDb();
    process.env.TAMANDUA_DB_PATH = path.join(isolationDir, "second.db");
    const second = getDb();
    assert.notEqual(second, first);
    assert.ok(fs.existsSync(path.join(isolationDir, "second.db")));
  });
});
