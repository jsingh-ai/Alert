import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import type { Alert, CommandGroup } from "../lib/types";
import { LATE_AFTER_SECONDS, clock, mergeByCall, summarizeCall } from "../lib/callStages";
import type { AlertTiming, CallStage, CallSummary } from "../lib/callStages";
import { OfflineNotice, SuiteHeader, SuiteMenu, SuiteStatusBar, TeamIcon, connectionState } from "../components/Suite";
import type { Connection, Tone } from "../components/Suite";
import { CheckCircleIcon, ChevronRightIcon, CloseIcon, LayersIcon, PlusIcon, SettingsIcon } from "../components/icons";
import "../styles/station.css";

const MACHINE_KEY = "pg_operator_locked_machine_id";
const POLL_MS = 5000;
/** Only call the station offline after this long without fresh data (several missed polls), so one dropped request never flips the screen. */
const OFFLINE_AFTER_MS = 20_000;
const HOLD_MS = 1500;
const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type Department = { id: string; name: string; color?: string };
type Machine = { id: string; name: string; code: string; machineGroup?: { name?: string } | null };
type Template = { id: string; buttonLabel: string; targets: Array<{ departmentId: string; department: Department }> };
type IssueType = { id: string; name: string; departmentId: string };
type Bootstrap = { machines: Machine[]; departments: Department[]; issueTypes: IssueType[]; commandTemplates: Template[] };
type Snapshot = { data?: { commands?: CommandGroup[] } };

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function readMachineId() {
  try {
    return localStorage.getItem(MACHINE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveMachineId(id: string) {
  try {
    if (id) localStorage.setItem(MACHINE_KEY, id);
    else localStorage.removeItem(MACHINE_KEY);
  } catch {
    /* storage unavailable */
  }
}

function timeOfDay(value: string | number | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function snapshotPath(machineId: string) {
  return `/api/operator/snapshot?machineId=${encodeURIComponent(machineId)}`;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** "Call Maintenance" → "Maintenance": the section heading already says "Call". */
function plainLabel(label: string) {
  return label.replace(/^call\s+/i, "");
}

/** "Maintenance" for a one-team call, "Material Clear" for a multi-team one. */
function callTitle(call: CallSummary) {
  if (call.alerts.length === 1) return call.alerts[0].alert.department.name;
  // Manual calls carry each team's issue name as their label, so name the call itself instead.
  return call.command.commandTemplateId ? plainLabel(call.command.commandLabel) : "Other request";
}

function responder(alert: Alert) {
  return alert.responderNameText?.trim() || "";
}

/** Machine group is shown only when it adds something ("Press" adds nothing to "Press 12"). */
function groupLabel(machine: Machine) {
  const group = machine.machineGroup?.name?.trim();
  if (!group || machine.name.toLowerCase().startsWith(group.toLowerCase())) return "";
  return group;
}

function haptic() {
  try {
    navigator.vibrate?.(20);
  } catch {
    /* not supported */
  }
}

export function OperatorPage() {
  const queryClient = useQueryClient();
  const now = useNow();
  const [machineId, setMachineId] = useState(readMachineId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);

  const bootstrap = useQuery({ queryKey: ["operator-bootstrap"], queryFn: () => api<{ data?: Bootstrap }>("/api/operator/bootstrap") });
  const snapshot = useQuery({
    queryKey: ["operator-snapshot", machineId],
    queryFn: () => api<Snapshot>(snapshotPath(machineId), {}, { quiet: true }),
    enabled: Boolean(machineId),
    refetchInterval: POLL_MS,
    // Keep polling when the tab is hidden, and catch up the moment it is shown again,
    // so a station that was in the background never wakes up claiming to be offline.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always"
  });

  const data = bootstrap.data?.data;
  const machines = useMemo(() => [...(data?.machines ?? [])].sort((a, b) => naturalSort.compare(a.name, b.name)), [data?.machines]);
  const templates = data?.commandTemplates ?? [];
  const machine = machines.find((m) => m.id === machineId);

  // Forget a saved machine that no longer exists; auto-pick when there is only one.
  useEffect(() => {
    if (!data) return;
    if (machineId && !machines.some((m) => m.id === machineId)) {
      saveMachineId("");
      setMachineId("");
    } else if (!machineId && machines.length === 1) {
      saveMachineId(machines[0].id);
      setMachineId(machines[0].id);
    }
  }, [data, machineId, machines]);

  const calls = useMemo(() => {
    const commands = mergeByCall((snapshot.data?.data?.commands ?? []).filter((c) => c.machine?.id === machineId && c.alerts.length > 0));
    return commands
      .map((command) => summarizeCall(command, now))
      .sort((a, b) => new Date(a.command.createdAt).getTime() - new Date(b.command.createdAt).getTime());
  }, [snapshot.data, machineId, now]);

  const busyDepartments = new Set(calls.flatMap((call) => call.alerts.map(({ alert }) => alert.department.id)));

  // Offline is judged by how old the data is, not by a single failed request: one dropped
  // poll is retried and replaced 5s later. Never claim "Running normally" without fresh data.
  const lastGood = snapshot.dataUpdatedAt;
  const connection = connectionState(snapshot, now, OFFLINE_AFTER_MS);
  const canCall = connection === "live";

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["operator-snapshot"] }),
      queryClient.invalidateQueries({ queryKey: ["floor"] }),
      queryClient.invalidateQueries({ queryKey: ["active-alerts"] })
    ]);

  const createCall = useMutation({
    mutationFn: (payload: Record<string, unknown>) => postJson("/api/commands", { machineId, ...payload }),
    // Returned so the mutation stays pending until the new call is on screen: no idle gap
    // where a second tap could create a duplicate call.
    onSuccess: () => refresh()
  });

  function chooseMachine(id: string) {
    saveMachineId(id);
    setMachineId(id);
    setPickerOpen(false);
  }

  // Every screen keeps the app bar and its menu, so a kiosk (no sidebar) can always sign out
  if (bootstrap.isLoading || bootstrap.isError) {
    return (
      <div className="su-page ms-page">
        <SuiteHeader eyebrow="Machine Station" title={bootstrap.isError ? "Can't reach the server" : "Connecting…"} status={{ tone: "neutral", text: bootstrap.isError ? "Offline" : "Checking…" }}>
          <SuiteMenu signOutLabel="Sign out of this station" />
        </SuiteHeader>
        {bootstrap.isError && (
          <div className="ms-problem">
            <strong>This station can't reach the server.</strong>
            <span>Check the network connection, then try again.</span>
            <button type="button" className="ms-btn primary" onClick={() => bootstrap.refetch()}>Try again</button>
          </div>
        )}
      </div>
    );
  }

  if (!machine || pickerOpen) {
    return (
      <div className="su-page ms-page">
        <SuiteHeader eyebrow="Station setup" title="Which machine is this?">
          {machine && <button type="button" className="ms-btn ghost" onClick={() => setPickerOpen(false)}>Back</button>}
          <SuiteMenu signOutLabel="Sign out of this station" />
        </SuiteHeader>
        <MachinePicker machines={machines} currentId={machineId} onPick={chooseMachine} />
      </div>
    );
  }

  const available = templates.filter((template) => !template.targets.some((t) => busyDepartments.has(t.departmentId)));
  const sendingId = createCall.isPending ? (createCall.variables?.templateId as string | undefined) : undefined;
  const callTemplate = (template: Template) => {
    haptic();
    createCall.mutate({ templateId: template.id });
  };
  const group = groupLabel(machine);
  const openOther = () => {
    createCall.reset();
    setOtherOpen(true);
  };

  return (
    <div className="su-page ms-page">
      <SuiteHeader
        // Small spaced label over the name: the machine code maintenance looks for, plus its group when it adds something
        eyebrow={[group || "Machine", machine.code].filter(Boolean).join(" · ")}
        title={machine.name}
        status={machineStatus(calls, connection)}
      >
        <SuiteMenu
          signOutLabel="Sign out of this station"
          items={(close) => <HoldButton onHold={() => { close(); setPickerOpen(true); }} />}
        />
      </SuiteHeader>

      {connection === "offline" && <OfflineNotice lastGood={lastGood} />}

      {calls.length > 0 ? (
        <div className="ms-body">
          <section className={`ms-calls ${calls.length > 1 ? "multi" : ""}`} aria-label="Open calls">
            {calls.map((call) => <ActiveCall key={call.command.id} call={call} compact={calls.length > 1} machineId={machineId} stale={connection === "offline"} disabled={!canCall} onChange={refresh} />)}
          </section>
          <aside className="ms-rail" aria-label="Call another team">
            {createCall.isError && !otherOpen && <p className="ms-error" role="alert">{errorText(createCall.error, "The call didn't go through. Try again.")}</p>}
            <div className="ms-list">
              {/* The heading belongs to the card, not floating above it */}
              <h2 className="ms-list-head">Call another team</h2>
              {available.map((template) => (
                <CallRow key={template.id} template={template} sending={sendingId === template.id} disabled={!canCall || createCall.isPending} onCall={() => callTemplate(template)} />
              ))}
              <button type="button" className="ms-row ms-row-other" onClick={openOther} disabled={!canCall || createCall.isPending}>
                <span className="ms-glyph" aria-hidden="true"><PlusIcon /></span>
                <span className="ms-row-text"><strong>Other request</strong><small>Pick teams and a reason</small></span>
                <ChevronRightIcon className="ms-row-chevron" />
              </button>
            </div>
          </aside>
        </div>
      ) : (
        <CallForHelp
          templates={available}
          issueTypes={data?.issueTypes ?? []}
          sendingId={sendingId}
          disabled={!canCall || createCall.isPending}
          error={createCall.isError && !otherOpen ? errorText(createCall.error, "The call didn't go through. Try again.") : ""}
          onCall={callTemplate}
          onOther={openOther}
        />
      )}

      <SuiteStatusBar connection={connection} lastGood={lastGood} />

      {otherOpen && data && (
        <OtherRequest
          departments={data.departments}
          issueTypes={data.issueTypes}
          busy={busyDepartments}
          sending={createCall.isPending}
          error={createCall.isError ? errorText(createCall.error, "The call didn't go through. Try again.") : ""}
          onClose={() => {
            createCall.reset();
            setOtherOpen(false);
          }}
          // "Manual Help Call" is the label the API recognises to display the issue name instead
          onSend={(targets) => {
            haptic();
            createCall.mutate({ commandLabel: "Manual Help Call", targets }, { onSuccess: () => setOtherOpen(false) });
          }}
        />
      )}
    </div>
  );
}

/* ---------- Header status: the machine's overall state, one short line ---------- */

function machineStatus(calls: CallSummary[], connection: Connection): { tone: Tone; text: string } {
  if (connection !== "live" && !(connection === "offline" && calls.length)) return { tone: "neutral", text: connection === "offline" ? "Status unknown" : "Checking…" };
  if (calls.length === 0) return { tone: "clear", text: "Running normally" };
  const worst: Tone = calls.some((c) => c.stage === "waiting") ? "waiting" : calls.some((c) => c.stage === "onTheWay") ? "onTheWay" : "onSite";
  return { tone: connection === "offline" ? "neutral" : calls.some((c) => c.late) ? "late" : worst, text: `${calls.length} open call${calls.length === 1 ? "" : "s"}` };
}

/* ---------- Idle: call for help ---------- */

function CallForHelp({ templates, issueTypes, sendingId, disabled, error, onCall, onOther }: {
  templates: Template[];
  issueTypes: IssueType[];
  sendingId?: string;
  disabled: boolean;
  error: string;
  onCall: (template: Template) => void;
  onOther: () => void;
}) {
  const single = templates.filter((t) => t.targets.length === 1);
  const combined = templates.filter((t) => t.targets.length !== 1);
  // What each team handles, from its configured request reasons: "Breakdown · Jam · Tooling"
  const handles = (departmentId: string) => issueTypes.filter((issue) => issue.departmentId === departmentId).slice(0, 3).map((issue) => issue.name).join(" · ");

  return (
    <section className="ms-idle" aria-label="Call for help">
      {error && <p className="ms-error" role="alert">{error}</p>}

      <div className="ms-tiles">
        {single.map((template) => {
          const department = template.targets[0].department;
          const sending = sendingId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              className={`ms-tile ${sending ? "sending" : ""}`}
              disabled={disabled}
              aria-busy={sending}
              onClick={() => onCall(template)}
            >
              <span className="ms-tile-icon"><TeamIcon department={department} size="lg" /></span>
              <strong className="ms-tile-label">{plainLabel(template.buttonLabel)}</strong>
              {/* Always present, so "Sending…" swaps in without moving the label */}
              <span className="ms-tile-sub">{sending ? "Sending…" : handles(department.id) || "\u00a0"}</span>
              <i className="ms-sweep" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div className="ms-more">
        <div className="ms-list ms-list-grid">
          {combined.map((template) => (
            <CallRow key={template.id} template={template} sending={sendingId === template.id} disabled={disabled} onCall={() => onCall(template)} />
          ))}
          <button type="button" className="ms-row ms-row-other" onClick={onOther} disabled={disabled}>
            <span className="ms-glyph" aria-hidden="true"><PlusIcon /></span>
            <span className="ms-row-text"><strong>Other request</strong><small>Pick teams and a reason</small></span>
            <ChevronRightIcon className="ms-row-chevron" />
          </button>
        </div>
      </div>
    </section>
  );
}

/** A compact call button: one team shows its glyph, several teams show one "combined" glyph and the team names. */
function CallRow({ template, sending, disabled, onCall }: { template: Template; sending: boolean; disabled: boolean; onCall: () => void }) {
  const names = template.targets.map((t) => t.department.name);
  const multi = names.length > 1;
  return (
    <button type="button" className={`ms-row ${sending ? "sending" : ""}`} disabled={disabled} aria-busy={sending} onClick={onCall}>
      {multi ? (
        <span className="ms-glyph" aria-hidden="true"><LayersIcon /></span>
      ) : (
        <TeamIcon department={template.targets[0].department} />
      )}
      <span className="ms-row-text">
        <strong>{plainLabel(template.buttonLabel)}</strong>
        {(multi || sending) && <small>{sending ? "Sending…" : names.join(" + ")}</small>}
      </span>
      <ChevronRightIcon className="ms-row-chevron" />
      <i className="ms-sweep" aria-hidden="true" />
    </button>
  );
}

/** Press and hold to change the station's machine, so it can't happen by accident. */
function HoldButton({ onHold }: { onHold: () => void }) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<number | null>(null);
  const started = useRef(0);

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setProgress(0);
  };
  const start = () => {
    stop();
    started.current = Date.now();
    timer.current = window.setInterval(() => {
      const value = Math.min(1, (Date.now() - started.current) / HOLD_MS);
      setProgress(value);
      if (value >= 1) {
        stop();
        onHold();
      }
    }, 30);
  };
  useEffect(() => stop, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.key === "Enter" || event.key === " ") && !timer.current) {
      event.preventDefault();
      start();
    }
  };

  return (
    <button
      type="button"
      className="ms-hold"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
      onKeyUp={stop}
      style={{ "--hold": progress } as CSSProperties}
    >
      <SettingsIcon />
      {progress > 0 ? "Keep holding…" : "Hold to change machine"}
    </button>
  );
}

