import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useKiosk } from "../lib/kiosk";
import type { Alert, CommandGroup } from "../lib/types";
import { LATE_AFTER_SECONDS, clock, sortCalls, summarizeCall } from "../lib/callStages";
import type { AlertTiming, CallStage, CallSummary } from "../lib/callStages";
import { OfflineNotice, SuiteHeader, SuiteMenu, SuiteStatusBar, TeamIcon, connectionState, teamHue, timeOfDay } from "../components/Suite";
import type { Connection, Tone } from "../components/Suite";
import { CheckCircleIcon, CloseIcon, SendIcon } from "../components/icons";
import "../styles/floor.css";

/*
 * Floor Status, for managers and supervisors:
 *   Overview   machines running / waiting for a team / being handled, longest wait, calls today; area filter
 *   The floor  one card per area, every machine a tile in a fixed order (green = running, red = waiting, amber = handled)
 *   Teams      one card per department with only its own calls, so departments never mix
 * Tapping any call opens its details (progress per team, activity, and a message box).
 */

/** The floor polls every 7s; only call it offline after several missed polls. */
const POLL_MS = 7000;
const OFFLINE_AFTER_MS = 20_000;

type FloorMachine = { id: string; name: string; code: string; machineGroup?: { name?: string } | null };
type MachineStats = Record<string, { alertsToday?: number; callsToday?: number }>;
type Department = { id: string; name: string; color?: string | null };
type MachineStage = CallStage | "running";
/** One team's part of a call (a call to two teams is two lanes). */
type Lane = { alert: Alert; timing: AlertTiming; call: CallSummary };

const STAGE_TEXT: Record<CallStage, string> = { waiting: "Waiting", accepted: "Accepted" };

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function StatusDot({ stage }: { stage: MachineStage }) {
  return <i className={`fs-dot ${stage}`} aria-hidden="true" />;
}

function responder(alert: Alert) {
  return alert.responderNameText?.trim() || "";
}

function areaOf(machine: FloorMachine) {
  return machine.machineGroup?.name ?? "Machines";
}

/** Header pill: the floor's overall state in a few words. */
function floorStatus(connection: Connection, machineCount: number, calls: CallSummary[], waitingMachines: number): { tone: Tone; text: string } {
  if (connection === "connecting") return { tone: "neutral", text: "Checking…" };
  if (connection === "offline" && calls.length === 0) return { tone: "neutral", text: "Status unknown" };
  if (machineCount === 0) return { tone: "neutral", text: "No machines" };
  const stale = connection === "offline";
  if (waitingMachines > 0) {
    return { tone: stale ? "neutral" : calls.some((c) => c.late) ? "late" : "waiting", text: `${plural(waitingMachines, "machine")} waiting` };
  }
  if (calls.length > 0) return { tone: stale ? "neutral" : "accepted", text: `${plural(calls.length, "call")} being handled` };
  return { tone: "clear", text: "All running" };
}

