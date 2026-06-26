# Project Pilot

Project Pilot is a local-only TypeScript Node.js MCP server for managing Codex work in registered local projects.

Approved projects are stored in `data/projects.json`. On first run, Project Pilot migrates the existing Trade Journal Lite project at `../trade-journal-lite` into that registry and marks it active.

It exposes a Streamable HTTP MCP endpoint at:

`http://127.0.0.1:3000/mcp`

It also serves a local task dashboard at:

`http://127.0.0.1:3000/dashboard`

## Tools

- `get_project_status`: read-only status for the current task, recent build log, git status, and test summary.
- `list_projects`: returns registered local projects and the active project id.
- `get_project`: returns one registered project by `projectId`.
- `register_project`: adds or updates an approved local project with command and Git metadata.
- `configure_maintenance_execution`: enables, disables, or updates self-maintenance execution for a registered project after validating the isolated worktree, live root, base branch, expected branch, and dirty-working-tree policy.
- `set_active_project`: changes the default project used by task tools when no `projectId` is supplied.
- `get_active_project`: returns the active registered project.
- `create_project_brief`: persists a durable project brief that ChatGPT can synthesize from the current conversation when you say "Start Autopilot".
- `get_project_brief`: returns one persisted project brief.
- `list_project_briefs`: returns persisted project briefs newest first.
- `start_autopilot`: starts an explicit Manager Mode run from a project brief and optional plan.
- `get_autopilot_status`: returns a durable Manager Mode run record, queue, decisions, timeline, and pause/completion state.
- `update_autopilot_limits`: updates an existing run's runtime, decision, task, or fix-attempt limits with an audit reason; it never creates runs, tasks, briefs, plans, or workers.
- `pause_autopilot`: pauses a running Manager Mode run.
- `resume_autopilot`: resumes a paused Manager Mode run.
- `stop_autopilot`: stops a Manager Mode run.
- `start_plan`: starts a read-only Codex planning pass in a registered project and captures `PLAN_REPORT.md`.
- `create_task_from_plan`: creates a queued implementation task from a `plan-ready` plan without starting implementation.
- `start_build`: writes `TASK.md` in the selected project's execution root, starts `codex --ask-for-approval never exec --cd <execution-root> --sandbox danger-full-access --json`, and captures JSONL logs. Normal projects use their registered root as the execution root.
- `get_build_status`: returns queued/running/passed/failed/stopped status, log tail, and `BUILD_REPORT.md` when available.
- `list_tasks`: returns all current tasks newest first with dashboard status, build summary, review result, and latest log lines.
- `run_review`: starts a second `codex --ask-for-approval never exec --cd <execution-root> --sandbox danger-full-access --json` review. The review prompt instructs Codex to perform a read-only independent review; Project Pilot writes `REVIEW_REPORT.md` from the captured report text.
- `approve_task`: manually approves a valid `ready-for-approval` task with an explicit reason and, when risk flags exist, confirmation that the cited risk evidence was reviewed. It does not modify the target project, run Git, commit, push, merge, or deploy.
- `decline_task`: records an approval decline reason, keeps the task work intact, and leaves the related Autopilot run paused.
- `finalize_task`: auto-completes policy-eligible safe tasks or returns `manual_approval_required` with exact reasons.
- `stop_task`: stops only a tracked active build or review process for the specified task.
- `retry_review`: starts a new review only after the build passed, the previous review is blocked/failed/needs-fixes, and no reviewer PID is active.

## Safety Boundaries

