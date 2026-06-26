import fs from "node:fs/promises";
import { assertAllowedPath } from "./paths.js";

export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(assertAllowedPath(filePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readLogTail(filePath: string, maxLines = 40): Promise<string> {
  const text = await readTextIfExists(filePath);
  if (!text) {
    return "";
  }

  return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
}

export function extractReviewReport(rawOutput: string, fallbackTaskId: string): {
  report: string;
  result: "pass" | "needs-fixes" | "blocked";
} {
  const strings = collectStringsFromJsonLines(rawOutput);
  const searchable = [rawOutput, ...strings].join("\n");
  const match = searchable.match(/REVIEW_REPORT_START\s*([\s\S]*?)\s*REVIEW_REPORT_END/);
  const report = match?.[1]?.trim() || blockedReviewReport(fallbackTaskId, "Codex did not emit a review report envelope.");
  const resultMatch = report.match(/Result:\s*(pass|needs-fixes|blocked)\b/i);
  const result = (resultMatch?.[1]?.toLowerCase() as "pass" | "needs-fixes" | "blocked" | undefined) ?? "blocked";
  return { report: `${report}\n`, result };
}

export function extractPlanReport(rawOutput: string, fallbackPlanId: string): {
  report?: string;
  error?: string;
} {
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

function blockedReviewReport(taskId: string, reason: string): string {
  return `# Review Report

Task ID: ${taskId}
Result: blocked

## Reasons

- ${reason}
`;
}

function collectStringsFromJsonLines(rawOutput: string): string[] {
  const values: string[] = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      collectStrings(JSON.parse(line), values);
    } catch {
      continue;
    }
  }
  return values;
}

function collectStrings(value: unknown, values: string[]): void {
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
