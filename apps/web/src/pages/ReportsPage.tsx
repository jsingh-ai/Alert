import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dateInputValue } from "../lib/format";
import { LATE_AFTER_SECONDS } from "../lib/callStages";
import { useKiosk } from "../lib/kiosk";
import { SuiteHeader, SuiteMenu, SuiteStatusBar, TeamIcon, connectionState, teamHue } from "../components/Suite";
import { ChevronRightIcon } from "../components/icons";
import "../styles/reports.css";

/* ---------- Types & data ---------- */

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
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  acknowledgeSeconds?: number | null;
  clearSeconds?: number | null;
  resolveSeconds?: number | null;
};
type Job = {
  id: string;
  label: string;
  machine: { id: string; name: string; groupName: string };
  status: string;
  createdAt: string;
  closedAt?: string | null;
  totalSeconds: number | null;
  teams: Array<{ alertId: string; department: { id: string; name: string }; status: string; responder?: string | null; acknowledgeSeconds: number | null; arriveSeconds: number | null }>;
};
type Summary = { alerts?: ReportRow[]; jobs?: Job[] };
type Preset = "today" | "7d" | "30d" | "custom";
type Dimension = "department" | "machine" | "responder" | "reason";
type Dept = { id: string; name: string; color?: string | null };
type SeriesKey = { key: string; label: string; color: string };

const PRESETS: Array<{ id: Preset; label: string; days: number }> = [
  { id: "today", label: "Today", days: 1 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 }
];
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_SERIES = 8;
/** The report refreshes every minute; it reads as offline once its data is this old. */
const REFRESH_MS = 60_000;
const OFFLINE_AFTER_MS = 150_000;

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}
function parseDay(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function localDayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function avg(values: Array<number | null | undefined>) {
  const list = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}
function isLate(row: ReportRow, now: number) {
  if (row.acknowledgeSeconds != null) return row.acknowledgeSeconds > LATE_AFTER_SECONDS;
  return row.status === "OPEN" && (now - new Date(row.createdAt).getTime()) / 1000 > LATE_AFTER_SECONDS;
}

/** 4m 12s · 1h 05m · 41h */
function dur(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return h >= 10 ? `${h}h` : `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
function shortDate(date: Date) {
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
function pct(n: number | null) {
  return n == null ? "–" : `${Math.round(n * 100)}%`;
}
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`;

function summarize(rows: ReportRow[], now: number) {
  const answered = rows.filter((r) => r.acknowledgeSeconds != null);
  return {
    calls: rows.length,
    response: avg(rows.map((r) => r.acknowledgeSeconds)),
    fix: avg(rows.map((r) => r.clearSeconds)),
    waitTotal: rows.reduce((sum, r) => sum + (r.resolveSeconds ?? 0), 0),
    lateShare: rows.length ? rows.filter((r) => isLate(r, now)).length / rows.length : null,
    answered: answered.length
  };
}

function heatOf(rows: ReportRow[]) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  for (const r of rows) {
    const d = new Date(r.createdAt);
    grid[(d.getDay() + 6) % 7][d.getHours()]++;
  }
  let busiest = { day: 0, hour: 0, n: 0 };
  grid.forEach((row, day) => row.forEach((n, hour) => { if (n > busiest.n) busiest = { day, hour, n }; }));
  return { grid, max: Math.max(1, ...grid.flat()), busiest };
}

/**
 * Department series wear the suite's team colour (teamHue), so a department looks the same here as on
 * Machine Station and the queue. Teams that share a hue step lighter in department order. --rp-mix
 * lifts the hue in dark mode so it holds up on the navy card.
 */
function seriesColor(hue: string, tier: number) {
  const base = `color-mix(in srgb, ${hue} var(--rp-mix), #fff)`;
  return tier === 0 ? base : `color-mix(in srgb, ${base} ${Math.max(30, 100 - tier * 35)}%, var(--pg-card))`;
}
const OTHER_COLOR = "var(--rp-other)";
const TIME_KEYS: SeriesKey[] = [
  { key: "r", label: "Response", color: "var(--rp-response)" },
  { key: "f", label: "Fix", color: "var(--rp-fix)" }
];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}


