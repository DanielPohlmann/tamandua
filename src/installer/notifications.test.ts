import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb } from "../../dist/db.js";
import { resolveNotifyTarget, buildNtfyRequest, detectOpenedPr } from "../../dist/installer/notifications.js";
import { emitEvent } from "../../dist/installer/events.js";
import { recordGateFindings } from "../../dist/installer/findings.js";
import { useTempTamanduaHome, seedRun, type TempTamanduaHome } from "../../tests/helpers/temp-db.ts";

describe("resolveNotifyTarget", () => {
  let savedUrl: string | undefined;
  let savedFormat: string | undefined;
  beforeEach(() => { savedUrl = process.env.TAMANDUA_NOTIFY_URL; savedFormat = process.env.TAMANDUA_NOTIFY_FORMAT; delete process.env.TAMANDUA_NOTIFY_URL; delete process.env.TAMANDUA_NOTIFY_FORMAT; });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.TAMANDUA_NOTIFY_URL; else process.env.TAMANDUA_NOTIFY_URL = savedUrl;
    if (savedFormat === undefined) delete process.env.TAMANDUA_NOTIFY_FORMAT; else process.env.TAMANDUA_NOTIFY_FORMAT = savedFormat;
  });

  it("prefers explicit url, then env, then workflow, and infers ntfy from the host", () => {
    assert.deepEqual(resolveNotifyTarget({}), { url: null, format: "json" });
    process.env.TAMANDUA_NOTIFY_URL = "https://ntfy.sh/my-topic";
    assert.deepEqual(resolveNotifyTarget({ workflow: { notifications: { url: "https://hooks.example/x" } } }), { url: "https://ntfy.sh/my-topic", format: "ntfy" });
    assert.deepEqual(resolveNotifyTarget({ explicitUrl: "https://hooks.example/y" }), { url: "https://hooks.example/y", format: "json" });
    assert.deepEqual(
      resolveNotifyTarget({ explicitUrl: "https://push.example/t", workflow: { notifications: { format: "ntfy" } } }),
      { url: "https://push.example/t", format: "ntfy" },
    );
  });

  it("honours TAMANDUA_NOTIFY_FORMAT and ignores unknown formats", () => {
    process.env.TAMANDUA_NOTIFY_FORMAT = "ntfy";
    assert.equal(resolveNotifyTarget({ explicitUrl: "https://push.example/t" }).format, "ntfy");
    process.env.TAMANDUA_NOTIFY_FORMAT = "bogus";
    assert.equal(resolveNotifyTarget({ explicitUrl: "https://push.example/t" }).format, "json");
    assert.equal(resolveNotifyTarget({ explicitUrl: "not a url" }).format, "json");
  });
});

describe("detectOpenedPr", () => {
  it("reports a newly set PR URL only once", () => {
    assert.equal(detectOpenedPr(undefined, "https://github.com/o/r/pull/7"), "https://github.com/o/r/pull/7");
    assert.equal(detectOpenedPr("https://github.com/o/r/pull/7", "https://github.com/o/r/pull/7"), null);
    assert.equal(detectOpenedPr(undefined, "not a url"), null);
  });
});

describe("ntfy delivery", () => {
  let home: TempTamanduaHome;
  let server: http.Server;
  let received: Array<{ headers: http.IncomingHttpHeaders; body: string }>;
  let url: string;

  beforeEach(async () => {
    home = useTempTamanduaHome("tamandua-notify-");
    received = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { received.push({ headers: req.headers, body }); res.end("ok"); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/topic`;
    seedRun(getDb(), { id: "run-1", context: { worktree_path: "/tmp/wt" } }, [
      { id: "s-review", stepId: "gate-review", index: 0, status: "waiting", fixRounds: 3 },
    ]);
    getDb().prepare("UPDATE runs SET notify_url = ?, notify_format = 'ntfy' WHERE id = 'run-1'").run(url);
    recordGateFindings({ runId: "run-1", gate: "gate-review", round: 3,
      findings: [{ rule: "r", severity: "blocking", file: "a.cs", evidence: "e" }] });
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    home.restore();
  });

  async function waitFor(count: number): Promise<void> {
    for (let i = 0; i < 50 && received.length < count; i++) await new Promise((r) => setTimeout(r, 20));
  }

  it("builds a blocked message with gate, round, open findings and worktree", () => {
    const request = buildNtfyRequest({ ts: "t", event: "run.blocked", runId: "run-1", stepId: "gate-review", detail: "Gate gate-review still failing" });
    assert.ok(request);
    assert.match(request!.headers.Title, /blocked/i);
    assert.equal(request!.headers.Priority, "high");
    assert.match(request!.body, /Gate: gate-review/);
    assert.match(request!.body, /Round: 3/);
    assert.match(request!.body, /Open findings: 1/);
    assert.match(request!.body, /Worktree: \/tmp\/wt/);
  });

  it("posts ntfy text for run.blocked and run.pr_opened and skips chatty events", async () => {
    emitEvent({ ts: new Date().toISOString(), event: "run.blocked", runId: "run-1", stepId: "gate-review", detail: "stuck" });
    emitEvent({ ts: new Date().toISOString(), event: "run.pr_opened", runId: "run-1", detail: "https://github.com/o/r/pull/9" });
    emitEvent({ ts: new Date().toISOString(), event: "pipeline.advanced", runId: "run-1", stepId: "pr" });
    await waitFor(2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 2);
    const blocked = received.find((r) => /stuck/.test(r.body));
    const pr = received.find((r) => r.headers.click);
    assert.ok(blocked);
    assert.equal(pr!.headers.click, "https://github.com/o/r/pull/9");
    assert.match(String(pr!.headers["content-type"]), /text\/plain/);
  });
});

describe("ntfy hardening", () => {
  let home: TempTamanduaHome;
  beforeEach(() => {
    home = useTempTamanduaHome("tamandua-notify-hardening-");
    seedRun(getDb(), { id: "run-1" }, []);
  });
  afterEach(() => { closeDb(); home.restore(); });

  it("percent-encodes the Click URL and omits it when the URL does not parse", () => {
    const encoded = buildNtfyRequest({ ts: "t", event: "run.pr_opened", runId: "run-1", detail: "https://github.com/o/r/pull/9?título=ação" });
    assert.equal(encoded!.headers.Click, "https://github.com/o/r/pull/9?t%C3%ADtulo=a%C3%A7%C3%A3o");
    const invalid = buildNtfyRequest({ ts: "t", event: "run.pr_opened", runId: "run-1", detail: "not a url" });
    assert.equal("Click" in invalid!.headers, false);
  });

  it("logs only the origin of a notify URL whose delivery failed", async () => {
    getDb().prepare("UPDATE runs SET notify_url = 'http://127.0.0.1:1/secret-topic', notify_format = 'ntfy' WHERE id = 'run-1'").run();
    emitEvent({ ts: new Date().toISOString(), event: "run.blocked", runId: "run-1", stepId: "gate", detail: "stuck" });
    const logFile = path.join(home.dir, ".tamandua", "tamandua.log");
    const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "");
    for (let i = 0; i < 100 && !readLog().includes("Webhook POST failed"); i++) await new Promise((r) => setTimeout(r, 20));
    const line = readLog().split("\n").find((l) => l.includes("Webhook POST failed")) ?? "";
    assert.match(line, /http:\/\/127\.0\.0\.1:1/);
    assert.doesNotMatch(line, /secret-topic/);
  });
});
