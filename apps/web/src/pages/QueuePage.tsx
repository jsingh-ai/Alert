import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Alert } from "../lib/types";
import { alertTiming, clock } from "../lib/callStages";
import type { AlertTiming } from "../lib/callStages";
import { OfflineNotice, SuiteHeader, SuiteMenu, SuiteStatusBar, TeamIcon, connectionState, timeOfDay } from "../components/Suite";
import type { Tone } from "../components/Suite";
import { useKiosk } from "../lib/kiosk";
import { CheckCircleIcon, MessageIcon, SendIcon } from "../components/icons";
import "../styles/queue.css";

/*
 * The department hub, and each responder's own page:
 *   Needs a response  calls waiting for this department: the main job (accept one), always at the top
 *   Your calls        side panel: calls you accepted or are helping on (where you're going, and messages)
 *   Team on calls     side panel: what teammates are on and for how long, with "Help out"
 * The operator closes every call at the machine, so nothing here closes a call.
 */

const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** Calls poll every 6s; the queue is called offline after several missed polls, never on one. */
const OFFLINE_AFTER_MS = 30_000;
/** How long a call that left the waiting list stays in the screen-reader announcement. */
const LEAVE_MS = 4000;
/** Polls further apart than this (a pocketed phone, an outage, a cached list) are a fresh start, not a diff. */
const GAP_MS = 15_000;
/** "Help out" is a message with this id, so it is sent once per person and the server can list who is helping. */
const helpMessageId = (alertId: string) => `help:${alertId}`;

type Item = { alert: Alert; timing: AlertTiming };
type Note = { id: string; note: string; createdAt: string; actorNameText?: string | null; clientMessageId?: string | null; user?: { id: string } | null };
type Leaving = { alert: Alert; reason: "taken" | "mine" | "cancelled"; until: number };
type Seen = { stage: string; mine: boolean; at: number; alert: Alert };
type Tracked = { key: string; updatedAt: number; firstSeen: Map<string, number>; seen: Map<string, Seen>; leaving: Map<string, Leaving> };

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function notesOf(alert: Alert): Note[] {
  return ((alert.events ?? []) as Note[]).filter((event) => event?.note);
}

/** Accepted by me: by user id when the API has it, else by name (pager accepts carry only a name). */
function acceptedByMe(alert: Alert, userId: string, displayName: string) {
  if (alert.status === "OPEN") return false;
  if (alert.acknowledgedByUserId) return alert.acknowledgedByUserId === userId;
  const who = alert.responderNameText?.trim();
  return Boolean(who && displayName && who === displayName);
}

function helpingOn(alert: Alert, userId: string) {
  if (!userId) return false;
  if (alert.helpers) return alert.helpers.some((helper) => helper.id === userId);
  return notesOf(alert).some((note) => note.user?.id === userId && note.clientMessageId === helpMessageId(alert.id));
}

function responder(alert: Alert) {
  return alert.responderNameText?.trim() || "";
}

/** "Jay helping", "Jay and Ana helping", leaving out me */
function helpersText(alert: Alert, userId: string) {
  const names = (alert.helpers ?? []).filter((helper) => helper.id !== userId).map((helper) => helper.name.split(" ")[0]);
  if (!names.length) return "";
  return `${names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(" and ")} helping`;
}

function subtitle(alert: Alert, showDepartment: boolean) {
  return [showDepartment ? alert.department.name : alert.machine.group, alert.issueType?.name ?? alert.commandLabel].filter(Boolean).join(" · ");
}

