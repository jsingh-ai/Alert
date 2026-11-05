import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Alert } from "../lib/types";
import { alertTiming, clock } from "../lib/callStages";
import type { AlertTiming } from "../lib/callStages";
import { DepartmentIcon } from "../components/DepartmentBadge";
import { CheckCircleIcon, SendIcon } from "../components/icons";
import "../styles/queue.css";

const QUICK_REPLIES = ["On my way", "5 minutes", "Need parts"];
const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const STALE_AFTER_MS = 30_000;

type Tab = "waiting" | "responding";

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function timeOfDay(value: string | null | undefined) {
  return value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function QueuePage() {
  const { session } = useAuth();
  const now = useNow();
  const departments = (session?.departments ?? []) as Array<{ id: string; name: string; color?: string }>;
  const [departmentId, setDepartmentId] = useState(departments.length === 1 ? departments[0].id : "");
  const [group, setGroup] = useState("all");
  const [tab, setTab] = useState<Tab>("waiting");

  const active = useQuery({
    queryKey: ["active-alerts", departmentId],
    queryFn: () => api<{ data?: Alert[] }>(`/api/alerts/active${departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : ""}`, {}, { quiet: true }),
    refetchInterval: 6000
  });

  const groups = useMemo(() => {
    const names = (session?.machines ?? []).map((m: any) => m.machineGroup?.name).filter((n: any): n is string => Boolean(n));
    return Array.from(new Set(names)).sort(naturalSort.compare);
  }, [session?.machines]);

  const items = useMemo(() => (active.data?.data ?? [])
    .filter((alert) => group === "all" || alert.machine.group === group)
    .map((alert) => ({ alert, timing: alertTiming(alert, now) }))
    .sort((a, b) => b.timing.totalSeconds - a.timing.totalSeconds), [active.data, group, now]);

  const waiting = items.filter(({ timing }) => timing.stage === "waiting");
  const responding = items.filter(({ timing }) => timing.stage !== "waiting");
  const late = waiting.filter(({ timing }) => timing.late).length;
  const offline = !active.isLoading && (active.isError || (active.dataUpdatedAt > 0 && now - active.dataUpdatedAt > STALE_AFTER_MS));

  // Calls that appear after the page loaded get a brief highlight (first-seen time per call).
  const firstSeen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const list = active.data?.data;
    if (!list) return;
    if (!firstSeen.current) {
      firstSeen.current = new Map(list.map((alert) => [alert.id, 0]));
      return;
    }
    for (const alert of list) if (!firstSeen.current.has(alert.id)) firstSeen.current.set(alert.id, Date.now());
  }, [active.data]);
  const fresh = new Set(items.filter(({ alert }) => now - (firstSeen.current?.get(alert.id) ?? 0) < 5000).map(({ alert }) => alert.id));

  // Waiting count in the browser tab title, so a phone in a pocket shows it at a glance.
  useEffect(() => {
    const base = "ProcessGuard";
    document.title = waiting.length ? `(${waiting.length}) Response Queue · ${base}` : `Response Queue · ${base}`;
    return () => { document.title = base; };
  }, [waiting.length]);

  const department = departments.find((d) => d.id === departmentId);

  return (
    <div className="rq-page">
      <header className="rq-head">
        <div className="rq-title">
          <h1>Response Queue</h1>
          <span className={`rq-live ${offline ? "offline" : ""}`}><i />{offline ? "Offline" : departments.length > 1 ? "Live" : department?.name ?? "Live"}</span>
        </div>
        {(departments.length > 1 || groups.length > 1) && (
          <div className="rq-filters">
            {departments.length > 1 && (
              <select aria-label="Department" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
                <option value="">All departments</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
            {groups.length > 1 && (
              <select aria-label="Machine group" value={group} onChange={(event) => setGroup(event.target.value)}>
                <option value="all">All machines</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
          </div>
        )}
      </header>

      {offline && <p className="rq-offline" role="status">Can't reach the server. Calls below may be out of date.</p>}

      <div className="rq-tabs" role="tablist" aria-label="Queue">
        <button type="button" role="tab" aria-selected={tab === "waiting"} className={tab === "waiting" ? "on" : ""} onClick={() => setTab("waiting")}>
          Needs a response {waiting.length > 0 && <em className={late ? "late" : ""}>{waiting.length}</em>}
        </button>
        <button type="button" role="tab" aria-selected={tab === "responding"} className={tab === "responding" ? "on" : ""} onClick={() => setTab("responding")}>
          Responding {responding.length > 0 && <em>{responding.length}</em>}
        </button>
      </div>

      <div className="rq-board" data-tab={tab}>
        <section className="rq-column waiting" aria-label="Needs a response">
          <header className="rq-column-head">
            <h2><i className="rq-dot waiting" />Needs a response</h2>
            <span>{waiting.length}{late ? ` · ${late} late` : ""}</span>
          </header>
          {active.isLoading ? <p className="rq-empty">Loading…</p> : waiting.length === 0 ? (
            <p className="rq-empty"><CheckCircleIcon />Nobody is waiting. New calls appear here.</p>
          ) : (
            <ol className="rq-list">
              {waiting.map(({ alert, timing }) => <li key={alert.id}><QueueCard alert={alert} timing={timing} isNew={fresh.has(alert.id)} me={session?.user.displayName ?? ""} showDepartment={!departmentId} /></li>)}
            </ol>
          )}
        </section>

        <section className="rq-column responding" aria-label="Responding">
          <header className="rq-column-head">
            <h2><i className="rq-dot onTheWay" />Responding</h2>
            <span>{responding.length}</span>
          </header>
          {active.isLoading ? <p className="rq-empty">Loading…</p> : responding.length === 0 ? (
            <p className="rq-empty">No one is out on a call.</p>
          ) : (
            <ol className="rq-list">
              {responding.map(({ alert, timing }) => <li key={alert.id}><QueueCard alert={alert} timing={timing} isNew={false} me={session?.user.displayName ?? ""} showDepartment={!departmentId} /></li>)}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function QueueCard({ alert, timing, isNew, me, showDepartment }: { alert: Alert; timing: AlertTiming; isNew: boolean; me: string; showDepartment: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const notes = (alert.events ?? []).filter((event: any) => event?.note);
  const who = alert.responderNameText?.trim();
  const mine = Boolean(who && me && who === me);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["active-alerts"] });
    queryClient.invalidateQueries({ queryKey: ["floor"] });
  };
  const step = useMutation({
    mutationFn: (action: "acknowledge" | "arrive") => postJson(`/api/alerts/${alert.id}/${action}`, {}),
    onSettled: refresh
  });
  const send = useMutation({
    mutationFn: (note: string) => postJson(`/api/alerts/${alert.id}/notes`, { note, clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
    onSuccess: () => {
      setMessage("");
      refresh();
    }
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (text) send.mutate(text);
  }

  const status = timing.stage === "waiting"
    ? null
    : timing.stage === "onTheWay"
      ? `${mine ? "You're" : `${who ?? "Someone"} is`} on the way`
      : `${mine ? "You're" : `${who ?? "Someone"} is`} at the machine`;

  return (
    <article className={`rq-card ${timing.stage} ${timing.late ? "late" : ""} ${isNew ? "is-new" : ""}`}>
      <header className="rq-card-head">
        <DepartmentIcon department={alert.department} size="md" variant="plain" />
        <div className="rq-card-title">
          <strong>{alert.machine.name}</strong>
          <small>{[showDepartment ? alert.department.name : alert.machine.group, alert.issueType?.name ?? alert.commandLabel].filter(Boolean).join(" · ")}</small>
        </div>
        <div className="rq-card-clock">
          {timing.late && <em className="rq-late">Late</em>}
          <strong>{clock(timing.stage === "waiting" ? timing.waitSeconds : timing.stageSeconds)}</strong>
        </div>
      </header>

      {status && (
        <p className="rq-status"><i className={`rq-dot ${timing.stage}`} />{status}<span>since {timeOfDay(timing.stage === "onSite" ? alert.arrivedAt : alert.acknowledgedAt)}</span></p>
      )}
      {(alert.displayMessage || alert.operatorNote) && <p className="rq-operator-note">“{alert.displayMessage || alert.operatorNote}”</p>}

      {timing.stage === "waiting" && (
        <button type="button" className="rq-btn primary" onClick={() => step.mutate("acknowledge")} disabled={step.isPending}>
          {step.isPending ? "Sending…" : "I'm on my way"}
        </button>
      )}
      {/* only the person who is on the way can say they've arrived */}
      {timing.stage === "onTheWay" && (mine || !who) && (
        <button type="button" className="rq-btn secondary" onClick={() => step.mutate("arrive")} disabled={step.isPending}>
          {step.isPending ? "Sending…" : "I've arrived"}
        </button>
      )}
      {timing.stage === "onSite" && <p className="rq-closes">The operator closes this call at {alert.machine.name}.</p>}
      {step.isError && <p className="rq-error" role="alert">{errorText(step.error, "That didn't go through. Try again.")}</p>}

      <div className="rq-messages">
        <button type="button" className="rq-messages-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {notes.length ? `Messages · ${notes.length}` : "Send a message"}
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
        {open && (
          <div className="rq-messages-body">
            {notes.length > 0 && (
              <ol className="rq-thread">
                {notes.map((note: any) => (
                  <li key={note.id}>
                    <strong>{note.actorNameText || "Message"}</strong>
                    <time>{timeOfDay(note.createdAt)}</time>
                    <p>{note.note}</p>
                  </li>
                ))}
              </ol>
            )}
            <div className="rq-quick">
              {QUICK_REPLIES.map((text) => (
                <button key={text} type="button" onClick={() => send.mutate(text)} disabled={send.isPending}>{text}</button>
              ))}
            </div>
            <form className="rq-compose" onSubmit={onSubmit}>
              <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Message ${alert.machine.name}`} aria-label="Message" />
              <button type="submit" disabled={!message.trim() || send.isPending} aria-label="Send"><SendIcon /></button>
            </form>
            {send.isError && <p className="rq-error" role="alert">Message not sent. Try again.</p>}
          </div>
        )}
      </div>
    </article>
  );
}
