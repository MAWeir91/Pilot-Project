import type { JsonFileHealth } from "./durable-json.js";
import type { LocalLauncherState } from "./local-launcher-core.js";
import type { AutopilotRunRecord } from "./types.js";

export type ReadinessComponentStatus = "ready" | "warning" | "blocked" | "unknown";

export interface ReadinessComponent {
  name: "launcher" | "tunnel" | "state-store" | "scheduler" | "active-run" | "configuration";
  status: ReadinessComponentStatus;
  summary: string;
  detail?: string;
}

export interface ReadinessSummary {
  status: ReadinessComponentStatus;
  generatedAt: string;
  userActionRequired: boolean;
  components: ReadinessComponent[];
  problems: string[];
}

export function buildReadinessSummary(input: {
  now?: string;
  launcherState?: LocalLauncherState;
  portOpen?: boolean;
  tunnelPids?: number[];
  dashboardHealthy?: boolean;
  stateHealth?: JsonFileHealth;
  runs?: AutopilotRunRecord[];
  configuration?: Record<string, unknown>;
}): ReadinessSummary {
  const components: ReadinessComponent[] = [
    launcherComponent(input),
    tunnelComponent(input),
    stateStoreComponent(input.stateHealth),
    schedulerComponent(input.runs ?? []),
    activeRunComponent(input.runs ?? []),
    configurationComponent(input.configuration)
  ];
  const status = overallStatus(components);
  const problems = components
    .filter((component) => component.status === "blocked" || component.status === "warning")
    .map((component) => `${component.name}: ${component.summary}${component.detail ? ` - ${component.detail}` : ""}`);

  return {
    status,
    generatedAt: input.now ?? new Date().toISOString(),
    userActionRequired: components.some((component) => component.status === "blocked"),
    components,
    problems
  };
}

export function formatReadinessSummary(summary: ReadinessSummary): string[] {
  return [
    `Overall: ${summary.status}${summary.userActionRequired ? " (user action required)" : ""}`,
    ...summary.components.map((component) =>
      `${component.name}: ${component.status} - ${component.summary}${component.detail ? ` (${component.detail})` : ""}`
    )
  ];
}

function launcherComponent(input: {
  launcherState?: LocalLauncherState;
  portOpen?: boolean;
  dashboardHealthy?: boolean;
}): ReadinessComponent {
  if (input.launcherState) {
    return {
      name: "launcher",
      status: input.dashboardHealthy === false ? "warning" : "ready",
      summary: `launcher state recorded for PID ${input.launcherState.launcherPid}`,
      detail: `pilot PID ${input.launcherState.pilotPid ?? "unknown"}`
    };
  }
  if (input.portOpen) {
    return {
      name: "launcher",
      status: "warning",
      summary: "Project Pilot is reachable but no launcher ownership state was found"
    };
  }
  return {
    name: "launcher",
    status: "unknown",
    summary: "launcher state is not recorded"
  };
}

function tunnelComponent(input: { launcherState?: LocalLauncherState; tunnelPids?: number[] }): ReadinessComponent {
  const pids = input.tunnelPids ?? [];
  if (pids.length > 0) {
    return {
      name: "tunnel",
      status: "ready",
      summary: `tunnel profile running as PID(s) ${pids.join(", ")}`
    };
  }
  if (input.launcherState?.tunnelPid) {
    return {
      name: "tunnel",
      status: "unknown",
      summary: `launcher recorded tunnel PID ${input.launcherState.tunnelPid}, but live process status was not checked`
    };
  }
  return {
    name: "tunnel",
    status: "warning",
    summary: "no launcher-owned tunnel PID is recorded"
  };
}

function stateStoreComponent(health: JsonFileHealth | undefined): ReadinessComponent {
  if (!health) {
    return { name: "state-store", status: "unknown", summary: "state-store health was not inspected" };
  }
  if (!health.valid || health.lastError) {
    return {
      name: "state-store",
      status: "blocked",
      summary: "state store is not currently healthy",
      detail: health.lastError ?? "invalid JSON"
    };
  }
  return {
    name: "state-store",
    status: "ready",
    summary: "state store JSON is valid",
    detail: `snapshots: ${health.snapshotCount ?? 0}`
  };
}

function schedulerComponent(runs: AutopilotRunRecord[]): ReadinessComponent {
  const activeRuns = runs.filter((run) => run.status === "running" || run.status === "queued");
  if (activeRuns.length === 0) {
    return { name: "scheduler", status: "ready", summary: "no active scheduler work is required" };
  }
  const blocked = activeRuns.find((run) => run.scheduler?.dispatchStatus?.includes("blocked"));
  if (blocked) {
    return {
      name: "scheduler",
      status: "blocked",
      summary: `scheduler blocked for run ${blocked.id}`,
      detail: blocked.scheduler?.lastDispatchOutcome ?? blocked.scheduler?.skippedDispatchReason
    };
  }
  const missing = activeRuns.find((run) => !run.scheduler);
  if (missing) {
    return { name: "scheduler", status: "warning", summary: `active run ${missing.id} has no scheduler state` };
  }
  return { name: "scheduler", status: "ready", summary: `${activeRuns.length} active run(s) have scheduler state` };
}

function activeRunComponent(runs: AutopilotRunRecord[]): ReadinessComponent {
  const active = runs.filter((run) => run.status === "running" || run.status === "queued");
  const waiting = runs.filter((run) => run.status === "paused" || run.status === "blocked" || run.status === "usage-limited");
  if (active.length > 0) {
    return {
      name: "active-run",
      status: "ready",
      summary: `${active.length} active run(s)`,
      detail: active.map((run) => `${run.id}:${run.phase}`).join(", ")
    };
  }
  if (waiting.length > 0) {
    return {
      name: "active-run",
      status: waiting.some((run) => run.status === "blocked") ? "blocked" : "warning",
      summary: `${waiting.length} run(s) waiting for operator control`,
      detail: waiting.map((run) => `${run.id}:${run.status}`).join(", ")
    };
  }
  return { name: "active-run", status: "ready", summary: "no active or waiting runs" };
}

function configurationComponent(configuration: Record<string, unknown> | undefined): ReadinessComponent {
  if (!configuration) {
    return { name: "configuration", status: "unknown", summary: "configuration was not inspected" };
  }
  const problems: string[] = [];
  if (configuration.managerModeConfigured === false) {
    problems.push("manager API key is not configured");
  }
  const projects = Array.isArray(configuration.projects) ? configuration.projects : [];
  for (const project of projects) {
    const record = project as { projectId?: unknown; maintenance?: { canStart?: unknown; cannotStartReason?: unknown } };
    if (record.maintenance?.canStart === false) {
      problems.push(`${String(record.projectId ?? "project")} maintenance blocked: ${String(record.maintenance.cannotStartReason ?? "unknown")}`);
    }
  }
  return problems.length > 0
    ? { name: "configuration", status: "blocked", summary: `${problems.length} configuration problem(s)`, detail: problems.join("; ") }
    : { name: "configuration", status: "ready", summary: "manager and project configuration are ready" };
}

function overallStatus(components: ReadinessComponent[]): ReadinessComponentStatus {
  if (components.some((component) => component.status === "blocked")) {
    return "blocked";
  }
  if (components.some((component) => component.status === "warning")) {
    return "warning";
  }
  if (components.some((component) => component.status === "unknown")) {
    return "unknown";
  }
  return "ready";
}
