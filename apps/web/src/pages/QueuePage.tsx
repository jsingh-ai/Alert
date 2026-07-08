import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatElapsed } from "../lib/format";
import { AlertCard } from "../components/AlertCard";
import type { Alert } from "../lib/types";

export function QueuePage() {
  const { session } = useAuth();
  const defaultDepartment = session?.departments?.[0]?.id ?? "";
  const [departmentId, setDepartmentId] = useState(defaultDepartment);
  const [machineGroup, setMachineGroup] = useState("all");
  const [selectedAlertId, setSelectedAlertId] = useState("");
  const [now, setNow] = useState(() => Date.now());
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
  const filteredAlerts = selectedAlertId ? visibleAlerts.filter((alert) => alert.id === selectedAlertId) : visibleAlerts;
  const columns = useMemo(() => [
    { key: "OPEN", label: "Open", items: filteredAlerts.filter((alert) => alert.status === "OPEN") },
    { key: "ACKNOWLEDGED", label: "Acknowledged", items: filteredAlerts.filter((alert) => alert.status === "ACKNOWLEDGED" || alert.status === "ARRIVED") }
  ], [filteredAlerts]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (selectedAlertId && !visibleAlerts.some((alert) => alert.id === selectedAlertId)) {
      setSelectedAlertId("");
    }
  }, [selectedAlertId, visibleAlerts]);

  function alertElapsed(alert: Alert) {
    const startedAt = new Date(alert.activeTimerStartedAt ?? alert.createdAt).getTime();
    if (Number.isNaN(startedAt)) return alert.elapsedSeconds;
    return Math.max(0, Math.floor((now - startedAt) / 1000));
  }

  return (
    <div className="page-stack queue-page">
      <header className={`queue-hero ${columns[0].items.length > 0 ? "has-open" : ""} ${columns[0].items.length === 0 && columns[1].items.length > 0 ? "has-acknowledged" : ""}`}>
        <div className="operator-section-mark" aria-hidden="true">DQ</div>
        <div className="operator-section-copy">
          <span>Department Response</span>
          <h1>Department Queue</h1>
        </div>
        <div className="queue-summary">
          <div><span>Open</span><strong>{columns[0].items.length}</strong></div>
          <div><span>Acknowledged</span><strong>{columns[1].items.length}</strong></div>
        </div>
      </header>
      <section className="queue-control-panel">
        <label className="queue-filter">
          <span>Department Change</span>
          <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            <option value="">All scoped departments</option>
            {session?.departments.map((department: any) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
        </label>
        <div className="queue-machine-filter">
          <div>
            <span>Machine Groups</span>
            <strong>{machineGroup === "all" ? "All machines" : machineGroup}</strong>
          </div>
          <div className="queue-tabs" role="tablist" aria-label="Machine groups">
            <button className={machineGroup === "all" ? "active" : ""} onClick={() => setMachineGroup("all")}>All</button>
            {machineGroups.map((group) => (
              <button key={group} className={machineGroup === group ? "active" : ""} onClick={() => setMachineGroup(group)}>{group}</button>
            ))}
          </div>
        </div>
      </section>
      <section className="queue-active-strip" aria-label="Active alert filters">
        <div>
          <span>Active Alerts</span>
          <strong>{selectedAlertId ? "Filtered" : `${visibleAlerts.length} active`}</strong>
        </div>
        <div className="queue-alert-chips">
          {visibleAlerts.length === 0 && <span className="queue-alert-chip-empty">No active alerts</span>}
          {visibleAlerts.map((alert) => (
            <button
              key={alert.id}
              className={`queue-alert-chip ${alert.status === "OPEN" ? "open" : "acknowledged"} ${selectedAlertId === alert.id ? "selected" : ""}`}
              onClick={() => setSelectedAlertId((current) => current === alert.id ? "" : alert.id)}
              title={`${alert.machine.name} - ${alert.department.name}`}
            >
              <span>{alert.machine.name}</span>
              <strong>{formatElapsed(alertElapsed(alert))}</strong>
            </button>
          ))}
        </div>
      </section>
      <div className="kanban-grid">
        {columns.map(({ key, label, items }) => (
          <section key={key} className={`queue-column status-${key.toLowerCase()}`}>
            <header>
              <div className="queue-column-mark" aria-hidden="true">{label.slice(0, 2).toUpperCase()}</div>
              <div>
                <span>{key === "OPEN" ? "Needs Response" : "Waiting To Resolve"}</span>
                <strong>{label}</strong>
              </div>
              <em>{items.length}</em>
            </header>
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
