import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePollingRoundMetadata } from "../../dist/installer/agent-scheduler.js";

describe("parsePollingRoundMetadata — Claude result object", () => {
  it("extracts .result as assistantOutput and .usage as tokenUsage", () => {
    const claudeOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "HEARTBEAT_OK",
      session_id: "abc",
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const md = parsePollingRoundMetadata(claudeOutput);
    assert.equal(md.assistantOutput, "HEARTBEAT_OK");
    assert.equal(md.tokenUsage, 150);
    assert.equal(md.jsonMetadataDetected, true);
  });

  it("handles pretty-printed (multi-line) Claude result JSON", () => {
    const claudeOutput = JSON.stringify(
      {
        type: "result",
        result: "STATUS: done\nCHANGES: x",
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 10 },
      },
      null,
      2,
    );
    const md = parsePollingRoundMetadata(claudeOutput);
    assert.equal(md.assistantOutput, "STATUS: done\nCHANGES: x");
    assert.equal(md.tokenUsage, 20);
  });

  it("still parses legacy pi JSONL (message_end) output", () => {
    const piOutput = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
        usage: { input: 3, output: 2 },
      },
    });
    const md = parsePollingRoundMetadata(piOutput);
    assert.equal(md.assistantOutput, "HEARTBEAT_OK");
    assert.equal(md.tokenUsage, 5);
  });
});
