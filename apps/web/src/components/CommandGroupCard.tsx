import { useEffect, useState } from "react";
import type { CommandGroup } from "../lib/types";
import { formatElapsed } from "../lib/format";
import { AlertCard } from "./AlertCard";

export function CommandGroupCard({ command, actionMode = "queue", now }: { command: CommandGroup; actionMode?: "queue" | "operator" | "floor"; now?: number }) {
  const [localNow, setLocalNow] = useState(() => Date.now());
  const currentTime = now ?? localNow;
  const activeTimerStartedAt = command.alerts
    .map((alert) => new Date(alert.activeTimerStartedAt ?? alert.createdAt).getTime())
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b)[0] ?? new Date(command.createdAt).getTime();
  const elapsed = Math.max(0, Math.floor((currentTime - activeTimerStartedAt) / 1000));
  const note = command.sharedNote ?? "";
  const showNote = actionMode === "queue" && Boolean(note);
  const acknowledged = command.alerts.some((alert) => alert.status === "ACKNOWLEDGED");
  const open = command.alerts.some((alert) => alert.status === "OPEN");

  useEffect(() => {
    if (now !== undefined) return;
    const timer = window.setInterval(() => setLocalNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [now]);
  return (
    <article className={`command-card ${actionMode === "operator" ? "operator-active-command" : ""} ${actionMode === "operator" && acknowledged ? "operator-acknowledged-command" : ""} ${actionMode === "floor" ? "floor-command-card" : ""} ${actionMode === "floor" && open ? "floor-command-open" : ""} ${actionMode === "floor" && acknowledged && !open ? "floor-command-acknowledged" : ""}`}>
      <header>
        <div>
          <strong>{command.machine.name} - {command.commandLabel}</strong>
          {actionMode !== "operator" && <span>{command.machine.group || command.machine.code} | {formatElapsed(elapsed)}</span>}
        </div>
        {actionMode !== "operator" && <span className="command-status">{command.status}</span>}
      </header>
      {showNote && (
        <p
          className={`shared-note ${!note ? "empty" : ""} ${note.length > 120 ? "long" : ""}`}
          title={note || "No note entered."}
        >
          {note || "\u00a0"}
        </p>
      )}
      <div className="split-alerts">
        {command.alerts.map((alert) => (
          actionMode === "operator" ? (
            <div key={alert.id} className={`operator-department-box ${alert.status === "ACKNOWLEDGED" ? "acknowledged" : ""}`}>
              <div className="operator-department-label">
                <strong>{alert.department.name}</strong>
                <span className="operator-department-status">{alert.status === "ACKNOWLEDGED" ? "Acknowledged" : alert.status === "OPEN" ? "Open" : alert.status}</span>
              </div>
              <AlertCard alert={alert} compact actionMode={actionMode} now={currentTime} />
            </div>
          ) : (
            <AlertCard key={alert.id} alert={alert} compact actionMode={actionMode} now={currentTime} />
          )
        ))}
      </div>
    </article>
  );
}
