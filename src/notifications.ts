import { spawn } from "node:child_process";
import type { AutopilotNotifier } from "./manager.js";
import type { TaskSummary, TaskStatus } from "./types.js";
import { NOTIFIABLE_TASK_STATUSES } from "./task-status.js";

export interface TaskNotifier {
  notifyTransition(previousStatus: TaskStatus | undefined, task: TaskSummary): void;
}

export class WindowsTaskNotifier implements TaskNotifier {
  notifyTransition(previousStatus: TaskStatus | undefined, task: TaskSummary): void {
    if (previousStatus === task.status || !NOTIFIABLE_TASK_STATUSES.has(task.status)) {
      return;
    }

    if (process.platform !== "win32") {
      return;
    }

    const title = "Project Pilot";
    const message = `${task.title} is ${task.status}`;
    const script = `
$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
$nodes = $xml.GetElementsByTagName("text")
$nodes.Item(0).AppendChild($xml.CreateTextNode(${JSON.stringify(title)})) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode(${JSON.stringify(message)})) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Project Pilot").Show($toast)
`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.unref();
  }
}

export class NullTaskNotifier implements TaskNotifier {
  notifyTransition(): void {
    // Used by tests and non-interactive callers.
  }
}

export class WindowsAutopilotNotifier implements AutopilotNotifier {
  notify(title: string, message: string): void {
    if (process.platform !== "win32") {
      return;
    }

    const script = `
$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
$nodes = $xml.GetElementsByTagName("text")
$nodes.Item(0).AppendChild($xml.CreateTextNode(${JSON.stringify(title)})) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode(${JSON.stringify(message)})) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Project Pilot").Show($toast)
`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.unref();
  }
}
