# State Durability Repair Report

Date: 2026-06-25

## Root Cause

Project Pilot could concurrently read and rewrite `data/tasks.json` from scheduler ticks, dashboard refreshes, MCP calls, worker callbacks, and reconciliation paths. The old `StateStore` serialized only writes and used a temp-file copy over the live file, which was vulnerable to Windows `EBUSY`/`EPERM`/`EACCES` conflicts and could expose invalid or incomplete live JSON after an interrupted write.

The Autopilot scheduler also had a launch-order gap: a queued task could be created before the run queue/worker-lease transition was durably committed. If persistence failed during that window, a retry could create duplicate recovery work.

## Fixes

- Added `DurableJsonFile`, a per-file in-process queue for all reads, writes, and read-modify-write transactions.
- Reworked `StateStore` and `ProjectRegistry` to use transactional durable JSON access.
- Writes now go to a unique same-directory temp file, sync the temp file, preserve a bounded live-file snapshot, move the old live file aside, then rename the temp file into place.
- Windows transient errors (`EBUSY`, `EPERM`, `EACCES`, transient `ENOENT`, and rename conflicts) are retried with bounded exponential backoff.
- Invalid or empty live JSON is never accepted silently. Recovery only runs when the live file is corrupt, and candidates are selected deterministically from valid snapshots/temp files by freshness.
- A valid live file is never replaced by an orphan temp file.
- Dashboard now exposes a State Store panel and `/dashboard/state-health` showing file validity, last successful read/write, snapshot count, orphan temp files, last error, and last recovery.
- Autopilot queued worker launch now uses a prepared-build path: task record, run queue status, recovery attempt count, and worker lease are committed in one state transaction before Codex is launched.
- Scheduler errors are caught and fail closed with a `state_store_unavailable` pause attempt instead of an unhandled server crash.

## Current State Migration

`data/tasks.json` was validated as the authoritative live state. It was not overwritten from any temp file.

Existing orphan temp files were left in place as diagnostics and are visible from state health:

- `tasks.json.22260.9ce13dff-b4cc-4942-aa5d-40d1f1d4be52.tmp`
- `tasks.json.17708.3bdc165b-05de-459c-90a9-e3ebafc6a417.tmp`

New bounded snapshots were created by successful durable writes. The live run `autopilot-2026-06-25T10-25-17-693Z-df2fcbb0` was left paused with an audit event so startup will not dispatch recovery before the user explicitly resumes.

Preserved run facts:

- Existing Trade Journal Lite run, brief, plan, tasks, queued recovery item, Git state, and audit history were preserved.
- Operational recovery queue item `queue-20820f91` remains queued as `recovery`.
- Original storage queue item `queue-766972b5` remains blocked to prevent duplicate dispatch.
- Recovery attempts for `task-2026-06-25T13-04-39-310Z-732c27a1` remain `0`.
- Runtime limit remains `28800000` ms.

## Tests Run

- `npm test` passed with 130 tests.
- Added regression coverage for simultaneous reads/updates, transient `EBUSY` read/write retry, retry exhaustion, interrupted replacement preserving live JSON, corrupt live recovery from snapshot, valid live ignoring orphan temp files, launch-before-persist prevention, duplicate recovery prevention after retry, and dashboard/server survival after recoverable state corruption.

## Restart Instructions

Restart Project Pilot once:

```powershell
cd $HOME\Projects\ai-pilot\project-pilot
npm run dev
```

After the dashboard is back, click Resume once on the existing Trade Journal Lite Autopilot run.

## Expected Behavior After One Resume

The scheduler should dispatch the existing operational recovery queue item `queue-20820f91` only after its launch transition is durably committed. It should not create a new run, brief, plan, task list, duplicate recovery task, duplicate worktree, or duplicate worker. Completed documentation/foundation/domain work should not rerun.
