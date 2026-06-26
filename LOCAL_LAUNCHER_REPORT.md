# Local Launcher Implementation Report

Date: 2026-06-25

## Summary

Project Pilot now has a one-terminal local launcher:

```powershell
npm run local
```

The launcher starts Project Pilot, waits for `http://127.0.0.1:3000/dashboard`, then starts the configured tunnel client profile `project-pilot`. Output is prefixed by source, and one `Ctrl+C` stops both launcher-owned child processes.

## Commands Added

- `npm run local`
- `npm run local:status`
- `npm run local:open`
- `npm run local:stop`
- `.\Start-ProjectPilot.ps1`

## Safety Behavior

- Refuses to start if port 3000 is already in use.
- Refuses to start if the configured tunnel profile is already running.
- Tracks only launcher-owned PIDs in `data/local-launcher.json`.
- `local:stop` stops only launcher-owned PIDs and does not kill unrelated Node, Codex, PowerShell, or tunnel processes.
- Stop actions warn if an Autopilot run appears active.
- The launcher does not modify task, plan, project, brief, Autopilot run, or Trade Journal Lite source state.

## Configuration

Non-secret `.env` settings:

```dotenv
PROJECT_PILOT_TUNNEL_COMMAND=tunnel-client
PROJECT_PILOT_TUNNEL_PROFILE=project-pilot
PROJECT_PILOT_TUNNEL_ARGS=run --profile {profile}
PROJECT_PILOT_LOCAL_HEALTH_TIMEOUT_MS=30000
```

If `tunnel-client` is not on `PATH`, set `PROJECT_PILOT_TUNNEL_COMMAND` to the full local executable path.

## Tests

Regression tests cover launcher config parsing, malformed config rejection, tunnel profile process detection, duplicate start refusal decisions, launcher-owned stop targeting, and active Autopilot run detection.

Results:

- `npx vitest run test/local-launcher.test.ts` passed with 7 tests.
- `npm test` passed with 154 tests.
- `npm run check` passed with TypeScript build plus 154 tests.

## Normal Workflow

Start:

```powershell
cd $HOME\Projects\ai-pilot\project-pilot
npm run local
```

Stop:

```powershell
Ctrl+C
```

Status:

```powershell
npm run local:status
```
