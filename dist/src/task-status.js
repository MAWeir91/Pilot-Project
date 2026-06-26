export const NOTIFIABLE_TASK_STATUSES = new Set([
    "failed",
    "blocked",
    "needs-fixes",
    "ready-for-approval"
]);
export function deriveTaskStatus(task) {
    if (task.status === "completed") {
        return "completed";
    }
    const reviewIsActive = task.review?.status === "queued" || task.review?.status === "running";
    const reviewIsTerminal = task.review?.status === "passed" ||
        task.review?.status === "failed" ||
        task.review?.status === "blocked" ||
        task.review?.status === "stopped" ||
        Boolean(task.review?.result);
    if (reviewIsActive || (task.status === "reviewing" && !reviewIsTerminal)) {
        return "reviewing";
    }
    if (task.review?.result === "pass" || task.status === "ready-for-approval") {
        return "ready-for-approval";
    }
    if (task.review?.result === "needs-fixes" || task.status === "needs-fixes") {
        return "needs-fixes";
    }
    if (task.review?.result === "blocked" ||
        task.review?.status === "blocked" ||
        task.status === "blocked" ||
        task.build.status === "blocked") {
        return "blocked";
    }
    if (task.status === "stopped" || task.build.status === "stopped") {
        return "stopped";
    }
    if (task.status === "failed" || task.build.status === "failed") {
        return "failed";
    }
    if (task.status === "build-passed" || task.status === "passed" || task.build.status === "passed") {
        return "build-passed";
    }
    if (task.status === "building" || task.status === "running" || task.build.status === "running") {
        return "building";
    }
    return "queued";
}
export function completeReadyTask(task, completedAt) {
    const status = deriveTaskStatus(task);
    if (status !== "ready-for-approval") {
        throw new Error(`Task ${task.id} is ${status}, not ready-for-approval.`);
    }
    return {
        ...task,
        status: "completed",
        completedAt
    };
}
