import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  findClaudeBinary,
  runClaude,
} from "../../dist/installer/agent-scheduler.js";

function makeMockBinary(binPath: string, behavior: string): void {
  fs.writeFileSync(binPath, `#!/bin/sh\n${behavior}\n`, { mode: 0o755 });
}

describe("findClaudeBinary", () => {
  let saved: string | undefined;
  let savedPath: string | undefined;
  beforeEach(() => {
    saved = process.env.TAMANDUA_CLAUDE_BINARY;
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TAMANDUA_CLAUDE_BINARY;
    else process.env.TAMANDUA_CLAUDE_BINARY = saved;
    if (savedPath !== undefined) process.env.PATH = savedPath;
  });

  it("respects TAMANDUA_CLAUDE_BINARY when executable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-"));
    const bin = path.join(dir, "claude-custom");
    makeMockBinary(bin, "echo hi");
    process.env.TAMANDUA_CLAUDE_BINARY = bin;
    assert.equal(findClaudeBinary(), bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws when TAMANDUA_CLAUDE_BINARY set but not executable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-"));
    const bin = path.join(dir, "claude-broken");
    fs.writeFileSync(bin, "#!/bin/sh\necho hi\n", { mode: 0o644 });
    process.env.TAMANDUA_CLAUDE_BINARY = bin;
    assert.throws(() => findClaudeBinary(), /TAMANDUA_CLAUDE_BINARY set but not executable/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("searches PATH for claude", () => {
    delete process.env.TAMANDUA_CLAUDE_BINARY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-"));
    const bin = path.join(dir, "claude");
    makeMockBinary(bin, "echo claude");
    process.env.PATH = `${dir}:${savedPath ?? ""}`;
    assert.equal(findClaudeBinary(), bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws clear error when claude not found", () => {
    delete process.env.TAMANDUA_CLAUDE_BINARY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-"));
    process.env.PATH = dir;
    assert.throws(() => findClaudeBinary(), /claude binary not found in PATH/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runClaude", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.TAMANDUA_CLAUDE_BINARY; });
  afterEach(() => {
    if (saved === undefined) delete process.env.TAMANDUA_CLAUDE_BINARY;
    else process.env.TAMANDUA_CLAUDE_BINARY = saved;
  });

  it("invokes claude with -p, --output-format json, --dangerously-skip-permissions and returns stdout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-run-"));
    const argsLog = path.join(dir, "args.log");
    const bin = path.join(dir, "claude");
    // Log args, then emit a Claude-style result object.
    makeMockBinary(
      bin,
      `echo "$@" >> "${argsLog}"; printf '{"type":"result","result":"HEARTBEAT_OK","usage":{"input_tokens":1,"output_tokens":1}}'`,
    );
    process.env.TAMANDUA_CLAUDE_BINARY = bin;

    const out = await runClaude("PROMPT_TEXT", { timeout: 30, workdir: dir });
    const args = fs.readFileSync(argsLog, "utf-8");

    assert.ok(args.includes("-p"), "should pass -p");
    assert.ok(args.includes("--output-format json"), "should pass --output-format json");
    assert.ok(args.includes("--dangerously-skip-permissions"), "should skip permissions");
    assert.ok(out.includes('"type":"result"'), "returns raw JSON result");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes --model when options.model is set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tam-claude-run-"));
    const argsLog = path.join(dir, "args.log");
    const bin = path.join(dir, "claude");
    makeMockBinary(bin, `echo "$@" >> "${argsLog}"; printf '{"type":"result","result":"ok"}'`);
    process.env.TAMANDUA_CLAUDE_BINARY = bin;

    await runClaude("PROMPT", { timeout: 30, workdir: dir, model: "sonnet" });
    const args = fs.readFileSync(argsLog, "utf-8");
    assert.ok(args.includes("--model sonnet"), "should pass --model sonnet");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
