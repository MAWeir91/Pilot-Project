# Manager Mode Repair Report

Date: 2026-06-25

## Root Cause

The active Trade Journal Lite Autopilot run `autopilot-2026-06-25T10-25-17-693Z-df2fcbb0` was blocked by two separate Manager Mode failures:

- Earlier failures were Manager API quota errors (`429 You exceeded your current quota`).
- The newest failure was a decision-validation failure. The persisted Zod diagnostics showed an invalid `action` value and a missing `summary`.

Project Pilot was using strict Zod validation after receiving manager output, but the manager prompt, TypeScript action type, JSON schema, Zod validator, and runtime dispatcher did not share one canonical contract. The dispatcher had task-level behavior, but the allowed action list did not include an explicit task-level finalization action. The old OpenAI response extraction also did not persist a bounded raw candidate/selected-output diagnostic, so the exact already-failed raw response object is not recoverable from stored state; only the persisted validation result is available.

The repaired implementation now records future selected-output and candidate previews before validation, including the received `action` value and missing required fields.

The foundation task `task-2026-06-25T01-36-32-141Z-5873a120` was safe but was blocked from automatic finalization because risk detection scanned raw task/report text and treated prohibited-scope language such as "no cloud deployment" as a positive deployment risk.

The later task `task-2026-06-25T11-47-40-428Z-d09c5590` reached `ready-for-approval` with a passed independent review, but finalization was incorrectly blocked because verification evaluation treated any historical command failure as permanently disqualifying. Its `BUILD_REPORT.md` recorded an initial failed `npm test` attempt followed by a passing retry, plus passing `npm run check` and `npm run build`. The old policy inspected every command-looking block and failed if any block was not passing, instead of evaluating the current effective result for each configured command.

The Autopilot run also remained in a stale review lifecycle state because task status derivation gave persisted `reviewing` precedence over terminal review metadata, and Manager Mode did not reconcile the current task before asking for another manager decision.

## Fixes

- Added a canonical Manager Mode JSON schema for the Responses API structured output.
- Added one canonical `MANAGER_DECISION_ACTIONS` source of truth used by the TypeScript type, JSON schema, Zod validator, prompt/example, and dispatcher.
- Added task-level actions `finalize_current_task` and `skip_duplicate_task`, distinct from project-level `finalize_project`.
- The strict decision shape now requires `action`, `summary`, `reason`, `taskId`, `tasks`, and `fixTask`, with unused action-specific fields set to `null`.
- Kept strict Zod validation and added one bounded corrective retry after the first malformed manager response.
- Repeated malformed manager responses now block with `manager_decision_invalid` and no worker launch.
- Manager API failures now block with `manager_api_error` or `manager_api_quota_error`, distinct from schema errors.
- OpenAI Responses extraction now selects the final assistant structured-output payload, skips reasoning items, handles refusals/incomplete/failed responses explicitly, and rejects nested or wrongly extracted payloads instead of silently remapping them.
- Risk classification now ignores negated/prohibited-scope evidence such as "no cloud deployment" and preserves blocks for genuine risky operations.
- Added duplicate task prevention in task creation and Autopilot resume/tick handling.
- Cancelled the duplicate queued foundation task while preserving its historical record.
- Added the registered `npm run check` command to Trade Journal Lite as `npm run lint && npm run typecheck`.
- Added structured task verification records with command, attempt number, timestamps, exit code, status, output reference, and `isCurrent`.
- Changed finalization to require the current effective result for each configured command to pass. Later successful retries supersede earlier failed attempts while preserving full command history.
- Fixed stale review status derivation so terminal review records such as `result: pass` are not masked by an old top-level `reviewing` status.
- Added a JobService reconciliation path used by Autopilot before manager decisions. A passed review now triggers verification reconciliation and task finalization eligibility checks before the run can remain in `reviewing`.
- Updated Autopilot queue reconciliation so a finalized current task marks its queue item `completed` and does not continue into a manager decision in the same tick.

## Reconciliation

