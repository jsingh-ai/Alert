import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import type { Alert, CommandGroup } from "../lib/types";
import { clock, mergeByCall, summarizeCall } from "../lib/callStages";
import type { AlertTiming, CallStage, CallSummary } from "../lib/callStages";
import { DepartmentIcon } from "../components/DepartmentBadge";
import { CheckCircleIcon, CloseIcon, MoonIcon, SettingsIcon, SignOutIcon, SunIcon } from "../components/icons";
import "../styles/station.css";

const MACHINE_KEY = "pg_operator_locked_machine_id";
const STALE_AFTER_MS = 15_000;
const HOLD_MS = 1500;
const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** One-tap updates that make sense for each stage of a call. */
const QUICK_MESSAGES: Record<CallStage, string[]> = {
  waiting: ["Still waiting", "Machine stopped", "Urgent, please hurry"],
  onTheWay: ["Machine stopped", "Urgent, please hurry"],
  onSite: []
};

type Department = { id: string; name: string; color?: string };
type Machine = { id: string; name: string; code: string; machineGroup?: { name?: string } | null };
type Template = { id: string; buttonLabel: string; targets: Array<{ departmentId: string; department: Department }> };
type IssueType = { id: string; name: string; departmentId: string };
type Bootstrap = { machines: Machine[]; departments: Department[]; issueTypes: IssueType[]; commandTemplates: Template[] };
type Snapshot = { data?: { commands?: CommandGroup[] } };
type BandState = CallStage | "clear" | "late" | "connecting" | "offline";

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

/** "Maintenance" for a one-team call, "Material Clear" for a multi-team one; never "Call …". */
function callTitle(call: CallSummary) {
  if (call.alerts.length === 1) return call.alerts[0].alert.department.name;
  return call.command.commandLabel.replace(/^call\s+/i, "");
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
    refetchInterval: 5000
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

  // Never claim "Running normally" without fresh data.
  const connecting = snapshot.isLoading;
  const offline = !connecting && (snapshot.isError || (snapshot.dataUpdatedAt > 0 && now - snapshot.dataUpdatedAt > STALE_AFTER_MS));
  const overall: CallStage | "clear" = calls.length === 0 ? "clear" : calls.some((c) => c.stage === "waiting") ? "waiting" : calls.some((c) => c.stage === "onTheWay") ? "onTheWay" : "onSite";
  const band: BandState = connecting ? "connecting" : offline ? "offline" : calls.some((c) => c.late) ? "late" : overall;
  const canCall = !connecting && !offline;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["operator-snapshot"] });
    queryClient.invalidateQueries({ queryKey: ["floor"] });
    queryClient.invalidateQueries({ queryKey: ["active-alerts"] });
  };

  const createCall = useMutation({
    mutationFn: (payload: Record<string, unknown>) => postJson("/api/commands", { machineId, ...payload }),
    onSuccess: refresh
  });

  function chooseMachine(id: string) {
    saveMachineId(id);
    setMachineId(id);
    setPickerOpen(false);
  }

  if (bootstrap.isLoading) return <div className="ms-page"><div className="ms-loading">Connecting to the station…</div></div>;

  if (bootstrap.isError) {
    return (
      <div className="ms-page">
        <div className="ms-problem">
          <h1>Can't reach the server</h1>
          <p>Check the network connection on this station.</p>
          <button type="button" className="ms-btn primary" onClick={() => bootstrap.refetch()}>Try again</button>
        </div>
      </div>
    );
  }

  if (!machine || pickerOpen) {
    return (
      <div className="ms-page">
        <MachinePicker machines={machines} currentId={machineId} onPick={chooseMachine} onCancel={machine ? () => setPickerOpen(false) : undefined} />
      </div>
    );
  }

  const available = templates.filter((template) => !template.targets.some((t) => busyDepartments.has(t.departmentId)));
  const oldest = calls[0];

  return (
    <div className="ms-page">
      <header className="ms-head">
        <div className="ms-machine">
          <small>{machine.machineGroup?.name ?? "Machine"} · {machine.code}</small>
          <h1>{machine.name}</h1>
        </div>
        <StationMenu onChangeMachine={() => setPickerOpen(true)} />
      </header>

      <StatusBand state={band} oldest={oldest} callCount={calls.length} lastUpdate={snapshot.dataUpdatedAt} />

      <div className={`ms-body ${calls.length ? "with-calls" : ""}`}>
        {calls.length > 0 && (
          <section className="ms-calls" aria-label="Open calls">
            {calls.map((call) => <ActiveCall key={call.command.id} call={call} machineId={machineId} disabled={!canCall} onChange={refresh} />)}
          </section>
        )}

        <section className="ms-request" aria-label="Call for help">
          <h2>{calls.length ? "Call another team" : "Call for help"}</h2>
          {createCall.isError && <p className="ms-error" role="alert">{errorText(createCall.error, "The call didn't go through. Try again.")}</p>}
          <div className="ms-buttons">
            {available.map((template) => {
              const sending = createCall.isPending && createCall.variables?.templateId === template.id;
              const names = template.targets.map((t) => t.department.name);
              const detail = sending
                ? "Sending…"
                : names.length > 1 || !names.every((n) => template.buttonLabel.toLowerCase().includes(n.toLowerCase()))
                  ? names.join(" + ")
                  : "";
              return (
                <button
                  key={template.id}
                  type="button"
                  className="ms-call-button"
                  disabled={!canCall || createCall.isPending}
                  onClick={() => createCall.mutate({ templateId: template.id })}
                >
                  <span className="ms-call-icons">
                    {template.targets.map((t) => <DepartmentIcon key={t.departmentId} department={t.department} size="lg" />)}
                  </span>
                  <span className="ms-call-text">
                    <strong>{template.buttonLabel}</strong>
                    {detail && <small>{detail}</small>}
                  </span>
                </button>
              );
            })}
            <button type="button" className="ms-call-button ms-other" onClick={() => setOtherOpen(true)} disabled={!canCall || createCall.isPending}>
              <span className="ms-call-icons"><span className="ms-other-icon" aria-hidden="true">+</span></span>
              <span className="ms-call-text">
                <strong>Other request</strong>
                <small>Pick teams and a reason</small>
              </span>
            </button>
          </div>
        </section>
      </div>

      {otherOpen && data && (
        <OtherRequest
          departments={data.departments}
          issueTypes={data.issueTypes}
          busy={busyDepartments}
          sending={createCall.isPending}
          onClose={() => setOtherOpen(false)}
          // "Manual Help Call" is the label the API recognises to display the issue name instead
          onSend={(targets) => createCall.mutate({ commandLabel: "Manual Help Call", targets }, { onSuccess: () => setOtherOpen(false) })}
        />
      )}
    </div>
  );
}

