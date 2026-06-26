export function renderDashboardHtml(): string {
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
    .status.ready-for-approval, .status.build-passed, .status.completed { color: var(--good); }
    .status.needs-fixes { color: var(--warn); }
    .status.failed, .status.stopped { color: var(--bad); }
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
    const fields = ["Task", "Project", "Task ID", "Updated", "Status", "Codex Access", "Approval", "Risks", "Build", "Review", "Recent activity", ""];
    const planFields = ["Plan", "Project", "Plan ID", "Updated", "Status", "Summary", "Recent activity", ""];

    function text(value) {
      return value === null || value === undefined || value === "" ? "-" : String(value);
    }

    function render(tasks, plans, runs, configuration, stateHealth) {
      refreshed.textContent = "Last updated: " + new Date().toLocaleTimeString();
      warning.style.display = "none";
      const configPanel = renderConfiguration(configuration || {});
      const statePanel = renderStateHealth(stateHealth || {});
      const autopilotPanel = renderAutopilotRuns(runs || []);

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
          '<td class="preview">' + escapeHtml(codexAccess) + '</td>' +
          '<td>' + escapeHtml(text(approval.mode)) + '<div class="muted">' + escapeHtml(approvalReasons) + '</div></td>' +
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

      content.innerHTML = configPanel +
        statePanel +
        autopilotPanel +
        (plans.length ? planTable : '<section><h3>Plans</h3><div class="empty">No plans yet.</div></section>') +
        (tasks.length ? taskTable : '<section><h3>Tasks</h3><div class="empty">No tasks yet.</div></section>');
    }

    function renderConfiguration(configuration) {
      const configured = configuration.managerModeConfigured ? "configured" : "not configured";
      const projectRows = Array.isArray(configuration.projects)
        ? configuration.projects.map((project) => {
          const maintenance = project.maintenance || {};
          const preflight = maintenance.preflight || {};
          return '<tr>' +
            '<td>' + escapeHtml(project.projectName || project.projectId) + '<div class="muted mono">' + escapeHtml(project.projectId) + '</div></td>' +
            '<td>' + escapeHtml(maintenance.enabled ? "enabled" : "disabled") + '</td>' +
            '<td class="mono">' + escapeHtml(text(maintenance.liveRoot)) + '</td>' +
            '<td class="mono">' + escapeHtml(text(maintenance.executionRoot)) + '</td>' +
            '<td>' + escapeHtml(text(maintenance.expectedBranch)) + '<div class="muted">base: ' + escapeHtml(text(maintenance.baseBranch)) + '</div></td>' +
            '<td>' + escapeHtml(preflight.ok ? "passed" : "blocked") + '<div class="muted preview">' + escapeHtml(text(maintenance.cannotStartReason)) + '</div></td>' +
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
          ["Project", "Mode", "Live Root", "Execution Root", "Expected Branch", "Preflight"].map((field) => '<th>' + escapeHtml(field) + '</th>').join("") +
          '</tr></thead><tbody>' + projectRows + '</tbody></table>'
        : "") +
      '</section>';
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
        const queue = Array.isArray(run.queue) ? run.queue.map((item) => item.title + " [" + item.status + "]").join("\\n") : "-";
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
        const actions = '<button type="button" data-pause-run-id="' + escapeHtml(run.id) + '">Pause</button> ' +
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
          '<td>' + escapeHtml(text(run.nextAction)) + '<div class="muted">' + escapeHtml(text(run.codexThreadStatus)) + '</div></td>' +
          '<td class="preview">' + escapeHtml(text(run.pauseReason || run.stopReason || run.completionSummary)) + (activeTask ? "\\n\\n" + escapeHtml(activeTask) : '') + '</td>' +
          '<td>' + actions + '</td>' +
        '</tr>';
      }).join("");
      return '<section><h3>Autopilot Runs</h3><table><thead><tr>' +
        ["Run", "Project", "Brief / Plan", "Progress", "Current Task", "Queue", "Runtime Budget", "Scheduler", "Worker", "Next Action", "Reason / Summary", ""].map((field) => '<th>' + escapeHtml(field) + '</th>').join("") +
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

    async function refresh() {
      try {
        const [tasksResponse, plansResponse, autopilotResponse, configurationResponse, stateHealthResponse] = await Promise.all([
          fetch("/dashboard/tasks", { cache: "no-store" }),
          fetch("/dashboard/plans", { cache: "no-store" }),
          fetch("/dashboard/autopilot", { cache: "no-store" }),
          fetch("/dashboard/configuration", { cache: "no-store" }),
          fetch("/dashboard/state-health", { cache: "no-store" })
        ]);
        if (!tasksResponse.ok) throw new Error("Tasks HTTP " + tasksResponse.status);
        if (!plansResponse.ok) throw new Error("Plans HTTP " + plansResponse.status);
        if (!autopilotResponse.ok) throw new Error("Autopilot HTTP " + autopilotResponse.status);
        if (!configurationResponse.ok) throw new Error("Configuration HTTP " + configurationResponse.status);
        if (!stateHealthResponse.ok) throw new Error("State health HTTP " + stateHealthResponse.status);
        const taskData = await tasksResponse.json();
        const planData = await plansResponse.json();
        const autopilotData = await autopilotResponse.json();
        const configurationData = await configurationResponse.json();
        const stateHealthData = await stateHealthResponse.json();
        render(taskData.tasks || [], planData.plans || [], autopilotData.runs || [], configurationData, stateHealthData);
      } catch (error) {
        warning.style.display = "inline";
      }
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
          fact("Codex Access Mode", task.codexAccessMode) +
          fact("Codex Approval Policy", task.codexApprovalPolicy) +
          fact("Approval Mode", task.approval && task.approval.mode) +
          fact("Risk Flags", task.approval && Array.isArray(task.approval.riskFlags) && task.approval.riskFlags.length ? task.approval.riskFlags.join(", ") : "none") +
          fact("Created", task.createdAt) +
          fact("Updated", task.updatedAt) +
        '</div>' +
        section("Codex Access Warning", task.codexAccessWarning) +
        section("Approval Policy", task.approval && Array.isArray(task.approval.reasons) ? task.approval.reasons.join("\\n") : "-") +
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
