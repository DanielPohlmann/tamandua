# Creating Workflows

This guide walks through creating a custom workflow for Tamandua.

## Overview

A workflow is a directory containing:
- `workflow.yml` — the workflow specification
- One subdirectory per agent (path set by `workspace.baseDir`) holding the agent's persona files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`)

When installed, the workflow is copied to `~/.tamandua/workflows/<workflow-id>/` and each agent's workspace is provisioned under `~/.tamandua/workspaces/workflows/<workflow-id>_<agent-id>/`.

## workflow.yml

```yaml
id: my-workflow             # Required. Unique identifier (kebab-case)
name: My Custom Workflow    # Optional. Human-readable name
version: 1                  # Optional. Schema version
description: |              # Optional. Free text — informational only
  A workflow that does something useful.

# Optional polling overrides applied to every agent's polling cron.
polling:
  model: default            # Optional. Override the polling model
  timeoutSeconds: 120       # Optional. Polling-cron interval hint (NOT the per-step budget)

# Optional initial context. Keys here are merged into every step's template
# context (the `{{task}}` key is always seeded automatically from the CLI arg).
context:
  some_key: some_value

# Optional notification webhook.
notifications:
  url: https://example.com/webhook

agents:
  - id: planner               # Required.
    name: Planner              # Optional.
    description: Decomposes tasks into stories.   # Optional.
    role: analysis             # Optional. analysis|coding|verification|testing|pr|scanning
                               # If omitted, the role is inferred from the agent id.
    model: claude-sonnet       # Optional. Per-agent model override
    pollingModel: claude-haiku # Optional. Model used for the polling cron only
    timeoutSeconds: 1800       # Optional. Per-step wall-clock budget (seconds).
                               # Defaults: analysis|verification|pr|scanning = 1200 (20m);
                               #           coding|testing = 1800 (30m).
    workspace:
      baseDir: agents/planner  # Required. Directory (relative to workflow.yml) holding
                               # this agent's persona files. AGENTS.md, IDENTITY.md, and
                               # SOUL.md are picked up automatically from here.
      skills:                  # Optional. Skill names to install for this agent.
        - tamandua-agents
      files:                   # Optional. Extra files to copy into the workspace,
                               # or overrides for the persona files. Keys are the
                               # destination filename in the workspace; values are
                               # source paths resolved against the workflow root
                               # (so `../../agents/shared/...` works for shared files).
        EXTRA.md: agents/planner/EXTRA.md

  - id: developer
    name: Developer
    role: coding
    workspace:
      baseDir: agents/developer

steps:
  - id: plan                   # Required. Unique step id within the workflow.
    agent: planner             # Required. Must match an agent id above.
    input: |                   # Required. Template (see Placeholders below).
      Plan the implementation of {{task}}.
      Output the stories as STORIES_JSON.
      Reply with STATUS: done.
    expects: "STATUS: done"    # Required. Substring expected in the agent's output.
    max_retries: 4             # Optional. Step-level retry budget. Default: 4.
    on_fail:
      escalate_to: human       # On exhausting max_retries, escalate to the lead agent.

  - id: implement
    agent: developer
    type: loop                 # Optional. "single" (default) or "loop".
    loop:
      over: stories            # Required for loops. Currently only "stories".
      completion: all_done     # Required for loops. Currently only "all_done".
      fresh_session: true      # Optional. New agent session per story. (camelCase
                               # `freshSession` also accepted; snake_case preferred.)
      verify_each: true        # Optional. Run verifyStep after each story.
      verify_step: verify      # Optional. Step id of the verifier.
    input: |
      Implement the current story.

      CURRENT STORY:
      {{current_story}}

      Reply with STATUS: done.
    expects: "STATUS: done"
    max_retries: 4
    on_fail:
      retry_step: implement    # Informational — current code only honors escalate_to
      on_exhausted:
        escalate_to: human

  - id: verify
    agent: verifier
    input: |
      Verify {{current_story_title}} against acceptance criteria.
      Reply with STATUS: done or STATUS: retry.
    expects: "STATUS: done"
```

