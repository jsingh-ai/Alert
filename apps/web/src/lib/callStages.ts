import type { Alert, CommandGroup } from "./types";

/**
 * A call has two live stages; the operator closes it at the machine once it's fixed:
 *   waiting   called, no team has accepted it yet        (red)
 *   accepted  a responder accepted it and is handling it  (amber)
 * Older calls marked "arrived" (pagers can still send it) count as accepted.
 */
export type CallStage = "waiting" | "accepted";

/** A waiting call turns "late" after this long without being accepted. */
export const LATE_AFTER_SECONDS = 5 * 60;

const STAGE_RANK: Record<CallStage, number> = { waiting: 0, accepted: 1 };

function ms(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export type AlertTiming = {
  stage: CallStage;
  /** seconds from the call to it being accepted (or until now, while waiting) */
  waitSeconds: number;
  /** seconds in the current stage */
  stageSeconds: number;
  /** seconds since the call was made */
  totalSeconds: number;
  late: boolean;
  createdAt: number;
};

export function alertTiming(alert: Alert, now: number): AlertTiming {
  const created = ms(alert.createdAt) ?? now;
  const stage: CallStage = alert.status === "OPEN" ? "waiting" : "accepted";
  const acceptedAt = stage === "waiting" ? null : ms(alert.acknowledgedAt) ?? ms(alert.arrivedAt) ?? created;
  const seconds = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 1000));
  const waitSeconds = seconds(created, acceptedAt ?? now);
  return {
    stage,
    waitSeconds,
    stageSeconds: seconds(acceptedAt ?? created, now),
    totalSeconds: seconds(created, now),
    late: stage === "waiting" && waitSeconds >= LATE_AFTER_SECONDS,
    createdAt: created
  };
}

export type CallSummary = {
  command: CommandGroup;
  alerts: Array<{ alert: Alert; timing: AlertTiming }>;
  /** most urgent stage across the call's departments */
  stage: CallStage;
  late: boolean;
  totalSeconds: number;
  /** oldest unanswered wait, used for sorting */
  longestWaitSeconds: number;
};

export function summarizeCall(command: CommandGroup, now: number): CallSummary {
  const alerts = command.alerts
    .map((alert) => ({ alert, timing: alertTiming(alert, now) }))
    .sort((a, b) => STAGE_RANK[a.timing.stage] - STAGE_RANK[b.timing.stage] || b.timing.totalSeconds - a.timing.totalSeconds);
  const stage = alerts.reduce<CallStage>((worst, { timing }) => (STAGE_RANK[timing.stage] < STAGE_RANK[worst] ? timing.stage : worst), "accepted");
  const created = ms(command.createdAt) ?? Math.min(...alerts.map(({ timing }) => timing.createdAt));
  return {
    command,
    alerts,
    stage,
    late: alerts.some(({ timing }) => timing.late),
    totalSeconds: Math.max(0, Math.floor((now - created) / 1000)),
    longestWaitSeconds: Math.max(0, ...alerts.filter(({ timing }) => timing.stage === "waiting").map(({ timing }) => timing.waitSeconds))
  };
}

/**
 * The operator snapshot API returns one group per department alert (keyed commandId:alertId),
 * so a call sent to two teams arrives as two "commands". Merge them back into one call by
 * their shared realCommandId. Safe to run on already-grouped data.
 */
export function mergeByCall(commands: CommandGroup[]): CommandGroup[] {
  const merged = new Map<string, CommandGroup>();
  for (const command of commands) {
    const key = command.realCommandId ?? command.id;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...command, id: key, alerts: [...command.alerts] });
      continue;
    }
    const seen = new Set(existing.alerts.map((alert) => alert.id));
    existing.alerts.push(...command.alerts.filter((alert) => !seen.has(alert.id)));
    if (new Date(command.createdAt).getTime() < new Date(existing.createdAt).getTime()) existing.createdAt = command.createdAt;
  }
  return Array.from(merged.values());
}

/** Most urgent first: waiting calls by longest wait, then accepted calls, oldest first. */
export function sortCalls(calls: CallSummary[]) {
  return [...calls].sort((a, b) =>
    STAGE_RANK[a.stage] - STAGE_RANK[b.stage] ||
    b.longestWaitSeconds - a.longestWaitSeconds ||
    b.totalSeconds - a.totalSeconds
  );
}

/** Clock-style duration: 0:45, 7:41, 1:02:10 */
export function clock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