- Manager Mode uses the official OpenAI Node SDK and Responses API only inside the local Project Pilot server. `OPENAI_API_KEY` is never returned through MCP responses or shown in the dashboard.
- Manager Mode uses `@openai/codex-sdk` for persistent read-only architect consultation threads. Project Pilot stores thread IDs and concise summaries, not hidden reasoning.
- Manager decisions are Zod-validated to one bounded action and mapped only to existing Project Pilot operations. Manager Mode does not execute shell commands or accept arbitrary commands from model output.
- Autopilot runs build tasks sequentially with one active worker per project, run the independent review after a successful build, and pause on blocked operations, API errors, repeated build/review failures, or configured run limits.
- Runtime limits use active runtime, not wall-clock age. Paused, blocked, quota-waiting, user-waiting, idle, and server-down intervals do not consume active runtime budget.
- Codex workers run with full local filesystem and network access using `--sandbox danger-full-access` and approval policy `never`. Use Project Pilot only on personal machines and trusted projects.
- The project registry controls every execution root passed to Codex with `--cd`; task and plan tools accept `projectId`, never arbitrary filesystem paths.
- Projects may define an explicit `executionRoot` distinct from their registered `path`. `TASK.md`, `BUILD_REPORT.md`, `REVIEW_REPORT.md`, `PLAN_REPORT.md`, maintenance worker logs, Codex working directories, and task-local command evidence are resolved from the execution root.
- Project Pilot self-maintenance projects must enable `maintenance`, set the live checkout as `maintenance.liveRoot`, set a known `maintenance.baseBranch`, and use an isolated execution worktree. Before planning, build, review, or Autopilot dispatch launches a worker, Project Pilot verifies the execution root exists, is a Git repository root, is a listed worktree, is not the live Project Pilot checkout, has a known base branch, and has either a clean working tree or an explicit dirty-working-tree reason.
- Failed maintenance Git preflight blocks the task or plan, pauses Autopilot before worker launch, and records bounded diagnostics such as expected base branch, current branch, dirty file count, and relevant paths. It does not inspect or expose file contents, credentials, `.env`, tunnel keys, or live `data/`.
- Planning workers run with `--sandbox read-only` and Project Pilot writes `PLAN_REPORT.md` from the captured plan report envelope.
- Build and review workers run with `--sandbox danger-full-access`.
- Codex is always spawned with `shell: false`.
- Project Pilot does not use `--yolo` or `--dangerously-bypass-approvals-and-sandbox`.
- There is no generic shell-command MCP tool.
- Tool inputs are validated with Zod.
- The server binds only to `127.0.0.1`.
- The dashboard and MCP routes reject non-loopback clients.
- Approval/finalization tools do not run Codex, execute shell commands, modify target-project files, run Git, commit, push, merge, or deploy.
- Risk flags include auditable evidence with confidence (`supported`, `unsupported`, or `needs-review`), source, source path/label, matched behavior, policy rule, and excerpt. Negative or exclusion safety language such as "no credentials", "no deployment", "payments excluded", or "local-only" does not create blocking risk without concrete implementation/configuration evidence.
- Ordinary Git repository work can be auto-finalized only when a task explicitly requested it and build plus independent review passed. This includes feature branches, isolated worktrees, descriptive commits, non-protected branch pushes, and draft pull requests.
- Dangerous Git operations require manual approval: force push, branch deletion, history rewriting including `reset --hard` or pushing rebased history, changing remotes/permissions/branch protections/organization settings, pushing directly to protected branches, or merging pull requests into protected branches.
- Existing manual-approval blocks remain for secrets, deployments, external services, databases, brokerage access, financial credentials, payments, network exposure, and destructive data changes.
- Active build and review PIDs are persisted, reconciled on startup/status reads, and never duplicated automatically.
- Autopilot scheduling is heartbeat-driven and single-flight per run. Queued recovery, fix, and task work dispatches after manager decisions, terminal worker events, startup reconciliation, and user resume without requiring server restarts.
- Worker leases are persisted for build, review, recovery, fix, and finalization phases. Scheduler reconciliation closes stale active leases as completed, recovered, or dead based on task state and tracked PID liveness, with timeline audit entries before any new dispatch. Lost process tracking is treated as operational recovery, distinct from reviewer-requested engineering fixes.
- JSON state files use serialized per-file transactions and Windows-safe durable writes through same-directory temp files, synced snapshots, bounded transient-error retries, and corruption recovery from valid snapshots only when the live file is invalid.
- Default timeouts are 15 minutes for builds and 8 minutes for reviews.

## Setup

```powershell
npm install
npm run build
npm test
```

Create a local `.env` from `.env.example` and set `OPENAI_API_KEY` to enable Manager Mode. Do not use `CONTROL_PLANE_API_KEY`.

```powershell
Copy-Item .env.example .env
notepad .env
```

Manager Mode settings:

```dotenv
OPENAI_API_KEY=sk-...
PROJECT_PILOT_MANAGER_MODEL=gpt-5
PROJECT_PILOT_MANAGER_MAX_DECISIONS_PER_RUN=12
PROJECT_PILOT_MANAGER_MAX_TASKS_PER_RUN=8
PROJECT_PILOT_MANAGER_MAX_FIX_ATTEMPTS_PER_TASK=1
PROJECT_PILOT_MANAGER_MAX_RUNTIME_MS=28800000
```

