import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateInputValue } from "../lib/format";

function Metric({ label, value }: { label: string; value: any }) {
  return <div className="metric-card"><span>{label}</span><strong>{value ?? "-"}</strong></div>;
}

function seconds(value: number | null) {
  if (value == null) return "-";
  const minutes = Math.round(value / 60);
  return `${minutes}m`;
}

function formatDayLabel(day: string) {
  const [, month, date] = day.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[Number(month) - 1] ?? month} ${Number(date)}`;
}

function TrendList({ title, items, valueFor, formatValue }: { title: string; items: any[]; valueFor: (item: any) => number; formatValue: (value: number | null) => string }) {
  const max = Math.max(1, ...items.map((item) => valueFor(item)));
  return (
    <div className="panel trend-panel">
      <h2>{title}</h2>
      <div className="trend-list">
        {items.length === 0 && <div className="empty-state small">No trend data for this range.</div>}
        {items.map((item) => {
          const value = valueFor(item);
          return (
            <div key={item.day} className="trend-row">
              <span>{formatDayLabel(item.day)}</span>
              <div><i style={{ width: `${Math.max(5, (value / max) * 100)}%` }} /></div>
              <strong>{formatValue(value || null)}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ReportsPage() {
  const { session } = useAuth();
  const [start, setStart] = useState(dateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [end, setEnd] = useState(dateInputValue(new Date()));
  const [departmentId, setDepartmentId] = useState("");
  const [machineGroupId, setMachineGroupId] = useState("");
  const machineGroups = Array.from(new Map((session?.machines ?? [])
    .filter((machine: any) => machine.machineGroup?.id)
    .map((machine: any) => [machine.machineGroup.id, machine.machineGroup])).values());
  const params = new URLSearchParams({ start, end });
  if (departmentId) params.set("departmentId", departmentId);
  if (machineGroupId) params.set("machineGroupId", machineGroupId);
  const reports = useQuery({ queryKey: ["reports", start, end, departmentId, machineGroupId], queryFn: () => api<any>(`/api/reports/summary?${params.toString()}`) });
  const data = reports.data?.data;
  const byDay = data?.byDay ?? [];

  return (
    <div className="page-stack">
      <header className="page-header"><div><h1>Reports</h1><p>Command and department alert history.</p></div></header>
      <section className="panel filters report-filters">
        <label>Start<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
        <label>End<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
        <label>Department
          <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            <option value="">All departments</option>
            {session?.departments.map((department: any) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
        </label>
        <label>Machine Group
          <select value={machineGroupId} onChange={(event) => setMachineGroupId(event.target.value)}>
            <option value="">All machine groups</option>
            {machineGroups.map((group: any) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
      </section>
      <section className="metric-grid">
        <Metric label="Total alerts" value={data?.totalAlerts ?? 0} />
        <Metric label="Open" value={data?.openAlerts ?? 0} />
        <Metric label="Closed" value={data?.closedAlerts ?? 0} />
        <Metric label="Avg acknowledge" value={seconds(data?.averageAcknowledgeSeconds)} />
        <Metric label="Avg clear" value={seconds(data?.averageClearSeconds)} />
      </section>
      <section className="report-grid">
        <TrendList title="Alert Volume Trend" items={byDay} valueFor={(item) => item.count ?? 0} formatValue={(value) => `${value ?? 0}`} />
        <TrendList title="Average Clear Time Trend" items={byDay} valueFor={(item) => Math.round((item.averageClearSeconds ?? 0) / 60)} formatValue={(value) => value == null ? "-" : `${value}m`} />
      </section>
      <section className="report-grid">
        {["byDepartment", "byMachineGroup", "byMachine", "byIssue", "byHour"].map((key) => (
          <div key={key} className="panel">
            <h2>{key.replace("by", "By ")}</h2>
            <div className="bar-list">
              {(data?.[key] ?? []).map((item: any) => <div key={item.name ?? item.hour}><span>{item.name ?? item.hour}</span><strong>{item.count}</strong></div>)}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