/* ---------- Active call ---------- */

type Pending = { kind: "close" | "cancel"; alertIds: string[]; label: string } | null;

/** A one-team call names the team in the headline, so it reads from across the room. */
function headline(call: CallSummary) {
  const team = call.alerts.length === 1 ? call.alerts[0].alert.department.name : "";
  if (call.stage === "waiting") {
    const blocking = call.alerts.filter(({ timing }) => timing.stage === "waiting").map(({ alert }) => alert.department.name);
    return `Waiting for ${team || listNames(blocking)}`;
  }
  if (call.stage === "onTheWay") return team ? `${team} is on the way` : "Help is on the way";
  return team ? `${team} is at the machine` : "Help is at the machine";
}

/** "Quality", "Quality and Supervisor", "Quality, Safety and Supervisor" */
function listNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "help";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Compact Called / Acknowledged / At machine / Closed dots for one team on a multi-team call; same steps as Track. */
function MiniTrack({ stage }: { stage: CallStage }) {
  const current = stage === "waiting" ? 1 : stage === "onTheWay" ? 2 : 3;
  return (
    <span className={`ms-mini ${stage}`} aria-hidden="true">
      {[0, 1, 2, 3].map((step) => (
        <i key={step} className={step < current ? "done" : step === current ? "current" : ""} />
      ))}
    </span>
  );
}

