// Scripted gate command. Exits with the next code queued for this script's name
// in FAKE_GATES_STATE ({ "<script name>": [exitCode, ...] }), 0 once the queue is empty.
import fs from "node:fs";
import path from "node:path";

const name = path.basename(process.argv[1], ".mjs");
const file = process.env.FAKE_GATES_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf-8"));
const queue = state[name] ?? [];
const code = queue.length > 0 ? queue.shift() : 0;
state[name] = queue;
fs.writeFileSync(file, JSON.stringify(state));
console.log(`${name} exit=${code} base=${process.env.BASE_BRANCH} complete=${process.env.FEATURE_COMPLETE}`);
process.exit(code);