Tests use fake manager and Codex adapters and never make real OpenAI or Codex API calls.

## Start The Server

Normal day-to-day startup uses one PowerShell terminal:

```powershell
cd $HOME\Projects\ai-pilot\project-pilot
npm run local
```

`npm run local` starts Project Pilot first, waits for `http://127.0.0.1:3000/dashboard` to become healthy, and then starts the configured tunnel client profile. Output is prefixed with `[pilot]`, `[tunnel]`, and `[launcher]`.

Normal shutdown is one `Ctrl+C` in that same terminal. The launcher stops only the Project Pilot and tunnel processes it started.

Useful local commands:

```powershell
npm run local:status
npm run local:open
npm run local:stop
```

- `npm run local:status` checks the local dashboard, port 3000, tunnel profile process, launcher-owned PIDs, and whether an Autopilot run appears active.
- `npm run local:open` opens the local dashboard.
- `npm run local:stop` stops only launcher-owned processes recorded in `data/local-launcher.json`. It does not kill unrelated Node, Codex, PowerShell, or tunnel processes.

The PowerShell wrapper runs the same launcher and can be used as a shortcut target:

```powershell
.\Start-ProjectPilot.ps1
.\Start-ProjectPilot.ps1 -Command status
.\Start-ProjectPilot.ps1 -Command open
.\Start-ProjectPilot.ps1 -Command stop
```

Launcher tunnel configuration is non-secret and belongs in `.env`:

```dotenv
PROJECT_PILOT_TUNNEL_COMMAND=tunnel-client
PROJECT_PILOT_TUNNEL_PROFILE=project-pilot
PROJECT_PILOT_TUNNEL_ARGS=run --profile {profile}
PROJECT_PILOT_LOCAL_HEALTH_TIMEOUT_MS=30000
```

If `tunnel-client` is not on `PATH`, set `PROJECT_PILOT_TUNNEL_COMMAND` to the full local executable path. Do not put tunnel keys or other secrets in `.env`, scripts, package.json, logs, or documentation.

### Troubleshooting Local Startup

- Port 3000 already in use: `npm run local` refuses to start a duplicate Project Pilot server. Run `npm run local:status`, close the old Project Pilot terminal, or stop a launcher-owned instance with `npm run local:stop`.
- Tunnel already running: `npm run local` refuses when it finds a `project-pilot` tunnel profile already running. Reuse that tunnel or stop it from the terminal that started it.
- Tunnel missing or not configured: install the tunnel client, add it to `PATH`, or set `PROJECT_PILOT_TUNNEL_COMMAND` to the executable path in `.env`.
- Transitioning from the old multiple-terminal setup: stop the old `npm run dev` terminal and the old tunnel terminal first. Then use `npm run local` so the launcher owns both child processes and one `Ctrl+C` can stop both.
- Active Autopilot work: `npm run local:stop` warns if a run appears active. It stops only the local server/tunnel it owns and does not terminate active worker PIDs.

## Operator Runbook

These steps are for the local Project Pilot checkout and its isolated maintenance worktrees. They do not restart, deploy, push, merge, or modify any live Project Pilot service. Treat live-service updates as a separate manual operation after reviewing the local branch output.

### Startup

1. Open PowerShell in the local Project Pilot checkout.
2. Run `npm run local`.
3. Confirm the dashboard opens at `http://127.0.0.1:3000/dashboard` or run `npm run local:status`.
4. Check the dashboard readiness panel. Continue only when no component is `blocked`. A `warning` needs operator judgment before starting long-running work.

Use `npm run dev` only for server-only development without the tunnel. It still binds to `127.0.0.1` and does not control the tunnel process.

### Shutdown

1. Prefer `Ctrl+C` in the terminal that started `npm run local`.
2. If the launcher terminal is gone, run `npm run local:status` first, then `npm run local:stop` only when the status shows launcher-owned PIDs.
3. If Autopilot work is active or waiting, pause or stop it intentionally through the dashboard or MCP tools before stopping the local server.

Shutdown affects only launcher-owned local Project Pilot and tunnel child processes. It does not stop arbitrary Node, Codex, PowerShell, tunnel, or live-service processes.

