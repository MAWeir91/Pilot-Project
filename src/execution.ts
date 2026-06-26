import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PROJECT_PILOT_LIVE_ROOT, assertAllowedPath, isPathInsideRoot } from "./paths.js";
import type { ProjectRecord } from "./types.js";

export interface ProjectExecutionContext {
  registeredRoot: string;
  executionRoot: string;
  maintenanceMode: boolean;
}

export type GitCommandRunner = (args: string[], cwd: string) => string;

export interface GitPreflightResult {
  ok: boolean;
  executionRoot: string;
  reason?: string;
  diagnostics: Record<string, unknown>;
}

export function projectExecutionContext(project: ProjectRecord): ProjectExecutionContext {
  return {
    registeredRoot: path.resolve(project.path),
    executionRoot: path.resolve(project.executionRoot ?? project.path),
    maintenanceMode: project.maintenance?.enabled === true
  };
}

export function taskArtifactRoot(project: ProjectRecord): string {
  return projectExecutionContext(project).executionRoot;
}

export function taskLocalLogPath(project: ProjectRecord, fileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error("Log file names may only contain letters, numbers, dot, underscore, and dash.");
  }
  const context = projectExecutionContext(project);
  if (!context.maintenanceMode) {
    return "";
  }
  return assertAllowedPath(path.join(context.executionRoot, ".project-pilot", "logs", fileName));
}

export function preflightWorkerLaunch(
  project: ProjectRecord,
  runner: GitCommandRunner = runGit
): GitPreflightResult {
  const context = projectExecutionContext(project);
  const diagnostics: Record<string, unknown> = {
    projectId: project.id,
    maintenanceMode: context.maintenanceMode,
    registeredRoot: context.registeredRoot,
    executionRoot: context.executionRoot
  };

  if (!context.maintenanceMode) {
    return { ok: true, executionRoot: context.executionRoot, diagnostics };
  }

  const liveRoot = path.resolve(project.maintenance?.liveRoot ?? PROJECT_PILOT_LIVE_ROOT);
  const baseBranch = project.maintenance?.baseBranch || project.defaultBranchName;
  diagnostics.liveRoot = liveRoot;
  diagnostics.baseBranch = baseBranch;

  const structuralError = validateMaintenanceRoots(context, liveRoot);
  if (structuralError) {
    return { ok: false, executionRoot: context.executionRoot, reason: structuralError, diagnostics };
  }

  try {
    const gitRoot = path.resolve(runner(["rev-parse", "--show-toplevel"], context.executionRoot).trim());
    diagnostics.gitRoot = gitRoot;
    if (gitRoot !== context.executionRoot) {
      return {
        ok: false,
        executionRoot: context.executionRoot,
        reason: `Maintenance execution root must be the repository root. Git reported ${gitRoot}.`,
        diagnostics
      };
    }

    const branch = runner(["branch", "--show-current"], context.executionRoot).trim();
    diagnostics.currentBranch = branch || "(detached)";
    if (!branch) {
      return { ok: false, executionRoot: context.executionRoot, reason: "Maintenance worktree is in detached HEAD state.", diagnostics };
    }

    const baseRef = resolveBaseRef(project, baseBranch, runner, context.executionRoot);
    diagnostics.baseRef = baseRef;
    runner(["merge-base", "--is-ancestor", baseRef, "HEAD"], context.executionRoot);

    const worktrees = parseWorktreeList(runner(["worktree", "list", "--porcelain"], context.executionRoot));
    diagnostics.worktreeCount = worktrees.length;
    diagnostics.isListedWorktree = worktrees.includes(context.executionRoot);
    if (!worktrees.includes(context.executionRoot)) {
      return {
        ok: false,
        executionRoot: context.executionRoot,
        reason: "Maintenance execution root is not listed by git worktree.",
        diagnostics
      };
    }

    const status = runner(["status", "--porcelain=v1"], context.executionRoot)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    diagnostics.dirtyFileCount = status.length;
    diagnostics.dirtyFiles = status.map(redactStatusLine).slice(0, 25);
    if (status.length > 0 && !project.maintenance?.allowDirtyWorkingTree) {
      return {
        ok: false,
        executionRoot: context.executionRoot,
        reason: "Maintenance worktree has uncommitted changes and no explicit dirty-working-tree reason.",
        diagnostics
      };
    }
    if (status.length > 0) {
      diagnostics.dirtyWorkingTreeReason = project.maintenance?.dirtyWorkingTreeReason;
    }

    return { ok: true, executionRoot: context.executionRoot, diagnostics };
  } catch (error) {
    return {
      ok: false,
      executionRoot: context.executionRoot,
      reason: `Git preflight failed: ${errorMessage(error)}`,
      diagnostics
    };
  }
}

function validateMaintenanceRoots(context: ProjectExecutionContext, liveRoot: string): string | undefined {
  if (!fs.existsSync(context.executionRoot) || !fs.statSync(context.executionRoot).isDirectory()) {
    return `Maintenance execution root is missing or not a directory: ${context.executionRoot}.`;
  }
  if (context.executionRoot === context.registeredRoot) {
    return "Maintenance execution root must be distinct from the registered project root.";
  }
  if (context.executionRoot === liveRoot || isPathInsideRoot(context.executionRoot, liveRoot)) {
    return "Maintenance execution root points at or inside the live Project Pilot checkout.";
  }
  if (liveRoot === context.executionRoot || isPathInsideRoot(liveRoot, context.executionRoot)) {
    return "Live Project Pilot checkout must not be inside the maintenance execution root.";
  }
  return undefined;
}

function resolveBaseRef(project: ProjectRecord, baseBranch: string, runner: GitCommandRunner, cwd: string): string {
  const candidates = [
    `refs/heads/${baseBranch}`,
    project.gitRemoteName ? `refs/remotes/${project.gitRemoteName}/${baseBranch}` : "",
    `refs/remotes/origin/${baseBranch}`
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      runner(["show-ref", "--verify", "--quiet", candidate], cwd);
      return candidate.replace(/^refs\/(?:heads|remotes)\//, "");
    } catch {
      // Try the next known local or remote branch ref.
    }
  }
  throw new Error(`Base branch is unknown to this worktree: ${baseBranch}.`);
}

function parseWorktreeList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^worktree (.+)$/)?.[1])
    .filter((worktree): worktree is string => Boolean(worktree))
    .map((worktree) => path.resolve(worktree));
}

function redactStatusLine(line: string): string {
  return line.replace(/\S+/g, (part, offset) => (offset < 3 ? part : path.basename(part)));
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