export function QueuePage() {
  const { session } = useAuth();
  const kiosk = useKiosk();
  const now = useNow();
  const userId = session?.user.id ?? "";
  const displayName = session?.user.displayName ?? "";
  // Help out is for the people who respond; a manager looking across departments shouldn't post "coming to help" by accident
  const canHelp = session?.membership.role === "RESPONDER";
  const departments = (session?.departments ?? []) as Array<{ id: string; name: string; color?: string }>;
  const [departmentId, setDepartmentId] = useState(departments.length === 1 ? departments[0].id : "");
  const [group, setGroup] = useState("all");

  const active = useQuery({
    queryKey: ["active-alerts", departmentId],
    queryFn: () => api<{ data?: Alert[] }>(`/api/alerts/active${departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : ""}`, {}, { quiet: true }),
    refetchInterval: 6000,
    // Keep polling on a phone in a pocket, so the tab title count stays true
    refetchIntervalInBackground: true
  });

  const groups = useMemo(() => {
    const names = (session?.machines ?? []).map((m: any) => m.machineGroup?.name).filter((n: any): n is string => Boolean(n));
    return Array.from(new Set(names)).sort(naturalSort.compare);
  }, [session?.machines]);

  const inGroup = (alert: Alert) => group === "all" || alert.machine.group === group;
  const isMine = (alert: Alert) => acceptedByMe(alert, userId, displayName) || helpingOn(alert, userId);
  const all: Item[] = (active.data?.data ?? []).map((alert) => ({ alert, timing: alertTiming(alert, now) }));
  const items = all.filter(({ alert }) => inGroup(alert));

  const waiting = items.filter(({ timing }) => timing.stage === "waiting").sort((a, b) => b.timing.totalSeconds - a.timing.totalSeconds);
  const accepted = items.filter(({ timing }) => timing.stage === "accepted");
  // My calls ignore the machine filter: it's my page, wherever the machine is
  const mine = all.filter(({ alert, timing }) => timing.stage === "accepted" && isMine(alert)).sort((a, b) => b.timing.stageSeconds - a.timing.stageSeconds);
  // Longest first: the call that's taking a while is the one someone may want to go and help on
  const team = accepted.filter(({ alert }) => !isMine(alert)).sort((a, b) => b.timing.stageSeconds - a.timing.stageSeconds);
  const late = waiting.filter(({ timing }) => timing.late).length;
  const connection = connectionState(active, now, OFFLINE_AFTER_MS);
  const offline = connection === "offline";

  // What changed since the last poll, worked out while rendering so animations start on the same frame:
  //   new waiting calls drop in; a call that's just been accepted slides into Your calls or Team on calls
  //   (it leaves Needs a response at once: that list only ever holds calls nobody has taken).
  // Only consecutive polls are compared. After a gap (a different department, a pocketed phone, an outage)
  // the list is a fresh start, so nothing is wrongly shown as cancelled or new.
  const tracked = useRef<Tracked | null>(null);
  useMemo(() => {
    const list = active.data?.data;
    if (!list) return;
    const updatedAt = active.dataUpdatedAt;
    const previous = tracked.current;
    const initial = !previous || previous.key !== departmentId || updatedAt - previous.updatedAt > GAP_MS;
    const state: Tracked = initial || !previous
      ? { key: departmentId, updatedAt, firstSeen: new Map(), seen: new Map(), leaving: new Map() }
      : { ...previous, updatedAt };
    tracked.current = state;
    const stamp = Date.now();
    const present = new Set(list.map((alert) => alert.id));
    for (const [id, seen] of state.seen) {
      if (present.has(id)) continue;
      if (seen.stage === "waiting") state.leaving.set(id, { alert: seen.alert, reason: "cancelled", until: stamp + LEAVE_MS });
      state.seen.delete(id);
    }
    for (const alert of list) {
      if (!state.firstSeen.has(alert.id)) state.firstSeen.set(alert.id, initial ? 0 : stamp);
      const stage = alert.status === "OPEN" ? "waiting" : "accepted";
      const mineNow = acceptedByMe(alert, userId, displayName) || helpingOn(alert, userId);
      const seen = state.seen.get(alert.id);
      if (seen && seen.stage === "waiting" && stage === "accepted") {
        state.leaving.set(alert.id, { alert, reason: acceptedByMe(alert, userId, displayName) ? "mine" : "taken", until: stamp + LEAVE_MS });
      }
      const changed = Boolean(seen && (seen.stage !== stage || seen.mine !== mineNow));
      state.seen.set(alert.id, { stage, mine: mineNow, at: changed ? stamp : seen?.at ?? 0, alert });
    }
    for (const [id, gone] of state.leaving) if (gone.until < stamp) state.leaving.delete(id);
  }, [active.data, active.dataUpdatedAt, departmentId, userId, displayName]);
  const t = tracked.current;
  const fresh = (id: string) => now - (t?.firstSeen.get(id) ?? 0) < 5000;
  const moved = (id: string) => now - (t?.seen.get(id)?.at ?? 0) < 2500;
  const leaving = Array.from(t?.leaving.values() ?? []).filter((gone) => gone.until > now && inGroup(gone.alert));

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
      : accepted.length
        ? { tone: offline ? "neutral" : "accepted", text: `${accepted.length} on calls` }
        : { tone: "clear", text: "All clear" };
  const showDepartment = !departmentId;
  const teamTitle = showDepartment ? "On calls" : "Team on calls";
  const announce = leaving.map((gone) => leavingText(gone)).join(". ");

  return (
    <div className={`su-page rq-page ${offline ? "stale" : ""}`}>
      <SuiteHeader
        eyebrow={["Response queue", group !== "all" ? group : ""].filter(Boolean).join(" · ")}
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
      {/* One steady live region, so screen readers hear when a call is taken or cancelled */}
      <p className="su-sr" aria-live="polite">{announce}</p>

      <div className={`rq-hub ${mine.length ? "" : "no-mine"}`}>
        {/* Side panel on wide screens; first on a phone, where the responder is on the move */}
        {mine.length > 0 && (
          <section className="rq-panel rq-mine" aria-label="Your calls">
            <header className="rq-panel-head">
              <h2><i className="rq-dot accepted" />Your calls</h2>
              <span className="rq-count">{mine.length}</span>
            </header>
            <ol className="rq-mine-list">
              {mine.map((item) => (
                <li key={item.alert.id}>
                  <MyCall item={item} helping={!acceptedByMe(item.alert, userId, displayName)} userId={userId} isMoved={moved(item.alert.id)} showDepartment={showDepartment} />
                </li>
              ))}
            </ol>
            <p className="rq-panel-foot">The operator closes each call at the machine once it's fixed.</p>
          </section>
        )}

        <section className="rq-panel rq-waiting" aria-label="Needs a response">
          <header className="rq-panel-head">
            <h2><i className="rq-dot waiting" />Needs a response</h2>
            <span className={`rq-count ${late ? "late" : ""}`}>{waiting.length}{late ? ` · ${late} late` : ""}</span>
          </header>
          {active.isLoading ? (
            <p className="rq-empty">Loading…</p>
          ) : !active.data ? (
            // Never say "All clear" when the list couldn't be loaded
            <p className="rq-empty">Can't load calls right now. Retrying…</p>
          ) : waiting.length === 0 ? (
            // Nothing waiting: one quiet message in the space, not an empty grid
            <div className="rq-clear">
              <CheckCircleIcon />
              <strong>All clear</strong>
              <span>Nobody is waiting. New calls appear here the moment a machine calls.</span>
            </div>
          ) : (
            <ol className="rq-grid">
              {waiting.map((item) => (
                <li key={item.alert.id}>
                  <WaitingCard item={item} isNew={fresh(item.alert.id)} showDepartment={showDepartment} disabled={offline} />
                </li>
              ))}
            </ol>
          )}
        </section>

        <aside className="rq-panel rq-team" aria-label={teamTitle}>
          <header className="rq-panel-head">
            <h2><i className="rq-dot accepted" />{teamTitle}</h2>
            <span className="rq-count">{team.length}</span>
          </header>
          {team.length ? (
            <ol className="rq-team-list">
              {team.map((item) => <li key={item.alert.id}><TeamCall item={item} userId={userId} isMoved={moved(item.alert.id)} showDepartment={showDepartment} canHelp={canHelp} disabled={offline} /></li>)}
            </ol>
          ) : (
            <p className="rq-empty small">{active.isLoading ? "Loading…" : "No one else is on a call."}</p>
          )}
        </aside>
      </div>

      <SuiteStatusBar connection={connection} lastGood={active.dataUpdatedAt} />
    </div>
  );
}