/* ---------- Status band: the one thing readable from across the room ---------- */

function StatusBand({ state, oldest, callCount, lastUpdate }: { state: BandState; oldest?: CallSummary; callCount: number; lastUpdate: number }) {
  const label: Record<BandState, string> = {
    connecting: "Connecting…",
    offline: "Offline",
    clear: "Running normally",
    waiting: "Waiting for help",
    late: "Waiting for help",
    onTheWay: "Help on the way",
    onSite: "Help at the machine"
  };
  let detail = "";
  if (state === "offline") detail = `Last update ${timeOfDay(lastUpdate) || "unknown"} · calls may be out of date`;
  else if (state === "clear") detail = "No open calls";
  else if (state === "late") detail = "No response yet · late";
  else if (state !== "connecting" && oldest) detail = callCount > 1 ? `${callCount} calls open` : callTitle(oldest);

  const showClock = oldest && state !== "connecting" && state !== "clear";
  return (
    <section className={`ms-band ${state}`} role="status" aria-live="polite">
      <i className="ms-band-dot" aria-hidden="true" />
      <div className="ms-band-text">
        <strong>{label[state]}</strong>
        {detail && <span>{detail}</span>}
      </div>
      {showClock && <span className="ms-band-clock">{clock(oldest.totalSeconds)}</span>}
    </section>
  );
}

/* ---------- Station menu (theme, sign out, protected machine change) ---------- */

