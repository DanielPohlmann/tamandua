export interface WorkflowRunArgs {
  taskTitle: string;
  workingDirectoryForHarness?: string;
  worktreeOriginRepository?: string;
  worktreeOriginRef?: string;
  noHurrySaveTokensMode?: boolean;
  noRelaunchUponRugpull?: boolean;
  harnessAs?: "pi" | "hermes" | "claude";
  context: Record<string, string>;
}

export function parseWorkflowRunArgs(args: string[]): WorkflowRunArgs {
  const taskParts: string[] = [];
  let workingDirectoryForHarness: string | undefined;
  let worktreeOriginRepository: string | undefined;
  let worktreeOriginRef: string | undefined;
  let noHurrySaveTokensMode: boolean | undefined;
  let noRelaunchUponRugpull: boolean | undefined;
  let harnessAs: "pi" | "hermes" | "claude" | undefined;
  const context: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--no-hurry-please-save-tokens-mode") {
      noHurrySaveTokensMode = true;
      continue;
    }

    if (token === "--no-relaunch-upon-rugpull") {
      noRelaunchUponRugpull = true;
      continue;
    }

    if (token === "--claude-as-harness") {
      if (harnessAs !== undefined) {
        throw new Error(
          "Cannot specify more than one harness. Choose one of --claude-as-harness, --pi-as-harness, or --hermes-as-harness.",
        );
      }
      harnessAs = "claude";
      continue;
    }

    if (token === "--pi-as-harness") {
      if (harnessAs !== undefined) {
        throw new Error(
          "Cannot specify more than one harness. Choose one of --claude-as-harness, --pi-as-harness, or --hermes-as-harness.",
        );
      }
      harnessAs = "pi";
      continue;
    }

    if (token === "--hermes-as-harness") {
      if (harnessAs !== undefined) {
        throw new Error(
          "Cannot specify more than one harness. Choose one of --claude-as-harness, --pi-as-harness, or --hermes-as-harness.",
        );
      }
      harnessAs = "hermes";
      continue;
    }

    if (token === "--working-directory-for-harness") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      i++;
      continue;
    }

    const inlinePrefix = "--working-directory-for-harness=";
    if (token.startsWith(inlinePrefix)) {
      const value = token.slice(inlinePrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      continue;
    }

    if (token === "--worktree-origin-repository") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-repository.");
      }
      worktreeOriginRepository = value;
      i++;
      continue;
    }

    const wtRepoPrefix = "--worktree-origin-repository=";
    if (token.startsWith(wtRepoPrefix)) {
      const value = token.slice(wtRepoPrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-repository.");
      }
      worktreeOriginRepository = value;
      continue;
    }

    if (token === "--worktree-origin-ref") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-ref.");
      }
      worktreeOriginRef = value;
      i++;
      continue;
    }

    const wtRefPrefix = "--worktree-origin-ref=";
    if (token.startsWith(wtRefPrefix)) {
      const value = token.slice(wtRefPrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-ref.");
      }
      worktreeOriginRef = value;
      continue;
    }

    if (token === "--context") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("Missing value for --context.");
      addContextPair(context, value);
      i++;
      continue;
    }

    if (token.startsWith("--context=")) {
      addContextPair(context, token.slice("--context=".length));
      continue;
    }

    taskParts.push(token);
  }

  return {
    taskTitle: taskParts.join(" ").trim(),
    workingDirectoryForHarness,
    worktreeOriginRepository,
    worktreeOriginRef,
    noHurrySaveTokensMode,
    noRelaunchUponRugpull,
    harnessAs,
    context,
  };
}

const CONTEXT_KEY = /^[a-z][a-z0-9_]*$/;

function addContextPair(context: Record<string, string>, pair: string): void {
  const separator = pair.indexOf("=");
  if (separator <= 0) throw new Error(`--context expects key=value, got "${pair}".`);
  const key = pair.slice(0, separator).trim();
  if (!CONTEXT_KEY.test(key)) {
    throw new Error(`--context key must match ${CONTEXT_KEY} (lowercase snake_case), got "${key}".`);
  }
  context[key] = pair.slice(separator + 1);
}
