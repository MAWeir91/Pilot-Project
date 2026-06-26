import fs from "node:fs/promises";
import { assertAllowedPath } from "./paths.js";
export async function readTextIfExists(filePath) {
    try {
        return await fs.readFile(assertAllowedPath(filePath), "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
export async function readLogTail(filePath, maxLines = 40) {
    const text = await readTextIfExists(filePath);
    if (!text) {
        return "";
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
}
export function extractReviewReport(rawOutput, fallbackTaskId) {
    const strings = collectStringsFromJsonLines(rawOutput);
    const searchable = [rawOutput, ...strings].join("\n");
    const match = searchable.match(/REVIEW_REPORT_START\s*([\s\S]*?)\s*REVIEW_REPORT_END/);
    const report = match?.[1]?.trim() || blockedReviewReport(fallbackTaskId, "Codex did not emit a review report envelope.");
    const resultMatch = report.match(/Result:\s*(pass|needs-fixes|blocked)\b/i);
    const result = resultMatch?.[1]?.toLowerCase() ?? "blocked";
    return { report: `${report}\n`, result };
}
export function extractPlanReport(rawOutput, fallbackPlanId) {
    const strings = collectStringsFromJsonLines(rawOutput);
    const searchable = [rawOutput, ...strings].join("\n");
    const match = searchable.match(/PLAN_REPORT_START\s*([\s\S]*?)\s*PLAN_REPORT_END/);
    const report = match?.[1]?.trim();
    if (!report) {
        return { error: `Codex exited successfully but did not emit a PLAN_REPORT_START/PLAN_REPORT_END envelope for ${fallbackPlanId}.` };
    }
    return {
        report: `${report}\n`
    };
}
function blockedReviewReport(taskId, reason) {
    return `# Review Report

Task ID: ${taskId}
Result: blocked

## Reasons

- ${reason}
`;
}
function collectStringsFromJsonLines(rawOutput) {
    const values = [];
    for (const line of rawOutput.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        try {
            collectStrings(JSON.parse(line), values);
        }
        catch {
            continue;
        }
    }
    return values;
}
function collectStrings(value, values) {
    if (typeof value === "string") {
        values.push(value);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => collectStrings(item, values));
        return;
    }
    if (value && typeof value === "object") {
        Object.values(value).forEach((item) => collectStrings(item, values));
    }
}