/** Re-renders on an interval so freshness checks run even when no data arrives. */
function useClock(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* ---------- Page ---------- */

export function ReportsPage() {
  const { session } = useAuth();
  const kiosk = useKiosk();
  // Ticks, so the status bar notices when the data stops refreshing
  const now = useClock(15_000);
  const today = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }, []);
  const [preset, setPreset] = useState<Preset>("7d");
  const [customStart, setCustomStart] = useState(dateInputValue(addDays(today, -6)));
  const [customEnd, setCustomEnd] = useState(dateInputValue(today));
  const [departmentId, setDepartmentId] = useState("");
  const [machineGroupId, setMachineGroupId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [responderId, setResponderId] = useState("");
  const [dimension, setDimension] = useState<Dimension>("department");
  const [reason, setReason] = useState("");
  const [showCalls, setShowCalls] = useState(false);
  const [showJobs, setShowJobs] = useState(true);

  const range = useMemo(() => {
    if (preset === "custom") {
      const start = parseDay(customStart);
      const end = parseDay(customEnd);
      return end < start ? { start: end, end: start } : { start, end };
    }
    const days = PRESETS.find((p) => p.id === preset)?.days ?? 7;
    return { start: addDays(today, -(days - 1)), end: today };
  }, [preset, customStart, customEnd, today]);
  const days = Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS) + 1;
  const previous = { start: addDays(range.start, -days), end: addDays(range.start, -1) };

  const filters = { departmentId, machineGroupId, machineId, responderId };
  const params = (r: { start: Date; end: Date }) => {
    const p = new URLSearchParams({ start: localDayKey(r.start), end: localDayKey(r.end) });
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p.toString();
  };
  const current = useQuery({
    queryKey: ["reports", params(range)],
    queryFn: () => api<{ data?: Summary }>(`/api/reports/summary?${params(range)}`),
    refetchInterval: REFRESH_MS
  });
  const prior = useQuery({
    queryKey: ["reports", "prior", params(previous)],
    queryFn: () => api<{ data?: Summary }>(`/api/reports/summary?${params(previous)}`)
  });
  const connection = connectionState(current, now, OFFLINE_AFTER_MS);

  const allRows = current.data?.data?.alerts ?? [];
  const rows = useMemo(() => (reason ? allRows.filter((r) => (r.issueType?.id ?? "general") === reason) : allRows), [allRows, reason]);
  const priorRows = useMemo(() => {
    const list = prior.data?.data?.alerts ?? [];
    return reason ? list.filter((r) => (r.issueType?.id ?? "general") === reason) : list;
  }, [prior.data, reason]);
  const jobs = useMemo(() => (current.data?.data?.jobs ?? []).filter((job) => !reason || job.teams.some((team) => rows.some((r) => r.id === team.alertId))), [current.data, reason, rows]);
  const stats = summarize(rows, now);
  const before = prior.data ? summarize(priorRows, now) : null;
  const heat = useMemo(() => heatOf(rows), [rows]);

  // Department colours follow the department's fixed order, never its rank.
  // Up to 8 departments get their own series; past that, the first 7 do and the rest fold into "Other".
  const departments = (session?.departments ?? []) as Dept[];
  const deptById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments]);
  const ownSlots = departments.length <= MAX_SERIES ? MAX_SERIES : MAX_SERIES - 1;
  const colorOf = useMemo(() => {
    const tiers = new Map<string, number>();
    return new Map(departments.slice(0, ownSlots).map((d) => {
      const hue = teamHue(d);
      const tier = tiers.get(hue) ?? 0;
      tiers.set(hue, tier + 1);
      return [d.id, seriesColor(hue, tier)] as const;
    }));
  }, [departments, ownSlots]);
  const seriesKeys = useMemo<SeriesKey[]>(() => {
    const present = new Set(rows.map((r) => r.department.id));
    const named = departments.filter((d) => colorOf.has(d.id) && present.has(d.id)).map((d) => ({ key: d.id, label: d.name, color: colorOf.get(d.id) ?? OTHER_COLOR }));
    return rows.some((r) => !colorOf.has(r.department.id)) ? [...named, { key: "other", label: "Other", color: OTHER_COLOR }] : named;
  }, [rows, departments, colorOf]);
  const keyOf = (row: ReportRow) => (colorOf.has(row.department.id) ? row.department.id : "other");

  const machineGroups = useMemo(() => Array.from(new Map((session?.machines ?? [])
    .filter((m: any) => m.machineGroup?.id)
    .map((m: any) => [m.machineGroup.id, m.machineGroup])).values()) as Array<{ id: string; name: string }>, [session?.machines]);
  const machines = ((session?.machines ?? []) as any[])
    .filter((m) => !machineGroupId || m.machineGroup?.id === machineGroupId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const responders = useMemo(() => Array.from(new Map(allRows.filter((r) => r.responder).map((r) => [r.responder!.id, r.responder!])).values()).sort((a, b) => a.name.localeCompare(b.name)), [allRows]);
  const reasons = useMemo(() => Array.from(new Map(allRows.map((r) => [r.issueType?.id ?? "general", r.issueType?.name ?? "General help"])).entries()), [allRows]);

  const anyFilter = Boolean(departmentId || machineGroupId || machineId || responderId || reason);
  const clearFilters = () => { setDepartmentId(""); setMachineGroupId(""); setMachineId(""); setResponderId(""); setReason(""); };

  function drill(dim: Dimension, id: string) {
    if (dim === "department") setDepartmentId(id);
    if (dim === "machine") setMachineId(id);
    if (dim === "responder") setResponderId(id);
    if (dim === "reason") setReason(id);
  }

  const rangeLabel = days === 1 ? shortDate(range.start) : `${shortDate(range.start)} – ${shortDate(range.end)}`;
  const previousLabel = days === 1 ? shortDate(previous.start) : `${shortDate(previous.start)} – ${shortDate(previous.end)}`;
  // App bar label: the period and what the report is scoped to
  const period = preset === "today" ? "Today" : preset === "7d" ? "Last 7 days" : preset === "30d" ? "Last 30 days" : rangeLabel;
  const scope = [
    departments.find((d) => d.id === departmentId)?.name,
    machineId ? machines.find((m) => m.id === machineId)?.name : machineGroups.find((g) => g.id === machineGroupId)?.name,
    responders.find((r) => r.id === responderId)?.name
  ].filter(Boolean).join(" · ") || "All departments";

  return (
    <div className="su-page rp-page">
      <SuiteHeader eyebrow={`${period} · ${scope}`} title="Reports">
        <button type="button" className="rp-export" onClick={() => exportCsv(rows)} disabled={!rows.length}>
          <DownloadGlyph />
          Export CSV
        </button>
        {kiosk && <SuiteMenu label="Menu" />}
      </SuiteHeader>

      <section className="rp-toolbar" aria-label="Report filters">
        <div className="rp-seg" role="tablist" aria-label="Date range">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={preset === p.id} className={preset === p.id ? "on" : ""} onClick={() => setPreset(p.id)}>{p.label}</button>
          ))}
          <button type="button" role="tab" aria-selected={preset === "custom"} className={preset === "custom" ? "on" : ""} onClick={() => setPreset("custom")}>Custom</button>
        </div>
        {preset === "custom" ? (
          <div className="rp-dates">
            <input type="date" aria-label="Start date" value={customStart} max={customEnd} onChange={(e) => setCustomStart(e.target.value)} />
            <span>to</span>
            <input type="date" aria-label="End date" value={customEnd} min={customStart} onChange={(e) => setCustomEnd(e.target.value)} />
          </div>
        ) : (
          <span className="rp-range-label">{rangeLabel}</span>
        )}
        <span className="rp-sep" aria-hidden="true" />
        <div className="rp-filters">
          <select aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select aria-label="Machine group" value={machineGroupId} onChange={(e) => { setMachineGroupId(e.target.value); setMachineId(""); }}>
            <option value="">All machine groups</option>
            {machineGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select aria-label="Machine" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            <option value="">All machines</option>
            {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select aria-label="Responder" value={responderId} onChange={(e) => setResponderId(e.target.value)}>
            <option value="">All responders</option>
            {responders.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {reason && (
            <button type="button" className="rp-chip" onClick={() => setReason("")} aria-label="Remove reason filter">
              Reason: {reasons.find(([id]) => id === reason)?.[1]}
              <span aria-hidden="true">×</span>
            </button>
          )}
          {anyFilter && <button type="button" className="rp-clear" onClick={clearFilters}>Clear filters</button>}
        </div>
      </section>

      {current.isError && <p className="rp-error" role="alert">{current.error instanceof Error ? current.error.message : "Couldn't load the report."}</p>}

      <section className="rp-stats" aria-label="Summary">
        <Stat label="Calls" value={stats.calls.toLocaleString()} delta={before ? delta(stats.calls, before.calls, "neutral") : null} hint={`vs previous ${days === 1 ? "day" : `${days} days`}`} />
        <Stat label="Avg response" hint="call → accepted" value={dur(stats.response)} delta={before ? delta(stats.response, before.response, "down") : null} />
        <Stat label="Avg fix" hint="accepted → closed" value={dur(stats.fix)} delta={before ? delta(stats.fix, before.fix, "down") : null} />
        <Stat label="Machine wait" hint="total, call → closed" value={dur(stats.waitTotal)} delta={before ? delta(stats.waitTotal, before.waitTotal, "down") : null} />
        <Stat label="Late responses" hint={`over ${LATE_AFTER_SECONDS / 60} min`} value={pct(stats.lateShare)} delta={before ? delta(stats.lateShare, before.lateShare, "down", true) : null} />
      </section>

      <div className="rp-grid">
        <Card title={days <= 1 ? "Calls per hour" : "Calls per day"} action={seriesKeys.length > 1 ? <Legend items={seriesKeys} /> : undefined}>
          <CallsChart rows={rows} range={range} hourly={days <= 1} keys={seriesKeys} keyOf={keyOf} />
        </Card>
        <Card title="Where the time goes" action={<Legend items={TIME_KEYS} />} flush>
          <TimeSplit rows={rows} departments={departments} deptById={deptById} />
        </Card>
      </div>

      <Card
        title="When calls happen"
        meta={heat.busiest.n > 0 ? <>Busiest <strong>{WEEKDAYS[heat.busiest.day]} around {hourLabel(heat.busiest.hour)}</strong> · {heat.busiest.n} call{heat.busiest.n === 1 ? "" : "s"}</> : undefined}
        action={rows.length ? <HeatScale /> : undefined}
      >
        <Heatmap rows={rows} heat={heat} />
      </Card>

      <Card
        title="Breakdown"
        action={
          <div className="rp-seg small" role="tablist" aria-label="Breakdown">
            {(["department", "machine", "responder", "reason"] as Dimension[]).map((d) => (
              <button key={d} type="button" role="tab" aria-selected={dimension === d} className={dimension === d ? "on" : ""} onClick={() => setDimension(d)}>
                {d === "department" ? "Departments" : d === "machine" ? "Machines" : d === "responder" ? "Responders" : "Reasons"}
              </button>
            ))}
          </div>
        }
        flush
      >
        <Breakdown rows={rows} dimension={dimension} now={now} deptById={deptById} onPick={drill} />
      </Card>

      <Card
        title="Multi-team calls"
        meta={`${jobs.length.toLocaleString()} in this view`}
        action={<button type="button" className="rp-btn" onClick={() => setShowJobs((v) => !v)} aria-expanded={showJobs}>{showJobs ? "Hide" : "Show"}</button>}
        flush
      >
        {showJobs && <JobsTable jobs={jobs} />}
      </Card>

      <Card
        title="All calls"
        meta={`${rows.length.toLocaleString()} in this view`}
        action={<button type="button" className="rp-btn" onClick={() => setShowCalls((v) => !v)} aria-expanded={showCalls}>{showCalls ? "Hide" : "Show"}</button>}
        flush
      >
        {showCalls && <CallsTable rows={rows} deptById={deptById} />}
      </Card>

      <SuiteStatusBar connection={connection} lastGood={current.dataUpdatedAt}>
        Compared with {previousLabel}
      </SuiteStatusBar>
    </div>
  );
}

function DownloadGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
    </svg>
  );
}