function leavingText({ alert, reason }: Leaving) {
  if (reason === "mine") return `You accepted ${alert.machine.name}. It's in Your calls`;
  if (reason === "taken") return `${responder(alert) || "A teammate"} accepted ${alert.machine.name}`;
  return `${alert.machine.name} call cancelled`;
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["active-alerts"] }),
      queryClient.invalidateQueries({ queryKey: ["floor"] })
    ]);
}

function CardHead({ alert, showDepartment, clockText, late }: { alert: Alert; showDepartment: boolean; clockText: string; late?: boolean }) {
  return (
    <header className="rq-card-head">
      <TeamIcon department={alert.department} />
      <div className="rq-card-title">
        <strong>{alert.machine.name}</strong>
        <small>{subtitle(alert, showDepartment)}</small>
      </div>
      <div className="rq-card-clock">
        {late && <em className="rq-late">Late</em>}
        <strong>{clockText}</strong>
      </div>
    </header>
  );
}

/** A call waiting for the department: what it is, what the operator said, and one button. */
function WaitingCard({ item: { alert, timing }, isNew, showDepartment, disabled }: { item: Item; isNew: boolean; showDepartment: boolean; disabled: boolean }) {
  const refresh = useRefresh();
  const accept = useMutation({
    mutationFn: () => postJson(`/api/alerts/${alert.id}/acknowledge`, {}),
    // The button keeps its sending motion until the call has moved to Your calls
    onSuccess: () => refresh(),
    onError: () => { void refresh(); }
  });
  const notes = notesOf(alert);
  const latest = notes[notes.length - 1];
  const note = alert.displayMessage || alert.operatorNote;
  // Losing a race to a teammate is normal, not an error
  const failure = accept.isError && (/not open|already/i.test(errorText(accept.error, "")) ? "Someone else just accepted this call." : errorText(accept.error, "That didn't go through. Try again."));

  return (
    <article className={`rq-card waiting ${timing.late ? "late" : ""} ${isNew ? "is-new" : ""}`}>
      <CardHead alert={alert} showDepartment={showDepartment} clockText={clock(timing.waitSeconds)} late={timing.late} />
      {note && <p className="rq-operator-note">“{note}”</p>}
      {/* The operator's latest message, so it's read before accepting */}
      {latest && latest.note !== note && (
        <p className="rq-latest"><MessageIcon /><strong>{latest.actorNameText || "Operator"}</strong><span>{latest.note}</span></p>
      )}
      <button type="button" className={`rq-btn primary ${accept.isPending ? "sending" : ""}`} onClick={() => accept.mutate()} disabled={accept.isPending || disabled} aria-busy={accept.isPending}>
        {accept.isPending ? "Accepting…" : "Accept call"}
        <i className="rq-sweep" aria-hidden="true" />
      </button>
      {failure && <p className="rq-error" role="alert">{failure}</p>}
    </article>
  );
}

