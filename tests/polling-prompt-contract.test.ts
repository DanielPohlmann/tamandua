import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPollingPrompt, buildAgentPrompt, buildWorkPrompt, STEP_OUTPUT_CONTRACT } from "../dist/installer/agent-scheduler.js";
import { resolveTamanduaCli } from "../dist/installer/paths.js";

describe("polling prompt protocol", () => {
  const cli = resolveTamanduaCli();

  it("invokes the shell launcher directly instead of through node", () => {
    for (const prompt of [
      buildPollingPrompt("wf", "wf_reviewer", "run-1"),
      buildAgentPrompt("wf", "wf_reviewer", "run-1"),
      buildWorkPrompt("wf", "wf_reviewer", "run-1"),
    ]) {
      assert.ok(!prompt.includes(`node "${cli}"`), "must not run the sh launcher with node");
    }
    assert.ok(buildPollingPrompt("wf", "wf_reviewer", "run-1").includes(`"${cli}" step peek "wf_reviewer" --run-id "run-1"`));
  });

  it("embeds the step output contract", () => {
    const prompt = buildPollingPrompt("wf", "wf_reviewer", "run-1", "### AGENTS.md\n\nFINDINGS_JSON contract here");
    assert.ok(prompt.includes(STEP_OUTPUT_CONTRACT));
    assert.match(STEP_OUTPUT_CONTRACT, /first line.*STATUS:/i);
    assert.match(STEP_OUTPUT_CONTRACT, /single line/i);
    assert.ok(prompt.includes("FINDINGS_JSON contract here"));
  });

  it("documents the engine-executed statuses, reasons and finding shapes", () => {
    assert.match(STEP_OUTPUT_CONTRACT, /STATUS: done\|retry\|blocked/);
    assert.match(STEP_OUTPUT_CONTRACT, /REASON:/);
    assert.match(STEP_OUTPUT_CONTRACT, /FINDINGS_JSON: \[/);
    assert.match(STEP_OUTPUT_CONTRACT, /RESOLVED: \[/);
    assert.match(STEP_OUTPUT_CONTRACT, /DISPUTED_JSON: \[/);
    assert.match(STEP_OUTPUT_CONTRACT, /blocking\|major\|minor/);
    assert.match(STEP_OUTPUT_CONTRACT, /uppercase letters and underscores/);
    assert.match(STEP_OUTPUT_CONTRACT, /no digits/);
    assert.match(STEP_OUTPUT_CONTRACT, /RESOLVED: \["<fingerprint>"/);
    assert.match(STEP_OUTPUT_CONTRACT, /DISPUTED_JSON: \[\{"fingerprint":"<fingerprint>","reason":"<why>"\}/);
    for (const field of ["rule", "severity", "file", "evidence"]) {
      assert.ok(STEP_OUTPUT_CONTRACT.includes(field), `contract mentions ${field}`);
    }
  });
});