function timerLabel(stage: CallStage) {
  return stage === "waiting" ? "Wait time" : stage === "onTheWay" ? "Travel time" : "Time on site";
}

/** Seconds in the call's current stage: the longest wait, the longest trip, or time on site. */
function stageSeconds(call: CallSummary) {
  const inStage = call.alerts.filter(({ timing }) => timing.stage === call.stage);
  return Math.max(0, ...inStage.map(({ timing }) => timing.stageSeconds));
}

function teamStatus(alert: Alert, timing: AlertTiming) {
  if (timing.stage === "waiting") return "Waiting for a response";
  const who = responder(alert) || "Responder";
  return `${who} · ${timing.stage === "onTheWay" ? "on the way" : "at the machine"} ${clock(timing.stageSeconds)}`;
}

/** Grey traceability line: "Acknowledged 11:43 (1:10) · arrived 11:45 (1:40)". The called time is in the card header. */
function teamTimes(alert: Alert, timing: AlertTiming) {
  const parts: string[] = [];
  if (alert.acknowledgedAt) parts.push(`Acknowledged ${timeOfDay(alert.acknowledgedAt)} (${clock(timing.waitSeconds)})`);
  if (alert.arrivedAt) parts.push(`${parts.length ? "arrived" : "Arrived"} ${timeOfDay(alert.arrivedAt)} (${clock(timing.travelSeconds)})`);
  return parts.join(" · ");
}