export function FloorPage() {
  const { session } = useAuth();
  const kiosk = useKiosk();
  const now = useNow();
  // null = every area
  const [group, setGroup] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const floor = useQuery({ queryKey: ["floor"], queryFn: () => api<any>("/api/floor/active"), refetchInterval: POLL_MS, refetchIntervalInBackground: true });
  const commands = (floor.data?.data?.commands ?? []) as CommandGroup[];
  const machines = (floor.data?.data?.machines ?? []) as FloorMachine[];
  const machineStats = (floor.data?.data?.machineStats ?? {}) as MachineStats;
  const connection = connectionState(floor, now, OFFLINE_AFTER_MS);
  const lastGood = floor.dataUpdatedAt;
  const stale = connection === "offline";
  const loaded = Boolean(floor.data);

  // Areas in their configured order (the API sorts machines by area, then position), never alphabetical
  const groups = useMemo(() => Array.from(new Set(machines.map(areaOf))), [machines]);
  // A chosen area that has gone away falls back to all, so the view can't get stuck empty
  const activeGroup = group && groups.includes(group) ? group : null;
  const visibleMachines = useMemo(() => machines.filter((m) => !activeGroup || areaOf(m) === activeGroup), [machines, activeGroup]);

  const calls = useMemo(() => {
    const ids = new Set(visibleMachines.map((m) => m.id));
    return sortCalls(commands.filter((command) => ids.has(command.machine.id) && command.alerts.length > 0).map((command) => summarizeCall(command, now)));
  }, [commands, visibleMachines, now]);

  const callsByMachine = useMemo(() => {
    const map = new Map<string, CallSummary[]>();
    for (const call of calls) map.set(call.command.machine.id, [...(map.get(call.command.machine.id) ?? []), call]);
    return map;
  }, [calls]);
  /** A machine's state is its most urgent call's (sortCalls puts waiting first) */
  const stageOf = (machine: FloorMachine): MachineStage => callsByMachine.get(machine.id)?.[0]?.stage ?? "running";

  const lanes: Lane[] = calls.flatMap((call) => call.alerts.map((lane) => ({ ...lane, call })));
  const waitingLanes = lanes.filter((lane) => lane.timing.stage === "waiting");
  // The overview counts machines, so running + waiting + being handled always adds up to the total
  const waitingMachines = visibleMachines.filter((m) => stageOf(m) === "waiting");
  const handledMachines = visibleMachines.filter((m) => stageOf(m) === "accepted").length;
  const runningCount = visibleMachines.length - waitingMachines.length - handledMachines;
  const lateMachines = waitingMachines.filter((m) => callsByMachine.get(m.id)?.[0]?.late).length;
  const longest = waitingLanes.reduce<Lane | null>((best, lane) => (!best || lane.timing.waitSeconds > best.timing.waitSeconds ? lane : best), null);
  const callsToday = visibleMachines.reduce((sum, m) => sum + (machineStats[m.id]?.callsToday ?? machineStats[m.id]?.alertsToday ?? 0), 0);

  // Departments: the ones this person covers, plus any team that has a call right now.
  // Teams with calls come first, so on a narrow screen the busy ones sit above the floor.
  const departmentMap = new Map<string, Department>();
  for (const d of (session?.departments ?? []) as Department[]) departmentMap.set(d.id, d);
  for (const lane of lanes) if (!departmentMap.has(lane.alert.department.id)) departmentMap.set(lane.alert.department.id, lane.alert.department);
  const lanesFor = (id: string) => lanes.filter((lane) => lane.alert.department.id === id);
  const busyTeams = Array.from(departmentMap.values()).filter((d) => lanesFor(d.id).length > 0);
  const quietTeams = Array.from(departmentMap.values()).filter((d) => lanesFor(d.id).length === 0);

  // The open call is found among all calls, so changing area doesn't close it
  const selected = useMemo(() => {
    const command = commands.find((c) => c.id === selectedId);
    return command && command.alerts.length ? summarizeCall(command, now) : undefined;
  }, [commands, selectedId, now]);
  useEffect(() => {
    if (selectedId && !selected && !floor.isFetching) setSelectedId(null);
  }, [selectedId, selected, floor.isFetching]);

  const areas = useMemo(() => {
    const map = new Map<string, FloorMachine[]>();
    for (const machine of visibleMachines) map.set(areaOf(machine), [...(map.get(areaOf(machine)) ?? []), machine]);
    return Array.from(map, ([name, list]) => ({ name, machines: list }));
  }, [visibleMachines]);

  const kpi = (value: number | string) => (loaded ? value : "–");

  return (
    <div className={`su-page fs-page ${stale ? "stale" : ""}`}>
      <SuiteHeader
        eyebrow={floor.isLoading ? "Loading" : [plural(visibleMachines.length, "machine"), activeGroup ?? ""].filter(Boolean).join(" · ")}
        title="Floor Status"
        status={floorStatus(connection, visibleMachines.length, calls, waitingMachines.length)}
      >
        {/* With the sidebar showing, theme and sign-out live there */}
        {kiosk && <SuiteMenu label="Menu" />}
      </SuiteHeader>

      {stale && <OfflineNotice lastGood={lastGood} />}

      {/* Overview: machines by state, the longest wait, today's calls, and the one filter (area) */}
      <section className="fs-overview" aria-label="Summary">
        <dl className="fs-kpis">
          <div className={`fs-kpi ${loaded && visibleMachines.length ? "" : "zero"}`}>
            <dt><StatusDot stage="running" />Running</dt>
            <dd>{kpi(runningCount)}{loaded && <span className="fs-kpi-total">/ {visibleMachines.length}</span>}</dd>
          </div>
          <div className={`fs-kpi ${waitingMachines.length ? "" : "zero"}`}>
            <dt><StatusDot stage="waiting" />Waiting for a team</dt>
            <dd>
              {kpi(waitingMachines.length)}
              {lateMachines > 0 && <small className="fs-late-text">{lateMachines} late</small>}
            </dd>
          </div>
          <div className={`fs-kpi ${handledMachines ? "" : "zero"}`}>
            <dt><StatusDot stage="accepted" />Being handled</dt>
            <dd>{kpi(handledMachines)}</dd>
          </div>
          <div className={`fs-kpi ${longest ? "" : "zero"}`}>
            <dt>Longest wait</dt>
            <dd>
              {longest ? (
                <>
                  <span className={longest.timing.late ? "fs-late-text" : ""}>{clock(longest.timing.waitSeconds)}</span>
                  <small>{longest.call.command.machine.name}</small>
                </>
              ) : "–"}
            </dd>
          </div>
          <div className={`fs-kpi ${loaded ? "" : "zero"}`}>
            <dt>Calls today</dt>
            <dd>{kpi(callsToday)}</dd>
          </div>
        </dl>
        {groups.length > 1 && (
          <div className="fs-filters">
            <span id="fs-area-label">Area</span>
            <div className="fs-seg" role="group" aria-labelledby="fs-area-label">
              {[null, ...groups].map((name) => (
                <button key={name ?? "*all"} type="button" aria-pressed={activeGroup === name} className={activeGroup === name ? "on" : ""} onClick={() => setGroup(name)}>
                  {name ?? "All"}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="fs-layout">
        {/* The floor: every machine, by area, in its usual order */}
        <div className="fs-floor">
          {floor.isLoading ? (
            <section className="fs-card"><p className="fs-empty">Loading machines…</p></section>
          ) : !loaded ? (
            <section className="fs-card"><p className="fs-empty">Can't load the floor right now. Retrying…</p></section>
          ) : areas.length === 0 ? (
            <section className="fs-card"><p className="fs-empty">No machines in this view.</p></section>
          ) : (
            areas.map((area) => (
              <Area key={area.name} name={area.name} machines={area.machines} stageOf={stageOf} callsByMachine={callsByMachine} stats={machineStats} selectedId={selectedId} onSelect={setSelectedId} />
            ))
          )}
        </div>

        {/* Teams: each department's own calls, waiting first. Quiet teams fold into one line. */}
        <div className="fs-teams">
          {busyTeams.map((department) => (
            <TeamCard key={department.id} department={department} lanes={lanesFor(department.id)} selectedId={selectedId} onSelect={setSelectedId} />
          ))}
          {loaded && (quietTeams.length > 0 || busyTeams.length === 0) && (
            <section className="fs-card fs-quiet" aria-label="Teams with no open calls">
              <CheckCircleIcon />
              <p>
                <strong>{busyTeams.length ? "No open calls" : "No open calls for any team"}</strong>
                {quietTeams.length > 0 && <span className="fs-quiet-teams">{quietTeams.map((d) => <span key={d.id}><TeamIcon department={d} size="sm" />{d.name}</span>)}</span>}
              </p>
            </section>
          )}
        </div>
      </div>

      <SuiteStatusBar connection={connection} lastGood={lastGood}>
        {loaded && `${plural(callsToday, "call")} today`}
      </SuiteStatusBar>

      {selected && <CallPanel call={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

/* ---------- The floor ---------- */

function Area({ name, machines, stageOf, callsByMachine, stats, selectedId, onSelect }: {
  name: string;
  machines: FloorMachine[];
  stageOf: (machine: FloorMachine) => MachineStage;
  callsByMachine: Map<string, CallSummary[]>;
  stats: MachineStats;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const waiting = machines.filter((m) => stageOf(m) === "waiting").length;
  const accepted = machines.filter((m) => stageOf(m) === "accepted").length;
  const running = machines.length - waiting - accepted;
  const pct = (n: number) => `${(n / Math.max(1, machines.length)) * 100}%`;

  return (
    <section className="fs-card fs-area" aria-label={name}>
      <header className="fs-area-head">
        <h2>{name}</h2>
        <div className="fs-area-meta">
          <span><strong>{running}</strong> of {machines.length} running</span>
          {waiting > 0 && <span className="fs-chip waiting">{waiting} waiting</span>}
          {accepted > 0 && <span className="fs-chip accepted">{accepted} being handled</span>}
        </div>
        {/* The area's overall state as a strip along the bottom of its header (the text beside it says the same) */}
        <span className="fs-health" aria-hidden="true">
          <i className="running" style={{ width: pct(running) }} />
          <i className="accepted" style={{ width: pct(accepted) }} />
          <i className="waiting" style={{ width: pct(waiting) }} />
        </span>
      </header>
      <ul className="fs-tiles">
        {machines.map((machine) => (
          <li key={machine.id}>
            <MachineTile machine={machine} calls={callsByMachine.get(machine.id) ?? []} stats={stats[machine.id]} selectedId={selectedId} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function MachineTile({ machine, calls, stats, selectedId, onSelect }: {
  machine: FloorMachine;
  calls: CallSummary[];
  stats?: MachineStats[string];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (calls.length === 0) {
    const today = stats?.callsToday ?? stats?.alertsToday ?? 0;
    return (
      <div className="fs-tile running">
        <strong className="fs-tile-name">{machine.name}</strong>
        <span className="fs-tile-state">Running</span>
        {today > 0 && <span className="fs-tile-today" title={`${plural(today, "call")} today`}>{today} today</span>}
      </div>
    );
  }
  // The most urgent call leads; the tile shows how long the machine has had a call open
  const worst = calls[0];
  const teams = Array.from(new Map(calls.flatMap((call) => call.alerts.map(({ alert }) => [alert.department.id, alert.department] as const))).values());
  const waitingTeams = worst.alerts.filter(({ timing }) => timing.stage === "waiting").map(({ alert }) => alert.department.name);
  const who = worst.alerts.map(({ alert }) => responder(alert)).filter(Boolean);
  // The tint already says waiting or handled, so the words say who: the team still waited for, or the responder
  const state = worst.stage === "waiting" ? waitingTeams.join(", ") : who.length ? who.join(", ") : "Accepted";
  const full = worst.stage === "waiting" ? `waiting for ${waitingTeams.join(" and ")}` : `${state}, ${teams.map((t) => t.name).join(" and ")}`;
  const more = calls.length > 1 ? ` · +${calls.length - 1} more` : "";
  return (
    <button
      type="button"
      className={`fs-tile ${worst.stage} ${worst.late ? "late" : ""} ${calls.some((call) => call.command.id === selectedId) ? "selected" : ""}`}
      onClick={() => onSelect(worst.command.id)}
      aria-label={`${machine.name}: ${full}, open ${clock(worst.totalSeconds)}${worst.late ? ", late" : ""}${calls.length > 1 ? `, ${calls.length - 1} more ${calls.length === 2 ? "call" : "calls"}` : ""}`}
    >
      <strong className="fs-tile-name">{machine.name}</strong>
      <span className="fs-tile-state">
        <span className="fs-tile-teams">{teams.map((department) => <TeamIcon key={department.id} department={department} size="sm" />)}</span>
        {worst.late && <em className="fs-late">Late</em>}
        <span className="fs-tile-who">{state}{more}</span>
      </span>
      <span className="fs-tile-clock">{clock(worst.totalSeconds)}</span>
    </button>
  );
}

/* ---------- Teams ---------- */

function TeamCard({ department, lanes, selectedId, onSelect }: {
  department: Department;
  lanes: Lane[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const waiting = lanes.filter((lane) => lane.timing.stage === "waiting").sort((a, b) => b.timing.waitSeconds - a.timing.waitSeconds);
  const accepted = lanes.filter((lane) => lane.timing.stage === "accepted").sort((a, b) => b.timing.stageSeconds - a.timing.stageSeconds);
  return (
    <section className="fs-card fs-team" aria-label={department.name}>
      <header className="fs-team-head" style={{ "--hue": teamHue(department) } as CSSProperties}>
        <TeamIcon department={department} />
        <h2>{department.name}</h2>
        <div className="fs-team-counts">
          {waiting.length > 0 && <span className="fs-chip waiting">{waiting.length} waiting</span>}
          {accepted.length > 0 && <span className="fs-chip accepted">{accepted.length} being handled</span>}
        </div>
      </header>
      <ol className="fs-team-list">
        {[...waiting, ...accepted].map(({ alert, timing, call }) => (
          <li key={alert.id}>
            <button
              type="button"
              className={`fs-row ${timing.stage} ${timing.late ? "late" : ""} ${selectedId === call.command.id ? "selected" : ""}`}
              onClick={() => onSelect(call.command.id)}
            >
              <span className="fs-row-main">
                <strong>{alert.machine.name}</strong>
                <small>
                  {timing.stage === "waiting"
                    ? `${alert.issueType?.name ?? alert.commandLabel} · called ${timeOfDay(alert.createdAt)}`
                    : `${responder(alert) || "Responder"} · accepted ${timeOfDay(alert.acknowledgedAt ?? alert.arrivedAt)}`}
                </small>
              </span>
              <span className="fs-row-time">
                <strong>
                  {timing.late && <em className="fs-late">Late</em>}
                  {clock(timing.stage === "waiting" ? timing.waitSeconds : timing.stageSeconds)}
                </strong>
                <small>{timing.stage === "waiting" ? "waiting" : "on call"}</small>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------- Detail panel ---------- */

type Step = { label: string; state: "done" | "current" | "next"; time?: string; duration?: string };

function stepsFor(alert: Alert, timing: AlertTiming): Step[] {
  const at = (value?: string | null) => (value ? timeOfDay(value) : undefined);
  const accepted = timing.stage === "accepted";
  return [
    { label: "Called", state: "done", time: at(alert.createdAt) },
    { label: "Accepted", state: accepted ? "done" : "current", time: accepted ? at(alert.acknowledgedAt ?? alert.arrivedAt) : undefined, duration: clock(timing.waitSeconds) },
    { label: "Closed", state: accepted ? "current" : "next", time: accepted ? "when fixed" : undefined, duration: accepted ? clock(timing.stageSeconds) : undefined }
  ];
}

type Activity = { key: string; at: number; title: string; detail?: string; note?: string };

function activityFor(call: CallSummary): Activity[] {
  const items: Activity[] = [{
    key: "created",
    at: new Date(call.command.createdAt).getTime(),
    title: `Called from ${call.command.machine.name}`,
    detail: call.alerts.map(({ alert }) => alert.department.name).join(", ")
  }];
  for (const { alert, timing } of call.alerts) {
    const who = alert.responderNameText?.trim() || alert.department.name;
    const acceptedAt = alert.acknowledgedAt ?? alert.arrivedAt;
    if (acceptedAt) items.push({ key: `${alert.id}-a`, at: new Date(acceptedAt).getTime(), title: `${who} accepted`, detail: `${alert.department.name} · accepted in ${clock(timing.waitSeconds)}` });
    if (!acceptedAt && timing.late) items.push({ key: `${alert.id}-l`, at: new Date(alert.createdAt).getTime() + LATE_AFTER_SECONDS * 1000, title: `${alert.department.name} is late`, detail: `No response after ${LATE_AFTER_SECONDS / 60} minutes` });
    for (const event of alert.events ?? []) {
      if (event?.note) items.push({ key: `${alert.id}-${event.id}`, at: new Date(event.createdAt).getTime(), title: event.actorNameText || "Message", detail: alert.department.name, note: event.note });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

function CallPanel({ call, onClose }: { call: CallSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [targetId, setTargetId] = useState(call.alerts[0]?.alert.id ?? "");
  const activity = activityFor(call);

  useEffect(() => {
    if (!call.alerts.some(({ alert }) => alert.id === targetId)) setTargetId(call.alerts[0]?.alert.id ?? "");
  }, [call, targetId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = useMutation({
    mutationFn: (note: string) => postJson(`/api/alerts/${targetId}/notes`, { note, clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
    onSuccess: () => {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["floor"] });
    }
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const note = message.trim();
    if (note && targetId) send.mutate(note);
  }

  const target = call.alerts.find(({ alert }) => alert.id === targetId)?.alert;
  const tone: Tone = call.late ? "late" : call.stage;

  return (
    <>
      <button type="button" className="fs-backdrop" aria-label="Close details" onClick={onClose} />
      <aside className="fs-panel" role="dialog" aria-label={`${call.command.machine.name} call`}>
        <header className="fs-panel-head">
          <div className="fs-panel-title">
            <small>{[call.command.machine.group, call.command.commandLabel].filter(Boolean).join(" · ")}</small>
            <h2>{call.command.machine.name}</h2>
          </div>
          <button type="button" className="fs-close" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </header>

        <div className="fs-panel-summary">
          <div className="fs-panel-timer">
            <span>Open for</span>
            <strong className={`num ${call.late ? "fs-late-text" : ""}`}>{clock(call.totalSeconds)}</strong>
          </div>
          <span className={`su-status ${tone}`}><i aria-hidden="true" />{STAGE_TEXT[call.stage]}{call.late ? " · late" : ""}</span>
        </div>

        <div className="fs-panel-body">
          {call.alerts.map(({ alert, timing }) => (
            <section key={alert.id} className="fs-card fs-progress">
              <header className="fs-progress-head">
                <TeamIcon department={alert.department} />
                <strong>{alert.department.name}</strong>
                <span className="fs-progress-who">{alert.responderNameText?.trim() || (timing.stage === "waiting" ? "No responder yet" : "")}</span>
              </header>
              <ol className="fs-steps">
                {stepsFor(alert, timing).map((step) => (
                  <li key={step.label} className={`${step.state} ${step.state === "current" ? timing.stage : ""} ${step.state === "current" && timing.late ? "late" : ""}`}>
                    <i aria-hidden="true" />
                    <strong>{step.label}</strong>
                    <span>{step.time ?? (step.state === "current" ? STAGE_TEXT[timing.stage].toLowerCase() : "")}</span>
                    {step.duration && <em>{step.duration}</em>}
                  </li>
                ))}
              </ol>
            </section>
          ))}

          <section className="fs-card fs-activity">
            <h3 className="fs-card-head">Activity</h3>
            <ol>
              {activity.map((item) => (
                <li key={item.key}>
                  <time>{timeOfDay(item.at)}</time>
                  <div>
                    <strong>{item.title}</strong>
                    {item.detail && <small>{item.detail}</small>}
                    {item.note && <p>{item.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <form className="fs-compose" onSubmit={onSubmit}>
          {call.alerts.length > 1 && (
            <select aria-label="Send to" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {call.alerts.map(({ alert }) => <option key={alert.id} value={alert.id}>To {alert.department.name}</option>)}
            </select>
          )}
          <div className="fs-compose-row">
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Message ${target?.department.name ?? "responder"}`} />
            <button type="submit" disabled={!message.trim() || send.isPending} aria-label="Send"><SendIcon /></button>
          </div>
        </form>
      </aside>
    </>
  );
}