/* ---------- Summary tiles ---------- */

type Delta = { text: string; tone: "good" | "bad" | "neutral" } | null;

function delta(cur: number | null, prev: number | null, better: "down" | "up" | "neutral", isShare = false): Delta {
  if (cur == null || prev == null) return null;
  if (prev === 0 && cur === 0) return { text: "no change", tone: "neutral" };
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9) return { text: "no change", tone: "neutral" };
  const arrow = diff > 0 ? "▲" : "▼";
  const text = isShare
    ? `${arrow} ${Math.abs(Math.round(diff * 100))} pts`
    : prev === 0 ? `${arrow} new` : `${arrow} ${Math.abs(Math.round((diff / prev) * 100))}%`;
  const tone = better === "neutral" ? "neutral" : (diff < 0) === (better === "down") ? "good" : "bad";
  return { text, tone };
}

function Stat({ label, value, delta: d, hint }: { label: string; value: string; delta: Delta; hint?: string }) {
  return (
    <div className="rp-stat">
      <span className="rp-stat-label">{label}</span>
      <strong className="rp-stat-value">{value}</strong>
      <span className="rp-stat-foot">
        {d && <span className={`rp-delta ${d.tone}`}>{d.text}</span>}
        {hint && <small>{hint}</small>}
      </span>
    </div>
  );
}

