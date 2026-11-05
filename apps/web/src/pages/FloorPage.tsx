import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Alert, CommandGroup } from "../lib/types";
import { LATE_AFTER_SECONDS, clock, sortCalls, summarizeCall } from "../lib/callStages";
import type { AlertTiming, CallStage, CallSummary } from "../lib/callStages";
import { DepartmentIcon } from "../components/DepartmentBadge";
import { CheckCircleIcon, CloseIcon, SendIcon } from "../components/icons";
import "../styles/floor.css";

const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type FloorMachine = { id: string; name: string; code: string; machineGroup?: { id?: string; name?: string } | null };
type MachineStats = Record<string, { alertsToday?: number }>;

const STAGE_TEXT: Record<CallStage, string> = { waiting: "Waiting", onTheWay: "On the way", onSite: "At machine" };

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function timeOfDay(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function StatusDot({ stage }: { stage: CallStage }) {
  return <i className={`fs-dot-status ${stage}`} aria-hidden="true" />;
}

export function FloorPage() {
  const { session } = useAuth();
  const now = useNow();
  const [group, setGroup] = useState("all");
  const [departmentId, setDepartmentId] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const floor = useQuery({ queryKey: ["floor"], queryFn: () => api<any>("/api/floor/active"), refetchInterval: 7000 });
  const commands = (floor.data?.data?.commands ?? []) as CommandGroup[];
  const machines = (floor.data?.data?.machines ?? []) as FloorMachine[];
  const machineStats = (floor.data?.data?.machineStats ?? {}) as MachineStats;
  const departments = (session?.departments ?? []) as Array<{ id: string; name: string; color?: string }>;

  const groups = useMemo(
    () => Array.from(new Set(machines.map((m) => m.machineGroup?.name).filter((n): n is string => Boolean(n)))).sort(naturalSort.compare),
    [machines]
  );
  const visibleMachines = useMemo(() => machines.filter((m) => group === "all" || m.machineGroup?.name === group), [machines, group]);

  const calls = useMemo(() => {
    const ids = new Set(visibleMachines.map((m) => m.id));
    const scoped = commands
      .filter((command) => ids.has(command.machine.id))
      .map((command) => (departmentId === "all" ? command : { ...command, alerts: command.alerts.filter((a) => a.department.id === departmentId) }))
      .filter((command) => command.alerts.length > 0);
    return sortCalls(scoped.map((command) => summarizeCall(command, now)));
  }, [commands, visibleMachines, departmentId, now]);

  // The one split that matters on this page: is anyone still waiting for a response?
  const waitingCalls = calls.filter((call) => call.stage === "waiting");
  const handledCalls = calls.filter((call) => call.stage !== "waiting");

  const callsByMachine = useMemo(() => {
    const map = new Map<string, CallSummary[]>();
    for (const call of calls) map.set(call.command.machine.id, [...(map.get(call.command.machine.id) ?? []), call]);
    return map;
  }, [calls]);

  const lanes = calls.flatMap((call) => call.alerts.map((lane) => ({ ...lane, call })));
  const waitingLanes = lanes.filter((lane) => lane.timing.stage === "waiting");
  const lateCount = waitingLanes.filter((lane) => lane.timing.late).length;
  const onTheWay = lanes.filter((lane) => lane.timing.stage === "onTheWay").length;
  const atMachine = lanes.filter((lane) => lane.timing.stage === "onSite").length;
  const longest = waitingLanes.reduce<(typeof waitingLanes)[number] | null>((best, lane) => (!best || lane.timing.waitSeconds > best.timing.waitSeconds ? lane : best), null);
  const waitingMachines = new Set(waitingCalls.map((call) => call.command.machine.id)).size;
  const callsToday = visibleMachines.reduce((sum, m) => sum + (machineStats[m.id]?.alertsToday ?? 0), 0);

  const selected = calls.find((call) => call.command.id === selectedId);
  useEffect(() => {
    if (selectedId && !selected && !floor.isFetching) setSelectedId(null);
  }, [selectedId, selected, floor.isFetching]);

  const gridGroups = useMemo(() => {
    const map = new Map<string, FloorMachine[]>();
    for (const machine of visibleMachines) {
      const name = machine.machineGroup?.name ?? "Machines";
      map.set(name, [...(map.get(name) ?? []), machine]);
    }
    return Array.from(map, ([name, list]) => ({ name, machines: [...list].sort((a, b) => naturalSort.compare(a.name, b.name)) })).sort((a, b) => naturalSort.compare(a.name, b.name));
  }, [visibleMachines]);

  const headline = floor.isLoading
    ? "Loading the floor…"
    : waitingMachines > 0
      ? `${plural(waitingMachines, "machine")} waiting for help`
      : handledCalls.length > 0
        ? "Nobody is waiting"
        : "All machines running clear";
  const subline = longest
    ? <>Longest wait <strong className={longest.timing.late ? "late" : ""}>{clock(longest.timing.waitSeconds)}</strong> at {longest.call.command.machine.name} for {longest.alert.department.name}{lateCount > 0 && <> · <span className="late">{lateCount} late</span></>}</>
    : handledCalls.length > 0
      ? `${plural(handledCalls.length, "call")} being handled right now`
      : "No open calls on the floor.";

  return (
    <div className="fs-page">
      <header className="fs-head">
        <div className="fs-title">
          <h1>Floor Status</h1>
          <span className={`fs-live ${floor.isError ? "offline" : ""}`}><i />{floor.isError ? "Reconnecting" : "Live"}</span>
        </div>
        <div className="fs-filters">
          {groups.length > 1 && (
            <div className="fs-seg" role="tablist" aria-label="Machine group">
              {["all", ...groups].map((name) => (
                <button key={name} type="button" role="tab" aria-selected={group === name} className={group === name ? "on" : ""} onClick={() => setGroup(name)}>
                  {name === "all" ? "All" : name}
                </button>
              ))}
            </div>
          )}
          {departments.length > 1 && (
            <select className="fs-select" aria-label="Department" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="all">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>
      </header>

      {/* 1 · Summary: one sentence, then the three counts that matter */}
      <section className={`fs-summary ${waitingMachines > 0 ? "has-waiting" : ""}`} aria-live="polite">
        <div className="fs-summary-text">
          <h2>{headline}</h2>
          <p>{subline}</p>
        </div>
        <dl className="fs-summary-counts">
          <div><dt><StatusDot stage="waiting" />Waiting</dt><dd>{waitingLanes.length}</dd></div>
          <div><dt><StatusDot stage="onTheWay" />On the way</dt><dd>{onTheWay}</dd></div>
          <div><dt><StatusDot stage="onSite" />At machine</dt><dd>{atMachine}</dd></div>
        </dl>
      </section>

      {/* 2 · Calls grouped by state */}
      <div className="fs-board">
        <CallColumn
          title="Waiting for response"
          stage="waiting"
          calls={waitingCalls}
          selectedId={selectedId}
          onSelect={setSelectedId}
          empty="Nobody is waiting for help."
        />
        <CallColumn
          title="Being handled"
          stage="onTheWay"
          calls={handledCalls}
          selectedId={selectedId}
          onSelect={setSelectedId}
          empty="No responders out right now."
        />
      </div>

      {/* 3 · Machines overview */}
      <section className="fs-machines">
        <header className="fs-section-head">
          <h2>Machines</h2>
          <span>{plural(callsByMachine.size, "machine")} with calls · {plural(callsToday, "call")} today</span>
        </header>
        <div className="fs-groups">
          {gridGroups.map((g) => (
            <div key={g.name} className="fs-group">
              <h3>{g.name}</h3>
              <div className="fs-tiles">
                {g.machines.map((machine) => {
                  const machineCalls = callsByMachine.get(machine.id) ?? [];
                  if (machineCalls.length === 0) {
                    return (
                      <div key={machine.id} className="fs-tile">
                        <strong>{machine.name}</strong>
                        <small>Running</small>
                      </div>
                    );
                  }
                  const worst = machineCalls[0];
                  return (
                    <button key={machine.id} type="button" className={`fs-tile active stage-${worst.stage} ${worst.late ? "late" : ""} ${selectedId === worst.command.id ? "selected" : ""}`} onClick={() => setSelectedId(worst.command.id)}>
                      <strong>{machine.name}</strong>
                      <small><StatusDot stage={worst.stage} />{STAGE_TEXT[worst.stage]} · {clock(worst.totalSeconds)}</small>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {!floor.isLoading && visibleMachines.length === 0 && <p className="fs-muted">No machines in this view.</p>}
        </div>
      </section>

      {selected && <CallPanel call={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function CallColumn({ title, stage, calls, selectedId, onSelect, empty }: {
  title: string;
  stage: CallStage;
  calls: CallSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: string;
}) {
  return (
    <section className={`fs-column ${stage}`} aria-label={title}>
      <header className="fs-section-head">
        <h2><StatusDot stage={stage} />{title}</h2>
        <span className="fs-count">{calls.length}</span>
      </header>
      {calls.length === 0 ? (
        <div className="fs-column-empty"><CheckCircleIcon />{empty}</div>
      ) : (
        <ol className="fs-cards">
          {calls.map((call) => (
            <li key={call.command.id}>
              <CallCard call={call} selected={selectedId === call.command.id} onSelect={() => onSelect(call.command.id)} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CallCard({ call, selected, onSelect }: { call: CallSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`fs-call ${call.late ? "late" : ""} ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className="fs-call-top">
        <span className="fs-call-title">
          <strong>{call.command.machine.name}</strong>
          <small>{call.command.commandLabel}</small>
        </span>
        <span className="fs-call-clock">
          {call.late && <em className="fs-late-tag">Late</em>}
          <strong className="num">{clock(call.totalSeconds)}</strong>
        </span>
      </span>
      <span className="fs-call-teams">
        {call.alerts.map(({ alert, timing }) => (
          <span key={alert.id} className={`fs-call-team ${timing.stage}`}>
            <DepartmentIcon department={alert.department} size="sm" variant="plain" />
            <span className="fs-call-team-name">{alert.department.name}</span>
            <span className="fs-call-team-state">
              <StatusDot stage={timing.stage} />
              {timing.stage === "waiting" ? "Waiting" : `${alert.responderNameText?.trim() || "Responder"} · ${STAGE_TEXT[timing.stage].toLowerCase()}`}
            </span>
            {/* a waiting team's timer equals the card's, so only handled teams show their own */}
            <span className="fs-call-team-time num">{timing.stage === "waiting" ? "" : clock(timing.stageSeconds)}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

/* ---------- Detail panel ---------- */

type Step = { label: string; state: "done" | "current" | "next"; time?: string; duration?: string };

function stepsFor(alert: Alert, timing: AlertTiming): Step[] {
  const at = (value?: string | null) => (value ? timeOfDay(new Date(value).getTime()) : undefined);
  const ack = timing.stage !== "waiting";
  const arrived = timing.stage === "onSite";
  return [
    { label: "Called", state: "done", time: at(alert.createdAt) },
    { label: "Acknowledged", state: ack ? "done" : "current", time: ack ? at(alert.acknowledgedAt) : undefined, duration: clock(timing.waitSeconds) },
    { label: "Arrived", state: arrived ? "done" : ack ? "current" : "next", time: arrived ? at(alert.arrivedAt) : undefined, duration: ack ? clock(timing.travelSeconds) : undefined },
    { label: "Closed", state: arrived ? "current" : "next", duration: arrived ? clock(timing.fixSeconds) : undefined }
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
    if (alert.acknowledgedAt) items.push({ key: `${alert.id}-a`, at: new Date(alert.acknowledgedAt).getTime(), title: `${who} acknowledged`, detail: `${alert.department.name} · responded in ${clock(timing.waitSeconds)}` });
    if (alert.arrivedAt) items.push({ key: `${alert.id}-r`, at: new Date(alert.arrivedAt).getTime(), title: `${who} arrived`, detail: `${alert.department.name} · ${clock(timing.travelSeconds)} travel` });
    if (!alert.acknowledgedAt && timing.late) items.push({ key: `${alert.id}-l`, at: new Date(alert.createdAt).getTime() + LATE_AFTER_SECONDS * 1000, title: `${alert.department.name} is late`, detail: `No response after ${LATE_AFTER_SECONDS / 60} minutes` });
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

  return (
    <>
      <button type="button" className="fs-backdrop" aria-label="Close details" onClick={onClose} />
      <aside className="fs-panel" role="dialog" aria-label={`${call.command.machine.name} call`}>
        <header className="fs-panel-head">
          <div>
            <small>{[call.command.machine.group, call.command.commandLabel].filter(Boolean).join(" · ")}</small>
            <h2>{call.command.machine.name}</h2>
          </div>
          <button type="button" className="fs-close" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </header>

        <div className="fs-panel-summary">
          <div><span>Open for</span><strong className={call.late ? "late" : ""}>{clock(call.totalSeconds)}</strong></div>
          <div><span>Teams</span><strong>{call.alerts.length}</strong></div>
          <div><span>Status</span><strong className="fs-panel-status"><StatusDot stage={call.stage} />{STAGE_TEXT[call.stage]}</strong></div>
        </div>

        <div className="fs-panel-body">
          {call.alerts.map(({ alert, timing }) => (
            <section key={alert.id} className="fs-progress">
              <header>
                <DepartmentIcon department={alert.department} size="sm" variant="plain" />
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

          <section className="fs-activity">
            <h3>Activity</h3>
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
