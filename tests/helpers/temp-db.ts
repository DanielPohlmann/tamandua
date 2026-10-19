import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_KEYS = ["TAMANDUA_DB_PATH", "HOME", "TAMANDUA_STATE_DIR"] as const;

export interface TempTamanduaHome {
  dir: string;
  restore(): void;
}

export function useTempTamanduaHome(prefix: string): TempTamanduaHome {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(dir, ".tamandua");
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.HOME = dir;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
  return {
    dir,
    restore() {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Db = { prepare(sql: string): { run(...args: unknown[]): unknown } };

export interface SeedRun {
  id: string;
  status?: string;
  context?: Record<string, string>;
  maxFixRounds?: number | null;
}

export interface SeedStep {
  id: string;
  stepId: string;
  index: number;
  agentId?: string;
  status?: string;
  type?: string;
  expects?: string;
  onFail?: Record<string, unknown> | null;
  runCommand?: string | null;
  invokedBy?: string | null;
  fixRounds?: number;
}

export function seedRun(db: Db, run: SeedRun, steps: SeedStep[]): void {
  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, max_fix_rounds, created_at, updated_at)
     VALUES (?, 'wf', 'task', ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(run.id, run.status ?? "running", JSON.stringify(run.context ?? {}), run.maxFixRounds ?? null);
  for (const step of steps) {
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type,
                          on_fail, run_command, invoked_by, fix_rounds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(
      step.id,
      run.id,
      step.stepId,
      step.agentId ?? `wf_${step.stepId}`,
      step.index,
      step.expects ?? "",
      step.status ?? "waiting",
      step.type ?? "single",
      step.onFail ? JSON.stringify(step.onFail) : null,
      step.runCommand ?? null,
      step.invokedBy ?? null,
      step.fixRounds ?? 0,
    );
  }
}