## Agent Persona Files

Each agent's `baseDir` is automatically scanned for these files; whatever is present is copied into the agent's workspace:

- `AGENTS.md` — system prompt / role brief
- `IDENTITY.md` — optional. Agent identity and background
- `SOUL.md` — optional. Personality and behavior guidelines

You can also list extra files (or override the persona files) under `workspace.files`. Source paths in `files` are resolved against the workflow root, so `../../agents/shared/setup/AGENTS.md` is valid for sharing personas across workflows in the same repo.

Example `AGENTS.md`:

```markdown
You are a workflow agent in the Tamandua system.
Your role: Planner.
You decompose tasks into implementable stories.

Always reply with KEY: value lines:
STATUS: done
PLAN: your plan summary

For stories, emit a single literal line:
STORIES_JSON: [{"id":"S1","title":"...","description":"...","acceptanceCriteria":["..."]}]
```

## Step Input Templates

Step `input` is rendered with `{{key}}` placeholders before being sent to the agent. The placeholder regex matches `{{word(.word)*}}`, but the resolver does a **flat key lookup** — there are no nested objects. Unknown keys are substituted with the literal text `[missing: <key>]`.

The context for each step is built from:

1. The run's seeded context (the `{{task}}` argument plus any `context:` from `workflow.yml` and `--context` overrides at run time).
2. `KEY: value` pairs parsed from every previous completed step's output. Keys are lowercased; subsequent steps reference them in lowercase (e.g., emitting `BRANCH: feature/foo` makes `{{branch}}` available downstream).
3. Computed values added by the runtime.

### Always available

| Placeholder | Description |
|-------------|-------------|
| `{{task}}` | The task description from `tamandua workflow run` |
| `{{run_id}}` | The run UUID |

### Computed when context allows

| Placeholder | Description |
|-------------|-------------|
| `{{has_frontend_changes}}` | `"true"` or `"false"` — derived from `repo` + `branch` if both are set |
| `{{has_pr}}` | `"true"` if a previous step emitted `PR_URL:` |

### Loop steps only

| Placeholder | Description |
|-------------|-------------|
| `{{current_story}}` | A formatted block: `Story <id>: <title>\n\n<description>\n\nAcceptance Criteria:\n  1. ...` |
| `{{current_story_id}}` | The current story's id |
| `{{current_story_title}}` | The current story's title |
| `{{completed_stories}}` | Bullet list of completed stories, or `(none yet)` |
| `{{stories_remaining}}` | Count of pending + running stories |
| `{{progress}}` | Contents of `progress-<run_id>.txt` (if the agent maintains one) |
| `{{progress_file}}` | Absolute path of that progress file, in the loop agent's workspace. Point agents at it instead of a bare `progress-{{run_id}}.txt`: in worktree mode a relative name lands in the run's git worktree, dirties the tree and is never read back |
| `{{verify_feedback}}` | Feedback from the verify step on retry, else empty |

### From prior step `KEY: value` outputs

Anything a prior step emits as `KEY: value` becomes `{{key}}` (lowercased). Common conventions used in the bundled workflows: `{{repo}}`, `{{branch}}`, `{{build_cmd}}`, `{{test_cmd}}`, `{{changes}}`, `{{tests}}`, `{{retry_feedback}}`, `{{pr}}`, `{{results}}`.

## Step Output Format

The output parser scans line-by-line for `^[A-Z_]+:` to detect the start of a new key. Anything that does not match starts a continuation of the previous key's value. Keys are stored lowercased.

> **CRITICAL — STATUS line.** The scheduler classifies agent output by exact
> markers: `STATUS: done` (success) or `STATUS: failed`/`STATUS: error`
> (failure). If neither marker is present, the step is treated as
> **lost/abandoned** and retried — wasting a retry slot even when the work was
> actually completed. This is the most common cause of spurious retries. When
> writing agent persona files (AGENTS.md), state explicitly that the last line
> of output must be `STATUS: done` on success, or that output must end with
> `STATUS: failed` and a `REASON:` line on failure. The bundled workflows
> include a `## CRITICAL — STATUS Line Requirement` section for this — copy it
> into your own personas.

