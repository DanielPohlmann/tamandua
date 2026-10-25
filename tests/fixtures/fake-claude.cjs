#!/usr/bin/env node
// Scripted stand-in for the `claude` CLI. It follows the polling prompt the way a
// real agent would (peek, claim, complete through the tamandua CLI) and answers
// each claimed step with the next reply scripted for that agent.
//
// Env: FAKE_CLAUDE_SCRIPT  JSON { "<agent short id>": [reply | { reply, write, git }] }
//      FAKE_CLAUDE_STATE   JSON counter file (turns consumed per agent)
//      FAKE_CLAUDE_LOG     JSONL log of { argv, prompt } per invocation
//      FAKE_TAMANDUA_CLI_JS path of dist/cli/cli.js
//      FAKE_CLAUDE_INPUTS  optional JSONL log of { agent, stepId, input } per claimed step
// A reply may contain {{FIRST_FINGERPRINT}}: the first finding fingerprint in the
// claimed input. An object entry with `git` runs `git <args>` in the harness cwd and
// one with `write` creates that file there before completing, to act on the worktree.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] || "";
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv: argv.filter((a) => a !== prompt), prompt })}\n`);

const result = (text) =>
  process.stdout.write(JSON.stringify({ type: "result", result: text, usage: { input_tokens: 10, output_tokens: 5 } }));
const heartbeat = () => {
  result("HEARTBEAT_OK");
  process.exit(0);
};

const match = prompt.match(/step peek "([^"]+)" --run-id "([^"]+)"/);
if (!match) heartbeat();
const [, agentId, runId] = match;
const cli = process.env.FAKE_TAMANDUA_CLI_JS;
const tamandua = (args, input) =>
  execFileSync(process.execPath, ["--no-warnings", cli, ...args], { encoding: "utf-8", input });

if (!tamandua(["step", "peek", agentId, "--run-id", runId]).includes("HAS_WORK")) heartbeat();
const claimed = JSON.parse(tamandua(["step", "claim", agentId, "--run-id", runId]));
if (!claimed.stepId) heartbeat();

const shortId = agentId.replace(/^.*?_/, "");
if (process.env.FAKE_CLAUDE_INPUTS) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_INPUTS, `${JSON.stringify({ agent: shortId, stepId: claimed.stepId, input: claimed.input })}\n`);
}
const script = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf-8"));
const statePath = process.env.FAKE_CLAUDE_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf-8")) : {};
const turn = state[shortId] || 0;
state[shortId] = turn + 1;
fs.writeFileSync(statePath, JSON.stringify(state));

const entry = (script[shortId] || [])[turn] ?? "STATUS: done";
const { reply, write, git } = typeof entry === "string" ? { reply: entry } : entry;
if (git) execFileSync("git", git, { stdio: "pipe" });
if (write) fs.writeFileSync(path.resolve(process.cwd(), write), "written by a read-only agent\n");

const fingerprint = (claimed.input.match(/"fingerprint"\s*:\s*"([0-9a-f]{40})"/) || [])[1] || "";
const text = reply.replaceAll("{{FIRST_FINGERPRINT}}", fingerprint);
tamandua(["step", "complete", claimed.stepId], text);
result(`${text}\nstep_id: "${claimed.stepId}"`);
