import "dotenv/config";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { DATA_DIR, PROJECT_PILOT_ROOT, STATE_FILE } from "./paths.js";
import type { TaskState } from "./types.js";
import {
  findTunnelProfileProcesses,
  hasActiveAutopilotRun,
  ownedStopTargets,
  parseLocalLauncherConfig,
  startPreflight,
  type LocalLauncherConfig,
  type LocalLauncherState,
  type ProcessInfo
} from "./local-launcher-core.js";

type LauncherCommand = "start" | "status" | "open" | "stop";

const command = parseCommand(process.argv[2]);
const config = parseLocalLauncherConfig(process.env, PROJECT_PILOT_ROOT);

try {
  switch (command) {
    case "start":
      await startLocal(config);
      break;
    case "status":
      await printStatus(config);
      break;
    case "open":
      await openDashboard(config);
      break;
    case "stop":
      await stopOwnedProcesses(config);
      break;
  }
} catch (error) {
  console.error(`[launcher] ${errorMessage(error)}`);
  process.exitCode = 1;
}

async function startLocal(config: LocalLauncherConfig): Promise<void> {
  await validateTunnelExecutable(config);
  const processes = await listProcesses();
  const tunnelProcesses = findTunnelProfileProcesses(processes, config);
  const preflight = startPreflight({
    pilotPortOpen: await isPortOpen(config.host, config.port),
    tunnelProcesses
  });
  if (!preflight.ok) {
    throw new Error(preflight.errors.join("\n"));
  }

  console.log("[launcher] Starting Project Pilot server...");
  const pilot = spawnPilot();
  prefixOutput(pilot, "pilot");

  await writeLauncherState(config, {
    version: 1,
    createdAt: new Date().toISOString(),
    launcherPid: process.pid,
    pilotPid: pilot.pid,
    tunnelCommand: config.tunnelCommand,
    tunnelArgs: config.tunnelArgs,
    tunnelProfile: config.tunnelProfile,
    dashboardUrl: config.dashboardUrl
  });

  let shuttingDown = false;
  let tunnel: ChildProcessWithoutNullStreams | undefined;

  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await warnIfActiveRun();
    console.log(`[launcher] ${reason}`);
    await stopChild("tunnel", tunnel);
    await stopChild("pilot", pilot);
    await removeLauncherState(config);
    process.exitCode = exitCode;
    process.exit();
  };

  process.once("SIGINT", () => {
    void shutdown("Ctrl+C received; stopping Project Pilot and tunnel.", 130);
  });
  process.once("SIGTERM", () => {
    void shutdown("Stop signal received; stopping Project Pilot and tunnel.", 143);
  });

  pilot.once("exit", (code, signal) => {
    if (!shuttingDown) {
      void shutdown(`Project Pilot exited unexpectedly with code ${String(code)} signal ${String(signal)}.`, 1);
    }
  });

  await waitForDashboard(config);
  console.log(`[launcher] Project Pilot healthy: ${config.dashboardUrl}`);
  console.log("[launcher] Starting tunnel profile...");

  tunnel = spawn(config.tunnelCommand, config.tunnelArgs, {
    cwd: PROJECT_PILOT_ROOT,
    env: process.env,
    shell: false,
    windowsHide: false
  });
  prefixOutput(tunnel, "tunnel");
  tunnel.once("error", (error) => {
    if (!shuttingDown) {
      void shutdown(`Tunnel failed to start: ${error.message}`, 1);
    }
  });
  tunnel.once("exit", (code, signal) => {
    if (!shuttingDown) {
      void shutdown(`Tunnel exited unexpectedly with code ${String(code)} signal ${String(signal)}.`, 1);
    }
  });

  await writeLauncherState(config, {
    version: 1,
    createdAt: new Date().toISOString(),
    launcherPid: process.pid,
    pilotPid: pilot.pid,
    tunnelPid: tunnel.pid,
    tunnelCommand: config.tunnelCommand,
    tunnelArgs: config.tunnelArgs,
    tunnelProfile: config.tunnelProfile,
    dashboardUrl: config.dashboardUrl
  });

  await delay(1000);
  if (tunnel.exitCode !== null) {
    throw new Error(`Tunnel exited before becoming ready with code ${tunnel.exitCode}.`);
  }

  console.log(`[launcher] Dashboard: ${config.dashboardUrl}`);
  console.log(`[launcher] Tunnel status: profile ${config.tunnelProfile} running as PID ${String(tunnel.pid)}.`);
  console.log("[launcher] Press Ctrl+C once to stop Project Pilot and the tunnel.");

  await new Promise<void>(() => {
    // Keep the launcher attached while both child processes run.
  });
}

async function printStatus(config: LocalLauncherConfig): Promise<void> {
  const processes = await listProcesses();
  const tunnelProcesses = findTunnelProfileProcesses(processes, config);
  const portOpen = await isPortOpen(config.host, config.port);
  const dashboardHealthy = await dashboardHealth(config).catch(() => false);
  const launcherState = await readLauncherState(config);

  console.log(`[status] Dashboard: ${config.dashboardUrl}`);
  console.log(`[status] Project Pilot port 3000: ${portOpen ? "open" : "closed"}`);
  console.log(`[status] Dashboard health: ${dashboardHealthy ? "healthy" : "unavailable"}`);
  console.log(
    `[status] Tunnel profile ${config.tunnelProfile}: ${
      tunnelProcesses.length > 0 ? `running as PID(s) ${tunnelProcesses.map((item) => item.pid).join(", ")}` : "not running"
    }`
  );
  console.log(
    `[status] Launcher ownership: ${
      launcherState ? `pilot PID ${launcherState.pilotPid ?? "unknown"}, tunnel PID ${launcherState.tunnelPid ?? "unknown"}` : "none"
    }`
  );
  const activeRun = await activeRunExists();
  console.log(`[status] Active Autopilot run: ${activeRun ? "yes" : "no"}`);
}

