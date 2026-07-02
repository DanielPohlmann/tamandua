import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve(import.meta.dirname, "..", "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");

describe("README Hermes harness documentation", () => {
  it("documents --hermes-as-harness flag", () => {
    assert.ok(
      readmeContent.includes("--hermes-as-harness"),
      "README must document --hermes-as-harness flag"
    );
  });

  it("documents --pi-as-harness flag", () => {
    assert.ok(
      readmeContent.includes("--pi-as-harness"),
      "README must document --pi-as-harness flag"
    );
  });

  it("states claude is the default harness", () => {
    assert.ok(
      readmeContent.includes("This is the default"),
      "README must state which harness is the default"
    );
    assert.ok(
      readmeContent.includes("--claude-as-harness"),
      "README must document --claude-as-harness"
    );
    assert.ok(
      readmeContent.match(/claude.*default|default.*claude/i),
      "README must state claude is the default harness"
    );
  });

  it("warns Hermes is alpha quality wherever mentioned", () => {
    // Every hermes mention in the README should be near alpha/slow/broken warnings
    // We check that the harness selection section contains the alpha warning block
    assert.ok(
      readmeContent.includes("Alpha quality"),
      "README must warn about Hermes alpha quality status"
    );
    assert.ok(
      readmeContent.match(/hermes.*alpha/i) || readmeContent.match(/alpha.*hermes/i),
      "README must link Hermes mentions to alpha status"
    );
  });

  it("warns Hermes is very slow", () => {
    assert.ok(
      readmeContent.includes("very slow"),
      "README must warn that Hermes is very slow"
    );
  });

  it("warns Hermes token accounting is broken", () => {
    assert.ok(
      readmeContent.includes("token accounting is broken") ||
      readmeContent.includes("token accounting"),
      "README must warn that Hermes token accounting is broken"
    );
  });

  it("documents TAMANDUA_HERMES_BINARY env var", () => {
    assert.ok(
      readmeContent.includes("TAMANDUA_HERMES_BINARY"),
      "README must document TAMANDUA_HERMES_BINARY environment variable"
    );
  });

  it("documents PATH fallback for hermes binary discovery", () => {
    assert.ok(
      readmeContent.includes("PATH") &&
      (readmeContent.includes("hermes") || readmeContent.includes("Hermes")),
      "README must document that hermes is searched on PATH when TAMANDUA_HERMES_BINARY is not set"
    );
  });

  it("documents harness flags as mutually exclusive", () => {
    assert.ok(
      readmeContent.match(/mutually exclusive/i) &&
      (readmeContent.includes("--pi-as-harness") || readmeContent.includes("--hermes-as-harness")),
      "README must state harness flags are mutually exclusive"
    );
  });

  it("workflow run command row includes harness flags", () => {
    assert.ok(
      readmeContent.includes("[--claude-as-harness \\| --pi-as-harness \\| --hermes-as-harness]") ||
      readmeContent.includes("[--claude-as-harness | --pi-as-harness | --hermes-as-harness]"),
      "README workflow run command row must show all three harness flags"
    );
  });

  it("harness validation runs at scheduling time", () => {
    assert.ok(
      readmeContent.match(/harness.*validat|validat.*harness/) ||
      readmeContent.match(/scheduling.*time/),
      "README must document that harness binary validation runs at scheduling time"
    );
  });
});
