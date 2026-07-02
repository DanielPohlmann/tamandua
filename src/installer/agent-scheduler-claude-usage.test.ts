import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractTokenUsage } from "../../dist/installer/agent-scheduler.js";

describe("extractTokenUsage — Claude usage shape", () => {
  it("sums input, output, and Claude cache token keys", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    };
    assert.equal(extractTokenUsage(usage), 200);
  });

  it("handles Claude usage with only input/output", () => {
    assert.equal(extractTokenUsage({ input_tokens: 10, output_tokens: 5 }), 15);
  });

  it("returns null for empty/irrelevant object", () => {
    assert.equal(extractTokenUsage({ foo: 1 }), null);
  });
});