- Auto-finalized `task-2026-06-25T01-36-32-141Z-5873a120` after confirming build passed, review passed, configured verification passed, and risk flags were empty.
- Marked duplicate queued task `task-2026-06-25T01-36-16-575Z-5ffeec9f` as stopped with an explicit duplicate-cancellation reason.
- Created Trade Journal Lite branch `autopilot/foundation-task-5873a120`.
- Created local commit `19657ca` with message `Add local Vite TypeScript foundation`.
- Did not push or create a draft PR because the Trade Journal Lite repository has no configured remote.
- Reconciled `task-2026-06-25T11-47-40-428Z-d09c5590` from persisted `BUILD_REPORT.md` and `REVIEW_REPORT.md` without rerunning the build or review.
- Stored verification history for the task:
  - `npm test` attempt 1: failed, not current.
  - `npm test` attempt 2: passed, current.
  - `npm run check` attempt 1: passed, current.
  - `npm run build` attempt 1: passed, current.
- Auto-finalized `task-2026-06-25T11-47-40-428Z-d09c5590` after confirming current verification results, review pass, and empty risk flags.
- Updated the existing run to `paused` with no `currentTaskId`, `lastCompletedTaskId` set to `task-2026-06-25T11-47-40-428Z-d09c5590`, and the matching queue item marked `completed`.
- No new Autopilot run, project brief, plan, task list, implementation task, build worker, or review worker was created.
- No Trade Journal Lite files were staged, deleted, or overwritten by the reconciliation repair. The existing untracked/modified Trade Journal Lite working tree was preserved.

## Verification

Project Pilot:

- `npm test` passed.
- `npm run check` passed.
- Manager contract regression tests cover valid `finalize_current_task`, valid `finalize_project`, unknown actions such as `approve_task`, missing `summary`, nested/wrongly extracted payloads, one corrective retry, second invalid response blocking, existing-run resume idempotency, safe foundation task finalization, and duplicate foundation cancellation.
- Verification regression tests cover failed command followed by passing retry, preservation of historic failed attempts, and blocking when a configured command has only failures.
- Lifecycle regression tests cover review pass reconciliation, stale `reviewing` status with terminal review metadata, restart reconciliation from completed review reports, resume without rerunning a completed build/review, and current-run reconciliation without creating new runs or tasks.

Trade Journal Lite:

- `npm test` passed.
- `npm run check` passed.
- `npm run build` passed.

## Remaining Limitation

The existing Autopilot run is intentionally paused after reconciliation. It is ready for user-controlled resume from the dashboard after Project Pilot is restarted.

## Runtime Budget Repair

### Root Cause

The Autopilot runtime guardrail previously compared `now - startedAt` to `limits.maxRuntimeMs`. That treated the run's full wall-clock age as active runtime, so paused, blocked, quota-waiting, user-waiting, idle, and server-down time consumed the budget. The Trade Journal Lite run hit `Manager runtime budget reached.` with a persisted 2-hour limit even though much of the elapsed time was spent waiting after quota/schema failures or user pauses.

### Correction

- Added persisted `activeRuntimeMs` and `activeRuntimeStartedAt` fields to Autopilot runs.
- Runtime limit checks now use active runtime only.
- Dashboard/status data now includes Active Runtime, Wall-Clock Elapsed, runtime limit, and remaining active-runtime budget.
- Startup reconciliation excludes server-down time instead of charging it to active runtime.
- Pause, block, stop, completion, and limit paths close any open active-runtime segment once.
- Added `update_autopilot_limits`, an audited MCP control that updates only an existing run's runtime, manager-decision, task, or fix-attempt limits and records old limits, new limits, timestamp, reason, and active runtime in the run timeline.

### Current Run Migration

- Recalculated active runtime for `autopilot-2026-06-25T10-25-17-693Z-df2fcbb0` from persisted timeline and task lifecycle evidence.
- Active runtime after repair: `1335391` ms.
- Wall-clock elapsed at repair: `8987430` ms.
- Runtime limit updated from `7200000` ms to `28800000` ms.
- Remaining active-runtime budget after repair: `27464609` ms.
- Run status changed from `usage-limited` to `paused` with a user-controlled resume reason.
- Existing completed task, queued tasks, brief, plan, and audit timeline were preserved.
- No new Autopilot run, project brief, plan, task list, implementation task, build worker, or review worker was created.

### Runtime Tests

Project Pilot:

- `npm test` passed with 117 tests.
- `npm run check` passed.
- Added regression coverage for paused time, blocked/quota-wait time, server restart, repeated resume attempts, audited limit updates, active-runtime-only blocking, and completed-task repair without rerunning work.

