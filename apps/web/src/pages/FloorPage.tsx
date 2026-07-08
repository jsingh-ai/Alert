import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatElapsed } from "../lib/format";
import { CommandGroupCard } from "../components/CommandGroupCard";
import type { CommandGroup } from "../lib/types";

export function FloorPage() {
  const [onlyActive, setOnlyActive] = useState(false);
  const [machineGroup, setMachineGroup] = useState("all");
  const floor = useQuery({ queryKey: ["floor"], queryFn: () => api<any>("/api/floor/active"), refetchInterval: 7000 });
  const commands = (floor.data?.data?.commands ?? []) as CommandGroup[];
  const machines = (floor.data?.data?.machines ?? []) as any[];
  const machineStats = floor.data?.data?.machineStats ?? {};
  const activeMachineIds = useMemo(() => new Set(commands.map((command) => command.machine.id)), [commands]);
  const alertCount = commands.reduce((sum, command) => sum + command.alerts.length, 0);
  const activeByMachine = useMemo(() => {
    const map = new Map<string, CommandGroup[]>();
    for (const command of commands) {
      map.set(command.machine.id, [...(map.get(command.machine.id) ?? []), command]);
    }
    return map;
  }, [commands]);
  const machineGroups = useMemo<string[]>(() => {
    const names = machines.map((machine: any) => machine.machineGroup?.name).filter((name: any): name is string => Boolean(name));
    return Array.from(new Set(names));
  }, [machines]);
  const visibleMachines = machines.filter((machine: any) =>
    (!onlyActive || activeMachineIds.has(machine.id)) &&
    (machineGroup === "all" || machine.machineGroup?.name === machineGroup)
  );

  return (
    <div className="page-stack floor-page">
      <header className={`floor-header ${commands.length > 0 ? "has-alerts" : ""}`}>
        <div className="floor-heading">
          <span>Live Floor</span>
          <h1>Floor Overview</h1>
        </div>
        <div className="floor-summary">
          <div><span>Machines</span><strong>{machines.length}</strong></div>
          <div><span>Active</span><strong>{activeMachineIds.size}</strong></div>
          <div><span>Alerts</span><strong>{alertCount}</strong></div>
        </div>
      </header>
      <div className="floor-tabs" role="tablist" aria-label="Machine groups">
        <button className={machineGroup === "all" ? "active" : ""} onClick={() => setMachineGroup("all")}>All</button>
        {machineGroups.map((group) => (
          <button key={group} className={machineGroup === group ? "active" : ""} onClick={() => setMachineGroup(group)}>{group}</button>
        ))}
        <label className={`floor-toggle floor-tabs-toggle ${onlyActive ? "active" : ""}`}>
          <input type="checkbox" checked={onlyActive} onChange={(event) => setOnlyActive(event.target.checked)} /> Active Alerts
        </label>
      </div>
      <section className="floor-grid">
        {visibleMachines.map((machine: any) => {
          const machineCommands = activeByMachine.get(machine.id) ?? [];
          const machineAlerts = machineCommands.reduce((sum, command) => sum + command.alerts.length, 0);
          const acknowledged = machineCommands.length > 0 && machineCommands.every((command) => command.alerts.every((alert) => alert.status === "ACKNOWLEDGED"));
          const stats = machineStats[machine.id] ?? {};
          const lastAlert = stats.lastAlert;
          return (
          <article key={machine.id} className={`floor-machine ${machineCommands.length > 0 ? "hot" : "normal"} ${acknowledged ? "acknowledged" : ""}`}>
            <div>
              <strong>{machine.name}</strong>
              <span>{machine.machineGroup?.name} / {machine.code}</span>
            </div>
            <em>{machineCommands.length > 0 ? `${machineAlerts} alert${machineAlerts === 1 ? "" : "s"}` : "Clear"}</em>
            <dl>
              <div><dt>Today</dt><dd>{stats.alertsToday ?? 0}</dd></div>
              <div><dt>Last</dt><dd>{lastAlert ? new Date(lastAlert.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "-"}</dd></div>
              <div><dt>Duration</dt><dd>{lastAlert ? formatElapsed(lastAlert.durationSeconds) : "-"}</dd></div>
            </dl>
          </article>
        );})}
        {visibleMachines.length === 0 && <div className="empty-state">No active machines right now.</div>}
      </section>
      <section className="panel floor-active-panel">
        <div className="section-heading">
          <h2>Active Alerts</h2>
        </div>
        <div className="command-list floor-command-list">
          {commands.length === 0 && <div className="empty-state">All clear. No active commands.</div>}
          {commands.map((command) => <CommandGroupCard key={command.id} command={command} actionMode="floor" />)}
        </div>
      </section>
    </div>
  );
}