function StationMenu({ onChangeMachine }: { onChangeMachine: () => void }) {
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="ms-menu">
      <button type="button" className="ms-menu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <SettingsIcon />
        <span>Station</span>
      </button>
      {open && (
        <>
          <div className="ms-menu-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="ms-menu-list" role="menu">
            <button type="button" role="menuitem" onClick={() => { toggle(); setOpen(false); }}>
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            <HoldButton onHold={() => { setOpen(false); onChangeMachine(); }} />
            <button type="button" role="menuitem" className="danger" onClick={logout}>
              <SignOutIcon />
              Sign out of this station
            </button>
          </div>
        </>
      )}
    </div>
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
      role="menuitem"
      className="ms-hold"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
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

function statusLine(alert: Alert, timing: AlertTiming) {
  const who = alert.responderNameText?.trim();
  if (timing.stage === "waiting") return "Waiting for a response";
  return `${who ?? "Responder"} · ${timing.stage === "onTheWay" ? "on the way" : "at the machine"}`;
}

/** Grey traceability line: "Called 11:41 · acknowledged 11:43 (1:10) · arrived 11:45 (1:40)" */
function timesLine(alert: Alert, timing: AlertTiming) {
  const parts = [`Called ${timeOfDay(alert.createdAt)}`];
  if (alert.acknowledgedAt) parts.push(`acknowledged ${timeOfDay(alert.acknowledgedAt)} (${clock(timing.waitSeconds)})`);
  if (alert.arrivedAt) parts.push(`arrived ${timeOfDay(alert.arrivedAt)} (${clock(timing.travelSeconds)})`);
  return parts.join(" · ");
}

function ActiveCall({ call, machineId, disabled, onChange }: { call: CallSummary; machineId: string; disabled: boolean; onChange: () => void }) {
  const [pending, setPending] = useState<Pending>(null);
  const [sentNote, setSentNote] = useState("");
  const noteTimer = useRef<number | null>(null);
  useEffect(() => () => { if (noteTimer.current) window.clearTimeout(noteTimer.current); }, []);

  const act = useMutation({
    mutationFn: async ({ kind, alertIds }: { kind: "close" | "cancel"; alertIds: string[] }) => {
      if (kind === "cancel") {
        // The screen can be a few seconds behind: never cancel a team that has just responded.
        const fresh = await api<Snapshot>(snapshotPath(machineId));
        const freshAlerts = mergeByCall(fresh.data?.commands ?? []).flatMap((c) => c.alerts);
        if (alertIds.some((id) => freshAlerts.find((a) => a.id === id)?.status !== "OPEN")) {
          throw new Error("Someone just responded, so this can't be cancelled now.");
        }
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

  const noteTarget = call.alerts.find(({ timing }) => timing.stage === "waiting")?.alert ?? call.alerts[0].alert;
  const note = useMutation({
    mutationFn: (text: string) => postJson(`/api/alerts/${noteTarget.id}/notes`, { note: text, clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
    onSuccess: (_, text) => {
      setSentNote(text);
      onChange();
      if (noteTimer.current) window.clearTimeout(noteTimer.current);
      noteTimer.current = window.setTimeout(() => setSentNote(""), 3000);
    }
  });

  const answered = call.alerts.filter(({ alert, timing }) => timing.stage !== "waiting" && alert.status !== "RESOLVED");
  const unanswered = call.alerts.filter(({ alert }) => alert.status === "OPEN");
  const allAnswered = unanswered.length === 0;
  const noneAnswered = answered.length === 0;
  const multi = call.alerts.length > 1;
  const quick = QUICK_MESSAGES[call.stage];

  return (
    <article className={`ms-active ${call.stage}`}>
      <header className="ms-active-head">
        <div>
          <h2>{callTitle(call)}</h2>
          <small>Called at {timeOfDay(call.command.createdAt)}{multi ? ` · ${call.alerts.length} teams` : ""}</small>
        </div>
        <span className="ms-active-clock">{clock(call.totalSeconds)}</span>
      </header>

      <ul className="ms-teams">
        {call.alerts.map(({ alert, timing }) => (
          <li key={alert.id} className={`ms-team ${timing.stage}`}>
            <DepartmentIcon department={alert.department} size="lg" />
            <div className="ms-team-main">
              {multi && <strong className="ms-team-name">{alert.department.name}</strong>}
              <span className="ms-team-status"><i className={`ms-dot ${timing.stage}`} aria-hidden="true" />{statusLine(alert, timing)}</span>
              <span className="ms-team-times">{timesLine(alert, timing)}</span>
            </div>
            <div className="ms-team-side">
              {timing.stage !== "waiting" && <span className="ms-team-time">{timing.stage === "onSite" ? "on site" : "on the way"} {clock(timing.stageSeconds)}</span>}
              {multi && !pending && (timing.stage === "waiting" ? (
                <button type="button" className="ms-btn ghost" disabled={disabled} onClick={() => setPending({ kind: "cancel", alertIds: [alert.id], label: `Cancel the ${alert.department.name} call?` })}>Cancel</button>
              ) : (
                <button type="button" className="ms-btn close" disabled={disabled} onClick={() => setPending({ kind: "close", alertIds: [alert.id], label: `Close ${alert.department.name}? Only if their part is fixed.` })}>Close</button>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {pending ? (
        <div className="ms-confirm" role="alertdialog" aria-label={pending.label}>
          <strong>{pending.label}</strong>
          <div>
            <button type="button" className="ms-btn ghost" autoFocus onClick={() => setPending(null)} disabled={act.isPending}>Back</button>
            <button type="button" className={`ms-btn ${pending.kind === "close" ? "close" : "danger"}`} onClick={() => act.mutate(pending)} disabled={act.isPending}>
              {act.isPending ? "Working…" : pending.kind === "close" ? "Yes, close it" : "Yes, cancel"}
            </button>
          </div>
        </div>
      ) : (
        <>
          {allAnswered && (
            <button type="button" className="ms-btn close big" disabled={disabled} onClick={() => setPending({ kind: "close", alertIds: answered.map(({ alert }) => alert.id), label: multi ? "Is the issue fixed? This closes the call for every team." : "Is the issue fixed?" })}>
              <CheckCircleIcon /> Close call · issue fixed
            </button>
          )}
          {noneAnswered && (
            <div className="ms-actions-end">
              <button type="button" className="ms-btn ghost" disabled={disabled} onClick={() => setPending({ kind: "cancel", alertIds: unanswered.map(({ alert }) => alert.id), label: "Cancel this call? Use this if it was pressed by mistake." })}>
                <CloseIcon /> Cancel call
              </button>
            </div>
          )}
        </>
      )}

      {act.isError && <p className="ms-error" role="alert">{errorText(act.error, "That didn't go through. Try again.")}</p>}

      {quick.length > 0 && !pending && (
        <div className="ms-quick">
          {quick.map((text) => (
            <button key={text} type="button" className={`ms-chip ${sentNote === text ? "sent" : ""}`} onClick={() => note.mutate(text)} disabled={note.isPending || disabled}>
              {sentNote === text ? <><CheckCircleIcon /> Sent</> : text}
            </button>
          ))}
          {note.isError && <span className="ms-error" role="alert">Update not sent. Try again.</span>}
        </div>
      )}
    </article>
  );
}

/* ---------- Other request ---------- */

function OtherRequest({ departments, issueTypes, busy, sending, onClose, onSend }: {
  departments: Department[];
  issueTypes: IssueType[];
  busy: Set<string>;
  sending: boolean;
  onClose: () => void;
  onSend: (targets: Array<{ departmentId: string; issueTypeId: string }>) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const closeRef = useRef<HTMLButtonElement>(null);
  const rows = departments
    .map((department) => ({ department, reasons: issueTypes.filter((issue) => issue.departmentId === department.id) }))
    .filter((row) => row.reasons.length > 0);
  // A team that became busy after it was picked is dropped from the request.
  const targets = Object.entries(picked).filter(([departmentId, issue]) => issue && !busy.has(departmentId)).map(([departmentId, issueTypeId]) => ({ departmentId, issueTypeId }));

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
                  <DepartmentIcon department={department} size="md" />
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

function MachinePicker({ machines, currentId, onPick, onCancel }: { machines: Machine[]; currentId: string; onPick: (id: string) => void; onCancel?: () => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, Machine[]>();
    for (const m of machines) map.set(m.machineGroup?.name ?? "Machines", [...(map.get(m.machineGroup?.name ?? "Machines") ?? []), m]);
    return Array.from(map).sort(([a], [b]) => naturalSort.compare(a, b));
  }, [machines]);

  return (
    <section className="ms-picker">
      <header>
        <div>
          <h1>Which machine is this station?</h1>
          <p>This screen remembers the machine, so operators only see its calls.</p>
        </div>
        {onCancel && <button type="button" className="ms-btn ghost" onClick={onCancel}>Back</button>}
      </header>
      {machines.length === 0 && <p className="ms-muted">No machines are set up for your account.</p>}
      {groups.map(([name, list]) => (
        <div key={name} className="ms-picker-group">
          <h2>{name}</h2>
          <div className="ms-picker-grid">
            {list.map((m) => (
              <button key={m.id} type="button" className={`ms-picker-tile ${m.id === currentId ? "current" : ""}`} onClick={() => onPick(m.id)}>
                <strong>{m.name}</strong>
                <small>{m.id === currentId ? "This station" : m.code}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
