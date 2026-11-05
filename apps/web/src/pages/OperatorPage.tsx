import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import type { Alert, CommandGroup } from "../lib/types";
import { clock, summarizeCall } from "../lib/callStages";
import type { AlertTiming, CallStage, CallSummary } from "../lib/callStages";
import { DepartmentIcon } from "../components/DepartmentBadge";
import { CheckCircleIcon, CloseIcon, SettingsIcon } from "../components/icons";
import "../styles/station.css";

const MACHINE_KEY = "pg_operator_locked_machine_id";
const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const QUICK_MESSAGES = ["Still waiting", "Machine stopped", "Urgent, please hurry"];

type Department = { id: string; name: string; color?: string };
type Machine = { id: string; name: string; code: string; machineGroup?: { name?: string } | null };
type Template = { id: string; buttonLabel: string; targets: Array<{ departmentId: string; department: Department }> };
type IssueType = { id: string; name: string; departmentId: string };
type Bootstrap = { machines: Machine[]; departments: Department[]; issueTypes: IssueType[]; commandTemplates: Template[] };

const STATUS: Record<CallStage | "clear", { label: string; tone: string }> = {
  clear: { label: "Running normally", tone: "clear" },
  waiting: { label: "Waiting for help", tone: "waiting" },
  onTheWay: { label: "Help on the way", tone: "onTheWay" },
  onSite: { label: "Help at the machine", tone: "onSite" }
};

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

