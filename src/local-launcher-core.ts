import path from "node:path";
import type { TaskState } from "./types.js";

export const LOCAL_DASHBOARD_URL = "http://127.0.0.1:3000/dashboard";
export const LOCAL_MCP_URL = "http://127.0.0.1:3000/mcp";
export const DEFAULT_TUNNEL_COMMAND = "tunnel-client";
export const DEFAULT_TUNNEL_PROFILE = "project-pilot";
export const DEFAULT_TUNNEL_ARGS_TEMPLATE = "run --profile {profile}";

export interface LocalLauncherConfig {
  host: "127.0.0.1";
  port: number;
  dashboardUrl: string;
  mcpUrl: string;
  tunnelCommand: string;
  tunnelProfile: string;
  tunnelArgs: string[];
  healthTimeoutMs: number;
  launcherStateFile: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  commandLine: string;
}

export interface LocalLauncherState {
  version: 1;
  createdAt: string;
  launcherPid: number;
  pilotPid?: number;
  tunnelPid?: number;
  tunnelCommand: string;
  tunnelArgs: string[];
  tunnelProfile: string;
  dashboardUrl: string;
}

export interface StartPreflightInput {
  pilotPortOpen: boolean;
  tunnelProcesses: ProcessInfo[];
}

export interface StartPreflightResult {
  ok: boolean;
  errors: string[];
}

export function parseLocalLauncherConfig(
  env: NodeJS.ProcessEnv,
  root: string,
  stateFile = path.join(root, "data", "local-launcher.json")
): LocalLauncherConfig {
  const host = (env.HOST ?? "127.0.0.1").trim();
  if (host !== "127.0.0.1") {
    throw new Error("Project Pilot local launcher requires HOST=127.0.0.1.");
  }

  const port = strictPort(env.PORT ?? "3000", "PORT");
  const tunnelProfile = nonEmpty(env.PROJECT_PILOT_TUNNEL_PROFILE ?? DEFAULT_TUNNEL_PROFILE, "PROJECT_PILOT_TUNNEL_PROFILE");
  const tunnelCommand = nonEmpty(env.PROJECT_PILOT_TUNNEL_COMMAND ?? DEFAULT_TUNNEL_COMMAND, "PROJECT_PILOT_TUNNEL_COMMAND");
  const tunnelArgs = buildTunnelArgs(env.PROJECT_PILOT_TUNNEL_ARGS ?? DEFAULT_TUNNEL_ARGS_TEMPLATE, tunnelProfile);
  const healthTimeoutMs = strictPositiveInteger(
    env.PROJECT_PILOT_LOCAL_HEALTH_TIMEOUT_MS ?? "30000",
    "PROJECT_PILOT_LOCAL_HEALTH_TIMEOUT_MS"
  );

  return {
    host: "127.0.0.1",
    port,
    dashboardUrl: `http://127.0.0.1:${port}/dashboard`,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    tunnelCommand,
    tunnelProfile,
    tunnelArgs,
    healthTimeoutMs,
    launcherStateFile: stateFile
  };
}

export function buildTunnelArgs(template: string, profile: string): string[] {
  const rendered = template.replaceAll("{profile}", profile).trim();
  const args = splitCommandLine(rendered);
  if (args.length === 0) {
    throw new Error("PROJECT_PILOT_TUNNEL_ARGS must not be empty.");
  }
  if (!args.includes(profile)) {
    throw new Error("PROJECT_PILOT_TUNNEL_ARGS must include {profile} or the configured tunnel profile.");
  }
  return args;
}

export function splitCommandLine(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new Error("PROJECT_PILOT_TUNNEL_ARGS contains an unterminated quote.");
  }
  if (current) {
    args.push(current);
  }
  return args;
}

export function findTunnelProfileProcesses(processes: ProcessInfo[], config: Pick<LocalLauncherConfig, "tunnelCommand" | "tunnelProfile">): ProcessInfo[] {
  const commandName = path.basename(config.tunnelCommand).toLowerCase().replace(/\.exe$/i, "");
  const profilePattern = new RegExp(`(?:^|\\s)--profile\\s+["']?${escapeRegExp(config.tunnelProfile)}["']?(?:\\s|$)`, "i");
  return processes.filter((processInfo) => {
    const commandLine = processInfo.commandLine.toLowerCase();
    const name = processInfo.name.toLowerCase().replace(/\.exe$/i, "");
    return profilePattern.test(processInfo.commandLine) && (name === commandName || commandLine.includes(commandName));
  });
}

export function startPreflight(input: StartPreflightInput): StartPreflightResult {
  const errors: string[] = [];
  if (input.pilotPortOpen) {
    errors.push(
      "Project Pilot is already reachable on 127.0.0.1:3000. Stop the existing server or use npm run local:status."
    );
  }
  if (input.tunnelProcesses.length > 0) {
    errors.push(
      `Tunnel profile project-pilot is already running as PID(s): ${input.tunnelProcesses.map((item) => item.pid).join(", ")}. Stop or reuse that tunnel before npm run local.`
    );
  }
  return { ok: errors.length === 0, errors };
}

export function ownedStopTargets(state: LocalLauncherState | undefined, processes: ProcessInfo[]): ProcessInfo[] {
  if (!state) {
    return [];
  }
  const wanted = new Set([state.pilotPid, state.tunnelPid].filter((pid): pid is number => Number.isInteger(pid)));
  return processes.filter((processInfo) => wanted.has(processInfo.pid) && matchesOwnedProcess(state, processInfo));
}

export function hasActiveAutopilotRun(state: TaskState): boolean {
  return (state.autopilotRuns ?? []).some((run) => {
    if (["completed", "stopped", "failed"].includes(run.status)) {
      return false;
    }
    if (run.status === "paused" || run.status === "blocked" || run.status === "usage-limited") {
      return false;
    }
    return true;
  });
}

function matchesOwnedProcess(state: LocalLauncherState, processInfo: ProcessInfo): boolean {
  if (state.pilotPid === processInfo.pid) {
    return /src[\\/]server\.ts|dist[\\/]src[\\/]server\.js/.test(processInfo.commandLine.replaceAll("\\", "/"));
  }
  if (state.tunnelPid === processInfo.pid) {
    return findTunnelProfileProcesses([processInfo], {
      tunnelCommand: state.tunnelCommand,
      tunnelProfile: state.tunnelProfile
    }).length === 1;
  }
  return false;
}

function nonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty.`);
  }
  return trimmed;
}

function strictPort(value: string, name: string): number {
  const port = strictPositiveInteger(value, name);
  if (port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535. Received: ${value}`);
  }
  return port;
}

function strictPositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a positive integer. Received: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${value}`);
  }
  return parsed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
