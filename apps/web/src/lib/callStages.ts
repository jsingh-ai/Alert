import type { Alert, CommandGroup } from "./types";

/**
 * A call moves through three live stages before the operator closes it at the machine:
 *   waiting   called, nobody has acknowledged yet          (red)
 *   onTheWay  acknowledged, responder travelling           (amber)
 *   onSite    responder marked arrived at the machine      (blue)
 */
export type CallStage = "waiting" | "onTheWay" | "onSite";

/** A waiting call turns "late" after this long without an acknowledgement. */
export const LATE_AFTER_SECONDS = 5 * 60;

const STAGE_RANK: Record<CallStage, number> = { waiting: 0, onTheWay: 1, onSite: 2 };

function ms(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export type AlertTiming = {
  stage: CallStage;
  /** seconds spent in each stage so far */
  waitSeconds: number;
  travelSeconds: number;
  fixSeconds: number;
  /** seconds in the current stage */
  stageSeconds: number;
  /** seconds since the call was made */
  totalSeconds: number;
  late: boolean;
  createdAt: number;
};

export function alertTiming(alert: Alert, now: number): AlertTiming {
  const created = ms(alert.createdAt) ?? now;
  const acknowledged = ms(alert.acknowledgedAt);
  const arrived = ms(alert.arrivedAt);
  const stage: CallStage = alert.status === "ARRIVED" || arrived ? "onSite" : alert.status === "OPEN" ? "waiting" : "onTheWay";
  const ackAt = stage === "waiting" ? null : acknowledged ?? created;
  const seconds = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 1000));
  const waitSeconds = seconds(created, ackAt ?? now);
  const travelSeconds = ackAt ? seconds(ackAt, stage === "onSite" ? arrived ?? now : now) : 0;
  const fixSeconds = stage === "onSite" && arrived ? seconds(arrived, now) : 0;
  const stageStart = stage === "onSite" ? arrived ?? now : stage === "onTheWay" ? ackAt ?? created : created;
  return {
    stage,
    waitSeconds,
    travelSeconds,
    fixSeconds,
    stageSeconds: seconds(stageStart, now),
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
  const stage = alerts.reduce<CallStage>((worst, { timing }) => (STAGE_RANK[timing.stage] < STAGE_RANK[worst] ? timing.stage : worst), "onSite");
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

/** Most urgent first: waiting calls by longest wait, then on-the-way, then on-site. */
export function sortCalls(calls: CallSummary[]) {
  return [...calls].sort((a, b) =>
    STAGE_RANK[a.stage] - STAGE_RANK[b.stage] ||
    b.longestWaitSeconds - a.longestWaitSeconds ||
    b.totalSeconds - a.totalSeconds
  );
}

export function stageLabel(stage: CallStage) {
  return stage === "waiting" ? "Waiting" : stage === "onTheWay" ? "On the way" : "On site";
}

/** Clock-style duration: 0:45, 7:41, 1:02:10 */
export function clock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