export function OperatorPage() {
  const queryClient = useQueryClient();
  const now = useNow();
  const [machineId, setMachineId] = useState(readMachineId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);

  const bootstrap = useQuery({ queryKey: ["operator-bootstrap"], queryFn: () => api<{ data?: Bootstrap }>("/api/operator/bootstrap") });
  const snapshot = useQuery({
    queryKey: ["operator-snapshot", machineId],
    queryFn: () => api<{ data?: { commands?: CommandGroup[] } }>(`/api/operator/snapshot${machineId ? `?machineId=${machineId}` : ""}`),
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
    const commands = (snapshot.data?.data?.commands ?? []).filter((c) => c.machine?.id === machineId && c.alerts.length > 0);
    return commands
      .map((command) => summarizeCall(command, now))
      .sort((a, b) => new Date(a.command.createdAt).getTime() - new Date(b.command.createdAt).getTime());
  }, [snapshot.data, machineId, now]);

  const busyDepartments = new Map<string, CallSummary>();
  for (const call of calls) for (const { alert } of call.alerts) busyDepartments.set(alert.department.id, call);
  const activeTemplates = new Map(calls.filter((c) => c.command.commandTemplateId).map((c) => [c.command.commandTemplateId as string, c]));
  const overall: CallStage | "clear" = calls.length === 0 ? "clear" : calls.some((c) => c.stage === "waiting") ? "waiting" : calls.some((c) => c.stage === "onTheWay") ? "onTheWay" : "onSite";

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

  if (bootstrap.isLoading) return <div className="ms-page"><div className="ms-loading">Loading station…</div></div>;

  if (!machine || pickerOpen) {
    return (
      <div className="ms-page">
        <MachinePicker machines={machines} currentId={machineId} onPick={chooseMachine} onCancel={machine ? () => setPickerOpen(false) : undefined} />
      </div>
    );
  }

  return (
    <div className={`ms-page has-${overall}`}>
      <header className="ms-head">
        <div className="ms-machine">
          <small>{machine.machineGroup?.name ?? "Machine"} · {machine.code}</small>
          <h1>{machine.name}</h1>
        </div>
        <div className={`ms-status ${STATUS[overall].tone}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          {STATUS[overall].label}
        </div>
        <button type="button" className="ms-change" onClick={() => setPickerOpen(true)} title="Change machine">
          <SettingsIcon />
          <span>Change machine</span>
        </button>
      </header>

      <div className={`ms-body ${calls.length ? "with-calls" : ""}`}>
        {calls.length > 0 && (
          <section className="ms-calls" aria-label="Open calls">
            {calls.map((call) => <ActiveCall key={call.command.id} call={call} onChange={refresh} />)}
          </section>
        )}

        <section className="ms-request" aria-label="Call for help">
          <header>
            <h2>{calls.length ? "Call another team" : "Call for help"}</h2>
            {createCall.isError && <span className="ms-error">Couldn't send the call. Try again.</span>}
          </header>
          <div className="ms-buttons">
            {templates
              // the active call is already shown on the left; usable buttons first, "already called" ones last
              .filter((template) => !activeTemplates.has(template.id))
              .sort((a, b) => Number(a.targets.some((t) => busyDepartments.has(t.departmentId))) - Number(b.targets.some((t) => busyDepartments.has(t.departmentId))))
              .map((template) => {
              const active = activeTemplates.get(template.id);
              const busy = template.targets.map((t) => busyDepartments.get(t.departmentId)).find(Boolean);
              const disabled = Boolean(active || busy) || createCall.isPending;
              const sending = createCall.isPending && createCall.variables?.templateId === template.id;
              const names = template.targets.map((t) => t.department.name);
              return (
                <button
                  key={template.id}
                  type="button"
                  className={`ms-call-button ${active ? "is-active" : ""} ${busy && !active ? "is-busy" : ""}`}
                  disabled={disabled}
                  onClick={() => createCall.mutate({ templateId: template.id })}
                >
                  <span className="ms-call-icons">
                    {template.targets.map((t) => <DepartmentIcon key={t.departmentId} department={t.department} size="lg" />)}
                  </span>
                  <span className="ms-call-text">
                    <strong>{template.buttonLabel}</strong>
                    {(() => {
                      const detail = sending
                        ? "Sending…"
                        : active
                          ? `Called ${clock(active.totalSeconds)} ago`
                          : busy
                            ? `${names.filter((_, i) => busyDepartments.has(template.targets[i].departmentId)).join(" + ")} already called`
                            : names.length > 1 || !names.every((n) => template.buttonLabel.toLowerCase().includes(n.toLowerCase()))
                              ? names.join(" + ")
                              : "";
                      return detail ? <small>{detail}</small> : null;
                    })()}
                  </span>
                </button>
              );
            })}
            <button type="button" className="ms-call-button ms-other" onClick={() => setOtherOpen(true)} disabled={createCall.isPending}>
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

/* ---------- Active call ---------- */

type Pending = { kind: "close" | "cancel"; alertIds: string[]; label: string } | null;

function teamLine(alert: Alert, timing: AlertTiming) {
  const who = alert.responderNameText?.trim();
  if (timing.stage === "waiting") return "Waiting for someone to respond";
  if (timing.stage === "onTheWay") return `${who ?? "Someone"} is on the way`;
  return `${who ?? "Help"} is at the machine`;
}

function ActiveCall({ call, onChange }: { call: CallSummary; onChange: () => void }) {
  const [pending, setPending] = useState<Pending>(null);
  const [sentNote, setSentNote] = useState("");

  const act = useMutation({
    mutationFn: async ({ kind, alertIds }: { kind: "close" | "cancel"; alertIds: string[] }) => {
      for (const id of alertIds) await postJson(`/api/alerts/${id}/${kind === "close" ? "resolve" : "cancel"}`, {});
    },
    onSuccess: () => {
      setPending(null);
      onChange();
    }
  });

  const note = useMutation({
    mutationFn: (text: string) => postJson(`/api/alerts/${call.alerts[0].alert.id}/notes`, { note: text, clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
    onSuccess: (_, text) => {
      setSentNote(text);
      onChange();
      window.setTimeout(() => setSentNote(""), 3000);
    }
  });

  const answered = call.alerts.filter(({ timing }) => timing.stage !== "waiting");
  const unanswered = call.alerts.filter(({ timing }) => timing.stage === "waiting");
  const allAnswered = unanswered.length === 0;
  const noneAnswered = answered.length === 0;

  return (
    <article className={`ms-active ${call.stage} ${call.late ? "late" : ""}`}>
      <header className="ms-active-head">
        <div>
          <h2>{call.command.commandLabel}</h2>
          <small>Called at {timeOfDay(call.command.createdAt)}</small>
        </div>
        <div className="ms-active-clock">
          {call.late && <em className="ms-late">Late</em>}
          <strong>{clock(call.totalSeconds)}</strong>
          <small>open</small>
        </div>
      </header>

      <ul className="ms-teams">
        {call.alerts.map(({ alert, timing }) => (
          <li key={alert.id} className={`ms-team ${timing.stage}`}>
            <DepartmentIcon department={alert.department} size="md" />
            <div className="ms-team-main">
              <div className="ms-team-top">
                <strong>{alert.department.name}</strong>
                <span className="ms-team-line"><i className={`ms-dot ${timing.stage}`} aria-hidden="true" />{teamLine(alert, timing)}</span>
              </div>
              <ol className="ms-track" aria-label={`${alert.department.name} progress`}>
                <li className="done"><i />Called</li>
                <li className={timing.stage === "waiting" ? "current" : "done"}><i />Acknowledged</li>
                <li className={timing.stage === "onSite" ? "done" : timing.stage === "onTheWay" ? "current" : ""}><i />At machine</li>
              </ol>
            </div>
            <div className="ms-team-side">
              {/* a waiting team's time equals the call's open time shown above */}
              {timing.stage !== "waiting" && <span className="ms-team-time">{clock(timing.stageSeconds)}</span>}
              {call.alerts.length > 1 && (timing.stage === "waiting" ? (
                <button type="button" className="ms-link" onClick={() => setPending({ kind: "cancel", alertIds: [alert.id], label: `Cancel the ${alert.department.name} call?` })}>Cancel</button>
              ) : (
                <button type="button" className="ms-link strong" onClick={() => setPending({ kind: "close", alertIds: [alert.id], label: `Close ${alert.department.name}? Only if their part is fixed.` })}>Close</button>
              ))}
            </div>
          </li>
        ))}
      </ul>

      <div className="ms-quick">
        <span>Send update</span>
        {QUICK_MESSAGES.map((text) => (
          <button key={text} type="button" className={`ms-chip ${sentNote === text ? "sent" : ""}`} onClick={() => note.mutate(text)} disabled={note.isPending}>
            {sentNote === text ? <><CheckCircleIcon /> Sent</> : text}
          </button>
        ))}
      </div>

      {pending ? (
        <div className="ms-confirm" role="alertdialog" aria-label={pending.label}>
          <strong>{pending.label}</strong>
          <div>
            <button type="button" className="ms-btn ghost" onClick={() => setPending(null)} disabled={act.isPending}>Back</button>
            <button type="button" className={`ms-btn ${pending.kind === "close" ? "close" : "danger"}`} onClick={() => act.mutate(pending)} disabled={act.isPending}>
              {act.isPending ? "Working…" : pending.kind === "close" ? "Yes, close it" : "Yes, cancel"}
            </button>
          </div>
        </div>
      ) : (
        <div className="ms-actions">
          {allAnswered && (
            <button type="button" className="ms-btn close big" onClick={() => setPending({ kind: "close", alertIds: answered.map(({ alert }) => alert.id), label: "Is the issue fixed? This closes the call for every team." })}>
              <CheckCircleIcon /> Close call · issue fixed
            </button>
          )}
          {noneAnswered && (
            <button type="button" className="ms-btn ghost big" onClick={() => setPending({ kind: "cancel", alertIds: unanswered.map(({ alert }) => alert.id), label: "Cancel this call? Use this if it was pressed by mistake." })}>
              <CloseIcon /> Cancel call
            </button>
          )}
          {!allAnswered && !noneAnswered && <p className="ms-hint">Close each team when their part is done.</p>}
          {act.isError && <span className="ms-error">That didn't go through. Try again.</span>}
        </div>
      )}
    </article>
  );
}

/* ---------- Other request ---------- */

function OtherRequest({ departments, issueTypes, busy, sending, onClose, onSend }: {
  departments: Department[];
  issueTypes: IssueType[];
  busy: Map<string, CallSummary>;
  sending: boolean;
  onClose: () => void;
  onSend: (targets: Array<{ departmentId: string; issueTypeId: string }>) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const targets = Object.entries(picked).filter(([, issue]) => issue).map(([departmentId, issueTypeId]) => ({ departmentId, issueTypeId }));

  return (
    <div className="ms-sheet-wrap" role="dialog" aria-label="Other request">
      <button type="button" className="ms-sheet-backdrop" aria-label="Close" onClick={onClose} />
      <section className="ms-sheet">
        <header>
          <div>
            <h2>Other request</h2>
            <small>Pick a reason for each team you need.</small>
          </div>
          <button type="button" className="ms-icon-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </header>
        <div className="ms-sheet-body">
          {departments.map((department) => {
            const reasons = issueTypes.filter((issue) => issue.departmentId === department.id);
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
