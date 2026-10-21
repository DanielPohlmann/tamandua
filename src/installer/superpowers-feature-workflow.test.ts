import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflowSpec } from "../../dist/installer/workflow-spec.js";
import { validateExpects } from "../../dist/installer/step-ops.js";

const WORKFLOW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "superpowers-feature");

describe("superpowers-feature workflow", async () => {
  const spec = await loadWorkflowSpec(WORKFLOW_DIR);
  const step = (id: string) => spec.steps.find((s) => s.id === id)!;
  const role = (agentId: string) => spec.agents.find((a) => a.id === agentId)?.role;

  it("runs in an isolated worktree", () => {
    assert.equal(spec.run?.workspace, "worktree");
  });

  it("runs the steps in the spec order", () => {
    assert.deepEqual(spec.steps.map((s) => s.id), [
      "load-plan", "setup", "implement", "verify",
      "gate-unit", "gate-security-checks", "gate-security", "gate-review-checks", "gate-review",
      "gate-e2e-checks", "gate-e2e", "gate-ci-local", "pr", "fix",
    ]);
  });

  it("runs the consumer's gate scripts as bash steps that loop through fix", () => {
    const commands: Record<string, string> = {
      "gate-unit": "node scripts/gates/unit.mjs",
      "gate-security-checks": "node scripts/gates/security-checks.mjs",
      "gate-review-checks": "node scripts/gates/review-checks.mjs",
      "gate-e2e-checks": "node scripts/gates/e2e-checks.mjs",
      "gate-ci-local": "node scripts/gates/ci-local.mjs",
    };
    for (const [id, command] of Object.entries(commands)) {
      assert.equal(step(id).type, "bash", id);
      assert.equal(step(id).run, command, id);
      assert.deepEqual(step(id).on_fail, { fix_step: "fix", max_rounds: 3 }, id);
    }
  });

  it("uses read-only verifiers that report retry verdicts", () => {
    for (const [id, agent, expectedRole] of [
      ["gate-security", "security", "verification"],
      ["gate-review", "reviewer", "verification"],
      ["gate-e2e", "tester", "testing"],
    ] as const) {
      assert.equal(step(id).agent, agent);
      assert.equal(role(agent), expectedRole);
      assert.equal(step(id).expects, "regex:^STATUS: (done|retry|blocked)$");
      assert.deepEqual(step(id).on_fail, { fix_step: "fix", max_rounds: 3 });
      assert.match(step(id).input, /FINDINGS_JSON/);
    }
    assert.match(step("gate-security").input, /\{\{gate_security_checks_output\}\}/);
    assert.match(step("gate-review").input, /\{\{reviewed_sha\}\}/);
    assert.match(step("gate-review").input, /\{\{findings_gate_review\}\}/);
    assert.match(step("gate-review").input, /REVIEWED_SHA:/);
    assert.match(step("gate-e2e").input, /\{\{feature_complete\}\}/);
  });

  it("lets the per-plan verifier send the story back to implement", () => {
    const verify = step("verify");
    const accepts = (output: string) => validateExpects(output, verify.expects!) === null;
    assert.ok(accepts("STATUS: done\nVERIFIED: ok"));
    assert.ok(accepts("STATUS: retry\nISSUES:\n- missing test file"));
    assert.ok(!accepts("STATUS: failed\nREASON: x"));
    assert.match(step("implement").input, /\{\{verify_feedback\}\}/);
  });

  it("gives code changes only to the developer through fix", () => {
    assert.equal(step("fix").agent, "developer");
    assert.equal(role("developer"), "coding");
    assert.match(step("fix").input, /\{\{fix_feedback\}\}/);
    assert.match(step("fix").input, /\{\{fix_origin\}\}/);
    assert.match(step("fix").input, /RESOLVED:/);
    assert.match(step("fix").input, /DISPUTED_JSON:/);
    const writers = spec.agents.filter((a) => a.role === "coding").map((a) => a.id).sort();
    assert.deepEqual(writers, ["developer", "setup"]);
  });

  it("pushes without --no-verify and routes hook failures back through gate-ci-local", () => {
    const pr = step("pr");
    assert.equal(pr.agent, "pr");
    assert.equal(role("pr"), "pr");
    assert.match(pr.input, /git push -u origin \{\{branch\}\}/);
    assert.doesNotMatch(pr.input, /git push[^\n]*--no-verify/);
    assert.match(pr.input, /gate\/pre-push/);
    assert.match(pr.input, /STATUS: blocked/);
    assert.match(pr.input, /\{\{minor_findings\}\}/);
    assert.deepEqual(pr.on_fail, { fix_step: "fix", max_rounds: 2, return_step: "gate-ci-local" });
    const accepts = (output: string) => validateExpects(output, pr.expects!) === null;
    assert.ok(accepts("STATUS: done\nPR: https://github.com/o/r/pull/1"));
    assert.ok(!accepts("STATUS: done"));
    assert.ok(accepts("STATUS: retry\nFINDINGS_JSON: []"));
    assert.ok(accepts("STATUS: blocked\nREASON: gh not logged in"));
  });

  it("declares budgets and seeds the context keys the prompts use", () => {
    assert.deepEqual(spec.budgets, { max_fix_rounds: 8 });
    assert.equal(spec.context?.base_branch, "develop");
    assert.equal(spec.context?.reviewed_sha, "");
  });

  it("has a persona for every agent and keeps consumer names out", () => {
    for (const agent of spec.agents) {
      const agentsMd = path.join(WORKFLOW_DIR, agent.workspace.baseDir, "AGENTS.md");
      const shared = agent.workspace.files?.["AGENTS.md"];
      assert.ok(fs.existsSync(agentsMd) || shared, agent.id);
    }
    const yml = fs.readFileSync(path.join(WORKFLOW_DIR, "workflow.yml"), "utf-8");
    assert.doesNotMatch(yml, /linkdaily/i);
  });
});
