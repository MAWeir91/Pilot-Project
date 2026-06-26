# Baseline Inspection Report

Task ID: task-2026-06-26T00-10-18-963Z-62d8e297

## Scope

This inspection used repository code, tests, README/recent repair reports, and summarized persisted state in `data/tasks.json`. It did not inspect `.env`, copy secret-bearing log contents, deploy, push, merge, commit, or change runtime behavior.

## Current Implementation Locations

- Dashboard UI: `src/dashboard.ts` renders one local HTML page with Manager Mode configuration, state store health, Autopilot runs, plans, tasks, task details, plan details, approval/finalize controls, and Autopilot pause/resume/stop controls.
- Dashboard/API routes: `src/server.ts` serves `/dashboard`, `/dashboard/tasks`, `/dashboard/tasks/:taskId`, `/dashboard/plans`, `/dashboard/plans/:planId`, `/dashboard/configuration`, `/dashboard/state-health`, `/dashboard/autopilot`, and dashboard POST actions for task approval/finalization and Autopilot control.
- Task/workflow state: `src/state.ts` persists tasks, plans, project briefs, and Autopilot runs in durable JSON; `src/task-status.ts` derives display task status from persisted task/build/review fields.
- Build/review/approval lifecycle: `src/jobs.ts` starts and reconciles tasks/plans/reviews, exposes task and plan details, parses verification records, evaluates approval, finalizes eligible safe tasks, and records manual approval actions.
- Manager Mode/Autopilot: `src/manager.ts` stores run queue, decisions, timeline, scheduler state, active-runtime accounting, runtime limits, recovery/fix accounting, and worker leases. It exposes `getAutopilotStatus`, `listAutopilotRuns`, limit updates, pause/resume/stop, scheduling, and reconciliation.
- Health/readiness: `src/durable-json.ts` tracks state-file validity, read/write timestamps, snapshots, orphan temp files, last recovery, and last error; `src/status.ts` returns active project, latest task, recent build log summary, git status, and test summary.
- Launcher/readiness: `src/local-launcher.ts` and `src/local-launcher-core.ts` implement `npm run local`, local dashboard health waiting, tunnel preflight/status/open/stop behavior, launcher-owned PID targeting, and active Autopilot detection.
- Policy/risk/audit: `src/approval-policy.ts` evaluates build/review/verification gates and evidence-based risk flags; `src/jobs.ts` records approval/decline audit entries and pauses related Autopilot runs for user-controlled resume.
- Operator documentation: `README.md`, `LOCAL_LAUNCHER_REPORT.md`, `STATE_DURABILITY_REPAIR_REPORT.md`, `RISK_APPROVAL_REPAIR_REPORT.md`, and `MANAGER_MODE_REPAIR_REPORT.md` document current tools, safety boundaries, launcher operation, state durability, risk approval, scheduler/recovery, and runtime accounting.
- Regression coverage: tests in `test/` cover dashboard/server routes, approval policy, task status, state durability, Manager Mode scheduling/runtime/recovery, launcher behavior, planning, paths, lifecycle reconciliation, Codex command construction, and project registry behavior.

## Verified Baseline

- Dashboard currently exposes task, plan, Autopilot, Manager Mode configuration, and state store panels. Task details include requirements, acceptance criteria, status history, errors, build/review reports, full build/review logs, approval reasons, risk evidence, and approval action history. Plan details include status history, errors, report, and log content.
- Autopilot state is persisted with queue entries, decisions, timeline events, scheduler fields, runtime limits, active runtime, recovery/fix counters, and worker leases. MCP `get_autopilot_status` returns the full durable run record; the dashboard feed also receives the raw run record and adds runtime/current-task summaries.
- Health/readiness is partially exposed. `/dashboard/state-health` reports durable state-file health. `get_project_status` reports active project, latest task state, recent build log, git status, and a BUILD_REPORT-derived test summary. The local launcher checks dashboard reachability, port occupancy, tunnel profile processes, launcher-owned PIDs, and active Autopilot presence.
- Approval explanations are evidence based. Risk findings include confidence, source, path/label, matched behavior, policy rule, and excerpt. Manual approvals require a reason and require risk-evidence review confirmation when risk flags exist. Declines keep work intact and leave related Autopilot runs paused.
- Current summarized persisted state contains 17 tasks, 2 plans, 2 project briefs, and 2 Autopilot runs. The current inspection run is `autopilot-2026-06-26T00-10-03-872Z-d578bd9d`, running/building task `task-2026-06-26T00-10-18-963Z-62d8e297`. The previous Trade Journal Lite run `autopilot-2026-06-25T10-25-17-693Z-df2fcbb0` is completed with queue history preserved.

## Confirmed Gaps

- Dashboard Autopilot detail is shallow. The rendered dashboard shows a one-row run summary with queue titles/statuses, runtime, scheduler summary, current active worker, next action, and reason/summary, but no dedicated run detail view for full timeline, manager decisions, historical worker leases, recovery attempts, or limit-update audit data.
- Project briefs and registered projects have MCP tools and persisted state but no dashboard view or detail screen in the current HTML dashboard.
- Health/readiness is split across surfaces. State health, launcher status, and `get_project_status` each expose part of readiness, but there is no single dashboard readiness summary combining server/local-only status, project registry status, latest task gates, state health, launcher/tunnel status, and active Autopilot readiness.
- Maintenance/self-improvement support exists as normal Manager Mode tasks, planning, recovery, and repair reports, but there is no distinct dashboard "maintenance mode" or explicit self-improvement mode state/control found in code.
- Documentation covers setup, tools, safety boundaries, launcher usage, and recent repairs, but it does not provide an operator-facing dashboard field guide that maps every dashboard panel/control to its backing state and safe operating procedure.
- Regression coverage is broad for server endpoints and lifecycle policy, but there is no browser/UI regression test that validates the rendered dashboard layout/controls themselves or an Autopilot run detail view, because that detail view does not exist.

## Assumptions Not Treated As Gaps

- No claim is made that a separate maintenance mode is required; only that none is currently implemented or documented as a distinct state/control.
- No claim is made that dashboard exposure of full Autopilot history is absent from backend data. The backend returns full run records; the confirmed gap is the rendered UI's lack of drill-down.
- No claim is made about secret handling beyond repository evidence. `.env` was intentionally not inspected.

## Constraints To Preserve In Later Work

- Preserve scheduler single-flight behavior, durable queue/worker launch transactions, recovery accounting, and no-duplicate-worker guarantees.
- Preserve active-runtime accounting so paused, blocked, quota-waiting, user-waiting, idle, and server-down time do not consume active runtime budget.
- Preserve durable state-store serialization, Windows-safe writes, corruption recovery rules, and health reporting.
- Preserve evidence-based risk policy, approval hard gates, manual approval reason/evidence requirements, and dashboard/MCP approval safeguards.
- Preserve local-only behavior: server binding, loopback route checks, no generic shell MCP tool, `shell: false` Codex spawning, and registered project-root control.
- Preserve Trade Journal Lite as a registered/allowlisted project and avoid changing its files, Git state, deployment state, credentials, or financial/trading behavior during Project Pilot dashboard/maintenance work.

## Non-Secret Artifact Status

This report contains code paths, counts, task/run IDs, statuses, and verified implementation/gap notes only. It intentionally excludes environment variables, API keys, raw logs, hidden model reasoning, credentials, and target-project source changes.
