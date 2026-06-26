import { describe, expect, it } from "vitest";
import { buildTunnelArgs, findTunnelProfileProcesses, hasActiveAutopilotRun, ownedStopTargets, parseLocalLauncherConfig, splitCommandLine, startPreflight } from "../src/local-launcher-core.js";
import { buildReadinessSummary, formatReadinessSummary } from "../src/readiness.js";
describe("local launcher core", () => {
    it("parses default launcher config without user-specific tunnel paths", () => {
        const config = parseLocalLauncherConfig({}, "C:\\project-pilot");
        expect(config).toMatchObject({
            host: "127.0.0.1",
            port: 3000,
            dashboardUrl: "http://127.0.0.1:3000/dashboard",
            tunnelCommand: "tunnel-client",
            tunnelProfile: "project-pilot",
            tunnelArgs: ["run", "--profile", "project-pilot"]
        });
    });
    it("parses quoted tunnel args and substitutes profile", () => {
        expect(buildTunnelArgs('run --profile "{profile}" --label "Project Pilot"', "project-pilot")).toEqual([
            "run",
            "--profile",
            "project-pilot",
            "--label",
            "Project Pilot"
        ]);
        expect(splitCommandLine('run --profile "project pilot"')).toEqual(["run", "--profile", "project pilot"]);
    });
    it("rejects malformed launcher config", () => {
        expect(() => parseLocalLauncherConfig({ PORT: "3=72000000" }, "C:\\project-pilot")).toThrow(/PORT/);
        expect(() => parseLocalLauncherConfig({ HOST: "0.0.0.0" }, "C:\\project-pilot")).toThrow(/HOST=127\.0\.0\.1/);
        expect(() => parseLocalLauncherConfig({ PROJECT_PILOT_TUNNEL_ARGS: "run --profile" }, "C:\\project-pilot")).toThrow(/PROJECT_PILOT_TUNNEL_ARGS/);
    });
    it("finds only the configured tunnel profile process", () => {
        const processes = [
            {
                pid: 10,
                name: "tunnel-client.exe",
                commandLine: '"C:\\Tools\\tunnel-client.exe" run --profile project-pilot'
            },
            {
                pid: 11,
                name: "tunnel-client.exe",
                commandLine: '"C:\\Tools\\tunnel-client.exe" run --profile other'
            },
            {
                pid: 12,
                name: "node.exe",
                commandLine: "node src/server.ts"
            }
        ];
        expect(findTunnelProfileProcesses(processes, {
            tunnelCommand: "tunnel-client",
            tunnelProfile: "project-pilot"
        }).map((item) => item.pid)).toEqual([10]);
    });
    it("refuses start when Project Pilot or the tunnel profile already exists", () => {
        const result = startPreflight({
            pilotPortOpen: true,
            tunnelProcesses: [{ pid: 10, name: "tunnel-client.exe", commandLine: "tunnel-client run --profile project-pilot" }]
        });
        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toMatch(/already reachable/);
        expect(result.errors.join("\n")).toMatch(/already running/);
    });
    it("selects only launcher-owned stop targets", () => {
        const state = {
            version: 1,
            createdAt: "2026-06-25T00:00:00.000Z",
            launcherPid: 1,
            pilotPid: 20,
            tunnelPid: 21,
            tunnelCommand: "tunnel-client",
            tunnelArgs: ["run", "--profile", "project-pilot"],
            tunnelProfile: "project-pilot",
            dashboardUrl: "http://127.0.0.1:3000/dashboard"
        };
        const processes = [
            { pid: 20, name: "node.exe", commandLine: "node node_modules/tsx/dist/cli.mjs src/server.ts" },
            { pid: 21, name: "tunnel-client.exe", commandLine: "tunnel-client run --profile project-pilot" },
            { pid: 22, name: "node.exe", commandLine: "node unrelated.js" },
            { pid: 23, name: "tunnel-client.exe", commandLine: "tunnel-client run --profile other" }
        ];
        expect(ownedStopTargets(state, processes).map((item) => item.pid)).toEqual([20, 21]);
    });
    it("detects active Autopilot runs without treating paused or blocked runs as active", () => {
        const inactive = {
            tasks: [],
            autopilotRuns: [
                runWithStatus("paused"),
                runWithStatus("blocked"),
                runWithStatus("completed")
            ]
        };
        const active = {
            tasks: [],
            autopilotRuns: [runWithStatus("running")]
        };
        expect(hasActiveAutopilotRun(inactive)).toBe(false);
        expect(hasActiveAutopilotRun(active)).toBe(true);
    });
    it("builds a non-secret readiness summary across launcher, tunnel, state, scheduler, active run, and config", () => {
        const state = {
            version: 1,
            createdAt: "2026-06-25T00:00:00.000Z",
            launcherPid: 1,
            pilotPid: 20,
            tunnelPid: 21,
            tunnelCommand: "tunnel-client",
            tunnelArgs: ["run", "--profile", "project-pilot"],
            tunnelProfile: "project-pilot",
            dashboardUrl: "http://127.0.0.1:3000/dashboard"
        };
        const run = {
            ...runWithStatus("running"),
            scheduler: { dispatchStatus: "dispatched", lastTickAt: "2026-06-25T00:00:01.000Z" }
        };
        const summary = buildReadinessSummary({
            launcherState: state,
            portOpen: true,
            dashboardHealthy: true,
            tunnelPids: [21],
            stateHealth: {
                filePath: "C:\\project-pilot\\data\\tasks.json",
                exists: true,
                valid: true,
                snapshotCount: 2,
                orphanTempFiles: []
            },
            runs: [run],
            configuration: { managerModeConfigured: false }
        });
        expect(summary.components.map((component) => component.name)).toEqual([
            "launcher",
            "tunnel",
            "state-store",
            "scheduler",
            "active-run",
            "configuration"
        ]);
        expect(summary.status).toBe("blocked");
        expect(summary.problems.join("\n")).toMatch(/manager API key is not configured/);
        expect(formatReadinessSummary(summary).join("\n")).not.toMatch(/token|secret|password/i);
    });
});
function runWithStatus(status) {
    const phase = status === "running" ? "building" : status === "completed" ? "completed" : "paused";
    return {
        id: `run-${status}`,
        projectId: "project",
        briefId: "brief",
        status,
        phase,
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z",
        startedAt: "2026-06-25T00:00:00.000Z",
        decisionsUsed: 0,
        tasksStarted: 0,
        fixAttemptsByTaskId: {},
        queue: [],
        decisions: [],
        timeline: [],
        codexThreads: {},
        limits: {
            maxManagerDecisions: 1,
            maxTasks: 1,
            maxFixAttemptsPerTask: 1,
            maxRuntimeMs: 1000
        }
    };
}
