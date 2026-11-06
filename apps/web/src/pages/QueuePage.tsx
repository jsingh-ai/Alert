import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Alert } from "../lib/types";
import { alertTiming, clock } from "../lib/callStages";
import type { AlertTiming } from "../lib/callStages";
import { OfflineNotice, SuiteHeader, SuiteMenu, SuiteStatusBar, TeamIcon, connectionState } from "../components/Suite";
import type { Tone } from "../components/Suite";
import { useKiosk } from "../lib/kiosk";
import { CheckCircleIcon, SendIcon } from "../components/icons";
import "../styles/queue.css";

const QUICK_REPLIES = ["On my way", "5 minutes", "Need parts"];
const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** Calls poll every 6s; the queue is called offline after several missed polls, never on one. */
const OFFLINE_AFTER_MS = 30_000;

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
  const kiosk = useKiosk();
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
  const connection = connectionState(active, now, OFFLINE_AFTER_MS);
  const offline = connection === "offline";

  // Calls that appear after the page loaded drop in; a call that changes stage slides into its new column.
  // Worked out while rendering (not in an effect) so the animation starts on the same frame the card appears.
  const firstSeen = useRef<Map<string, number> | null>(null);
  const lastStage = useRef(new Map<string, { status: string; at: number }>());
  useMemo(() => {
    const list = active.data?.data;
    if (!list) return;
    const initial = !firstSeen.current;
    if (!firstSeen.current) firstSeen.current = new Map();
    for (const alert of list) {
      if (!firstSeen.current.has(alert.id)) firstSeen.current.set(alert.id, initial ? 0 : Date.now());
      const seen = lastStage.current.get(alert.id);
      if (!seen) lastStage.current.set(alert.id, { status: alert.status, at: 0 });
      else if (seen.status !== alert.status) lastStage.current.set(alert.id, { status: alert.status, at: Date.now() });
    }
  }, [active.data]);
  const fresh = new Set(items.filter(({ alert }) => now - (firstSeen.current?.get(alert.id) ?? 0) < 5000).map(({ alert }) => alert.id));
  const moved = new Set(items.filter(({ alert }) => now - (lastStage.current.get(alert.id)?.at ?? 0) < 2500).map(({ alert }) => alert.id));

  // Waiting count in the browser tab title, so a phone in a pocket shows it at a glance.
  useEffect(() => {
    const base = "ProcessGuard";
    document.title = waiting.length ? `(${waiting.length}) Response Queue · ${base}` : `Response Queue · ${base}`;
    return () => { document.title = base; };
  }, [waiting.length]);

  const department = departments.find((d) => d.id === departmentId);
  // Same semantics as the other pages: keep the counts when offline, just without colour
  const status: { tone: Tone; text: string } = connection === "connecting" || (offline && items.length === 0)
    ? { tone: "neutral", text: offline ? "Status unknown" : "Checking…" }
    : waiting.length
      ? { tone: offline ? "neutral" : late ? "late" : "waiting", text: `${waiting.length} waiting` }
      : responding.length
        ? { tone: offline ? "neutral" : responding.every(({ timing }) => timing.stage === "onSite") ? "onSite" : "onTheWay", text: `${responding.length} responding` }
        : { tone: "clear", text: "All clear" };
  const nothingOpen = !active.isLoading && items.length === 0;

  return (
    <div className={`su-page rq-page ${offline ? "stale" : ""}`}>
      <SuiteHeader
        eyebrow={[ "Response queue", group !== "all" ? group : "" ].filter(Boolean).join(" · ")}
        title={department ? <span className="rq-head-team"><TeamIcon department={department} /><span>{department.name}</span></span> : "All departments"}
        status={status}
      >
        {kiosk && <SuiteMenu label="Menu" />}
      </SuiteHeader>

      {(departments.length > 1 || groups.length > 1) && (
        // Filters sit in a toolbar surface, never loose on the page
        <div className="rq-toolbar">
          {departments.length > 1 && (
            <label>
              <span>Department</span>
              <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
                <option value="">All departments</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          {groups.length > 1 && (
            <label>
              <span>Machines</span>
              <select value={group} onChange={(event) => setGroup(event.target.value)}>
                <option value="all">All machines</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {offline && <OfflineNotice lastGood={active.dataUpdatedAt} />}

      {nothingOpen ? (
        // Nothing open: one quiet card, not two empty panels
        <section className="rq-clear" aria-label="Queue">
          <CheckCircleIcon />
          <strong>All clear</strong>
          <span>Nobody is waiting. New calls appear here the moment a machine calls.</span>
        </section>
      ) : (
      <>
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
          {/* The column title belongs to its panel */}
          <header className="rq-column-head">
            <h2><i className="rq-dot waiting" />Needs a response</h2>
            <span className="rq-count">{waiting.length}{late ? ` · ${late} late` : ""}</span>
          </header>
          {active.isLoading ? <p className="rq-empty">Loading…</p> : waiting.length === 0 ? (
            <p className="rq-empty"><CheckCircleIcon />Nobody is waiting. New calls appear here.</p>
          ) : (
            <ol className="rq-list">
              {waiting.map(({ alert, timing }) => <li key={alert.id}><QueueCard alert={alert} timing={timing} isNew={fresh.has(alert.id)} isMoved={moved.has(alert.id)} me={session?.user.displayName ?? ""} showDepartment={!departmentId} /></li>)}
            </ol>
          )}
        </section>

        <section className="rq-column responding" aria-label="Responding">
          <header className="rq-column-head">
            <h2><i className="rq-dot onTheWay" />Responding</h2>
            <span className="rq-count">{responding.length}</span>
          </header>
          {active.isLoading ? <p className="rq-empty">Loading…</p> : responding.length === 0 ? (
            <p className="rq-empty">No one is out on a call.</p>
          ) : (
            <ol className="rq-list">
              {responding.map(({ alert, timing }) => <li key={alert.id}><QueueCard alert={alert} timing={timing} isNew={false} isMoved={moved.has(alert.id)} me={session?.user.displayName ?? ""} showDepartment={!departmentId} /></li>)}
            </ol>
          )}
        </section>
      </div>
      </>
      )}

      <SuiteStatusBar connection={connection} lastGood={active.dataUpdatedAt} />
    </div>
  );
}

function QueueCard({ alert, timing, isNew, isMoved, me, showDepartment }: { alert: Alert; timing: AlertTiming; isNew: boolean; isMoved: boolean; me: string; showDepartment: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const notes = (alert.events ?? []).filter((event: any) => event?.note);
  const who = alert.responderNameText?.trim();
  const mine = Boolean(who && me && who === me);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["active-alerts"] }),
      queryClient.invalidateQueries({ queryKey: ["floor"] })
    ]);
  const step = useMutation({
    mutationFn: (action: "acknowledge" | "arrive") => postJson(`/api/alerts/${alert.id}/${action}`, {}),
    onSuccess: () => refresh(),
    onError: () => { void refresh(); }
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
    <article className={`rq-card ${timing.stage} ${timing.late ? "late" : ""} ${isNew ? "is-new" : ""} ${isMoved ? "is-moved" : ""}`}>
      <header className="rq-card-head">
        <TeamIcon department={alert.department} />
        <div className="rq-card-title">
          <strong>{alert.machine.name}</strong>
          <small>{[showDepartment ? alert.department.name : alert.machine.group, alert.issueType?.name ?? alert.commandLabel].filter(Boolean).join(" · ")}</small>
        </div>
        <div className="rq-card-clock">
          {timing.late && <em className="rq-late">Late</em>}
          {/* the clock counts the current stage: waiting time, then time since they set off / arrived */}
          <strong>{clock(timing.stage === "waiting" ? timing.waitSeconds : timing.stageSeconds)}</strong>
        </div>
      </header>

      {status && (
        <p className="rq-status"><i className={`rq-dot ${timing.stage}`} />{status}<span>since {timeOfDay(timing.stage === "onSite" ? alert.arrivedAt : alert.acknowledgedAt)}</span></p>
      )}
      {(alert.displayMessage || alert.operatorNote) && <p className="rq-operator-note">“{alert.displayMessage || alert.operatorNote}”</p>}

      {timing.stage === "waiting" && (
        <button type="button" className={`rq-btn primary ${step.isPending ? "sending" : ""}`} onClick={() => step.mutate("acknowledge")} disabled={step.isPending} aria-busy={step.isPending}>
          {step.isPending ? "Letting them know…" : "I'm on my way"}
          <i className="rq-sweep" aria-hidden="true" />
        </button>
      )}
      {/* only the person who is on the way can say they've arrived */}
      {timing.stage === "onTheWay" && (mine || !who) && (
        <button type="button" className={`rq-btn secondary ${step.isPending ? "sending" : ""}`} onClick={() => step.mutate("arrive")} disabled={step.isPending} aria-busy={step.isPending}>
          {step.isPending ? "Checking you in…" : "I've arrived"}
          <i className="rq-sweep" aria-hidden="true" />
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
