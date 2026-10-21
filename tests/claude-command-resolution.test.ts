import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClaudeCommand, findClaudeBinary } from "../dist/installer/agent-scheduler.js";

describe("resolveClaudeCommand", () => {
  for (const ext of [".js", ".cjs", ".mjs"]) {
    it(`runs ${ext} scripts through the current node executable`, () => {
      const script = `/tmp/fake-claude${ext}`;
      assert.deepEqual(resolveClaudeCommand(script, ["-p", "hi"]), {
        command: process.execPath,
        args: [script, "-p", "hi"],
      });
    });
  }

  it("leaves a regular binary unchanged", () => {
    assert.deepEqual(resolveClaudeCommand("/usr/bin/claude", ["-p", "hi"]), {
      command: "/usr/bin/claude",
      args: ["-p", "hi"],
    });
  });

  it("does not treat names that merely contain js as scripts", () => {
    assert.equal(resolveClaudeCommand("/usr/bin/claude-js", []).command, "/usr/bin/claude-js");
  });
});

describe("findClaudeBinary with a script override", () => {
  const original = process.env.TAMANDUA_CLAUDE_BINARY;
  afterEach(() => {
    if (original === undefined) delete process.env.TAMANDUA_CLAUDE_BINARY;
    else process.env.TAMANDUA_CLAUDE_BINARY = original;
  });

  it("accepts a readable .mjs script without the exec bit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
    const script = path.join(dir, "claude.mjs");
    fs.writeFileSync(script, "console.log('ok');\n", { mode: 0o644 });
    process.env.TAMANDUA_CLAUDE_BINARY = script;
    try {
      assert.equal(findClaudeBinary(), script);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
