import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  readEventsFromCursor,
  emitEvent,
  getRecentEvents,
  getRunEvents,
  getEventsPath,
  type TamanduaEvent,
} from "../../dist/installer/events.js";

function makeEvent(runId: string, event: string): TamanduaEvent {
  return {
    ts: new Date().toISOString(),
    event,
    runId,
  };
}

describe("events", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-events-"));
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe("emitEvent", () => {
    it("writes an event to the run-specific file", () => {
      const evt = makeEvent("run-1", "run.started");
      emitEvent(evt);

      const runFile = path.join(stateDir, "events", "run-1.jsonl");
      assert.ok(fs.existsSync(runFile), "run event file should exist");

      const content = fs.readFileSync(runFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.runId, "run-1");
      assert.equal(parsed.event, "run.started");
    });

    it("writes an event to the global events file", () => {
      const evt = makeEvent("run-2", "step.running");
      emitEvent(evt);

      const globalFile = path.join(stateDir, "events", "all.jsonl");
      assert.ok(fs.existsSync(globalFile), "global event file should exist");

      const content = fs.readFileSync(globalFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.runId, "run-2");
      assert.equal(parsed.event, "step.running");
    });

    it("writes multiple events as JSONL lines", () => {
      emitEvent(makeEvent("run-3", "run.started"));
      emitEvent(makeEvent("run-3", "step.running"));
      emitEvent(makeEvent("run-3", "step.completed"));

      const runFile = path.join(stateDir, "events", "run-3.jsonl");
      const content = fs.readFileSync(runFile, "utf-8");
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 3, "should have 3 event lines");

      const lastLine = JSON.parse(lines[2]!);
      assert.equal(lastLine.event, "step.completed");
    });

    it("each event appears in both run file and global file", () => {
      emitEvent(makeEvent("run-4", "step.done"));

      const runFile = path.join(stateDir, "events", "run-4.jsonl");
      const globalFile = path.join(stateDir, "events", "all.jsonl");

      const runContent = fs.readFileSync(runFile, "utf-8").trim();
      const globalContent = fs.readFileSync(globalFile, "utf-8").trim();
      assert.equal(runContent, globalContent, "both files should have the same content");
    });

    it("includes optional fields when present", () => {
      const evt: TamanduaEvent = {
        ts: new Date().toISOString(),
        event: "story.done",
        runId: "run-5",
        workflowId: "wf-bugfix",
        stepId: "step-1",
        storyId: "story-a",
        agentId: "agent-dev",
        detail: "all tests pass",
      };
      emitEvent(evt);

      const runFile = path.join(stateDir, "events", "run-5.jsonl");
      const content = fs.readFileSync(runFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.workflowId, "wf-bugfix");
      assert.equal(parsed.stepId, "step-1");
      assert.equal(parsed.storyId, "story-a");
      assert.equal(parsed.agentId, "agent-dev");
      assert.equal(parsed.detail, "all tests pass");
    });

    it("emits non-significant events (webhook skipped internally)", () => {
      assert.doesNotThrow(() => emitEvent(makeEvent("run-6", "step.running")));

      const globalFile = path.join(stateDir, "events", "all.jsonl");
      const content = fs.readFileSync(globalFile, "utf-8");
      assert.ok(content.includes("step.running"));
    });
  });

  describe("getRecentEvents", () => {
    it("reads recent events from the global file", () => {
      emitEvent(makeEvent("run-a", "run.started"));
      emitEvent(makeEvent("run-a", "step.running"));

      const events = getRecentEvents(10);
      assert.ok(events.length >= 2);
      assert.equal(events[0]!.runId, "run-a");
      assert.equal(events[0]!.event, "run.started");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        emitEvent(makeEvent(`run-limit-${i}`, "run.started"));
      }
      const events = getRecentEvents(3);
      assert.ok(events.length <= 3);
    });

    it("returns empty array when no global events exist", () => {
      const events = getRecentEvents();
      assert.deepEqual(events, []);
    });

    it("skips malformed JSON lines", () => {
      emitEvent(makeEvent("run-mal", "run.started"));

      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.appendFileSync(globalFile, "not valid json\n", "utf-8");
      emitEvent(makeEvent("run-mal", "run.completed"));

      const events = getRecentEvents(10);
      const completed = events.filter((e) => e.event === "run.completed");
      assert.equal(completed.length, 1);
    });
  });

  describe("getRunEvents", () => {
    it("reads events for a specific run", () => {
      emitEvent(makeEvent("run-specific", "run.started"));
      emitEvent(makeEvent("run-specific", "step.running"));
      emitEvent(makeEvent("run-specific", "step.completed"));

      const events = getRunEvents("run-specific");
      assert.equal(events.length, 3);
      assert.equal(events[0]!.event, "run.started");
      assert.equal(events[2]!.event, "step.completed");
    });

    it("returns empty array for non-existent run", () => {
      const events = getRunEvents("non-existent-run");
      assert.deepEqual(events, []);
    });

    it("only returns events for the requested run", () => {
      emitEvent(makeEvent("run-x", "run.started"));
      emitEvent(makeEvent("run-y", "run.started"));

      const eventsX = getRunEvents("run-x");
      assert.equal(eventsX.length, 1);
      assert.equal(eventsX[0]!.runId, "run-x");

      const eventsY = getRunEvents("run-y");
      assert.equal(eventsY.length, 1);
    });

    it("skips malformed JSON in run events", () => {
      emitEvent(makeEvent("run-bad", "run.started"));

      const runFile = path.join(stateDir, "events", "run-bad.jsonl");
      fs.appendFileSync(runFile, "garbage line\n", "utf-8");
      emitEvent(makeEvent("run-bad", "run.completed"));

      const events = getRunEvents("run-bad");
      assert.equal(events.length, 2);
    });
  });

  describe("getEventsPath", () => {
    it("returns the path to the events directory", () => {
      const dir = getEventsPath();
      assert.equal(dir, path.join(stateDir, "events"));
    });

    it("returns a path that matches where events are actually stored", () => {
      emitEvent(makeEvent("run-path-test", "run.started"));
      const dir = getEventsPath();
      const expectedFile = path.join(dir, "run-path-test.jsonl");
      assert.ok(fs.existsSync(expectedFile));
    });
  });

  describe("readEventsFromCursor", () => {
    it("returns only events appended after the provided global offset", () => {
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });

      const first = makeEvent("run-a", "run.started");
      const second = makeEvent("run-a", "step.running");
      fs.appendFileSync(globalFile, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf-8");

      const initial = readEventsFromCursor({ kind: "global" }, 0);
      assert.deepEqual(initial.events, [first, second]);

      const third = makeEvent("run-a", "step.done");
      fs.appendFileSync(globalFile, `${JSON.stringify(third)}\n`, "utf-8");

      const appended = readEventsFromCursor({ kind: "global" }, initial.nextOffset);
      assert.deepEqual(appended.events, [third]);

      const nothingNew = readEventsFromCursor({ kind: "global" }, appended.nextOffset);
      assert.deepEqual(nothingNew.events, []);
      assert.equal(nothingNew.nextOffset, appended.nextOffset);
    });

    it("supports run-specific event files", () => {
      const runId = "run-123";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const first = makeEvent(runId, "story.started");
      fs.appendFileSync(runFile, `${JSON.stringify(first)}\n`, "utf-8");

      const initial = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.deepEqual(initial.events, [first]);

      const second = makeEvent(runId, "story.done");
      fs.appendFileSync(runFile, `${JSON.stringify(second)}\n`, "utf-8");

      const appended = readEventsFromCursor({ kind: "run", runId }, initial.nextOffset);
      assert.deepEqual(appended.events, [second]);
    });

    it("handles offset beyond file length by resetting to 0", () => {
      const runId = "run-overflow";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `${JSON.stringify(evt)}\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 999999);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.runId, runId);
    });

    it("handles empty lines gracefully", () => {
      const runId = "run-empty-lines";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `\n${JSON.stringify(evt)}\n\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.event, "run.started");
    });

    it("ignores malformed/incomplete JSONL rows", () => {
      const runId = "run-malformed";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const first = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `${JSON.stringify(first)}\n{\"ts\":\"partial\"`, "utf-8");

      const initial = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.deepEqual(initial.events, [first]);

      const later = makeEvent(runId, "run.completed");
      fs.appendFileSync(runFile, `, invalid}\n${JSON.stringify(later)}\n`, "utf-8");

      const afterMalformed = readEventsFromCursor({ kind: "run", runId }, initial.nextOffset);
      assert.deepEqual(afterMalformed.events, [later]);
    });

    it("skips non-object JSON values (strings, numbers, booleans, null)", () => {
      const runId = "run-nonobject";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `"not an object"\n42\ntrue\nfalse\nnull\n${JSON.stringify(evt)}\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.event, "run.started");
    });

    it("handles trailing partial line (no final newline)", () => {
      const runId = "run-partial";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `${JSON.stringify(evt)}\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.events.length, 1);

      fs.appendFileSync(runFile, `{\"ts\":\"partial\",\"event\"`, "utf-8");
      const afterPartial = readEventsFromCursor({ kind: "run", runId }, result.nextOffset);
      assert.deepEqual(afterPartial.events, []);
    });

    it("handles carriage return in line endings", () => {
      const runId = "run-cr";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `${JSON.stringify(evt)}\r\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.event, "run.started");
    });
  });

  describe("fireWebhook", () => {
    let dbPath: string;
    let db: DatabaseSync;
    let originalDbPath: string | undefined;
    let server: http.Server | null = null;
    let webhookReceived: string | null = null;

    beforeEach(() => {
      originalDbPath = process.env.TAMANDUA_DB_PATH;
      dbPath = path.join(stateDir, "tamandua.db");
      process.env.TAMANDUA_DB_PATH = dbPath;

      fs.mkdirSync(stateDir, { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL DEFAULT 'test',
        task TEXT NOT NULL DEFAULT 'test',
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        notify_format TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    });

    afterEach(async () => {
      if (originalDbPath !== undefined) process.env.TAMANDUA_DB_PATH = originalDbPath;
      else delete process.env.TAMANDUA_DB_PATH;
      try { db.close(); } catch {}
      if (server) { server.close(); server = null; }
    });

    it("delivers webhook POST for significant events with notify_url", async () => {
      const webhookPromise = new Promise<string>((resolve) => {
        server = http.createServer((req, res) => {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => { webhookReceived = body; res.writeHead(200); res.end("OK"); resolve(body); });
        });
        server!.listen(0, "127.0.0.1");
      });

      await new Promise<void>((resolve) => { server!.once("listening", resolve); });
      const addr = server!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      db.prepare("INSERT INTO runs (id, workflow_id, task, status, notify_url) VALUES (?, ?, ?, ?, ?)")
        .run("webhook-run", "test-wf", "test task", "running", `http://127.0.0.1:${port}/webhook`);

      emitEvent({ ts: new Date().toISOString(), event: "run.started", runId: "webhook-run" });

      const body = await webhookPromise;
      const parsed = JSON.parse(body);
      assert.equal(parsed.runId, "webhook-run");
      assert.equal(parsed.event, "run.started");
    });

    it("skips webhook for non-significant events", () => {
      db.prepare("INSERT INTO runs (id, workflow_id, task, status, notify_url) VALUES (?, ?, ?, ?, ?)")
        .run("nohook-run", "test-wf", "test task", "running", "http://127.0.0.1:19999/nope");
      assert.doesNotThrow(() =>
        emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: "nohook-run" })
      );
    });

    it("skips webhook when notify_url is missing", () => {
      db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)")
        .run("nonotify-run", "test-wf", "test task", "running");
      assert.doesNotThrow(() =>
        emitEvent({ ts: new Date().toISOString(), event: "run.completed", runId: "nonotify-run" })
      );
    });
  });

  it("returns empty when events file does not exist (ENOENT)", () => {
    const result = readEventsFromCursor({ kind: "global" }, 0);
    assert.deepEqual(result.events, []);
    assert.equal(result.nextOffset, 0);
  });

  it("returns empty on non-ENOENT read error (e.g. permission denied)", () => {
    // Create a directory where the file would be — making readFileSync fail with EISDIR
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(globalFile, { recursive: true }); // create a directory with the file name

    const result = readEventsFromCursor({ kind: "global" }, 0);
    assert.deepEqual(result.events, []);
  });
});