### Maintenance Mode

Maintenance mode is for Project Pilot self-improvement from an isolated Git worktree. Configure it with `configure_maintenance_execution` or the equivalent dashboard/client flow using:

- `projectId`: the registered Project Pilot maintenance project.
- `liveRoot`: the live checkout path that must not be mutated by workers.
- `executionRoot`: the isolated worktree where `TASK.md`, reports, worker logs, and changes are written.
- `baseBranch` and `expectedBranch`: the branch readiness boundary for the worktree.
- `allowDirtyWorkingTree` plus `dirtyWorkingTreeReason`: only when a dirty worktree is intentional and documented.

Before launching planning, build, review, or Autopilot workers, Project Pilot validates that the execution root exists, is a Git repository root, is a listed worktree, is not the live checkout, has the expected branch context, and satisfies the dirty-working-tree policy. Failed preflight blocks local work and records bounded diagnostics without exposing `.env`, tunnel keys, credentials, file contents, or live `data/`.

### Local Status And Troubleshooting

Use these local checks before starting work, before handoff, and after failures:

```powershell
npm run local:status
npm run check
```

- `npm run local:status` reports launcher ownership, port 3000, dashboard health, tunnel profile PIDs, readiness components, and active-run state.
- The dashboard readiness panel reports launcher, tunnel, state-store, scheduler, active-run, and configuration status.
- `npm run check` runs the TypeScript build and test suite for the current checkout.

Do not paste secrets into tasks, reports, logs, issue text, or documentation. If troubleshooting requires configuration details, describe the variable name and symptom, not the secret value.

### Controlled Restart After Branch Readiness

Use this sequence after a maintenance branch is ready for operator review:

1. Verify local readiness: dashboard readiness is not `blocked`, maintenance status is `ready`, the task build passed, review passed or is `ready-for-approval`, and `BUILD_REPORT.md` reports `Final status: passed`.
2. Inspect the isolated worktree diff, `BUILD_REPORT.md`, and `REVIEW_REPORT.md`. Confirm no secrets, live `data/`, tunnel keys, or unintended files are included.
3. If Project Pilot approval/finalization is appropriate, use the dashboard or MCP approval tools. These tools record approval state only; they do not commit, push, merge, deploy, or restart the live service.
4. Stop the local launcher with `Ctrl+C` or `npm run local:stop` when there is no active local work that must continue.
5. Perform any commit, push, pull request, merge, live-checkout update, deployment, or live-service restart manually under the operator's normal Git and service runbook.
6. Start the local service again with `npm run local` and recheck `npm run local:status`.

The handoff point is step 5. Project Pilot's local maintenance workflow ends with reviewed files in the isolated worktree and explicit reports; live integration is a human-controlled action.

### Failed Local Run Recovery

1. Preserve the local evidence first: `TASK.md`, `BUILD_REPORT.md`, `REVIEW_REPORT.md`, `PLAN_REPORT.md`, dashboard status, and relevant log tails.
2. Run `npm run local:status` to identify whether the failure is launcher, tunnel, state-store, scheduler, active-run, or configuration related.
3. For duplicate port or tunnel failures, stop the terminal that owns the old process, or use `npm run local:stop` only for launcher-owned PIDs.
4. For blocked maintenance preflight, fix the isolated worktree condition shown in readiness: wrong branch, missing worktree, dirty tree without reason, missing base branch, or execution root pointing at the live checkout.
5. For failed builds or reviews, inspect the reports in the execution root, make the smallest local correction, then rerun the relevant project checks before retrying review or starting another task.
6. For state-store warnings or blocked scheduler state, avoid hand-editing `data/` while the server is running. Stop the local launcher, preserve a backup of the affected JSON and snapshots, then recover only from known-good local evidence.
7. Restart with `npm run local` and verify readiness before resuming Autopilot or creating new maintenance tasks.

If recovery requires credentials, external service access, a live deployment, a protected-branch merge, or a live-service restart, stop the local Project Pilot workflow and hand off to the operator with the exact user action needed.

For server-only development without the tunnel, the existing command remains:

```powershell
npm run dev
```

Then configure ChatGPT or an MCP client to use:

`http://127.0.0.1:3000/mcp`

## Checks

```powershell
npm run check
```

`npm run check` runs the TypeScript build and the test suite.