## Scheduler, Restart Recovery, and Observability Repair

### Root Causes

The current storage task `task-2026-06-25T13-04-39-310Z-732c27a1` was blocked by operational process tracking loss. Its original build worker PID `24884` was no longer alive after Project Pilot restarted, and no terminal build event, exit code, fresh build report, or review result was captured for that task. The run then depended on manual resume/restart behavior because queued work was only advanced during specific manager ticks and terminal paths, not through a durable scheduler heartbeat.

The run queue also kept the original storage queue item in `queued` state after that task had already launched. That made future duplicate dispatch possible after the recovery item completed.

### Correction

- Added a persistent scheduler state to Autopilot runs with last tick, next scheduled tick, dispatch status, dispatch outcome, and skipped-dispatch reason.
- Added a per-run single-flight scheduler lock so overlapping ticks cannot launch duplicate workers.
- Scheduling is now triggered after manager decisions, queued task creation, build/review/fix/recovery/finalization terminal paths, startup reconciliation, and user resume.
- Queued operational recovery and reviewer-fix items are dispatched before ordinary manager queue items.
- Added persisted worker leases for build, review, recovery, fix, and finalization phases, including run ID, task ID, phase, PID when available, command, start time, attempt type, report path, expected artifact, log path, status, and outcome.
- Lost PID, missing terminal event, restart, and scheduler-loss cases are treated as operational recovery, separate from reviewer-requested engineering fixes.
- Recovery attempts are counted separately from `fixAttemptsByTaskId` and bounded.
- Startup/runtime configuration parsing now rejects malformed positive integer values instead of silently truncating or partially parsing them.
- Added a local instance lock so a second Project Pilot server instance refuses to start when a live PID already owns the lock, with stale-lock recovery after crashes.
- Dashboard run details now expose runtime budget, scheduler state, queue dispatch status, and active/historical worker lease details.

### Current Run Migration

- Preserved Autopilot run `autopilot-2026-06-25T10-25-17-693Z-df2fcbb0`, its brief, plan, completed documentation/foundation work, current storage task, queued tasks, Git state, and audit timeline.
- Left the run `paused`; no resume, worker launch, new run, new brief, new plan, new task list, duplicate task, duplicate worktree, or duplicate worker was created.
- Preserved storage task `task-2026-06-25T13-04-39-310Z-732c27a1` as blocked from lost worker tracking.
- Converted existing queued revalidation item `queue-20820f91` from reviewer fix to operational `recovery`.
- Marked original storage queue item `queue-766972b5` as `blocked` and linked it to the already-created storage task so it cannot dispatch as duplicate work later.
- Recorded a recovered historical worker lease for PID `24884` with status `dead`.
- Set `recoveryAttemptsByTaskId["task-2026-06-25T13-04-39-310Z-732c27a1"]` to `0`; the recovery allowance will be consumed only when the recovery worker actually dispatches after user resume.
- Cleared any storage-task reviewer fix count so operational recovery does not consume the reviewer-requested engineering fix allowance.
- Runtime limit remains `28800000` ms. Current persisted active runtime is `1897360` ms, leaving `26902640` ms of active-runtime budget before the 8-hour cap.

### Expected Resume Behavior

After Project Pilot restarts and the user clicks Resume once, the scheduler should:

1. Keep completed documentation/foundation/domain tasks completed and not rerun them.
2. Dispatch the existing operational recovery queue item `queue-20820f91`.
3. Run the recovery through the normal build -> review -> finalization lifecycle.
4. Keep later queued UI/finalization tasks queued until the storage recovery task resolves.
5. Continue advancing terminal lifecycle events without requiring another server restart.

### Scheduler and Recovery Tests

Project Pilot:

- `npm test` passed with 122 tests.
- `npm run check` passed with 122 tests.
- Added regression coverage for queued recovery dispatch without restart, scheduler advancement after queued decisions, single-flight duplicate-worker prevention, restart/lost-worker operational recovery, separate recovery versus reviewer-fix accounting, malformed runtime environment rejection, duplicate instance startup refusal, active-runtime accounting, limit updates, and completed-task repair without rerunning work.

## Restart

Restart Project Pilot after this repair so the MCP server and dashboard load the new contract:

```powershell
cd $HOME\Projects\ai-pilot\project-pilot
npm run dev
```
