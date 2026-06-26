export function renderTaskMarkdown(taskId, input) {
    const criteria = input.acceptanceCriteria
        .map((item, index) => `${index + 1}. ${item}`)
        .join("\n");
    return `# ${input.title}

Task ID: ${taskId}

## Requirements

${input.requirements}

## Acceptance Criteria

${criteria}

## Project Pilot Guardrails

- Implement only this task.
- Do not deploy, push, merge, commit, delete unrelated files, or handle credentials.
- Keep all work inside this project folder.
- Run the relevant tests, lint, and build checks before writing the build report.
`;
}
export function buildPrompt(taskId, options = {}) {
    const commands = (options.configuredCommands ?? []).map((command) => `  - \`${command}\``).join("\n");
    const resultRecords = (options.configuredCommands ?? [])
        .map((command) => `PROJECT_PILOT_COMMAND_RESULT {"command":${JSON.stringify(command)},"attempt":1,"status":"passed|failed|unknown","exitCode":0,"startedAt":"ISO-8601 timestamp","endedAt":"ISO-8601 timestamp"}`)
        .join("\n");
    return `You are Codex running under Project Pilot for task ${taskId}.

Read AGENTS.md first if present, then read TASK.md. Implement only the task described in TASK.md.

Required behavior:
- Stay inside the current project.
- Do not deploy, push, merge, commit, delete unrelated files, or request credentials.
- Make the smallest coherent code changes needed for the task.
- Run relevant tests, lint, and build commands available in the project.
- Treat these configured verification commands as required when present:
${commands || "  - No configured commands were provided by the controller."}
- Write the canonical build report at: ${options.reportPath ?? ".project-pilot/reports/<task-id>/BUILD_REPORT.md"}
- The report must include:
  - Report Type: build
  - Task ID: ${taskId}
  - Run ID: ${options.runId ?? "none"}
  - Execution Root: ${options.executionRoot ?? "current working directory"}
  - Branch: ${options.branch ?? "unknown"}
  - Timestamp: ${options.timestamp ?? "current ISO-8601 timestamp"}
  - Report Path: ${options.reportPath ?? ".project-pilot/reports/<task-id>/BUILD_REPORT.md"}
  - Summary of changes
  - Files changed
  - Commands run and results as explicit structured records, one per command attempt:
${resultRecords || "    PROJECT_PILOT_COMMAND_RESULT {\"command\":\"no configured commands\",\"attempt\":1,\"status\":\"unknown\",\"exitCode\":null}"}
  - Acceptance criteria status
  - Final status: passed, failed, or blocked

Finish by reporting the same final status in your final response.`;
}
export function reviewPrompt(taskId, options = {}) {
    return `You are Codex running a read-only Project Pilot review for task ${taskId}.

Do not modify files. Inspect TASK.md, git diff, available test configuration/results, and the canonical build report at ${options.buildReportPath ?? ".project-pilot/reports/<task-id>/BUILD_REPORT.md"}.
You may run read-only inspection commands. Avoid commands that write caches, install dependencies, deploy, push, merge, commit, delete files, or request credentials.

Return a review report in this exact envelope:

REVIEW_REPORT_START
# Review Report

Report Type: review
Task ID: ${taskId}
Run ID: ${options.runId ?? "none"}
Execution Root: ${options.executionRoot ?? "current working directory"}
Branch: ${options.branch ?? "unknown"}
Timestamp: ${options.timestamp ?? "current ISO-8601 timestamp"}
Report Path: ${options.reviewReportPath ?? ".project-pilot/reports/<task-id>/REVIEW_REPORT.md"}
Result: pass | needs-fixes | blocked

## Reasons

- Exact reasons for the result.

## Evidence

- Files, diff areas, commands, or reports inspected.
REVIEW_REPORT_END

Use exactly one result value: pass, needs-fixes, or blocked.`;
}
export function planPrompt(planId, input) {
    return `You are Codex running a read-only Project Pilot planning pass for plan ${planId}.

Do not modify files. Inspect the project structure, existing conventions, dependency files, tests, and relevant source code.
You may run read-only inspection commands. Avoid commands that write caches, install dependencies, deploy, push, merge, commit, delete files, or request credentials.

Request title:
${input.title}

Requirements:
${input.requirements}

Constraints:
${input.constraints}

Return a planning report in this exact envelope:

PLAN_REPORT_START
# Plan Report

Plan ID: ${planId}

## Summary Of The Request

## Recommended Architecture

## Implementation Phases

## Files Likely To Change

## Dependencies Or Services Needed

## Trade-offs And Alternatives

## Risks

## Test Strategy

## Questions/Blockers
PLAN_REPORT_END

If the request is blocked, still return the envelope and put the blocker details under Questions/Blockers.`;
}
