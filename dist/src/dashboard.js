export function renderDashboardHtml() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Pilot Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #5c6670;
      --line: #d8dde3;
      --accent: #0f766e;
      --warn: #b45309;
      --bad: #b91c1c;
      --good: #15803d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      padding: 24px 28px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 650;
      letter-spacing: 0;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: end;
      color: var(--muted);
      font-size: 13px;
    }
    #warning {
      display: none;
      color: var(--warn);
      font-weight: 650;
    }
    main { padding: 20px 28px 32px; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
    }
    th, td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 13px;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      background: #eef1f4;
    }
    tr:last-child td { border-bottom: 0; }
    button {
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #ffffff;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      padding: 6px 9px;
    }
    button:hover { border-color: var(--accent); }
    .title { min-width: 220px; font-weight: 650; }
    .mono {
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .muted { color: var(--muted); }
    .status {
      display: inline-block;
      min-width: 92px;
      padding: 3px 7px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #f8fafc;
      font-weight: 650;
      white-space: nowrap;
    }
    .status.ready-for-approval, .status.build-passed, .status.completed, .status.passed, .status.reconciled-from-evidence, .status.recovered, .status.ready { color: var(--good); }
    .status.needs-fixes, .status.unknown, .status.skipped, .status.superseded, .status.warning { color: var(--warn); }
    .status.failed, .status.stopped, .status.blocked, .status.dead { color: var(--bad); }
    .preview {
      max-width: 420px;
      white-space: pre-wrap;
      color: #29313a;
      line-height: 1.35;
    }
    .empty {
      padding: 28px;
      background: var(--panel);
      border: 1px solid var(--line);
      color: var(--muted);
    }
    dialog {
      width: min(1120px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0;
      color: var(--text);
    }
    dialog::backdrop { background: rgba(23, 32, 42, 0.38); }
    .modal-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px;
      border-bottom: 1px solid var(--line);
      background: #f8fafc;
    }
    .modal-head h2 {
      margin: 0 0 6px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .modal-body {
      padding: 18px 20px 22px;
      display: grid;
      gap: 16px;
    }
    .details-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .fact {
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 10px;
      background: #ffffff;
    }
    .fact b {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    section h3 {
      margin: 0 0 8px;
      font-size: 14px;
      letter-spacing: 0;
    }
    pre {
      margin: 0;
      padding: 12px;
      max-height: 320px;
      overflow: auto;
      white-space: pre-wrap;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #111827;
      color: #f8fafc;
      font-size: 12px;
      line-height: 1.45;
    }
    .history {
      margin: 0;
      padding-left: 18px;
      line-height: 1.6;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
    }
    .tag {
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 2px 5px;
      background: #ffffff;
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
    }
    @media (max-width: 980px) {
      header { align-items: start; flex-direction: column; }
      .meta { justify-content: start; }
      main { padding: 12px; overflow-x: auto; }
      table { min-width: 1080px; }
      .details-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Project Pilot Dashboard</h1>
    <div class="meta">
      <span id="refreshed">Last updated: never</span>
      <span id="warning">Connection issue. Showing last successful data.</span>
    </div>
  </header>
  <main id="content"></main>
  <dialog id="details">
    <div class="modal-head">
      <div>
        <h2 id="details-title">Task details</h2>
        <div id="details-subtitle" class="mono muted"></div>
      </div>
      <button id="close-details" type="button">Close</button>
    </div>
    <div id="details-body" class="modal-body"></div>
  </dialog>
  <script>
    const content = document.getElementById("content");
    const refreshed = document.getElementById("refreshed");
    const warning = document.getElementById("warning");
    const details = document.getElementById("details");
    const detailsTitle = document.getElementById("details-title");
    const detailsSubtitle = document.getElementById("details-subtitle");
    const detailsBody = document.getElementById("details-body");
    const fields = ["Task", "Project", "Task ID", "Updated", "Status", "Task State", "Codex Access", "Approval", "Verification", "Risks", "Build", "Review", "Recent activity", ""];
    const planFields = ["Plan", "Project", "Plan ID", "Updated", "Status", "Summary", "Recent activity", ""];
    const dashboardState = {
      tasks: [],
      plans: [],
      runs: [],
      configuration: {},
      stateHealth: {},
      readiness: {},
      errors: {}
    };

    function text(value) {
      return value === null || value === undefined || value === "" ? "-" : String(value);
    }

    function renderTags(tags) {
      if (!Array.isArray(tags) || !tags.length) return "";
      return '<div class="tags">' + tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join("") + '</div>';
    }

    function markUpdated() {
      refreshed.textContent = "Last updated: " + new Date().toLocaleTimeString();
    }

    function renderCurrent() {
      render(
        dashboardState.tasks,
        dashboardState.plans,
        dashboardState.runs,
        dashboardState.configuration,
        dashboardState.stateHealth,
        dashboardState.readiness,
        dashboardState.errors
      );
    }

    function render(tasks, plans, runs, configuration, stateHealth, readiness, errors) {
      errors = errors || {};
      const readinessPanel = errors.readiness ? unavailablePanel("Readiness / Health", errors.readiness) : renderReadiness(readiness || {});
      const configPanel = errors.configuration ? unavailablePanel("Manager Mode", errors.configuration) : renderConfiguration(configuration || {});
      const statePanel = errors.stateHealth ? unavailablePanel("State Store", errors.stateHealth) : renderStateHealth(stateHealth || {});
      const autopilotPanel = errors.autopilot ? unavailablePanel("Autopilot Runs", errors.autopilot) : renderAutopilotRuns(runs || []);

      const taskRows = tasks.map((task) => {
        const preview = Array.isArray(task.latestLogPreview) ? task.latestLogPreview.slice(0, 3).join("\\n") : "No recent activity.";
        const approval = task.approval || {};
        const risks = Array.isArray(approval.riskFlags) && approval.riskFlags.length ? approval.riskFlags.join(", ") : "none";
        const approvalReasons = Array.isArray(approval.reasons) ? approval.reasons.join("\\n") : "-";
        const codexAccess = text(task.codexAccessMode) + "\\nApproval policy: " + text(task.codexApprovalPolicy) + "\\n" + text(task.codexAccessWarning);
        const approvalRequired = task.status === "ready-for-approval" && approval.status === "manual_approval_required";
        const finalize = approval.eligible
          ? '<button type="button" data-finalize-task-id="' + escapeHtml(task.taskId) + '">Finalize safe task</button> '
          : "";
        const approve = approvalRequired
          ? '<button type="button" data-approve-task-id="' + escapeHtml(task.taskId) + '">Approve</button> '
          : "";
        const decline = approvalRequired
          ? '<button type="button" data-decline-task-id="' + escapeHtml(task.taskId) + '">Decline / Keep Paused</button> '
          : "";
        return '<tr>' +
          '<td class="title">' + escapeHtml(task.title) + '<div class="muted">' + escapeHtml(task.createdAt) + '</div></td>' +
          '<td>' + escapeHtml(task.projectName) + '</td>' +
          '<td class="mono">' + escapeHtml(task.taskId) + '</td>' +
          '<td class="mono muted">' + escapeHtml(task.updatedAt) + '</td>' +
          '<td><span class="status ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span></td>' +
          '<td><span class="status ' + escapeHtml(task.stateKind) + '">' + escapeHtml(text(task.stateLabel)) + '</span>' + renderTags(task.stateTags) + '<div class="muted preview">' + escapeHtml(text(task.stateExplanation)) + '</div></td>' +
          '<td class="preview">' + escapeHtml(codexAccess) + '</td>' +
          '<td>' + escapeHtml(text(approval.mode)) + '<div class="muted">' + escapeHtml(approvalReasons) + '</div></td>' +
          '<td><span class="status ' + escapeHtml(task.verificationStatus) + '">' + escapeHtml(text(task.verificationStatus)) + '</span><div class="muted preview">' + escapeHtml(text(task.verificationSummary)) + '</div></td>' +
          '<td>' + escapeHtml(risks) + '</td>' +
          '<td>' + escapeHtml(task.buildSummary) + '</td>' +
          '<td>' + escapeHtml(text(task.reviewResult)) + '</td>' +
          '<td class="preview">' + escapeHtml(preview) + '</td>' +
          '<td>' + finalize + approve + decline + '<button type="button" data-task-id="' + escapeHtml(task.taskId) + '">View details</button></td>' +
        '</tr>';
      }).join("");

      const taskTable = '<section><h3>Tasks</h3><table><thead><tr>' +
        fields.map((field) => '<th>' + escapeHtml(field) + '</th>').join("") +
        '</tr></thead><tbody>' + taskRows + '</tbody></table></section>';

      const planRows = plans.map((plan) => {
        const preview = Array.isArray(plan.latestLogPreview) ? plan.latestLogPreview.slice(0, 3).join("\\n") : "No recent activity.";
        return '<tr>' +
          '<td class="title">' + escapeHtml(plan.title) + '<div class="muted">' + escapeHtml(plan.createdAt) + '</div></td>' +
          '<td>' + escapeHtml(plan.projectName) + '</td>' +
          '<td class="mono">' + escapeHtml(plan.planId) + '</td>' +
          '<td class="mono muted">' + escapeHtml(plan.updatedAt) + '</td>' +
          '<td><span class="status ' + escapeHtml(plan.status) + '">' + escapeHtml(plan.status) + '</span></td>' +
          '<td class="preview">' + escapeHtml(plan.summary) + '</td>' +
          '<td class="preview">' + escapeHtml(preview) + '</td>' +
          '<td><button type="button" data-plan-id="' + escapeHtml(plan.planId) + '">View details</button></td>' +
        '</tr>';
      }).join("");

      const planTable = '<section><h3>Plans</h3><table><thead><tr>' +
        planFields.map((field) => '<th>' + escapeHtml(field) + '</th>').join("") +
        '</tr></thead><tbody>' + planRows + '</tbody></table></section>';

      content.innerHTML = readinessPanel +
        configPanel +
        statePanel +
        autopilotPanel +
        (errors.plans ? unavailablePanel("Plans", errors.plans) : plans.length ? planTable : '<section><h3>Plans</h3><div class="empty">No plans yet.</div></section>') +
        (errors.tasks ? unavailablePanel("Tasks", errors.tasks) : tasks.length ? taskTable : '<section><h3>Tasks</h3><div class="empty">No tasks yet.</div></section>');
    }

    function unavailablePanel(title, detail) {
      return '<section><h3>' + escapeHtml(title) + '</h3><div class="empty">This section is temporarily unavailable.' +
        '<div class="muted">' + escapeHtml(detail || "Try again shortly.") + '</div></div></section>';
    }

    function renderConfiguration(configuration) {
      const configured = configuration.managerModeConfigured ? "configured" : "not configured";
      const projectRows = Array.isArray(configuration.projects)
        ? configuration.projects.map((project) => {
          const maintenance = project.maintenance || {};
          const preflight = maintenance.preflight || {};
          const preflightStatus = preflight.ok === true ? "passed" : preflight.ok === false ? "blocked" : "not checked";
          return '<tr>' +
            '<td>' + escapeHtml(project.projectName || project.projectId) + '<div class="muted mono">' + escapeHtml(project.projectId) + '</div></td>' +
            '<td>' + escapeHtml(maintenance.enabled ? "enabled" : "disabled") + '</td>' +
            '<td class="preview">' + escapeHtml(text(maintenance.mode)) + '<div class="muted">' + escapeHtml(text(maintenance.operatorMessage)) + '</div></td>' +
            '<td class="mono">' + escapeHtml(text(maintenance.liveRoot)) + '</td>' +
            '<td class="mono">' + escapeHtml(text(maintenance.executionRoot)) + '</td>' +
            '<td>' + escapeHtml(text(maintenance.expectedBranch)) + '<div class="muted">base: ' + escapeHtml(text(maintenance.baseBranch)) + '</div></td>' +
            '<td class="preview">' + escapeHtml(text(maintenance.manualHandoff && maintenance.manualHandoff.message)) + '</td>' +
            '<td>' + escapeHtml(preflightStatus) + '<div class="muted preview">' + escapeHtml(text(maintenance.cannotStartReason || preflight.reason)) + '</div></td>' +
          '</tr>';
        }).join("")
        : "";
      return '<section><h3>Manager Mode</h3><table><tbody>' +
        '<tr><th>Configuration</th><td>' + escapeHtml(configured) + '</td><th>Manager Model</th><td>' + escapeHtml(configuration.managerModel) + '</td></tr>' +
        '<tr><th>Decision Limit</th><td>' + escapeHtml(configuration.maxManagerDecisionsPerRun) + '</td><th>Task Limit</th><td>' + escapeHtml(configuration.maxTasksPerRun) + '</td></tr>' +
        '<tr><th>Fix Limit</th><td>' + escapeHtml(configuration.maxFixAttemptsPerTask) + '</td><th>Runtime Limit</th><td>' + escapeHtml(configuration.maxManagerRuntimeMs) + ' ms</td></tr>' +
      '</tbody></table>' +
      (projectRows
        ? '<h3>Maintenance Execution</h3><table><thead><tr>' +
          ["Project", "Enabled", "Mode", "Live Root", "Execution Root", "Expected Branch", "Manual Handoff", "Preflight"].map((field) => '<th>' + escapeHtml(field) + '</th>').join("") +
          '</tr></thead><tbody>' + projectRows + '</tbody></table>'
        : "") +
      '</section>';
    }

    function renderReadiness(readiness) {
      const components = Array.isArray(readiness.components) ? readiness.components : [];
      const rows = components.map((component) => '<tr>' +
        '<td>' + escapeHtml(text(component.name)) + '</td>' +
        '<td><span class="status ' + escapeHtml(text(component.status)) + '">' + escapeHtml(text(component.status)) + '</span></td>' +
        '<td class="preview">' + escapeHtml(text(component.summary)) + '</td>' +
        '<td class="preview">' + escapeHtml(text(component.detail)) + '</td>' +
      '</tr>').join("");
      const problems = Array.isArray(readiness.problems) && readiness.problems.length ? readiness.problems.join("\\n") : "none";
      return '<section><h3>Readiness / Health</h3><table><tbody>' +
        '<tr><th>Overall</th><td><span class="status ' + escapeHtml(text(readiness.status)) + '">' + escapeHtml(text(readiness.status)) + '</span></td><th>User Action Required</th><td>' + escapeHtml(text(readiness.userActionRequired)) + '</td></tr>' +
        '<tr><th>Generated</th><td class="mono">' + escapeHtml(text(readiness.generatedAt)) + '</td><th>Problems</th><td class="preview">' + escapeHtml(problems) + '</td></tr>' +
      '</tbody></table>' +
      '<table><thead><tr>' + ["Component", "Status", "Summary", "Detail"].map((field) => '<th>' + escapeHtml(field) + '</th>').join("") + '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="4">No readiness components reported.</td></tr>') +
      '</tbody></table></section>';
    }

    function renderStateHealth(stateHealth) {
      const temps = Array.isArray(stateHealth.orphanTempFiles) && stateHealth.orphanTempFiles.length
        ? stateHealth.orphanTempFiles.join("\\n")
        : "none";
      return '<section><h3>State Store</h3><table><tbody>' +
        '<tr><th>File</th><td class="mono">' + escapeHtml(text(stateHealth.filePath)) + '</td><th>Valid JSON</th><td>' + escapeHtml(text(stateHealth.valid)) + '</td></tr>' +
        '<tr><th>Last Read</th><td>' + escapeHtml(text(stateHealth.lastSuccessfulReadAt)) + '</td><th>Last Write</th><td>' + escapeHtml(text(stateHealth.lastSuccessfulWriteAt)) + '</td></tr>' +
        '<tr><th>Snapshots</th><td>' + escapeHtml(text(stateHealth.snapshotCount)) + '</td><th>Orphan Temp Files</th><td class="preview">' + escapeHtml(temps) + '</td></tr>' +
        '<tr><th>Last Recovery</th><td class="preview">' + escapeHtml(text(stateHealth.lastRecovery)) + '</td><th>Last Error</th><td class="preview">' + escapeHtml(text(stateHealth.lastError)) + '</td></tr>' +
      '</tbody></table></section>';
    }

    function renderAutopilotRuns(runs) {
      if (!runs.length) {
        return '<section><h3>Autopilot Runs</h3><div class="empty">No autopilot runs yet.</div></section>';
      }
      const rows = runs.map((run) => {
        const queue = Array.isArray(run.queue) ? run.queue.map((item) => item.title + " [" + text(item.stateLabel || item.status) + "]").join("\\n") : "-";
        const runtime = run.runtime || {};
        const runtimeText = "Active: " + formatDuration(runtime.activeRuntimeMs) +
          "\\nWall-clock: " + formatDuration(runtime.wallClockElapsedMs) +
          "\\nLimit: " + formatDuration(runtime.runtimeLimitMs) +
          "\\nRemaining: " + formatDuration(runtime.remainingActiveRuntimeMs);
        const limit = run.limitPauseKind ? "Limit pause: " + run.limitPauseKind : "";
        const activeTask = run.activeTaskStatus
          ? "Task status: " + run.activeTaskStatus + "\\n" + text(run.activeTaskBuildSummary) + "\\n" + (Array.isArray(run.activeTaskLogPreview) ? run.activeTaskLogPreview.join("\\n") : "")
          : "";
        const activeWorker = Array.isArray(run.workers) ? run.workers.filter((worker) => worker.status === "active").slice(-1)[0] : null;
        const workerText = activeWorker
          ? [
              "Worker: " + text(activeWorker.phase) + " / " + text(activeWorker.attemptType),
              "PID: " + text(activeWorker.pid || "pending"),
              "Started: " + text(activeWorker.startedAt),
              "Last activity: " + text(activeWorker.lastActivityAt || activeWorker.endedAt || activeWorker.startedAt),
              "Command: " + text(activeWorker.command),
              "Report: " + text(activeWorker.reportPath)
            ].join("\\n")
          : "No active worker.";
        const schedulerText = run.scheduler
          ? [
              "Last tick: " + text(run.scheduler.lastTickAt),
              "Next tick: " + text(run.scheduler.nextScheduledTickAt),
              "Dispatch: " + text(run.scheduler.dispatchStatus),
              "Outcome: " + text(run.scheduler.lastDispatchOutcome || run.scheduler.skippedDispatchReason)
            ].join("\\n")
          : "No scheduler state.";
        const activity = [
          "Run updated: " + text(run.updatedAt),
          "Last activity: " + text(run.lastActivityAt),
          "Queue: " + text(run.queueStateSummary),
          "Workers: " + text(run.workerStateSummary)
        ].join("\\n");
        const actions = '<button type="button" data-run-id="' + escapeHtml(run.id) + '">View details</button> ' +
          '<button type="button" data-pause-run-id="' + escapeHtml(run.id) + '">Pause</button> ' +
          '<button type="button" data-resume-run-id="' + escapeHtml(run.id) + '">Resume</button> ' +
          '<button type="button" data-stop-run-id="' + escapeHtml(run.id) + '">Stop</button>';
        return '<tr>' +
          '<td class="mono">' + escapeHtml(run.id) + '<div class="muted">' + escapeHtml(run.createdAt) + '</div></td>' +
          '<td>' + escapeHtml(run.projectId) + '</td>' +
          '<td>' + escapeHtml(run.briefId) + '<div class="muted">' + escapeHtml(text(run.planId)) + '</div></td>' +
          '<td><span class="status ' + escapeHtml(run.status) + '">' + escapeHtml(run.status) + '</span><div class="muted">' + escapeHtml(run.phase) + '</div></td>' +
          '<td class="mono">' + escapeHtml(text(run.currentTaskId)) + '<div class="muted">last: ' + escapeHtml(text(run.lastCompletedTaskId)) + '</div></td>' +
          '<td class="preview">' + escapeHtml(queue || "-") + '</td>' +
          '<td class="preview">' + escapeHtml(runtimeText) + (limit ? '<div class="muted">' + escapeHtml(limit) + '</div>' : '') + '</td>' +
          '<td class="preview">' + escapeHtml(schedulerText) + '</td>' +
          '<td class="preview">' + escapeHtml(workerText) + '</td>' +
          '<td class="preview">' + escapeHtml(activity) + '</td>' +
          '<td>' + escapeHtml(text(run.nextAction)) + '<div class="muted preview">' + escapeHtml(text(run.nextStepExplanation)) + '</div><div class="muted">' + escapeHtml(text(run.codexThreadStatus)) + '</div></td>' +
          '<td class="preview">' + escapeHtml(text(run.pauseReason || run.stopReason || run.completionSummary)) + (activeTask ? "\\n\\n" + escapeHtml(activeTask) : '') + '</td>' +
          '<td>' + actions + '</td>' +
        '</tr>';
      }).join("");
      return '<section><h3>Autopilot Runs</h3><table><thead><tr>' +
        ["Run", "Project", "Brief / Plan", "Progress", "Current Task", "Queue", "Runtime Budget", "Scheduler", "Worker", "Activity", "Next Action", "Reason / Summary", ""].map((field) => '<th>' + escapeHtml(field) + '</th>').join("") +
        '</tr></thead><tbody>' + rows + '</tbody></table></section>';
    }

    function formatDuration(ms) {
      const value = Number(ms || 0);
      if (!Number.isFinite(value) || value <= 0) return "0s";
      const seconds = Math.floor(value / 1000);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainingSeconds = seconds % 60;
      return (hours ? hours + "h " : "") + (minutes ? minutes + "m " : "") + remainingSeconds + "s";
    }

    function escapeHtml(value) {
      return text(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    async function fetchJson(path, label, timeoutMs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(path, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(label + " HTTP " + response.status);
        return await response.json();
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error(label + " timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    function recordFailure(key, message) {
      dashboardState.errors[key] = message || "This section did not respond in time.";
      warning.textContent = "Some dashboard sections are temporarily unavailable.";
      warning.style.display = "inline";
      renderCurrent();
    }

    async function refresh() {
      const core = fetchJson("/dashboard/core", "Core dashboard data", 3500)
        .then((data) => {
          dashboardState.tasks = data.tasks || [];
          dashboardState.plans = data.plans || [];
          dashboardState.runs = data.runs || [];
          delete dashboardState.errors.tasks;
          delete dashboardState.errors.plans;
          delete dashboardState.errors.autopilot;
          markUpdated();
          renderCurrent();
        })
        .catch((error) => {
          recordFailure("tasks", error.message);
          recordFailure("plans", error.message);
          recordFailure("autopilot", error.message);
        });

      const configuration = fetchJson("/dashboard/configuration", "Configuration", 2500)
        .then((data) => {
          dashboardState.configuration = data;
          delete dashboardState.errors.configuration;
          markUpdated();
          renderCurrent();
        })
        .catch((error) => recordFailure("configuration", error.message));

      const stateHealth = fetchJson("/dashboard/state-health", "State health", 2500)
        .then((data) => {
          dashboardState.stateHealth = data;
          delete dashboardState.errors.stateHealth;
          markUpdated();
          renderCurrent();
        })
        .catch((error) => recordFailure("stateHealth", error.message));

      const readiness = fetchJson("/dashboard/readiness", "Readiness", 2500)
        .then((data) => {
          dashboardState.readiness = data;
          delete dashboardState.errors.readiness;
          markUpdated();
          renderCurrent();
        })
        .catch((error) => recordFailure("readiness", error.message));

      await Promise.allSettled([core, configuration, stateHealth, readiness]);
    }

    async function showDetails(taskId) {
      detailsTitle.textContent = "Loading task details";
      detailsSubtitle.textContent = taskId;
      detailsBody.innerHTML = "";
      openDetails();

      try {
        const response = await fetch("/dashboard/tasks/" + encodeURIComponent(taskId), { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const task = await response.json();
        detailsTitle.textContent = task.title;
        detailsSubtitle.textContent = task.taskId;
        detailsBody.innerHTML = renderDetails(task);
      } catch (error) {
        detailsBody.innerHTML = '<section><h3>Error</h3><pre>' + escapeHtml(error.message) + '</pre></section>';
      }
    }

    async function showPlanDetails(planId) {
      detailsTitle.textContent = "Loading plan details";
      detailsSubtitle.textContent = planId;
      detailsBody.innerHTML = "";
      openDetails();

      try {
        const response = await fetch("/dashboard/plans/" + encodeURIComponent(planId), { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const plan = await response.json();
        detailsTitle.textContent = plan.title;
        detailsSubtitle.textContent = plan.planId;
        detailsBody.innerHTML = renderPlanDetails(plan);
      } catch (error) {
        detailsBody.innerHTML = '<section><h3>Error</h3><pre>' + escapeHtml(error.message) + '</pre></section>';
      }
    }

    async function showRunDetails(runId) {
      detailsTitle.textContent = "Loading run details";
      detailsSubtitle.textContent = runId;
      detailsBody.innerHTML = "";
      openDetails();

      try {
        const response = await fetch("/dashboard/autopilot/" + encodeURIComponent(runId), { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const run = await response.json();
        detailsTitle.textContent = "Autopilot run";
        detailsSubtitle.textContent = run.id;
        detailsBody.innerHTML = renderRunDetails(run);
      } catch (error) {
        detailsBody.innerHTML = '<section><h3>Error</h3><pre>' + escapeHtml(error.message) + '</pre></section>';
      }
    }

    async function approveTask(taskId) {
      try {
        const taskResponse = await fetch("/dashboard/tasks/" + encodeURIComponent(taskId), { cache: "no-store" });
        if (!taskResponse.ok) throw new Error("HTTP " + taskResponse.status);
        const task = await taskResponse.json();
        const approval = task.approval || {};
        const evidence = approvalEvidenceText(approval);
        const confirmed = confirm(
          "Approve this task?\\n\\n" +
          "Title: " + text(task.title) + "\\n" +
          "Task ID: " + text(task.taskId) + "\\n" +
          "Build: " + text(task.buildSummary) + "\\n" +
          "Review: " + text(task.reviewResult) + "\\n" +
          "Risk flags: " + (Array.isArray(approval.riskFlags) && approval.riskFlags.length ? approval.riskFlags.join(", ") : "none") + "\\n\\n" +
          "Evidence / rationale:\\n" + evidence + "\\n\\n" +
          "Next action: mark this task completed and keep any Autopilot run paused for user-controlled resume."
        );
        if (!confirmed) return;
        const reason = prompt("Approval reason / note:");
        if (!reason || !reason.trim()) return;
        const response = await fetch("/dashboard/tasks/" + encodeURIComponent(taskId) + "/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason,
            reviewedRiskEvidence: Array.isArray(approval.riskFlags) && approval.riskFlags.length > 0
          })
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "HTTP " + response.status);
        }
        await refresh();
      } catch (error) {
        warning.textContent = "Approval failed: " + error.message;
        warning.style.display = "inline";
      }
    }

    async function declineTask(taskId) {
      const reason = prompt("Why should this task remain paused?");
      if (!reason || !reason.trim()) return;
      try {
        const response = await fetch("/dashboard/tasks/" + encodeURIComponent(taskId) + "/decline", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason })
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "HTTP " + response.status);
        }
        await refresh();
      } catch (error) {
        warning.textContent = "Decline failed: " + error.message;
        warning.style.display = "inline";
      }
    }

    async function finalizeTask(taskId) {
      try {
        const response = await fetch("/dashboard/tasks/" + encodeURIComponent(taskId) + "/finalize", {
          method: "POST",
          headers: { "content-type": "application/json" }
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "HTTP " + response.status);
        }
        const result = await response.json();
        if (result.status === "manual_approval_required") {
          warning.textContent = "Manual approval required: " + (Array.isArray(result.reasons) ? result.reasons.join("; ") : "policy blocked completion");
          warning.style.display = "inline";
          return;
        }
        await refresh();
      } catch (error) {
        warning.textContent = "Finalize failed: " + error.message;
        warning.style.display = "inline";
      }
    }

    async function autopilotAction(runId, action) {
      const verb = action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Stop";
      if (!confirm(verb + " this autopilot run?")) {
        return;
      }
      try {
        const response = await fetch("/dashboard/autopilot/" + encodeURIComponent(runId) + "/" + action, {
          method: "POST",
          headers: { "content-type": "application/json" }
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "HTTP " + response.status);
        }
        await refresh();
      } catch (error) {
        warning.textContent = verb + " failed: " + error.message;
        warning.style.display = "inline";
      }
    }

    function openDetails() {
      if (typeof details.showModal === "function") {
        details.showModal();
      } else {
        details.setAttribute("open", "open");
      }
    }

    function renderDetails(task) {
      const history = Array.isArray(task.statusHistory) ? task.statusHistory : [];
      const errors = Array.isArray(task.errors) && task.errors.length ? task.errors.join("\\n") : "No recorded errors.";
      const approvalActions = Array.isArray(task.approvalActions) && task.approvalActions.length
        ? task.approvalActions.map((item) => item.at + " " + item.kind + " - " + item.reason).join("\\n")
        : "No manual approval actions.";
      return '<div class="details-grid">' +
          fact("Project", task.projectName) +
          fact("Status", task.status) +
          fact("Task State", task.stateLabel) +
          fact("State Tags", Array.isArray(task.stateTags) && task.stateTags.length ? task.stateTags.join(", ") : "-") +
          fact("Codex Access Mode", task.codexAccessMode) +
          fact("Codex Approval Policy", task.codexApprovalPolicy) +
          fact("Approval Mode", task.approval && task.approval.mode) +
          fact("Verification", task.verificationStatus) +
          fact("Risk Flags", task.approval && Array.isArray(task.approval.riskFlags) && task.approval.riskFlags.length ? task.approval.riskFlags.join(", ") : "none") +
          fact("Created", task.createdAt) +
          fact("Updated", task.updatedAt) +
        '</div>' +
        section("Codex Access Warning", task.codexAccessWarning) +
        section("Task State Explanation", task.stateExplanation) +
        section("Approval Policy", task.approval && Array.isArray(task.approval.reasons) ? task.approval.reasons.join("\\n") : "-") +
        section("Verification Identity", verificationIdentityText(task)) +
        section("Evidence Paths", evidencePathsText(task)) +
        section("Verification", verificationText(task)) +
        section("Risk Evidence", task.approval ? approvalEvidenceText(task.approval) : "-") +
        section("Approval Actions", approvalActions) +
        section("Requirements", task.requirements) +
        section("Acceptance Criteria", Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.map((item, index) => String(index + 1) + ". " + item).join("\\n") : "") +
        '<section><h3>Status History</h3><ol class="history">' +
          history.map((item) => '<li><span class="mono">' + escapeHtml(item.at) + '</span> ' + escapeHtml(item.status) + ' - ' + escapeHtml(item.source) + '</li>').join("") +
        '</ol></section>' +
        section("Errors", errors) +
        section("BUILD_REPORT.md", task.buildReport || "No BUILD_REPORT.md found.") +
        section("REVIEW_REPORT.md", task.reviewReport || "No REVIEW_REPORT.md found.") +
        section("Full Build Log", task.buildLog || "No build log output.") +
        section("Full Review Log", task.reviewLog || "No review log output.");
    }

    function renderRunDetails(run) {
      return '<div class="details-grid">' +
          fact("Project", run.projectId) +
          fact("Status", run.status) +
          fact("Phase", run.phase) +
          fact("Current Task", run.currentTaskId) +
          fact("Last Completed Task", run.lastCompletedTaskId) +
          fact("Last Activity", run.lastActivityAt) +
          fact("Decisions Used", run.decisionsUsed) +
          fact("Tasks Started", run.tasksStarted) +
        '</div>' +
        section("Runtime", runtimeDetailsText(run)) +
        section("Remaining Limits", limitsText(run)) +
        section("Queue State", queueDetailsText(run.queue)) +
        section("Worker Status", workerDetailsText(run.workers)) +
        section("Scheduler Tick", schedulerDetailsText(run.scheduler)) +
        section("Current Phase / Task / Next Action", [
          "Phase: " + text(run.phase),
          "Current task: " + text(run.currentTaskId),
          "Next action: " + text(run.nextAction),
          "Explanation: " + text(run.nextStepExplanation)
        ].join("\\n")) +
        section("Pause / Stop / Completion Explanation", text(run.pauseReason || run.stopReason || run.completionSummary || "No pause, stop, or completion explanation recorded.")) +
        section("Audit Explanation", auditExplanationText(run.audit)) +
        section("Recovery History", recoveryDetailsText(run.recoveryHistory)) +
        '<section><h3>Persistent Active-Run Timeline</h3><ol class="history">' +
          (Array.isArray(run.timeline) ? run.timeline.map((item) => '<li><span class="mono">' + escapeHtml(item.at) + '</span> ' + escapeHtml(item.kind) + ' - ' + escapeHtml(item.summary) + '</li>').join("") : "") +
        '</ol></section>' +
        section("Manager Decisions", decisionsText(run.decisions)) +
        section("Active Task Context", [
          "Task status: " + text(run.activeTaskStatus),
          "Build: " + text(run.activeTaskBuildSummary),
          "Recent activity:",
          ...(Array.isArray(run.activeTaskLogPreview) ? run.activeTaskLogPreview : [])
        ].join("\\n"));
    }

    function runtimeDetailsText(run) {
      const runtime = run.runtime || {};
      return [
        "Active runtime: " + formatDuration(runtime.activeRuntimeMs),
        "Wall-clock runtime: " + formatDuration(runtime.wallClockElapsedMs),
        "Runtime limit: " + formatDuration(runtime.runtimeLimitMs),
        "Remaining active runtime: " + formatDuration(runtime.remainingActiveRuntimeMs),
        "Active runtime started: " + text(runtime.activeRuntimeStartedAt)
      ].join("\\n");
    }

    function limitsText(run) {
      const limits = run.limits || {};
      const runtime = run.runtime || {};
      return [
        "Manager decisions: " + text(run.decisionsUsed) + " / " + text(limits.maxManagerDecisions),
        "Tasks: " + text(run.tasksStarted) + " / " + text(limits.maxTasks),
        "Fix attempts per task: " + text(limits.maxFixAttemptsPerTask),
        "Runtime remaining: " + formatDuration(runtime.remainingActiveRuntimeMs),
        "Limit pause kind: " + text(run.limitPauseKind)
      ].join("\\n");
    }

    function queueDetailsText(queue) {
      if (!Array.isArray(queue) || !queue.length) return "Queue is empty.";
      return queue.map((item) => [
        "- " + text(item.title) + " | " + text(item.stateLabel) + " | " + text(item.source),
        "  State tags: " + (Array.isArray(item.stateTags) && item.stateTags.length ? item.stateTags.join(", ") : "-"),
        "  Queue ID: " + text(item.id),
        "  Task ID: " + text(item.taskId),
        "  Original task: " + text(item.fixAttemptForTaskId),
        "  Explanation: " + text(item.stateExplanation),
        "  Updated: " + text(item.updatedAt)
      ].join("\\n")).join("\\n");
    }

    function workerDetailsText(workers) {
      if (!Array.isArray(workers) || !workers.length) return "No worker leases recorded.";
      return workers.map((worker) => [
        "- " + text(worker.phase) + " | " + text(worker.stateLabel) + " | " + text(worker.attemptType),
        "  Task ID: " + text(worker.taskId),
        "  PID: " + text(worker.pid || "pending"),
        "  Started: " + text(worker.startedAt),
        "  Ended: " + text(worker.endedAt),
        "  Last activity: " + text(worker.lastActivityAt),
        "  Report: " + text(worker.reportPath),
        "  Log: " + text(worker.logPath),
        "  Outcome: " + text(worker.outcome)
      ].join("\\n")).join("\\n");
    }

    function schedulerDetailsText(scheduler) {
      scheduler = scheduler || {};
      return [
        "Last tick: " + text(scheduler.lastTickAt),
        "Next tick: " + text(scheduler.nextScheduledTickAt),
        "In progress: " + text(scheduler.inProgress),
        "Dispatch: " + text(scheduler.dispatchStatus),
        "Outcome: " + text(scheduler.lastDispatchOutcome),
        "Skipped reason: " + text(scheduler.skippedDispatchReason)
      ].join("\\n");
    }

    function recoveryDetailsText(history) {
      if (!Array.isArray(history) || !history.length) return "No recovery attempts recorded.";
      return history.map((item) => "- " + Object.entries(item).map(([key, value]) => key + "=" + text(value)).join(" | ")).join("\\n");
    }

    function decisionsText(decisions) {
      if (!Array.isArray(decisions) || !decisions.length) return "No manager decisions recorded.";
      return decisions.map((item) => [
        "- " + text(item.at) + " | " + text(item.action),
        "  Summary: " + text(item.summary),
        "  Reason: " + text(item.reason)
      ].join("\\n")).join("\\n");
    }

    function auditExplanationText(audit) {
      if (!audit) return "No audit explanation summary recorded.";
      const entries = Array.isArray(audit.explanations) ? audit.explanations : [];
      const lines = [
        "User action required: " + text(audit.userActionRequired),
        "Run state: " + text(audit.runStateExplanation),
        "",
        ...entries.map((item) => [
          "- " + text(item.at) + " | " + text(item.category) + " | userActionRequired=" + text(item.userActionRequired),
          "  Summary: " + text(item.summary),
          "  Explanation: " + text(item.explanation)
        ].join("\\n"))
      ];
      return lines.join("\\n");
    }

    function approvalEvidenceText(approval) {
      const reasons = Array.isArray(approval.reasons) ? approval.reasons.join("\\n") : "-";
      const evidence = Array.isArray(approval.riskEvidence) && approval.riskEvidence.length
        ? approval.riskEvidence.map((item) =>
            "- " + text(item.flag) + " | " + text(item.confidence) + " | " + text(item.source) + " | " + text(item.sourcePath) + "\\n" +
            "  Rule: " + text(item.policyRule) + "\\n" +
            "  Behavior: " + text(item.matchedBehavior) + "\\n" +
            "  Excerpt: " + text(item.excerpt)
          ).join("\\n")
        : "No risk evidence.";
      return "Reasons:\\n" + reasons + "\\n\\nRisk evidence:\\n" + evidence;
    }

    function evidencePathsText(task) {
      const paths = task.evidencePaths || {};
      return [
        "Build report: " + text(paths.buildReport),
        "Review report: " + text(paths.reviewReport),
        "Canonical build: " + text(paths.canonicalBuildReport),
        "Canonical review: " + text(paths.canonicalReviewReport),
        "Legacy build: " + text(paths.legacyBuildReport),
        "Legacy review: " + text(paths.legacyReviewReport)
      ].join("\\n");
    }

    function verificationIdentityText(task) {
      const identity = task.verificationIdentity || {};
      return [
        "Task ID: " + text(identity.taskId),
        "Run ID: " + text(identity.runId),
        "Execution root: " + text(identity.executionRoot),
        "Branch: " + text(identity.branch),
        "Build evidence: " + text(identity.buildEvidenceDiagnostic || "ok"),
        "Review evidence: " + text(identity.reviewEvidenceDiagnostic || "ok")
      ].join("\\n");
    }

    function verificationText(task) {
      const records = Array.isArray(task.verification) && task.verification.length
        ? task.verification.map((item) =>
            "- " + text(item.command) + " | attempt " + text(item.attempt) + " | " + text(item.status) + " | current=" + text(item.isCurrent) + "\\n" +
            "  Source: " + text(item.evidence && item.evidence.source) + "\\n" +
            "  Output: " + text(item.outputRef) + "\\n" +
            "  Explanation: " + text(item.evidence && item.evidence.explanation)
          ).join("\\n")
        : "No structured verification records.";
      const events = Array.isArray(task.verificationEvents) && task.verificationEvents.length
        ? task.verificationEvents.map((item) =>
            "- " + text(item.at) + " | " + text(item.kind) + " | " + text(item.status) + " | " + text(item.source) + "\\n" +
            "  " + text(item.explanation)
          ).join("\\n")
        : "No verification audit events.";
      return "Status: " + text(task.verificationStatus) + "\\n" +
        text(task.verificationSummary) + "\\n\\nRecords:\\n" + records + "\\n\\nAudit events:\\n" + events;
    }

    function renderPlanDetails(plan) {
      const history = Array.isArray(plan.statusHistory) ? plan.statusHistory : [];
      const errors = Array.isArray(plan.errors) && plan.errors.length ? plan.errors.join("\\n") : "No recorded errors.";
      return '<div class="details-grid">' +
          fact("Project", plan.projectName) +
          fact("Status", plan.status) +
          fact("PID", plan.pid) +
          fact("Exit Code", plan.exitCode) +
          fact("Created", plan.createdAt) +
          fact("Updated", plan.updatedAt) +
          fact("Started", plan.startedAt) +
          fact("Ended", plan.endedAt) +
          fact("Report", plan.reportPath) +
        '</div>' +
        section("Summary", plan.summary) +
        section("Requirements", plan.requirements) +
        section("Constraints", plan.constraints) +
        '<section><h3>Status History</h3><ol class="history">' +
          history.map((item) => '<li><span class="mono">' + escapeHtml(item.at) + '</span> ' + escapeHtml(item.status) + ' - ' + escapeHtml(item.source) + '</li>').join("") +
        '</ol></section>' +
        section("PLAN_REPORT.md", plan.report || "No PLAN_REPORT.md found.") +
        section("Errors", errors) +
        section("Latest Planning Log Lines", plan.logTail || "No planning log output.") +
        section("Full Planning Log", plan.log || "No planning log output.");
    }

    function fact(label, value) {
      return '<div class="fact"><b>' + escapeHtml(label) + '</b>' + escapeHtml(value) + '</div>';
    }

    function section(title, value) {
      return '<section><h3>' + escapeHtml(title) + '</h3><pre>' + escapeHtml(value) + '</pre></section>';
    }

    content.addEventListener("click", (event) => {
      const finalizeButton = event.target.closest("button[data-finalize-task-id]");
      if (finalizeButton) {
        finalizeTask(finalizeButton.getAttribute("data-finalize-task-id"));
        return;
      }

      const approveButton = event.target.closest("button[data-approve-task-id]");
      if (approveButton) {
        approveTask(approveButton.getAttribute("data-approve-task-id"));
        return;
      }

      const declineButton = event.target.closest("button[data-decline-task-id]");
      if (declineButton) {
        declineTask(declineButton.getAttribute("data-decline-task-id"));
        return;
      }

      const button = event.target.closest("button[data-task-id]");
      if (button) {
        showDetails(button.getAttribute("data-task-id"));
        return;
      }

      const planButton = event.target.closest("button[data-plan-id]");
      if (planButton) {
        showPlanDetails(planButton.getAttribute("data-plan-id"));
        return;
      }

      const runButton = event.target.closest("button[data-run-id]");
      if (runButton) {
        showRunDetails(runButton.getAttribute("data-run-id"));
        return;
      }

      const pauseRun = event.target.closest("button[data-pause-run-id]");
      if (pauseRun) {
        autopilotAction(pauseRun.getAttribute("data-pause-run-id"), "pause");
        return;
      }

      const resumeRun = event.target.closest("button[data-resume-run-id]");
      if (resumeRun) {
        autopilotAction(resumeRun.getAttribute("data-resume-run-id"), "resume");
        return;
      }

      const stopRun = event.target.closest("button[data-stop-run-id]");
      if (stopRun) {
        autopilotAction(stopRun.getAttribute("data-stop-run-id"), "stop");
      }
    });

    document.getElementById("close-details").addEventListener("click", () => details.close());
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