```
STATUS: done
CHANGES: what was changed
TESTS: what tests were run
```

Continuation lines work — this becomes a single multi-line value:

```
NOTES: first line
second line still part of NOTES
THIRD_KEY: starts here
```

For loop-generating steps, the output must include a `STORIES_JSON:` line (parsed separately and not merged into the KEY: value context):

```
STATUS: done
PLAN: implementation plan summary
STORIES_JSON: [{"id":"S1","title":"Add login","description":"...","acceptanceCriteria":["Users can log in","Tests pass"]}]
```

`STORIES_JSON` requirements:
- Must be a JSON array (the parser walks following lines until it hits another `KEY:` line, so multi-line JSON is fine).
- **Maximum 20 stories.**
- Each story must have `id`, `title`, `description`, and a non-empty `acceptanceCriteria` array (`acceptance_criteria` is also accepted).
- Story `id`s must be unique within the array.

## Roles

| Role | Capabilities | Use For | Default timeout |
|------|--------------|---------|-----------------|
| `analysis`     | Read code, reason — no write/exec restrictions enforced by tamandua, used as a description on pi | Planner, reviewer, investigator, triager | 1200s (20m) |
| `coding`       | Read/write/exec — primary workhorse role            | Developer, fixer, setup        | 1800s (30m) |
| `verification` | Read + exec, no write — independent verification    | Verifier                       | 1200s (20m) |
| `testing`      | Read + exec for E2E, no write                       | Tester                         | 1800s (30m) |
| `pr`           | Read + exec only — runs `gh pr create`              | PR creation                    | 1200s (20m) |
| `scanning`     | Read + exec for security scanning                   | Security scanner               | 1200s (20m) |

If `role` is omitted, the role is inferred from the agent id (e.g., ids containing `planner` → `analysis`, `verifier` → `verification`, `tester` → `testing`, `scanner` → `scanning`, `pr` → `pr`, anything else → `coding`).

## Retry and Escalation

```yaml
- id: implement
  ...
  max_retries: 4          # Step-level retry budget. Default: 4. THIS IS THE
                           # number actually enforced when a step fails.
  on_fail:
    retry_step: implement  # Informational only — not currently read by the runtime.
    on_exhausted:
      escalate_to: human   # Valid: "human", "main", or "agent:<id>:<name>".
                            # On exhaustion the run is marked failed and the
                            # escalation target is logged. Other values (e.g.
                            # "user") silently no-op.
```

Notes:
- The step-level `max_retries` is the only retry budget enforced. An `on_fail.max_retries` field is accepted by the YAML schema but **not read** by the current runtime — leave it out to avoid confusion.
- For `type: loop` steps, retries are tracked per-story (each story has its own retry budget, currently fixed at 4).

## Loops

Loop steps repeat over stories generated by a previous step (the planner emits `STORIES_JSON:`).

```yaml
- id: implement
  type: loop
  loop:
    over: stories          # Currently only "stories".
    completion: all_done   # Currently only "all_done".
    verify_each: true      # Optional. Run verify_step after each story.
    verify_step: verify    # Optional. Step id of the verifier.
    fresh_session: true    # Optional. Start a new agent session per story.
```

YAML uses snake_case (`fresh_session`, `verify_each`, `verify_step`); the camelCase variants (`freshSession`, `verifyEach`, `verifyStep`) are also accepted for backward compatibility.

## Installing Workflows

```bash
# List available bundled workflows
tamandua workflow list

# Install a bundled workflow by name
tamandua workflow install <workflow-id>

# Install all bundled workflows at once
tamandua workflow install --all

# Run it
tamandua workflow run <workflow-id> "your task description"
```

`tamandua workflow install` only accepts the **id of a workflow bundled with this repo** (a directory under `workflows/` in the tamandua source checkout). Installing a custom workflow from a filesystem path or a remote URL is not currently supported by the CLI — to add a custom workflow, drop it into the `workflows/` directory of your tamandua checkout and reinstall.
