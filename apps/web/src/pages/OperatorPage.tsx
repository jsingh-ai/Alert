import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson } from "../lib/api";
import { formatElapsed } from "../lib/format";
import { CommandGroupCard } from "../components/CommandGroupCard";

export function OperatorPage() {
  const queryClient = useQueryClient();
  const [lockedMachineId, setLockedMachineId] = useState(() => localStorage.getItem("pg_operator_locked_machine_id") ?? "");
  const [machineId, setMachineId] = useState(() => localStorage.getItem("pg_operator_locked_machine_id") ?? "");
  const [machinePickerOpen, setMachinePickerOpen] = useState(() => !localStorage.getItem("pg_operator_locked_machine_id"));
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDepartments, setManualDepartments] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());

  const bootstrap = useQuery({ queryKey: ["operator-bootstrap"], queryFn: () => api<any>("/api/operator/bootstrap") });
  const snapshot = useQuery({ queryKey: ["operator-snapshot"], queryFn: () => api<any>("/api/operator/snapshot"), refetchInterval: 10000 });

  const data = bootstrap.data?.data;
  const machines = (data?.machines ?? []) as any[];
  const selectedMachine = machines.find((machine) => machine.id === machineId);
  const lockedMachine = machines.find((machine) => machine.id === lockedMachineId);
  const groupedMachines = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const machine of machines) {
      const name = machine.machineGroup?.name ?? "Machines";
      groups.set(name, [...(groups.get(name) ?? []), machine]);
    }
    return Array.from(groups, ([name, machines]) => ({ name, machines }));
  }, [machines]);
  const visibleCommands = useMemo(() => {
    const commands = snapshot.data?.data?.commands ?? [];
    if (!machineId) return [];
    return commands.filter((command: any) => command.machine?.id === machineId);
  }, [snapshot.data, machineId]);
  const activeTemplateStates = useMemo(() => {
    const map = new Map<string, { startedAt: number; openCount: number; acknowledgedCount: number; totalCount: number }>();
    for (const command of visibleCommands) {
      if (!command.commandTemplateId) continue;
      for (const alert of command.alerts ?? []) {
        const startedAt = new Date(alert.activeTimerStartedAt ?? alert.createdAt ?? command.createdAt).getTime();
        if (Number.isNaN(startedAt)) continue;
        const current = map.get(command.commandTemplateId);
        map.set(command.commandTemplateId, {
          startedAt: current ? Math.min(current.startedAt, startedAt) : startedAt,
          openCount: (current?.openCount ?? 0) + (alert.status === "OPEN" ? 1 : 0),
          acknowledgedCount: (current?.acknowledgedCount ?? 0) + (alert.status === "ACKNOWLEDGED" ? 1 : 0),
          totalCount: (current?.totalCount ?? 0) + 1
        });
      }
    }
    return map;
  }, [visibleCommands]);
  const activeDepartments = useMemo(() => {
    const map = new Map<string, string>();
    for (const command of visibleCommands) {
      for (const alert of command.alerts ?? []) {
        if (alert.department?.id) map.set(alert.department.id, alert.department.name);
      }
    }
    return map;
  }, [visibleCommands]);
  const allVisibleCallsAcknowledged = visibleCommands.length > 0 && visibleCommands.every((command: any) =>
    (command.alerts ?? []).length > 0 && command.alerts.every((alert: any) => alert.status === "ACKNOWLEDGED")
  );
  const openCommands = useMemo(() => visibleCommands.filter((command: any) =>
    (command.alerts ?? []).some((alert: any) => alert.status === "OPEN")
  ), [visibleCommands]);
  const acknowledgedCommands = useMemo(() => visibleCommands.filter((command: any) =>
    (command.alerts ?? []).length > 0 && command.alerts.every((alert: any) => alert.status === "ACKNOWLEDGED")
  ), [visibleCommands]);

  useEffect(() => {
    if (!lockedMachineId) return;
    if (machines.length > 0 && !machines.some((machine) => machine.id === lockedMachineId)) {
      localStorage.removeItem("pg_operator_locked_machine_id");
      setLockedMachineId("");
      setMachineId("");
    }
  }, [lockedMachineId, machines]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const createCommand = useMutation({
    mutationFn: (payload: any) => postJson("/api/commands", payload),
    onSuccess: () => {
      setManualDepartments({});
      queryClient.invalidateQueries({ queryKey: ["operator-snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["floor"] });
    }
  });

  function sendTemplate(templateId: string) {
    if (!machineId) return alert("Pick a machine first.");
    createCommand.mutate({ machineId, templateId });
  }

  function commandStatus(template: any) {
    if (!machineId) return { disabled: true, state: "Select machine", activeNames: [] as string[] };
    const activeState = activeTemplateStates.get(template.id);
    if (activeState) {
      const acknowledged = activeState.totalCount > 0 && activeState.acknowledgedCount === activeState.totalCount;
      return {
        disabled: true,
        fullyActive: true,
        acknowledged,
        state: acknowledged ? "Acknowledged" : "Active now",
        activeNames: [],
        elapsedSeconds: Math.max(0, Math.floor((now - activeState.startedAt) / 1000))
      };
    }
    const busyDepartments = (template.targets ?? [])
      .map((target: any) => activeDepartments.get(target.departmentId))
      .filter(Boolean);
    if (busyDepartments.length > 0) {
      return {
        disabled: true,
        fullyActive: false,
        state: `${busyDepartments.join(" + ")} active`,
        activeNames: busyDepartments
      };
    }
    return { disabled: false, fullyActive: false, state: "Call", activeNames: [] as string[] };
  }

  function commandBadge(label: string) {
    return label.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function sendManual() {
    if (!machineId) return alert("Pick a machine first.");
    const targets = Object.entries(manualDepartments).filter(([, issueTypeId]) => issueTypeId).map(([departmentId, issueTypeId]) => ({ departmentId, issueTypeId }));
    if (!targets.length) return alert("Select at least one department and issue.");
    createCommand.mutate({ machineId, commandLabel: "Manual Help Call", targets });
  }

  function lockMachine() {
    if (!machineId) return alert("Pick a machine first.");
    localStorage.setItem("pg_operator_locked_machine_id", machineId);
    setLockedMachineId(machineId);
    setMachinePickerOpen(false);
  }

  function unlockMachine() {
    localStorage.removeItem("pg_operator_locked_machine_id");
    setLockedMachineId("");
    setMachinePickerOpen(true);
  }

  return (
    <div className="page-stack">
      <div className={`selected-machine-banner ${selectedMachine ? "active" : ""} ${visibleCommands.length > 0 ? "has-calls" : ""} ${allVisibleCallsAcknowledged ? "acknowledged-calls" : ""}`}>
        <div className="machine-title-mark" aria-hidden="true">
          <span>{selectedMachine?.code ?? "--"}</span>
        </div>
        <div className="machine-title-copy">
          <span className="machine-title-eyebrow">Operator Station</span>
          <strong>{selectedMachine ? selectedMachine.name : "No machine selected"}</strong>
        </div>
        <span className="machine-title-status">
          {!selectedMachine ? "Select machine" : allVisibleCallsAcknowledged ? "Acknowledged" : visibleCommands.length > 0 ? "Active call" : "Monitoring"}
        </span>
      </div>
      <section className="panel">
        {lockedMachineId && !machinePickerOpen ? (
          <button className="collapse-header machine-lock-header" onClick={unlockMachine} aria-expanded={false}>
            <span>Select Machine - locked to {lockedMachine?.name ?? "selected machine"}</span>
            <strong>Unlock</strong>
          </button>
        ) : (
          <>
            <div className="section-title-row">
              <div className="section-heading">
                <h2>Select Machine</h2>
              </div>
              <div className="section-actions">
                <button className="lock-button" onClick={lockMachine} disabled={!machineId}>Lock machine</button>
              </div>
            </div>
            <div className="machine-groups">
              {groupedMachines.map((group) => (
                <div key={group.name}>
                  <h3>{group.name}</h3>
                  <div className="machine-grid">
                    {group.machines.map((machine) => (
                      <button
                        key={machine.id}
                        className={`machine-tile ${machine.id === machineId ? "selected" : ""}`}
                        onClick={() => setMachineId(machine.id)}
                      >
                        <strong>{machine.name}</strong><span>{machine.code}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      <section className="panel">
        <div className={`operator-section-banner quick-command-banner ${visibleCommands.length > 0 ? "has-calls" : ""} ${allVisibleCallsAcknowledged ? "acknowledged" : ""}`}>
          <div className="operator-section-mark" aria-hidden="true">QC</div>
          <div className="operator-section-copy">
            <span>Operator Actions</span>
            <h2>Quick Commands</h2>
          </div>
          <strong>{(data?.commandTemplates ?? []).length} commands</strong>
        </div>
        <div className="command-grid">
          {(data?.commandTemplates ?? []).map((template: any) => {
            const status = commandStatus(template);
            return (
              <button
                key={template.id}
                className={`command-button ${status.fullyActive && machineId ? "blocked" : ""} ${status.acknowledged ? "acknowledged" : ""} ${status.disabled && !status.fullyActive && machineId ? "partially-blocked" : ""}`}
                onClick={() => sendTemplate(template.id)}
                disabled={createCommand.isPending || status.disabled}
              >
                <span className="command-call-glyph" aria-hidden="true">☎</span>
                <span className="command-icon">{commandBadge(template.buttonLabel)}</span>
                <span className="command-copy">
                  <strong>{template.buttonLabel}</strong>
                  <span>{template.targets.map((target: any) => target.department.name).join(" + ")}</span>
                </span>
                {status.elapsedSeconds !== undefined && <span className="command-timer">{formatElapsed(status.elapsedSeconds)}</span>}
                <span className="command-state">{status.state}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="panel subtle operator-manual-call">
        <button className="collapse-header" onClick={() => setManualOpen((open) => !open)} aria-expanded={manualOpen}>
          <span>Manual multi-department call</span>
          <strong>{manualOpen ? "Hide" : "Show"}</strong>
        </button>
        {manualOpen && (
          <div className="collapse-body">
            <div className="manual-grid">
              {(data?.departments ?? []).map((department: any) => (
                <label key={department.id} className="manual-row">
                  <span>{department.name}</span>
                  <select value={manualDepartments[department.id] ?? ""} onChange={(event) => setManualDepartments((current) => ({ ...current, [department.id]: event.target.value }))}>
                    <option value="">Do not call</option>
                    {(data?.issueTypes ?? []).filter((issue: any) => issue.departmentId === department.id).map((issue: any) => <option key={issue.id} value={issue.id}>{issue.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <button onClick={sendManual} disabled={createCommand.isPending}>Send manual call</button>
          </div>
        )}
      </section>
      <section className="panel">
        <div className={`operator-section-banner active-call-banner ${visibleCommands.length > 0 ? "has-calls" : ""} ${allVisibleCallsAcknowledged ? "acknowledged" : ""}`}>
          <div className="operator-section-mark" aria-hidden="true">AC</div>
          <div className="operator-section-copy">
            <span>Machine Queue</span>
            <h2>Active Calls</h2>
          </div>
          <strong>{!machineId ? "Select machine" : visibleCommands.length === 0 ? "Clear" : `${visibleCommands.length} active`}</strong>
        </div>
        <div className="operator-active-columns">
          {!machineId && <div className="empty-state">Select a machine to see its active calls.</div>}
          {machineId && visibleCommands.length === 0 && <div className="empty-state">No active calls for this machine.</div>}
          {machineId && visibleCommands.length > 0 && (
            <>
              <div className="operator-active-column open">
                <div className="operator-active-column-header">
                  <strong>Open</strong>
                  <span>{openCommands.length}</span>
                </div>
                <div className="command-list operator-command-list">
                  {openCommands.length === 0 && <div className="empty-state small">No open calls.</div>}
                  {openCommands.map((command: any) => <CommandGroupCard key={command.id} command={command} actionMode="operator" />)}
                </div>
              </div>
              <div className="operator-active-column acknowledged">
                <div className="operator-active-column-header">
                  <strong>Acknowledged</strong>
                  <span>{acknowledgedCommands.length}</span>
                </div>
                <div className="command-list operator-command-list">
                  {acknowledgedCommands.length === 0 && <div className="empty-state small">No calls waiting to resolve.</div>}
                  {acknowledgedCommands.map((command: any) => <CommandGroupCard key={command.id} command={command} actionMode="operator" />)}
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