describe("emitEvent", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-emit-"));
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes to both run-specific and global events files", () => {
    const evt = makeEvent("run-emit", "run.started");
    emitEvent(evt);

    const runFile = path.join(stateDir, "events", "run-emit.jsonl");
    const globalFile = path.join(stateDir, "events", "all.jsonl");

    const runContent = fs.readFileSync(runFile, "utf-8");
    const globalContent = fs.readFileSync(globalFile, "utf-8");

    assert.ok(runContent.includes(evt.runId));
    assert.ok(globalContent.includes(evt.runId));
  });

  it("creates events directory if it does not exist", () => {
    const eventsDir = path.join(stateDir, "events");
    assert.ok(!fs.existsSync(eventsDir));

    emitEvent(makeEvent("run-createdir", "run.started"));

    assert.ok(fs.existsSync(eventsDir));
    assert.ok(fs.statSync(eventsDir).isDirectory());
  });
});

describe("getRecentEvents", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-recent-"));
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns empty array when global file does not exist", () => {
    const events = getRecentEvents();
    assert.deepEqual(events, []);
  });

  it("reads recent events from global file", () => {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    const evt1 = makeEvent("run-a", "run.started");
    const evt2 = makeEvent("run-a", "run.completed");
    fs.appendFileSync(globalFile, `${JSON.stringify(evt1)}\n${JSON.stringify(evt2)}\n`, "utf-8");

    const events = getRecentEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0]!.event, "run.started");
    assert.equal(events[1]!.event, "run.completed");
  });

  it("respects limit parameter", () => {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    for (let i = 0; i < 10; i++) {
      const evt = makeEvent("run-a", `event.${i}`);
      fs.appendFileSync(globalFile, `${JSON.stringify(evt)}\n`, "utf-8");
    }

    const events = getRecentEvents(3);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.event, "event.7");
    assert.equal(events[2]!.event, "event.9");
  });

  it("skips malformed JSON lines", () => {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    const evt1 = makeEvent("run-a", "run.started");
    const evt2 = makeEvent("run-a", "run.completed");
    fs.appendFileSync(globalFile, `${JSON.stringify(evt1)}\nnot-json\n${JSON.stringify(evt2)}\n`, "utf-8");

    const events = getRecentEvents();
    // Only valid JSON lines are returned
    assert.equal(events.length, 2);
    assert.equal(events[0]!.event, "run.started");
    assert.equal(events[1]!.event, "run.completed");
  });

  it("handles global events file being a directory (non-ENOENT error)", () => {
    // Create a directory where the global file should be
    const globalFileAsDir = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(globalFileAsDir, { recursive: true });

    const events = getRecentEvents();
    assert.deepEqual(events, []);
  });
});