/** One of my calls: a slim row (where, since when) with its messages one tap away. */
function MyCall({ item: { alert, timing }, helping, userId, isMoved, showDepartment }: { item: Item; helping: boolean; userId: string; isMoved: boolean; showDepartment: boolean }) {
  const [open, setOpen] = useState(false);
  const notes = notesOf(alert);
  const last = notes[notes.length - 1];
  // Someone else wrote last: worth a look
  const unread = Boolean(last && last.user?.id !== userId);
  const others = helpersText(alert, userId);
  const status = helping
    ? (responder(alert) ? `Helping ${responder(alert)}` : "Helping on this call")
    : [`You accepted at ${timeOfDay(alert.acknowledgedAt ?? alert.arrivedAt)}`, others].filter(Boolean).join(" · ");
  return (
    <article className={`rq-my ${isMoved ? "is-moved" : ""}`}>
      <div className="rq-my-row">
        <TeamIcon department={alert.department} />
        <div className="rq-card-title">
          <strong>{alert.machine.name}</strong>
          <small>{subtitle(alert, showDepartment)}</small>
        </div>
        <strong className="rq-my-clock">{clock(timing.stageSeconds)}</strong>
        <div className="rq-my-foot">
          <p className="rq-my-status"><i className="rq-dot accepted" />{status}</p>
          <button type="button" className={`rq-pill ${open ? "open" : ""} ${unread && !open ? "unread" : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <MessageIcon />{notes.length ? `Messages · ${notes.length}` : "Message"}
            {unread && !open && <i className="rq-unread" aria-label="New message" />}
          </button>
        </div>
      </div>
      {open && <Messages alert={alert} />}
    </article>
  );
}

/** A teammate's call, kept small: where, who (and who's helping), when it was accepted and for how long, and a way to go and help. */
function TeamCall({ item: { alert, timing }, userId, isMoved, showDepartment, canHelp, disabled }: { item: Item; userId: string; isMoved: boolean; showDepartment: boolean; canHelp: boolean; disabled: boolean }) {
  const refresh = useRefresh();
  const help = useMutation({
    mutationFn: () => postJson(`/api/alerts/${alert.id}/notes`, { note: "Coming to help", clientMessageId: helpMessageId(alert.id) }),
    // Once it lands, the call moves to Your calls ("Helping Marcus Lee")
    onSuccess: () => refresh()
  });
  const who = [responder(alert) || "A teammate", helpersText(alert, userId)].filter(Boolean).join(" · ");
  return (
    <article className={`rq-teamcall ${isMoved ? "is-moved" : ""}`}>
      <div className="rq-teamcall-main">
        <strong>{alert.machine.name}</strong>
        <small>{[who, showDepartment ? alert.department.name : alert.issueType?.name ?? alert.commandLabel].filter(Boolean).join(" · ")}</small>
      </div>
      {/* How long it's been since they accepted, and when that was: enough to judge whether to go and help */}
      <div className="rq-teamcall-time">
        <strong>{clock(timing.stageSeconds)}</strong>
        <small>Accepted {timeOfDay(alert.acknowledgedAt ?? alert.arrivedAt)}</small>
      </div>
      {canHelp && (
        <button type="button" className={`rq-help ${help.isPending ? "sending" : ""}`} onClick={() => help.mutate()} disabled={help.isPending || disabled} aria-busy={help.isPending}>
          {help.isPending ? "Letting them know…" : "Help out"}
        </button>
      )}
      {help.isError && <p className="rq-error" role="alert">{errorText(help.error, "That didn't go through. Try again.")}</p>}
    </article>
  );
}

/** The call's conversation with the operator: the thread and a box to type in. */
function Messages({ alert }: { alert: Alert }) {
  const refresh = useRefresh();
  const [message, setMessage] = useState("");
  const notes = notesOf(alert);
  const send = useMutation({
    mutationFn: (note: string) => postJson(`/api/alerts/${alert.id}/notes`, { note, clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
    onSuccess: () => {
      setMessage("");
      return refresh();
    }
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (text) send.mutate(text);
  }

  return (
    <div className="rq-messages-body">
      {notes.length > 0 && (
        <ol className="rq-thread">
          {notes.map((note) => (
            <li key={note.id}>
              <strong>{note.actorNameText || "Message"}</strong>
              <time>{timeOfDay(note.createdAt)}</time>
              <p>{note.note}</p>
            </li>
          ))}
        </ol>
      )}
      <form className="rq-compose" onSubmit={onSubmit}>
        <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Message ${alert.machine.name}`} aria-label="Message" />
        <button type="submit" disabled={!message.trim() || send.isPending} aria-label="Send"><SendIcon /></button>
      </form>
      {send.isError && <p className="rq-error" role="alert">Message not sent. Try again.</p>}
    </div>
  );
}