/** A card with its label inside, on a hairline: title left, an optional note, controls right. */
function Card({ title, meta, action, flush = false, className = "", children }: { title: string; meta?: ReactNode; action?: ReactNode; flush?: boolean; className?: string; children?: ReactNode }) {
  return (
    <section className={`rp-card ${className}`}>
      <header className="rp-card-head">
        <h2>{title}</h2>
        {meta && <span className="rp-card-meta">{meta}</span>}
        {action && <div className="rp-card-action">{action}</div>}
      </header>
      {children && <div className={`rp-card-body ${flush ? "flush" : ""}`}>{children}</div>}
    </section>
  );
}

/* ---------- Tooltip ---------- */

type Tip = { x: number; y: number; content: ReactNode } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return <div className="rp-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">{tip.content}</div>;
}

function Legend({ items }: { items: SeriesKey[] }) {
  return (
    <ul className="rp-legend">
      {items.map((item) => <li key={item.key}><i style={{ background: item.color }} />{item.label}</li>)}
    </ul>
  );
}

/* ---------- Calls over time: stacked columns ---------- */

/** Smallest clean axis max with 4 even steps (1, 2, 2.5, 5 × 10ⁿ). */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const raw = value / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  return step * 4;
}

function CallsChart({ rows, range, hourly, keys, keyOf }: {
  rows: ReportRow[];
  range: { start: Date; end: Date };
  hourly: boolean;
  keys: SeriesKey[];
  keyOf: (row: ReportRow) => string;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<Tip>(null);

  const buckets = useMemo(() => {
    const list: Array<{ key: string; label: string; counts: Map<string, number>; total: number }> = [];
    if (hourly) {
      for (let h = 0; h < 24; h++) list.push({ key: String(h), label: h % 6 === 0 ? hourLabel(h) : "", counts: new Map(), total: 0 });
      for (const r of rows) {
        const b = list[new Date(r.createdAt).getHours()];
        b.counts.set(keyOf(r), (b.counts.get(keyOf(r)) ?? 0) + 1);
        b.total++;
      }
    } else {
      for (let d = new Date(range.start); d <= range.end; d = addDays(d, 1)) list.push({ key: localDayKey(d), label: shortDate(d), counts: new Map(), total: 0 });
      const index = new Map(list.map((b, i) => [b.key, i]));
      for (const r of rows) {
        const i = index.get(localDayKey(new Date(r.createdAt)));
        if (i == null) continue;
        list[i].counts.set(keyOf(r), (list[i].counts.get(keyOf(r)) ?? 0) + 1);
        list[i].total++;
      }
    }
    return list;
  }, [rows, range, hourly, keyOf]);

  const height = 240;
  const pad = { l: 36, r: 8, t: 8, b: 26 };
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...buckets.map((b) => b.total)));
  const band = buckets.length ? plotW / buckets.length : 0;
  const barW = Math.max(3, Math.min(36, band * 0.5));
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 56))));

  return (
    // The measured box stays mounted, so the chart keeps tracking its width once data arrives
    <div ref={wrapRef} className="rp-plot" onMouseLeave={() => { setHover(null); setTip(null); }}>
      {!rows.length ? <div className="rp-empty">No calls in this range.</div> : width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Calls per ${hourly ? "hour" : "day"}, stacked by department. Total ${rows.length}.`}>
          {[0, 1, 2, 3, 4].map((i) => {
            const v = (max / 4) * i;
            return (
              <g key={i}>
                <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} className={i === 0 ? "rp-axis" : "rp-gridline"} />
                <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end" className="rp-tick">{Math.round(v).toLocaleString()}</text>
              </g>
            );
          })}
          {buckets.map((b, i) => {
            const cx = pad.l + band * i + band / 2;
            let acc = 0;
            const segs = keys.map((k) => ({ ...k, value: b.counts.get(k.key) ?? 0 })).filter((s) => s.value > 0);
            return (
              <g key={b.key} opacity={hover == null || hover === i ? 1 : 0.4}>
                {segs.map((s, si) => {
                  const top = y(acc + s.value);
                  const bottom = y(acc);
                  acc += s.value;
                  const h = Math.max(0, bottom - top - (si > 0 ? 2 : 0)); // 2px surface gap between segments
                  const x = cx - barW / 2;
                  const last = si === segs.length - 1;
                  if (!last || h < 4) return <rect key={s.key} x={x} y={top} width={barW} height={h} style={{ fill: s.color }} />;
                  const r = Math.min(4, barW / 2);
                  return <path key={s.key} style={{ fill: s.color }} d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`} />;
                })}
                {i % labelEvery === 0 && b.label && <text x={cx} y={height - 8} textAnchor="middle" className="rp-tick">{b.label}</text>}
                <rect
                  x={pad.l + band * i}
                  y={pad.t}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onMouseMove={(e) => {
                    setHover(i);
                    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setTip({
                      x: Math.min(e.clientX - box.left + 14, width - 190),
                      y: Math.max(0, e.clientY - box.top - 20),
                      content: (
                        <>
                          <strong>{hourly ? `${((Number(b.key) + 11) % 12) + 1}${Number(b.key) < 12 ? " AM" : " PM"}` : b.label} · {b.total} call{b.total === 1 ? "" : "s"}</strong>
                          {keys.map((k) => b.counts.get(k.key) ? <span key={k.key}><i style={{ background: k.color }} />{k.label}<em>{b.counts.get(k.key)}</em></span> : null)}
                        </>
                      )
                    });
                  }}
                />
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