describe("getRunEvents", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-runevents-"));
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns empty array when run events file does not exist", () => {
    const events = getRunEvents("nonexistent-run");
    assert.deepEqual(events, []);
  });

  it("reads all events for a specific run", () => {
    const runId = "run-readall";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const evt1 = makeEvent(runId, "run.started");
    const evt2 = makeEvent(runId, "step.running");
    const evt3 = makeEvent(runId, "step.done");
    fs.appendFileSync(
      runFile,
      `${JSON.stringify(evt1)}\n${JSON.stringify(evt2)}\n${JSON.stringify(evt3)}\n`,
      "utf-8",
    );

    const events = getRunEvents(runId);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.event, "run.started");
    assert.equal(events[2]!.event, "step.done");
  });

  it("skips malformed JSON lines in run events", () => {
    const runId = "run-malformed";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const evt1 = makeEvent(runId, "run.started");
    fs.appendFileSync(runFile, `bad-json\n${JSON.stringify(evt1)}\n`, "utf-8");

    const events = getRunEvents(runId);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, "run.started");
  });

  it("handles run events file being a directory", () => {
    const runId = "run-dir-instead";
    const runFileAsDir = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(runFileAsDir, { recursive: true });

    const events = getRunEvents(runId);
    assert.deepEqual(events, []);
  });
});

describe("getEventsPath", () => {
  it("returns the events directory under TAMANDUA_STATE_DIR", () => {
    const p = getEventsPath();
    assert.ok(p.includes("events"));
  });
});
