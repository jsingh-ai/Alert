import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AlertCard } from "../components/AlertCard";
import type { Alert } from "../lib/types";

export function QueuePage() {
  const { session } = useAuth();
  const defaultDepartment = session?.departments?.[0]?.id ?? "";
  const [departmentId, setDepartmentId] = useState(defaultDepartment);
  const [machineGroup, setMachineGroup] = useState("all");
  const active = useQuery({
    queryKey: ["active-alerts", departmentId],
    queryFn: () => api<any>(`/api/alerts/active${departmentId ? `?departmentId=${departmentId}` : ""}`),
    refetchInterval: 8000
  });

  const alerts = (active.data?.data ?? []) as Alert[];
  const machineGroups = useMemo(() => {
    const names = (session?.machines ?? [])
      .map((machine: any) => machine.machineGroup?.name)
      .filter((name: any): name is string => Boolean(name));
    return Array.from(new Set(names));
  }, [session?.machines]);
  const visibleAlerts = alerts.filter((alert) => machineGroup === "all" || alert.machine.group === machineGroup);
  const columns = useMemo(() => [
    { key: "OPEN", label: "Open", items: visibleAlerts.filter((alert) => alert.status === "OPEN") },
    { key: "ACKNOWLEDGED", label: "Acknowledged", items: visibleAlerts.filter((alert) => alert.status === "ACKNOWLEDGED" || alert.status === "ARRIVED") }
  ], [visibleAlerts]);

  return (
    <div className="page-stack queue-page">
      <header className="queue-header">
        <div className="queue-heading">
          <span>Department</span>
          <h1>Queue</h1>
        </div>
        <div className="queue-summary">
          <div><span>Open</span><strong>{columns[0].items.length}</strong></div>
          <div><span>Acknowledged</span><strong>{columns[1].items.length}</strong></div>
        </div>
        <label className="queue-filter">
          <span>Department</span>
          <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            <option value="">All scoped departments</option>
            {session?.departments.map((department: any) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
        </label>
      </header>
      <div className="queue-tabs" role="tablist" aria-label="Machine groups">
        <button className={machineGroup === "all" ? "active" : ""} onClick={() => setMachineGroup("all")}>All</button>
        {machineGroups.map((group) => (
          <button key={group} className={machineGroup === group ? "active" : ""} onClick={() => setMachineGroup(group)}>{group}</button>
        ))}
      </div>
      <div className="kanban-grid">
        {columns.map(({ key, label, items }) => (
          <section key={key} className={`queue-column status-${key.toLowerCase()}`}>
            <header><strong>{label}</strong><span>{items.length}</span></header>
            <div className="queue-list">
              {items.length === 0 && <div className="empty-state small">No {label.toLowerCase()} alerts.</div>}
              {items.map((alert) => <AlertCard key={alert.id} alert={alert} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
