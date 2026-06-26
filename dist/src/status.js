import { spawnSync } from "node:child_process";
import { buildReportFile } from "./paths.js";
import { readLogTail, readTextIfExists } from "./logs.js";
import { StateStore } from "./state.js";
import { deriveTaskStatus } from "./task-status.js";
import { DEFAULT_PROJECT_ID, ProjectRegistry } from "./projects.js";
export async function getProjectStatus(store = new StateStore(), projects = new ProjectRegistry()) {
    const activeProject = await projects.getActiveProject();
    const latestTask = await store.latestTask();
    const taskProjectId = latestTask?.projectId ?? DEFAULT_PROJECT_ID;
    const statusProject = latestTask && taskProjectId !== activeProject.id ? await projects.getProject(taskProjectId) : activeProject;
    const buildReport = await readTextIfExists(buildReportFile(statusProject.path));
    const git = getGitStatus(statusProject.path);
    const latestTaskStatus = latestTask ? deriveTaskStatus(latestTask) : undefined;
    return {
        projectId: statusProject.id,
        projectName: statusProject.name,
        projectRoot: statusProject.path,
        activeProjectId: activeProject.id,
        currentTaskStatus: latestTask
            ? {
                taskId: latestTask.id,
                title: latestTask.title,
                status: latestTaskStatus,
                buildStatus: latestTask.build.status,
                reviewStatus: latestTask.review?.status ?? null,
                updatedAt: latestTask.updatedAt
            }
            : null,
        recentBuildLogSummary: latestTask ? await readLogTail(latestTask.build.logPath, 20) : "",
        gitStatus: git,
        testStatus: summarizeTestStatus(latestTaskStatus, buildReport)
    };
}
function getGitStatus(projectRoot) {
    const result = spawnSync("git", ["status", "--short"], {
        cwd: projectRoot,
        shell: false,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000
    });
    if (result.error) {
        return { ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
        return {
            ok: false,
            exitCode: result.status,
            stderr: result.stderr.trim()
        };
    }
    const output = result.stdout.trim();
    return {
        ok: true,
        clean: output.length === 0,
        short: output || "clean"
    };
}
function summarizeTestStatus(taskStatus, report) {
    if (!report) {
        return {
            latestTaskStatus: taskStatus ?? null,
            summary: "No BUILD_REPORT.md found."
        };
    }
    const relevantLines = report
        .split(/\r?\n/)
        .filter((line) => /(test|lint|build|check|pass|fail|block)/i.test(line))
        .slice(-20);
    return {
        latestTaskStatus: taskStatus ?? null,
        summary: relevantLines.join("\n") || "BUILD_REPORT.md exists, but no test lines were detected."
    };
}