/** One line of progress for a compact row: "Called 11:34 AM · no response yet", "Marcus Lee · on the way since 11:36 AM". */
function progressLine(alert: Alert, timing: AlertTiming) {
  const who = responder(alert) || "Responder";
  if (timing.stage === "waiting") return `Called ${timeOfDay(alert.createdAt)} · no response yet`;
  if (timing.stage === "onTheWay") return `${who} · on the way since ${timeOfDay(alert.acknowledgedAt ?? alert.createdAt)}`;
  return `${who} · at the machine since ${timeOfDay(alert.arrivedAt)}`;
}

/** Called → Acknowledged → At machine → Closed, for a one-team call. */
function Track({ alert, timing }: { alert: Alert; timing: AlertTiming }) {
  const who = responder(alert);
  const steps: Array<{ label: string; detail: string; state: "done" | "current" | "todo" }> = [
    { label: "Called", detail: timeOfDay(alert.createdAt), state: "done" },
    {
      label: "Acknowledged",
      detail: timing.stage === "waiting" ? "No response yet" : [timeOfDay(alert.acknowledgedAt ?? alert.createdAt), who].filter(Boolean).join(" · "),
      state: timing.stage === "waiting" ? "current" : "done"
    },
    {
      label: "At the machine",
      detail: timing.stage === "onSite" ? timeOfDay(alert.arrivedAt) || "Arrived" : timing.stage === "onTheWay" ? "On the way" : "",
      state: timing.stage === "onSite" ? "done" : timing.stage === "onTheWay" ? "current" : "todo"
    },
    { label: "Closed", detail: timing.stage === "onSite" ? "When it's fixed" : "", state: timing.stage === "onSite" ? "current" : "todo" }
  ];
  return (
    <ol className={`ms-track ${timing.stage}`} aria-label="Call progress">
      {steps.map((step) => (
        <li key={step.label} className={step.state} aria-current={step.state === "current" ? "step" : undefined}>
          <span className="ms-track-dot" aria-hidden="true">{step.state === "done" && <CheckIcon />}</span>
          <span className="ms-track-label">{step.label}</span>
          <span className="ms-track-detail">{step.detail || " "}</span>
        </li>
      ))}
    </ol>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

function ActiveCall({ call, compact, machineId, stale, disabled, onChange }: { call: CallSummary; compact: boolean; machineId: string; stale: boolean; disabled: boolean; onChange: () => void }) {
  const [pending, setPending] = useState<Pending>(null);

  const act = useMutation({
    mutationFn: async ({ kind, alertIds }: { kind: "close" | "cancel"; alertIds: string[] }) => {
      if (kind === "cancel") {
        // The screen can be a few seconds behind: never cancel a team that has just responded.
        const fresh = await api<Snapshot>(snapshotPath(machineId));
        const freshAlerts = mergeByCall(fresh.data?.commands ?? []).flatMap((c) => c.alerts);
        const current = alertIds.map((id) => freshAlerts.find((a) => a.id === id));
        if (current.some((alert) => !alert)) throw new Error("This call was already closed.");
        if (current.some((alert) => alert?.status !== "OPEN")) throw new Error("Someone just responded, so this can't be cancelled now.");
      }
      const results = await Promise.allSettled(alertIds.map((id) => postJson(`/api/alerts/${id}/${kind === "close" ? "resolve" : "cancel"}`, {})));
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed) throw new Error(failed === alertIds.length ? "That didn't go through. Try again." : "Part of that didn't go through. Check the teams below.");
    },
    onSettled: () => {
      setPending(null);
      onChange();
    }
  });

  const answered = call.alerts.filter(({ alert, timing }) => timing.stage !== "waiting" && alert.status !== "RESOLVED");
  const unanswered = call.alerts.filter(({ alert }) => alert.status === "OPEN");
  const allAnswered = unanswered.length === 0;
  const noneAnswered = answered.length === 0;
  const multi = call.alerts.length > 1;
  const single = multi ? null : call.alerts[0];
  const names = call.alerts.map(({ alert }) => alert.department.name).join(" + ");

  // The call's one action (shared by the full card and the compact row)
  const action = allAnswered ? (
    <button type="button" className="ms-btn primary big" disabled={disabled} onClick={() => setPending({ kind: "close", alertIds: answered.map(({ alert }) => alert.id), label: multi ? "Is the issue fixed? This closes the call for every team." : "Is the issue fixed?" })}>
      <CheckCircleIcon /> Issue fixed, close call
    </button>
  ) : noneAnswered ? (
    <button type="button" className="ms-btn cancel" disabled={disabled} onClick={() => setPending({ kind: "cancel", alertIds: unanswered.map(({ alert }) => alert.id), label: "Cancel this call? Use this if it was pressed by mistake." })}>
      <CloseIcon /> Cancel call
    </button>
  ) : null;

  const confirm = pending && (
    <div className="ms-confirm" role="alertdialog" aria-label={pending.label}>
      <strong>{pending.label}</strong>
      <div>
        <button type="button" className="ms-btn ghost" autoFocus onClick={() => setPending(null)} disabled={act.isPending}>Back</button>
        <button type="button" className={`ms-btn ${pending.kind === "close" ? "primary" : "danger"}`} onClick={() => act.mutate(pending)} disabled={act.isPending || disabled}>
          {act.isPending ? "Working…" : pending.kind === "close" ? "Yes, close it" : "Yes, cancel"}
        </button>
      </div>
    </div>
  );

  const error = act.isError && <p className="ms-error" role="alert">{errorText(act.error, "That didn't go through. Try again.")}</p>;
  const stateClass = `${call.stage} ${call.late ? "late" : ""} ${stale ? "stale" : ""}`;

  // Several calls open: each one-team call is a compact row (headline + progress | timer | action),
  // so every open call is visible at once without scrolling.
  if (compact && single) {
    return (
      <article className={`ms-call ms-call-row ${stateClass}`}>
        <div className="ms-row-main">
          <h2>
            {headline(call)}
            {call.late && <em className="ms-late">Late</em>}
          </h2>
          <p className="ms-row-progress">
            <MiniTrack stage={single.timing.stage} />
            <span>{progressLine(single.alert, single.timing)}</span>
          </p>
        </div>
        <div className="ms-row-timer">
          <span>{timerLabel(call.stage)}</span>
          <strong>{clock(stageSeconds(call))}</strong>
          <small>{call.stage === "waiting" ? `Target ${clock(LATE_AFTER_SECONDS)}` : `Open for ${clock(call.totalSeconds)}`}</small>
        </div>
        <div className="ms-row-actions">{confirm || action}</div>
        {error}
      </article>
    );
  }

  return (
    <article className={`ms-call ${stateClass} ${compact ? "compact" : ""}`}>
      <header className="ms-call-head">
        <div className="ms-call-main">
          {multi && (
            <span className="ms-call-kicker">
              <span className="ms-glyph sm" aria-hidden="true"><LayersIcon /></span>
              {callTitle(call)}
              <span className="ms-call-kicker-sub">{names}</span>
            </span>
          )}
          <h2>
            {headline(call)}
            {call.late && <em className="ms-late">Late</em>}
          </h2>
          {/* One-team calls show the called time in the progress track instead */}
          {multi && <small>Called {timeOfDay(call.command.createdAt)}</small>}
        </div>
      </header>

      {/* The timer is the hero: the one number people read from across the floor */}
      <div className="ms-call-mid">
        <div className="ms-timer-row">
          <div className="ms-timer">
            <span>{timerLabel(call.stage)}</span>
            <strong>{clock(stageSeconds(call))}</strong>
          </div>
          {/* Target vs actual, as on any MES board: the response target while waiting, then total open time */}
          <div className="ms-target">
            <span>{call.stage === "waiting" ? "Response target" : "Open for"}</span>
            <strong>{clock(call.stage === "waiting" ? LATE_AFTER_SECONDS : call.totalSeconds)}</strong>
          </div>
        </div>
      {single ? (
        <Track alert={single.alert} timing={single.timing} />
      ) : (
        <ul className="ms-teams">
          {call.alerts.map(({ alert, timing }) => (
            <li key={alert.id} className={`ms-team ${timing.stage}`}>
              <TeamIcon department={alert.department} />
              <div className="ms-team-main">
                <strong>{alert.department.name}</strong>
                <span className="ms-team-status"><i className={`ms-dot ${timing.stage}`} aria-hidden="true" />{teamStatus(alert, timing)}</span>
                {teamTimes(alert, timing) && <span className="ms-team-times">{teamTimes(alert, timing)}</span>}
              </div>
              <div className="ms-team-side">
                <MiniTrack stage={timing.stage} />
                {!pending && (timing.stage === "waiting" ? (
                  <button type="button" className="ms-btn cancel" disabled={disabled} onClick={() => setPending({ kind: "cancel", alertIds: [alert.id], label: `Cancel the ${alert.department.name} call?` })}>Cancel</button>
                ) : (
                  <button type="button" className="ms-btn secondary" disabled={disabled} onClick={() => setPending({ kind: "close", alertIds: [alert.id], label: `Close ${alert.department.name}? Only if their part is fixed.` })}>Close</button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      </div>

      {confirm || (action && (
        <footer className="ms-call-foot">
          <div className="ms-call-actions">{action}</div>
        </footer>
      ))}

      {error}
    </article>
  );
}

/* ---------- Other request ---------- */

function OtherRequest({ departments, issueTypes, busy, sending, error, onClose, onSend }: {
  departments: Department[];
  issueTypes: IssueType[];
  busy: Set<string>;
  sending: boolean;
  error: string;
  onClose: () => void;
  onSend: (targets: Array<{ departmentId: string; issueTypeId: string }>) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const rows = departments
    .map((department) => ({ department, reasons: issueTypes.filter((issue) => issue.departmentId === department.id) }))
    .filter((row) => row.reasons.length > 0);
  // A team that became busy after it was picked is dropped from the request.
  const targets = Object.entries(picked).filter(([departmentId, issue]) => issue && !busy.has(departmentId)).map(([departmentId, issueTypeId]) => ({ departmentId, issueTypeId }));

  // Once, on open: the page re-renders every second, and re-running this would pull focus back to Close.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="ms-sheet-wrap">
      <div className="ms-sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <section className="ms-sheet" role="dialog" aria-modal="true" aria-labelledby="ms-other-title">
        <header>
          <div>
            <h2 id="ms-other-title">Other request</h2>
            <small>Pick a reason for each team you need.</small>
          </div>
          <button ref={closeRef} type="button" className="ms-icon-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </header>
        <div className="ms-sheet-body">
          {rows.map(({ department, reasons }) => {
            const isBusy = busy.has(department.id);
            return (
              <div key={department.id} className={`ms-sheet-row ${isBusy ? "busy" : ""}`}>
                <div className="ms-sheet-dept">
                  <TeamIcon department={department} />
                  <strong>{department.name}</strong>
                  {isBusy && <small>Already called</small>}
                </div>
                <div className="ms-sheet-reasons">
                  {reasons.map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      className={`ms-chip ${picked[department.id] === issue.id ? "on" : ""}`}
                      disabled={isBusy}
                      aria-pressed={picked[department.id] === issue.id}
                      onClick={() => setPicked((current) => ({ ...current, [department.id]: current[department.id] === issue.id ? "" : issue.id }))}
                    >
                      {issue.name}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {rows.length === 0 && <p className="ms-muted">No request reasons are set up yet.</p>}
        </div>
        <footer>
          {error && <p className="ms-error" role="alert">{error}</p>}
          <button type="button" className="ms-btn ghost" onClick={onClose}>Back</button>
          <button type="button" className="ms-btn primary" disabled={!targets.length || sending} onClick={() => onSend(targets)}>
            {sending ? "Sending…" : targets.length ? `Call ${targets.length} team${targets.length === 1 ? "" : "s"}` : "Pick at least one team"}
          </button>
        </footer>
      </section>
    </div>
  );
}

/* ---------- Machine picker (station setup) ---------- */

function MachinePicker({ machines, currentId, onPick }: { machines: Machine[]; currentId: string; onPick: (id: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, Machine[]>();
    for (const m of machines) map.set(m.machineGroup?.name ?? "Machines", [...(map.get(m.machineGroup?.name ?? "Machines") ?? []), m]);
    return Array.from(map).sort(([a], [b]) => naturalSort.compare(a, b));
  }, [machines]);

  if (machines.length === 0) return <div className="ms-problem"><strong>No machines are set up for your account.</strong><span>Ask an administrator to add this station's machine.</span></div>;

  // One card per machine group, its name in the card header; the station remembers the choice
  return (
    <div className="ms-picker">
      {groups.map(([name, list]) => (
        <section key={name} className="ms-list ms-picker-group">
          <h2 className="ms-list-head">{name}</h2>
          <div className="ms-picker-grid">
            {list.map((m) => (
              <button key={m.id} type="button" className={`ms-picker-tile ${m.id === currentId ? "current" : ""}`} onClick={() => onPick(m.id)}>
                <strong>{m.name}</strong>
                <small>{m.id === currentId ? "This station" : m.code}</small>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
