import path from "node:path";
import fs from "node:fs";

export const PROJECT_PILOT_ROOT = path.resolve(
  process.env.PROJECT_PILOT_ROOT ?? process.cwd()
);

export const PROJECT_PILOT_LIVE_ROOT = path.resolve(
  process.env.PROJECT_PILOT_LIVE_ROOT ?? path.join(PROJECT_PILOT_ROOT, "..", "project-pilot")
);

export const ALLOWLISTED_PROJECT_ROOT = path.resolve(
  PROJECT_PILOT_ROOT,
  "..",
  "trade-journal-lite"
);

export const DATA_DIR = path.join(PROJECT_PILOT_ROOT, "data");
export const STATE_FILE = path.join(DATA_DIR, "tasks.json");
export const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

export function taskFile(projectRoot: string): string {
  return path.join(projectRoot, "TASK.md");
}

export function buildReportFile(projectRoot: string): string {
  return path.join(projectRoot, "BUILD_REPORT.md");
}

export function reviewReportFile(projectRoot: string): string {
  return path.join(projectRoot, "REVIEW_REPORT.md");
}

export function taskReportsDir(projectRoot: string, taskId: string): string {
  assertTaskIdPathSegment(taskId);
  return path.join(projectRoot, ".project-pilot", "reports", taskId);
}

export function taskBuildReportFile(projectRoot: string, taskId: string): string {
  return path.join(taskReportsDir(projectRoot, taskId), "BUILD_REPORT.md");
}

export function taskReviewReportFile(projectRoot: string, taskId: string): string {
  return path.join(taskReportsDir(projectRoot, taskId), "REVIEW_REPORT.md");
}

export function planReportFile(projectRoot: string): string {
  return path.join(projectRoot, "PLAN_REPORT.md");
}

export const TASK_FILE = taskFile(ALLOWLISTED_PROJECT_ROOT);
export const BUILD_REPORT_FILE = buildReportFile(ALLOWLISTED_PROJECT_ROOT);
export const REVIEW_REPORT_FILE = reviewReportFile(ALLOWLISTED_PROJECT_ROOT);

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function assertAllowedPath(candidatePath: string): string {
  const resolved = path.resolve(candidatePath);
  if (!allowedRoots().some((root) => isPathInsideRoot(resolved, root))) {
    throw new Error(`Path is outside the Project Pilot allowlist: ${resolved}`);
  }
  return resolved;
}

export function assertRegisteredProjectRoot(projectRoot: string): string {
  const resolved = assertAllowedPath(projectRoot);
  if (!registeredProjectRoots().some((root) => root === resolved)) {
    throw new Error(`Project root is not registered with Project Pilot: ${resolved}`);
  }
  return resolved;
}

export function dataPath(fileName: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
    throw new Error("Data file names may only contain letters, numbers, dot, underscore, and dash.");
  }

  return assertAllowedPath(path.join(DATA_DIR, fileName));
}

export function registeredProjectRoots(): string[] {
  try {
    const text = fs.readFileSync(PROJECTS_FILE, "utf8");
    const parsed = JSON.parse(text) as { projects?: Array<{ path?: unknown; executionRoot?: unknown }> };
    const roots = (parsed.projects ?? [])
      .flatMap((project) => [
        typeof project.path === "string" ? path.resolve(project.path) : "",
        typeof project.executionRoot === "string" ? path.resolve(project.executionRoot) : ""
      ])
      .filter(Boolean);
    return roots.length > 0 ? [...new Set(roots)] : [ALLOWLISTED_PROJECT_ROOT];
  } catch {
    return [ALLOWLISTED_PROJECT_ROOT];
  }
}

function allowedRoots(): string[] {
  return [PROJECT_PILOT_ROOT, ...registeredProjectRoots()];
}

function assertTaskIdPathSegment(taskId: string): void {
  if (!/^task-[a-zA-Z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid task ID for report path: ${taskId}`);
  }
}