/* ---------- Where the time goes: response vs fix per department ---------- */

function TimeSplit({ rows, departments, deptById }: { rows: ReportRow[]; departments: Dept[]; deptById: Map<string, Dept> }) {
  const [tip, setTip] = useState<Tip>(null);
  const items = useMemo(() => {
    const byDept = new Map<string, { name: string; rows: ReportRow[] }>();
    for (const r of rows) {
      const e = byDept.get(r.department.id) ?? { name: r.department.name, rows: [] };
      e.rows.push(r);
      byDept.set(r.department.id, e);
    }
    const order = new Map(departments.map((d, i) => [d.id, i]));
    return Array.from(byDept, ([id, e]) => ({ id, name: e.name, response: avg(e.rows.map((r) => r.acknowledgeSeconds)) ?? 0, fix: avg(e.rows.map((r) => r.clearSeconds)) ?? 0, count: e.rows.length }))
      .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  }, [rows, departments]);
  const max = Math.max(1, ...items.map((i) => i.response + i.fix));

  if (!items.length) return <div className="rp-empty">No calls in this range.</div>;
  return (
    <div className="rp-split" onMouseLeave={() => setTip(null)}>
      <ul className="rp-split-list">
        {items.map((item) => (
          <li
            key={item.id}
            onMouseMove={(e) => {
              const box = (e.currentTarget.closest(".rp-split") as HTMLElement).getBoundingClientRect();
              setTip({
                x: Math.min(e.clientX - box.left + 14, box.width - 190),
                y: e.clientY - box.top - 20,
                content: (
                  <>
                    <strong>{item.name} · {item.count} call{item.count === 1 ? "" : "s"}</strong>
                    <span><i style={{ background: "var(--rp-response)" }} />Response<em>{dur(item.response)}</em></span>
                    <span><i style={{ background: "var(--rp-fix)" }} />Fix<em>{dur(item.fix)}</em></span>
                  </>
                )
              });
            }}
          >
            <span className="rp-split-name">
              <TeamIcon department={deptById.get(item.id) ?? item} size="md" />
              <span><strong>{item.name}</strong><small>{item.count.toLocaleString()} call{item.count === 1 ? "" : "s"}</small></span>
            </span>
            <span className="rp-split-bar" aria-label={`${item.name}: response ${dur(item.response)}, fix ${dur(item.fix)}`}>
              {item.response > 0 && <i style={{ width: `${(item.response / max) * 100}%`, background: "var(--rp-response)" }} />}
              {item.fix > 0 && <i style={{ width: `${(item.fix / max) * 100}%`, background: "var(--rp-fix)" }} />}
            </span>
            <span className="rp-split-total">{dur(item.response + item.fix)}</span>
          </li>
        ))}
      </ul>
      <Tooltip tip={tip} />
    </div>
  );
}

