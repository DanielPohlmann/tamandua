import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkflowSpec } from "../../dist/installer/workflow-spec.js";

function withWorkflow(yml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-spec-gates-"));
  fs.writeFileSync(path.join(dir, "workflow.yml"), yml, "utf-8");
  return dir;
}

const AGENTS = `
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
  - id: reviewer
    workspace:
      baseDir: agents/reviewer
`;

describe("loadWorkflowSpec gate keys", () => {
  it("normalizes a bash step onto the bash-runner agent", async () => {
    const dir = withWorkflow(`id: wf
${AGENTS}
steps:
  - id: gate-unit
    type: bash
    run: node scripts/gates/unit.mjs
    on_fail: { fix_step: fix, max_rounds: 2 }
  - id: fix
    agent: dev
    input: "fix {{fix_feedback}}"
    expects: "STATUS: done"
`);
    try {
      const spec = await loadWorkflowSpec(dir);
      const gate = spec.steps[0];
      assert.equal(gate.type, "bash");
      assert.equal(gate.agent, "bash-runner");
      assert.equal(gate.input, "");
      assert.equal(gate.expects, "");
      assert.equal(gate.run, "node scripts/gates/unit.mjs");
      assert.deepEqual(gate.on_fail, { fix_step: "fix", max_rounds: 2 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a bash step without run", async () => {
    const dir = withWorkflow(`id: wf
${AGENTS}
steps:
  - id: gate-unit
    type: bash
`);
    try {
      await assert.rejects(loadWorkflowSpec(dir), /step\[0\] \("gate-unit"\).*run/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown fix_step", async () => {
    const dir = withWorkflow(`id: wf
${AGENTS}
steps:
  - id: gate-review
    agent: reviewer
    input: x
    expects: y
    on_fail: { fix_step: nope }
`);
    try {
      await assert.rejects(loadWorkflowSpec(dir), /fix_step "nope" does not match any step/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a fix step that is a loop, a bash step, or declares its own fix_step", async () => {
    const dir = withWorkflow(`id: wf
${AGENTS}
steps:
  - id: gate-unit
    type: bash
    run: "true"
    on_fail: { fix_step: other-gate }
  - id: other-gate
    type: bash
    run: "true"
`);
    try {
      await assert.rejects(loadWorkflowSpec(dir), /fix step "other-gate" must be a single agent step/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-positive max_rounds and budgets", async () => {
    const badRounds = withWorkflow(`id: wf
${AGENTS}
steps:
  - id: gate-unit
    type: bash
    run: "true"
    on_fail: { fix_step: fix, max_rounds: 0 }
  - id: fix
    agent: dev
    input: x
    expects: y
`);
    const badBudget = withWorkflow(`id: wf
budgets: { max_fix_rounds: -1 }
${AGENTS}
steps:
  - id: s
    agent: dev
    input: x
    expects: y
`);
    try {
      await assert.rejects(loadWorkflowSpec(badRounds), /max_rounds must be a positive integer/);
      await assert.rejects(loadWorkflowSpec(badBudget), /budgets.max_fix_rounds must be a positive integer/);
    } finally {
      fs.rmSync(badRounds, { recursive: true, force: true });
      fs.rmSync(badBudget, { recursive: true, force: true });
    }
  });

  it("accepts return_step only when it names an earlier step", async () => {
    const dir = withWorkflow(`id: wf
${AGENTS}
steps:
  - id: pr
    agent: dev
    input: x
    expects: y
    on_fail: { fix_step: fix, return_step: gate-ci-local }
  - id: gate-ci-local
    type: bash
    run: "true"
  - id: fix
    agent: dev
    input: x
    expects: y
`);
    try {
      await assert.rejects(loadWorkflowSpec(dir), /return_step "gate-ci-local" must name an earlier step/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reserves the bash-runner agent id", async () => {
    const dir = withWorkflow(`id: wf
agents:
  - id: bash-runner
    workspace:
      baseDir: agents/x
steps: []
`);
    try {
      await assert.rejects(loadWorkflowSpec(dir), /agent id "bash-runner" is reserved/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
