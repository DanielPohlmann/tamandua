import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findWindowsBash, windowsShellCommand } from "../../dist/lib/posix-shell.js";
import { homeDir } from "../../dist/lib/home-dir.js";

describe("windowsShellCommand", () => {
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";

  it("leaves commands unchanged on POSIX", () => {
    assert.equal(windowsShellCommand("./autoresearch.sh", "linux", bash), "./autoresearch.sh");
  });

  it("leaves non-.sh commands unchanged on Windows", () => {
    assert.equal(windowsShellCommand("node -e 1", "win32", bash), "node -e 1");
    assert.equal(windowsShellCommand("bash run.sh", "win32", bash), "bash run.sh");
  });

  it("runs a bare .sh path through Git Bash", () => {
    assert.equal(
      windowsShellCommand("C:\\repo\\autoresearch.checks.sh", "win32", bash),
      `"${bash}" "C:/repo/autoresearch.checks.sh"`,
    );
  });

  it("keeps arguments and handles quoted paths", () => {
    assert.equal(
      windowsShellCommand('"C:\\my repo\\run.sh" --fast', "win32", bash),
      `"${bash}" "C:/my repo/run.sh" --fast`,
    );
    assert.equal(windowsShellCommand("./run.sh a b", "win32", bash), `"${bash}" "./run.sh" a b`);
  });

  it("falls back to plain bash when Git Bash is missing", () => {
    assert.equal(windowsShellCommand("./run.sh", "win32", null), `bash "./run.sh"`);
  });
});

describe("findWindowsBash", () => {
  it("skips the System32 and WindowsApps launchers", { skip: process.platform !== "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-bash-"));
    try {
      const sys = path.join(dir, "Windows", "System32");
      const apps = path.join(dir, "WindowsApps");
      const git = path.join(dir, "Git", "bin");
      for (const d of [sys, apps, git]) {
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "bash.exe"), "");
      }
      const found = findWindowsBash({
        SystemRoot: path.join(dir, "Windows"),
        PATH: [sys, apps, git].join(path.delimiter),
        ProgramFiles: path.join(dir, "none"),
      });
      assert.equal(found, path.join(git, "bash.exe"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("homeDir", () => {
  it("prefers HOME over os.homedir()", () => {
    const saved = process.env.HOME;
    try {
      process.env.HOME = path.join(os.tmpdir(), "tamandua-home-test");
      assert.equal(homeDir(), path.join(os.tmpdir(), "tamandua-home-test"));
      process.env.HOME = "  ";
      assert.equal(homeDir(), os.homedir());
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  });
});
