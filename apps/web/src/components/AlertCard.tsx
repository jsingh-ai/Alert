import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postJson } from "../lib/api";
import { formatElapsed } from "../lib/format";
import type { Alert } from "../lib/types";
import { StatusBadge } from "./StatusBadge";

type ActionMode = "queue" | "operator" | "floor";

export function AlertCard({ alert, compact = false, actionMode = "queue", now }: { alert: Alert; compact?: boolean; actionMode?: ActionMode; now?: number }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [localNow, setLocalNow] = useState(() => Date.now());
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["active-alerts"] });
    queryClient.invalidateQueries({ queryKey: ["floor"] });
    queryClient.invalidateQueries({ queryKey: ["operator-snapshot"] });
  };
  const mutate = useMutation({
    mutationFn: (action: string) => postJson(`/api/alerts/${alert.id}/${action}`, { responderNameText: "Web" }),
    onSuccess: refresh
  });
  const sendMessage = useMutation({
    mutationFn: (note: string) => postJson(`/api/alerts/${alert.id}/notes`, {
      note,
      clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}`
    }),
    onSuccess: () => {
      setMessage("");
      refresh();
    }
  });
  const events = [...((alert.messages?.length ? alert.messages : alert.events) ?? [])].filter((event: any) => event.eventType === "NOTE");
  const activeTimerStartedAt = new Date(alert.activeTimerStartedAt ?? alert.createdAt).getTime();
  const currentTime = now ?? localNow;
  const activeElapsedSeconds = Number.isNaN(activeTimerStartedAt) ? alert.elapsedSeconds : Math.max(0, Math.floor((currentTime - activeTimerStartedAt) / 1000));
  const canResolve = alert.status === "ACKNOWLEDGED" || alert.status === "ARRIVED";
  const queueAction = actionMode === "queue" && alert.status === "OPEN" ? "acknowledge" : actionMode === "queue" && canResolve ? "resolve" : "";

  useEffect(() => {
    if (now !== undefined) return;
    const timer = window.setInterval(() => setLocalNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [now]);

  return (
    <article className={`alert-card priority-${alert.priority.toLowerCase()} ${actionMode === "queue" ? "queue-alert" : ""} ${actionMode === "queue" ? `queue-alert-${alert.status.toLowerCase()}` : ""} ${actionMode === "floor" ? "floor-alert" : ""} ${actionMode === "operator" ? "operator-active-alert" : ""} ${actionMode === "operator" && alert.status === "ACKNOWLEDGED" ? "operator-acknowledged-alert" : ""}`}>
      {actionMode !== "operator" && (
        <header>
          <div>
            <strong>{alert.machine.name}</strong>
            <span>{alert.issueText}</span>
          </div>
          <StatusBadge status={alert.status} />
        </header>
      )}
      {!compact && (alert.displayMessage || alert.operatorNote) && <p>{alert.displayMessage || alert.operatorNote}</p>}
      <div className="alert-meta">
        {(actionMode === "queue" || actionMode === "floor") && <strong className="queue-panel-title">Elapsed Time</strong>}
        <span className="alert-timer-value">{formatElapsed(activeElapsedSeconds)}</span>
        {actionMode === "operator" && alert.responderNameText && <span className="alert-responder-value">Responder: {alert.responderNameText}</span>}
      </div>
      {(actionMode === "operator" || actionMode === "queue" || actionMode === "floor") && (
        <div className="alert-conversation">
          {actionMode === "operator" && <strong className="operator-conversation-title">Live Conversation</strong>}
          {(actionMode === "queue" || actionMode === "floor") && <strong className="queue-panel-title">Messages</strong>}
          {events.length > 0 && (
            <div className="conversation-log">
              {events.map((event: any) => (
                <div key={event.id} className={`conversation-event ${event.eventType === "NOTE" ? "note" : ""}`}>
                  <div>
                    <strong>{event.actorNameText || "System"}</strong>
                    <span>{new Date(event.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                  <p>{event.note || event.eventType.replaceAll("_", " ").toLowerCase()}</p>
                </div>
              ))}
            </div>
          )}
          <form className="conversation-form" onSubmit={(event) => {
            event.preventDefault();
            const note = message.trim();
            if (note) sendMessage.mutate(note);
          }}>
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Type a message" />
            <button type="submit" disabled={!message.trim() || sendMessage.isPending}>Send</button>
          </form>
        </div>
      )}
      {queueAction && (
        <div className="action-row queue-action-row">
          <button
            className={queueAction === "resolve" ? "success" : "queue-acknowledge-button"}
            onClick={() => mutate.mutate(queueAction)}
            disabled={mutate.isPending}
          >
            {queueAction === "resolve" ? "Resolve" : "Acknowledge"}
          </button>
        </div>
      )}
      {actionMode === "operator" && canResolve && (
        <div className="action-row operator-resolve-row">
          <button className="success" onClick={() => mutate.mutate("resolve")} disabled={mutate.isPending}>Resolve</button>
        </div>
      )}
    </article>
  );
}
