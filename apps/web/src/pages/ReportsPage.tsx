import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { classNames, dateInputValue, formatElapsed } from "../lib/format";

type ReportLens = { type: "department" | "machineGroup" | "machine" | "issue" | "hour" | "day" | "responder"; id: string; label: string } | null;
type ReportMode = "overview" | "departments" | "machines" | "responders" | "table";

type ReportRow = {
  id: string;
  commandLabel: string;
  machine: { id: string; name: string; code: string; groupId: string; groupName: string };
  department: { id: string; name: string };
  responder?: { id: string; name: string } | null;
  issueType?: { id: string; name: string } | null;
  status: string;
  priority: string;
  displayMessage?: string | null;
  operatorNote?: string | null;
  createdAt: string;
  dayKey: string;
  hourKey: string;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  acknowledgeSeconds?: number | null;
  clearSeconds?: number | null;
  resolveSeconds?: number | null;
};

function duration(value: number | null | undefined) {
  if (value == null) return "-";
  return formatElapsed(value);
}

function shortDuration(value: number | null | undefined) {
  if (value == null) return "-";
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatDayLabel(day: string) {
  const [, month, date] = day.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[Number(month) - 1] ?? month} ${Number(date)}`;
}

function dateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function csvValue(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function exportCsv(rows: ReportRow[]) {
  const headers = ["Created", "Machine Group", "Machine", "Code", "Department", "Responder", "Command", "Issue", "Status", "Priority", "Ack Time", "Clear Time", "Resolve Time", "Resolved", "Message"];
  const lines = rows.map((row) => [
    row.createdAt,
    row.machine.groupName,
    row.machine.name,
    row.machine.code,
    row.department.name,
    row.responder?.name ?? "",
    row.commandLabel,
    row.issueType?.name ?? "General help",
    row.status,
    row.priority,
    duration(row.acknowledgeSeconds),
    duration(row.clearSeconds),
    duration(row.resolveSeconds),
    row.resolvedAt ?? "",
    row.displayMessage ?? row.operatorNote ?? ""
  ].map(csvValue).join(","));
  const blob = new Blob([[headers.map(csvValue).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `processguard-reports-${dateInputValue(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function MetricTile({ label, value, detail, tone = "neutral" }: { label: string; value: string | number; detail: string; tone?: "neutral" | "blue" | "red" | "green" | "amber" }) {
  return (
    <article className={`report-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </article>
  );
}

function TrendCard({ title, subtitle, items, valueFor, formatValue, activeLens, onSelect }: {
  title: string;
  subtitle: string;
  items: any[];
  valueFor: (item: any) => number;
  formatValue: (value: number | null) => string;
  activeLens: ReportLens;
  onSelect: (item: any) => void;
}) {
  const max = Math.max(1, ...items.map((item) => valueFor(item)));
  return (
    <section className="report-card report-trend-card">
      <header className="report-card-header">
        <div>
          <span>{subtitle}</span>
          <h2>{title}</h2>
        </div>
      </header>
      <div className="report-trend-list">
        {items.length === 0 && <div className="empty-state small">No trend data for this range.</div>}
        {items.map((item) => {
          const value = valueFor(item);
          const selected = activeLens?.type === "day" && activeLens.id === item.day;
          return (
            <button key={item.day} className={classNames("report-trend-row", selected && "selected")} onClick={() => onSelect(item)}>
              <span>{formatDayLabel(item.day)}</span>
              <div><i style={{ width: `${Math.max(4, (value / max) * 100)}%` }} /></div>
              <strong>{formatValue(value || null)}</strong>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function BreakdownCard({ title, label, items, lensType, activeLens, onSelect, timeMetric = "clear" }: {
  title: string;
  label: string;
  items: any[];
  lensType: NonNullable<ReportLens>["type"];
  activeLens: ReportLens;
  onSelect: (lens: ReportLens) => void;
  timeMetric?: "clear" | "resolve";
}) {
  const max = Math.max(1, ...items.map((item) => item.count ?? 0));
  return (
    <section className="report-card report-breakdown-card">
      <header className="report-card-header">
        <div>
          <span>{label}</span>
          <h2>{title}</h2>
        </div>
      </header>
      <div className="report-breakdown-list">
        {items.length === 0 && <div className="empty-state small">No rows found.</div>}
        {items.map((item) => {
          const id = item.id ?? item.hour ?? item.name;
          const selected = activeLens?.type === lensType && activeLens.id === id;
          return (
            <button key={id} className={classNames("report-breakdown-row", selected && "selected")} onClick={() => onSelect(selected ? null : { type: lensType, id, label: item.name ?? item.hour })}>
              <div>
                <strong>{item.name ?? item.hour}</strong>
                <span>Avg ack {shortDuration(item.averageAcknowledgeSeconds)} / {timeMetric} {shortDuration(timeMetric === "resolve" ? item.averageResolveSeconds : item.averageClearSeconds)}</span>
              </div>
              <em>{item.count}</em>
              <i style={{ width: `${Math.max(6, ((item.count ?? 0) / max) * 100)}%` }} />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ReportTable({ rows }: { rows: ReportRow[] }) {
  return (
    <section className="report-card report-table-card">
      <header className="report-card-header report-table-header">
        <div>
          <span>Exportable Data</span>
          <h2>Alert Table</h2>
        </div>
        <button className="report-export-button" onClick={() => exportCsv(rows)} disabled={rows.length === 0}>Export CSV</button>
      </header>
      <div className="report-table-wrap">
        <table className="report-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Machine</th>
              <th>Group</th>
              <th>Department</th>
              <th>Responder</th>
              <th>Command</th>
              <th>Status</th>
              <th>Ack</th>
              <th>Clear</th>
              <th>Resolve</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{dateTime(row.createdAt)}</td>
                <td><strong>{row.machine.name}</strong><span>{row.machine.code}</span></td>
                <td>{row.machine.groupName}</td>
                <td>{row.department.name}</td>
                <td>{row.responder?.name ?? "-"}</td>
                <td><strong>{row.commandLabel}</strong><span>{row.displayMessage ?? row.operatorNote ?? ""}</span></td>
                <td><em className={`report-status ${row.status.toLowerCase()}`}>{row.status}</em></td>
                <td>{duration(row.acknowledgeSeconds)}</td>
                <td>{duration(row.clearSeconds)}</td>
                <td>{duration(row.resolveSeconds)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10}><div className="empty-state small">No alert rows match the current filters.</div></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function machineMatchesLens(row: ReportRow, lens: ReportLens) {
  if (!lens) return true;
  if (lens.type === "department") return row.department.id === lens.id;
  if (lens.type === "machineGroup") return row.machine.groupId === lens.id;
  if (lens.type === "machine") return row.machine.id === lens.id;
  if (lens.type === "issue") return (row.issueType?.id ?? "general-help") === lens.id;
  if (lens.type === "hour") return row.hourKey === lens.id;
  if (lens.type === "day") return row.dayKey === lens.id;
  if (lens.type === "responder") return row.responder?.id === lens.id;
  return true;
}

export function ReportsPage() {
  const { session } = useAuth();
  const [start, setStart] = useState(dateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [end, setEnd] = useState(dateInputValue(new Date()));
  const [departmentId, setDepartmentId] = useState("");
  const [machineGroupId, setMachineGroupId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [responderId, setResponderId] = useState("");
  const [mode, setMode] = useState<ReportMode>("overview");
  const [lens, setLens] = useState<ReportLens>(null);

  const machineGroups = useMemo(() => Array.from(new Map((session?.machines ?? [])
    .filter((machine: any) => machine.machineGroup?.id)
    .map((machine: any) => [machine.machineGroup.id, machine.machineGroup])).values()), [session?.machines]);
  const machines = useMemo(() => (session?.machines ?? [])
    .filter((machine: any) => !machineGroupId || machine.machineGroup?.id === machineGroupId)
    .sort((a: any, b: any) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })), [session?.machines, machineGroupId]);

  const params = new URLSearchParams({ start, end });
  if (departmentId) params.set("departmentId", departmentId);
  if (machineGroupId) params.set("machineGroupId", machineGroupId);
  if (machineId) params.set("machineId", machineId);
  if (responderId) params.set("responderId", responderId);

  const reports = useQuery({
    queryKey: ["reports", start, end, departmentId, machineGroupId, machineId, responderId],
    queryFn: () => api<any>(`/api/reports/summary?${params.toString()}`)
  });
  const data = reports.data?.data;
  const byDay = data?.byDay ?? [];
  const rows = ((data?.alerts ?? []) as ReportRow[]).filter((row) => machineMatchesLens(row, lens));
  const topDepartment = data?.byDepartment?.[0]?.name ?? "No data";
  const topMachine = data?.byMachine?.[0]?.name ?? "No data";

  const selectedMachineGroupName = machineGroupId ? machineGroups.find((group: any) => group.id === machineGroupId)?.name : "All groups";
  const selectedMachineName = machineId ? machines.find((machine: any) => machine.id === machineId)?.name : "All machines";
  const responders = data?.byResponder ?? [];

  return (
    <div className="page-stack reports-page">
      <header className="reports-hero">
        <div className="operator-section-mark" aria-hidden="true">RP</div>
        <div className="operator-section-copy">
          <span>Reports</span>
          <h1>Alert Analytics</h1>
        </div>
        <div className="reports-hero-summary">
          <div><span>Alerts</span><strong>{data?.totalAlerts ?? 0}</strong></div>
          <div><span>Avg Ack</span><strong>{shortDuration(data?.averageAcknowledgeSeconds)}</strong></div>
          <div><span>Avg Clear</span><strong>{shortDuration(data?.averageClearSeconds)}</strong></div>
        </div>
      </header>

      <section className="reports-control-panel">
        <div className="report-filter-box">
          <span>Date Range</span>
          <div className="report-date-grid">
            <label>Start<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
            <label>End<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
          </div>
        </div>
        <div className="report-filter-box">
          <span>Department</span>
          <select value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setLens(null); }}>
            <option value="">All departments</option>
            {session?.departments.map((department: any) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
        </div>
        <div className="report-filter-box">
          <span>Machine Group</span>
          <select value={machineGroupId} onChange={(event) => { setMachineGroupId(event.target.value); setMachineId(""); setLens(null); }}>
            <option value="">All machine groups</option>
            {machineGroups.map((group: any) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </div>
        <div className="report-filter-box">
          <span>Machine</span>
          <select value={machineId} onChange={(event) => { setMachineId(event.target.value); setLens(null); }}>
            <option value="">All machines</option>
            {machines.map((machine: any) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
          </select>
        </div>
        <div className="report-filter-box">
          <span>Responder</span>
          <select value={responderId} onChange={(event) => { setResponderId(event.target.value); setLens(null); }}>
            <option value="">All responders</option>
            {responders.map((responder: any) => <option key={responder.id} value={responder.id}>{responder.name}</option>)}
          </select>
        </div>
      </section>

      <section className="reports-mode-row">
        <div className="reports-tabs" role="tablist" aria-label="Report views">
          {[
            ["overview", "Overview"],
            ["departments", "Departments"],
            ["machines", "Machines"],
            ["responders", "Responders"],
            ["table", "Data Table"]
          ].map(([id, label]) => (
            <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id as ReportMode)}>{label}</button>
          ))}
        </div>
        <div className="report-current-filter">
          <span>{selectedMachineGroupName}</span>
          <strong>{selectedMachineName}</strong>
        </div>
      </section>

      {lens && (
        <button className="report-lens-chip" onClick={() => setLens(null)}>
          Showing {lens.label}. Click to clear.
        </button>
      )}

      <section className="reports-metric-grid">
        <MetricTile label="Total Alerts" value={data?.totalAlerts ?? 0} detail={`${data?.closedAlerts ?? 0} closed in range`} tone="blue" />
        <MetricTile label="Open Work" value={data?.openAlerts ?? 0} detail="Open and acknowledged alerts" tone="red" />
        <MetricTile label="Top Department" value={topDepartment} detail={`${data?.byDepartment?.[0]?.count ?? 0} alerts`} />
        <MetricTile label="Top Machine" value={topMachine} detail={`${data?.byMachine?.[0]?.count ?? 0} alerts`} tone="amber" />
        <MetricTile label="Resolve Time" value={shortDuration(data?.averageResolveSeconds)} detail="Created to resolved" tone="green" />
      </section>

      {mode === "overview" && (
        <>
          <section className="reports-trend-grid">
            <TrendCard title="Alert Volume" subtitle="Daily Trend" items={byDay} valueFor={(item) => item.count ?? 0} formatValue={(value) => `${value ?? 0}`} activeLens={lens} onSelect={(item) => setLens(lens?.type === "day" && lens.id === item.day ? null : { type: "day", id: item.day, label: formatDayLabel(item.day) })} />
            <TrendCard title="Acknowledge Time" subtitle="Daily Average" items={byDay} valueFor={(item) => Math.round(item.averageAcknowledgeSeconds ?? 0)} formatValue={shortDuration} activeLens={lens} onSelect={(item) => setLens(lens?.type === "day" && lens.id === item.day ? null : { type: "day", id: item.day, label: formatDayLabel(item.day) })} />
            <TrendCard title="Clear Time" subtitle="Daily Average" items={byDay} valueFor={(item) => Math.round(item.averageClearSeconds ?? 0)} formatValue={shortDuration} activeLens={lens} onSelect={(item) => setLens(lens?.type === "day" && lens.id === item.day ? null : { type: "day", id: item.day, label: formatDayLabel(item.day) })} />
          </section>
          <section className="reports-breakdown-grid">
            <BreakdownCard title="Departments" label="Response Load" items={data?.byDepartment ?? []} lensType="department" activeLens={lens} onSelect={setLens} />
            <BreakdownCard title="Machine Groups" label="Where Calls Happen" items={data?.byMachineGroup ?? []} lensType="machineGroup" activeLens={lens} onSelect={setLens} />
            <BreakdownCard title="Issue Types" label="Call Reasons" items={data?.byIssue ?? []} lensType="issue" activeLens={lens} onSelect={setLens} />
          </section>
        </>
      )}

      {mode === "departments" && (
        <section className="reports-breakdown-grid expanded">
          <BreakdownCard title="Department Performance" label="Click a row to drill into data" items={data?.byDepartment ?? []} lensType="department" activeLens={lens} onSelect={setLens} />
          <BreakdownCard title="Issue Mix" label="Department Call Reasons" items={data?.byIssue ?? []} lensType="issue" activeLens={lens} onSelect={setLens} />
          <BreakdownCard title="By Hour" label="Demand Pattern" items={data?.byHour ?? []} lensType="hour" activeLens={lens} onSelect={setLens} />
        </section>
      )}

      {mode === "machines" && (
        <section className="reports-breakdown-grid expanded">
          <BreakdownCard title="Machine Groups" label="Group-Level Trend" items={data?.byMachineGroup ?? []} lensType="machineGroup" activeLens={lens} onSelect={setLens} />
          <BreakdownCard title="Machines" label="Machine-Level Detail" items={data?.byMachine ?? []} lensType="machine" activeLens={lens} onSelect={setLens} />
        </section>
      )}

      {mode === "responders" && (
        <section className="reports-breakdown-grid expanded">
          <BreakdownCard title="Responder Performance" label="Acknowledged alerts and end-to-end close time" items={responders} lensType="responder" activeLens={lens} onSelect={setLens} timeMetric="resolve" />
        </section>
      )}

      {(mode === "table" || lens) && <ReportTable rows={rows} />}
    </div>
  );
}