/* ---------- When calls happen: weekday × hour heatmap ---------- */

function HeatScale() {
  return <div className="rp-heat-scale" aria-hidden="true"><span>Fewer</span>{[1, 2, 3, 4, 5, 6, 7].map((s) => <i key={s} className={`rp-heat-cell s${s}`} />)}<span>More</span></div>;
}

function Heatmap({ rows, heat }: { rows: ReportRow[]; heat: ReturnType<typeof heatOf> }) {
  const [tip, setTip] = useState<Tip>(null);
  const { grid, max } = heat;

  if (!rows.length) return <div className="rp-empty">No calls in this range.</div>;
  return (
    <div className="rp-heat-wrap" onMouseLeave={() => setTip(null)}>
      <div className="rp-heat" role="img" aria-label="Calls by weekday and hour">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="rp-heat-hour">{h % 3 === 0 ? hourLabel(h) : ""}</span>)}
        {grid.map((row, day) => (
          <div key={day} className="rp-heat-row">
            <span className="rp-heat-day">{WEEKDAYS[day]}</span>
            {row.map((n, hour) => {
              const step = n === 0 ? 0 : Math.min(7, Math.ceil((n / max) * 7));
              return (
                <i
                  key={hour}
                  className={`rp-heat-cell s${step}`}
                  onMouseMove={(e) => {
                    const box = (e.currentTarget.closest(".rp-heat-wrap") as HTMLElement).getBoundingClientRect();
                    setTip({ x: Math.min(e.clientX - box.left + 14, box.width - 170), y: e.clientY - box.top - 20, content: <strong>{WEEKDAYS[day]} {hourLabel(hour)} · {n} call{n === 1 ? "" : "s"}</strong> });
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/* ---------- Breakdown table ---------- */

function Breakdown({ rows, dimension, now, deptById, onPick }: { rows: ReportRow[]; dimension: Dimension; now: number; deptById: Map<string, Dept>; onPick: (dim: Dimension, id: string) => void }) {
  const items = useMemo(() => {
    const map = new Map<string, { id: string; name: string; sub?: string; rows: ReportRow[] }>();
    for (const r of rows) {
      const entry = dimension === "department" ? { id: r.department.id, name: r.department.name }
        : dimension === "machine" ? { id: r.machine.id, name: r.machine.name, sub: r.machine.groupName }
          : dimension === "responder" ? (r.responder ? { id: r.responder.id, name: r.responder.name } : { id: "", name: "No responder yet" })
            : { id: r.issueType?.id ?? "general", name: r.issueType?.name ?? "General help" };
      const e = map.get(entry.id) ?? { ...entry, rows: [] };
      e.rows.push(r);
      map.set(entry.id, e);
    }
    return Array.from(map.values())
      .map((e) => ({ ...e, count: e.rows.length, response: avg(e.rows.map((r) => r.acknowledgeSeconds)), fix: avg(e.rows.map((r) => r.clearSeconds)), late: e.rows.filter((r) => isLate(r, now)).length / e.rows.length }))
      .sort((a, b) => b.count - a.count);
  }, [rows, dimension, now]);
  const max = Math.max(1, ...items.map((i) => i.count));

  if (!items.length) return <div className="rp-empty">No calls in this range.</div>;
  return (
    <div className="rp-table-wrap">
      <table className="rp-table">
        <thead>
          <tr>
            <th>{dimension === "department" ? "Department" : dimension === "machine" ? "Machine" : dimension === "responder" ? "Responder" : "Reason"}</th>
            <th className="num">Calls</th>
            <th className="num">Avg response</th>
            <th className="num">Avg fix</th>
            <th className="num">Late</th>
            <th className="go" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id || "none"}
              className={item.id ? "clickable" : ""}
              title={item.id ? `Filter the report to ${item.name}` : undefined}
              onClick={() => item.id && onPick(dimension, item.id)}
              tabIndex={item.id ? 0 : -1}
              onKeyDown={(e) => { if (item.id && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(dimension, item.id); } }}
            >
              <td>
                <span className="rp-name">
                  {dimension === "department" && <TeamIcon department={deptById.get(item.id) ?? item} size="sm" />}
                  <span><strong>{item.name}</strong>{item.sub && <small>{item.sub}</small>}</span>
                </span>
              </td>
              <td className="num"><span className="rp-inline-bar"><i style={{ width: `${(item.count / max) * 100}%` }} /></span>{item.count}</td>
              <td className="num">{dur(item.response)}</td>
              <td className="num">{dur(item.fix)}</td>
              <td className={`num ${item.late > 0.2 ? "rp-warn" : ""}`}>{pct(item.late)}</td>
              <td className="go">{item.id && <ChevronRightIcon />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Multi-team calls ---------- */

function JobsTable({ jobs }: { jobs: Job[] }) {
  if (!jobs.length) return <p className="rp-more">No calls to more than one team in this view.</p>;
  return (
    <div className="rp-table-wrap tall">
      <table className="rp-table">
        <thead>
          <tr><th>When</th><th>Call</th><th>Machine</th><th className="num">Whole job</th><th>Time to arrive, by team</th><th>Status</th></tr>
        </thead>
        <tbody>
          {jobs.slice(0, 200).map((job) => (
            <tr key={job.id}>
              <td className="nowrap">{new Date(job.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
              <td><strong>{job.label}</strong></td>
              <td><strong>{job.machine.name}</strong><small>{job.machine.groupName}</small></td>
              <td className="num">{job.status === "CLOSED" ? dur(job.totalSeconds) : "–"}</td>
              <td>
                {job.teams.map((team) => (
                  <div key={team.alertId} className="rp-team-line">
                    <strong>{team.department.name}</strong> – {team.status === "CANCELLED" ? "cancelled" : team.arriveSeconds !== null ? dur(team.arriveSeconds) : "not yet"}
                  </div>
                ))}
              </td>
              <td><span className={`rp-status ${job.status.toLowerCase()}`}>{job.status === "CLOSED" ? "Closed" : job.status === "CANCELLED" ? "Cancelled" : "Open"}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- All calls ---------- */

function CallsTable({ rows, deptById }: { rows: ReportRow[]; deptById: Map<string, Dept> }) {
  const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500);
  return (
    <div className="rp-table-wrap tall">
      <table className="rp-table">
        <thead>
          <tr><th>When</th><th>Machine</th><th>Department</th><th>Reason</th><th>Responder</th><th className="num">Response</th><th className="num">Fix</th><th>Status</th></tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id}>
              <td className="nowrap">{new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
              <td><strong>{r.machine.name}</strong><small>{r.machine.groupName}</small></td>
              <td><span className="rp-name"><TeamIcon department={deptById.get(r.department.id) ?? r.department} size="sm" />{r.department.name}</span></td>
              <td>{r.issueType?.name ?? r.commandLabel}</td>
              <td>{r.responder?.name ?? "–"}</td>
              <td className="num">{dur(r.acknowledgeSeconds)}</td>
              <td className="num">{dur(r.clearSeconds)}</td>
              <td><span className={`rp-status ${r.status.toLowerCase()}`}>{r.status === "RESOLVED" ? "Closed" : r.status === "CANCELLED" ? "Cancelled" : r.status === "OPEN" ? "Open" : "Accepted"}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 500 && <p className="rp-more">Showing the latest 500. Export CSV for all {rows.length.toLocaleString()}.</p>}
    </div>
  );
}

function csv(value: unknown) {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

function exportCsv(rows: ReportRow[]) {
  const headers = ["Created", "Machine group", "Machine", "Code", "Department", "Responder", "Call", "Reason", "Status", "Priority", "Response (s)", "Fix (s)", "Total (s)", "Closed", "Message"];
  const lines = rows.map((r) => [
    r.createdAt, r.machine.groupName, r.machine.name, r.machine.code, r.department.name, r.responder?.name ?? "",
    r.commandLabel, r.issueType?.name ?? "General help", r.status, r.priority,
    r.acknowledgeSeconds ?? "", r.clearSeconds ?? "", r.resolveSeconds ?? "", r.resolvedAt ?? "", r.displayMessage ?? r.operatorNote ?? ""
  ].map(csv).join(","));
  const blob = new Blob([[headers.map(csv).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `processguard-calls-${dateInputValue(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
