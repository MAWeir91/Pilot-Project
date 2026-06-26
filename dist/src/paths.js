import path from "node:path";
import fs from "node:fs";
export const PROJECT_PILOT_ROOT = path.resolve(process.env.PROJECT_PILOT_ROOT ?? process.cwd());
export const ALLOWLISTED_PROJECT_ROOT = path.resolve(PROJECT_PILOT_ROOT, "..", "trade-journal-lite");
export const DATA_DIR = path.join(PROJECT_PILOT_ROOT, "data");
export const STATE_FILE = path.join(DATA_DIR, "tasks.json");
export const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
export function taskFile(projectRoot) {
    return path.join(projectRoot, "TASK.md");
}
export function buildReportFile(projectRoot) {
    return path.join(projectRoot, "BUILD_REPORT.md");
}
export function reviewReportFile(projectRoot) {
    return path.join(projectRoot, "REVIEW_REPORT.md");
}
export function planReportFile(projectRoot) {
    return path.join(projectRoot, "PLAN_REPORT.md");
}
export const TASK_FILE = taskFile(ALLOWLISTED_PROJECT_ROOT);
export const BUILD_REPORT_FILE = buildReportFile(ALLOWLISTED_PROJECT_ROOT);
export const REVIEW_REPORT_FILE = reviewReportFile(ALLOWLISTED_PROJECT_ROOT);
export function isPathInsideRoot(candidatePath, rootPath) {
    const candidate = path.resolve(candidatePath);
    const root = path.resolve(rootPath);
    return candidate === root || candidate.startsWith(root + path.sep);
}
export function assertAllowedPath(candidatePath) {
    const resolved = path.resolve(candidatePath);
    if (!allowedRoots().some((root) => isPathInsideRoot(resolved, root))) {
        throw new Error(`Path is outside the Project Pilot allowlist: ${resolved}`);
    }
    return resolved;
}
export function assertRegisteredProjectRoot(projectRoot) {
    const resolved = assertAllowedPath(projectRoot);
    if (!registeredProjectRoots().some((root) => root === resolved)) {
        throw new Error(`Project root is not registered with Project Pilot: ${resolved}`);
    }
    return resolved;
}
export function dataPath(fileName) {
    if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
        throw new Error("Data file names may only contain letters, numbers, dot, underscore, and dash.");
    }
    return assertAllowedPath(path.join(DATA_DIR, fileName));
}
export function registeredProjectRoots() {
    try {
        const text = fs.readFileSync(PROJECTS_FILE, "utf8");
        const parsed = JSON.parse(text);
        const roots = (parsed.projects ?? [])
            .map((project) => (typeof project.path === "string" ? path.resolve(project.path) : ""))
            .filter(Boolean);
        return roots.length > 0 ? [...new Set(roots)] : [ALLOWLISTED_PROJECT_ROOT];
    }
    catch {
        return [ALLOWLISTED_PROJECT_ROOT];
    }
}
function allowedRoots() {
    return [PROJECT_PILOT_ROOT, ...registeredProjectRoots()];
}