async function openDashboard(config: LocalLauncherConfig): Promise<void> {
  await openUrl(config.dashboardUrl);
  console.log(`[launcher] Opened ${config.dashboardUrl}`);
}

async function stopOwnedProcesses(config: LocalLauncherConfig): Promise<void> {
  await warnIfActiveRun();
  const state = await readLauncherState(config);
  const processes = await listProcesses();
  const targets = ownedStopTargets(state, processes);
  if (targets.length === 0) {
    console.log("[launcher] No launcher-owned Project Pilot or tunnel processes are running.");
    await removeLauncherState(config);
    return;
  }

  for (const target of targets) {
    console.log(`[launcher] Stopping owned process ${target.pid} (${target.name}).`);
    await stopPid(target.pid);
  }
  await removeLauncherState(config);
}

function spawnPilot(): ChildProcessWithoutNullStreams {
  const tsxCli = path.join(PROJECT_PILOT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return spawn(process.execPath, [tsxCli, "src/server.ts"], {
    cwd: PROJECT_PILOT_ROOT,
    env: process.env,
    shell: false,
    windowsHide: false
  });
}

function prefixOutput(child: ChildProcessWithoutNullStreams, prefix: string): void {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => writePrefixed(prefix, String(chunk), false));
  child.stderr.on("data", (chunk) => writePrefixed(prefix, String(chunk), true));
}

function writePrefixed(prefix: string, chunk: string, error: boolean): void {
  const stream = error ? process.stderr : process.stdout;
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length > 0) {
      stream.write(`[${prefix}] ${line}${os.EOL}`);
    }
  }
}

async function waitForDashboard(config: LocalLauncherConfig): Promise<void> {
  const deadline = Date.now() + config.healthTimeoutMs;
  while (Date.now() < deadline) {
    if (await dashboardHealth(config).catch(() => false)) {
      return;
    }
    await delay(500);
  }
  throw new Error(`Project Pilot did not become healthy at ${config.dashboardUrl} within ${config.healthTimeoutMs} ms.`);
}

async function dashboardHealth(config: LocalLauncherConfig): Promise<boolean> {
  return await new Promise((resolve) => {
    const request = http.get(config.dashboardUrl, { timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 1000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function validateTunnelExecutable(config: LocalLauncherConfig): Promise<void> {
  const resolved = await resolveExecutable(config.tunnelCommand);
  if (!resolved) {
    throw new Error(
      `Tunnel executable not found: ${config.tunnelCommand}. Set PROJECT_PILOT_TUNNEL_COMMAND in .env to the tunnel-client executable path or add it to PATH.`
    );
  }
}

async function resolveExecutable(command: string): Promise<string | null> {
  if (/[\\/]/.test(command)) {
    return (await fileExists(command)) ? command : null;
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, process.platform === "win32" && !path.extname(command) ? `${command}${extension}` : command);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    ].join("; ");
    const output = await execFileText("powershell.exe", ["-NoProfile", "-Command", script]);
    const parsed = JSON.parse(output || "[]") as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => row as { ProcessId?: unknown; Name?: unknown; CommandLine?: unknown })
      .filter((row) => typeof row.ProcessId === "number")
      .map((row) => ({
        pid: row.ProcessId as number,
        name: typeof row.Name === "string" ? row.Name : "",
        commandLine: typeof row.CommandLine === "string" ? row.CommandLine : ""
      }));
  }

  const output = await execFileText("ps", ["-axo", "pid=,comm=,args="]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      return match
        ? { pid: Number.parseInt(match[1], 10), name: path.basename(match[2]), commandLine: match[3] }
        : undefined;
    })
    .filter((item): item is ProcessInfo => Boolean(item));
}

async function execFileText(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function stopChild(label: string, child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.pid === undefined) {
    return;
  }
  console.log(`[launcher] Stopping ${label} PID ${child.pid}.`);
  child.kill("SIGINT");
  await delay(2500);
  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
}

async function stopPid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGINT");
  } catch (error) {
    console.log(`[launcher] PID ${pid} is not running or could not receive SIGINT: ${errorMessage(error)}`);
    return;
  }
  await delay(1500);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already stopped.
  }
}

async function warnIfActiveRun(): Promise<void> {
  if (await activeRunExists()) {
    console.warn("[launcher] Warning: an Autopilot run appears active. Stopping the local server/tunnel does not stop tracked workers.");
  }
}

async function activeRunExists(): Promise<boolean> {
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as TaskState;
    return hasActiveAutopilotRun(state);
  } catch {
    return false;
  }
}

async function readLauncherState(config: LocalLauncherConfig): Promise<LocalLauncherState | undefined> {
  try {
    return JSON.parse(await fs.readFile(config.launcherStateFile, "utf8")) as LocalLauncherState;
  } catch {
    return undefined;
  }
}

async function writeLauncherState(config: LocalLauncherConfig, state: LocalLauncherState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(config.launcherStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function removeLauncherState(config: LocalLauncherConfig): Promise<void> {
  await fs.rm(config.launcherStateFile, { force: true });
}

async function openUrl(url: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileText("powershell.exe", ["-NoProfile", "-Command", "Start-Process", url]);
    return;
  }
  if (process.platform === "darwin") {
    await execFileText("open", [url]);
    return;
  }
  await execFileText("xdg-open", [url]);
}

function parseCommand(value: string | undefined): LauncherCommand {
  if (!value) {
    return "start";
  }
  if (value === "start" || value === "status" || value === "open" || value === "stop") {
    return value;
  }
  throw new Error(`Unknown local launcher command: ${value}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
