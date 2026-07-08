import { useEffect, useState } from "react";
import type { CommandGroup } from "../lib/types";
import { formatElapsed } from "../lib/format";
import { AlertCard } from "./AlertCard";

export function CommandGroupCard({ command, actionMode = "queue" }: { command: CommandGroup; actionMode?: "queue" | "operator" | "floor" }) {
  const [now, setNow] = useState(() => Date.now());
  const activeTimerStartedAt = command.alerts
    .map((alert) => new Date(alert.activeTimerStartedAt ?? alert.createdAt).getTime())
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b)[0] ?? new Date(command.createdAt).getTime();
  const elapsed = Math.max(0, Math.floor((now - activeTimerStartedAt) / 1000));
  const note = command.sharedNote ?? "";
  const showNote = actionMode === "queue" && Boolean(note);
  const acknowledged = command.alerts.some((alert) => alert.status === "ACKNOWLEDGED");
  const open = command.alerts.some((alert) => alert.status === "OPEN");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <article className={`command-card ${actionMode === "operator" ? "operator-active-command" : ""} ${actionMode === "operator" && acknowledged ? "operator-acknowledged-command" : ""} ${actionMode === "floor" ? "floor-command-card" : ""} ${actionMode === "floor" && open ? "floor-command-open" : ""} ${actionMode === "floor" && acknowledged && !open ? "floor-command-acknowledged" : ""}`}>
      <header>
        <div>
          <strong>{command.machine.name} - {command.commandLabel}</strong>
          {actionMode !== "operator" && <span>{command.machine.group || command.machine.code} | {formatElapsed(elapsed)}</span>}
        </div>
        <span className="command-status">{command.status}</span>
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
        {command.alerts.map((alert) => <AlertCard key={alert.id} alert={alert} compact actionMode={actionMode} />)}
      </div>
    </article>
  );
}
