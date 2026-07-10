import type { Prisma } from "@prisma/client";
import { elapsedSeconds } from "../utils/time.js";
import { ACTIVE_ALERT_STATUSES } from "./permissions.js";

type Db = Prisma.TransactionClient;

type AlertStatus = "OPEN" | "ACKNOWLEDGED" | "ARRIVED" | "RESOLVED" | "CANCELLED";
type AlertEventType = "CREATED" | "NOTE" | "ACKNOWLEDGED" | "ARRIVED" | "RESOLVED" | "CANCELLED" | "COMMAND_CREATED" | "DUPLICATE_MERGED";

type IncludedAlert = Prisma.AndonAlertGetPayload<{
  include: {
    machine: { include: { machineGroup: true } };
    department: true;
    issueType: true;
    command: true;
    events: { orderBy: { createdAt: "desc" }; take: 8 };
    communicationMessages: {
      where: { deletedAt: null };
      orderBy: { seq: "desc" };
      take: 20;
      include: { user: { select: { id: true; username: true; displayName: true } } };
    };
  };
}>;

type IncludedPagerAlert = Prisma.AndonAlertGetPayload<{
  include: {
    machine: true;
    department: true;
    issueType: true;
    command: true;
  };
}>;

export function actionAvailable(alert: { status: AlertStatus | string }) {
  if (alert.status === "OPEN") return "acknowledge";
  if (alert.status === "ACKNOWLEDGED" || alert.status === "ARRIVED") return "resolve";
  return "";
}

export function statusLabel(status: AlertStatus | string) {
  const labels: Record<AlertStatus, string> = {
    OPEN: "Open",
    ACKNOWLEDGED: "Acknowledged",
    ARRIVED: "Arrived",
    RESOLVED: "Resolved",
    CANCELLED: "Cancelled"
  };
  return labels[status as AlertStatus] ?? status;
}

function secondsBetween(start: Date | null, end: Date | null) {
  if (!start || !end) return null;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

function activeTimerStartedAt(alert: { status: AlertStatus | string; createdAt: Date; acknowledgedAt: Date | null; arrivedAt: Date | null }) {
  if (alert.status === "ARRIVED" && alert.arrivedAt) return alert.arrivedAt;
  if (alert.status === "ACKNOWLEDGED" && alert.acknowledgedAt) return alert.acknowledgedAt;
  return alert.createdAt;
}

function activeTimerStage(alert: { status: AlertStatus | string }) {
  if (alert.status === "ARRIVED") return "CLEAR";
  if (alert.status === "ACKNOWLEDGED") return "ARRIVE";
  return "ACKNOWLEDGE";
}

export function includeAlert() {
  return {
    machine: { include: { machineGroup: true } },
    department: true,
    issueType: true,
    command: true,
    events: { orderBy: { createdAt: "desc" as const }, take: 8 },
    communicationMessages: {
      where: { deletedAt: null },
      orderBy: { seq: "desc" as const },
      take: 20,
      include: { user: { select: { id: true, username: true, displayName: true } } }
    }
  };
}

export function includePagerAlert() {
  return {
    machine: true,
    department: true,
    issueType: true,
    command: true
  };
}

export function alertCommandLabel(alert: {
  issueType?: { name: string } | null;
  command?: { commandLabel?: string | null; commandTemplateId?: string | null } | null;
}) {
  const issueName = alert.issueType?.name ?? "Help Call";
  const commandLabel = alert.command?.commandLabel?.trim();
  if (!commandLabel) return issueName;
  if (!alert.command?.commandTemplateId && commandLabel.toLowerCase() === "manual help call") {
    return issueName;
  }
  return commandLabel;
}

export function serializeAlert(alert: IncludedAlert) {
  const issueName = alert.issueType?.name ?? "General help";
  const messages = [...alert.communicationMessages].reverse().filter((message) => message.messageType === "TEXT").map((message) => ({
    id: message.id,
    channelId: message.channelId,
    alertId: (message as any).alertId ?? alert.id,
    seq: message.seq,
    eventType: "NOTE",
    actorNameText: message.user.displayName,
    note: message.body,
    user: {
      id: message.user.id,
      username: message.user.username,
      displayName: message.user.displayName
    },
    clientMessageId: message.clientMessageId,
    createdAt: message.createdAt
  }));
  const legacyNotes = alert.events
    .filter((event) => event.eventType === "NOTE")
    .map((event) => ({
      id: event.id,
      eventType: event.eventType,
      actorNameText: event.actorNameText,
      note: event.note,
      createdAt: event.createdAt
    }));
  return {
    id: alert.id,
    commandId: alert.commandId,
    commandLabel: alertCommandLabel(alert),
    machine: {
      id: alert.machine.id,
      name: alert.machine.name,
      code: alert.machine.code,
      machine_code: alert.machine.code,
      group: alert.machine.machineGroup.name
    },
    department: {
      id: alert.department.id,
      name: alert.department.name,
      color: alert.department.color
    },
    issueType: alert.issueType ? {
      id: alert.issueType.id,
      name: alert.issueType.name,
      defaultPriority: alert.issueType.defaultPriority
    } : null,
    issueText: `${alert.department.name} / ${issueName}`,
    status: alert.status,
    statusLabel: statusLabel(alert.status),
    priority: alert.priority,
    displayMessage: alert.displayMessage,
    operatorNote: alert.operatorNote,
    responderNameText: alert.responderNameText,
    actionAvailable: actionAvailable(alert),
    elapsedSeconds: elapsedSeconds(activeTimerStartedAt(alert)),
    acknowledgeSeconds: secondsBetween(alert.createdAt, alert.acknowledgedAt),
    arriveSeconds: secondsBetween(alert.acknowledgedAt, alert.arrivedAt),
    responseSeconds: secondsBetween(alert.createdAt, alert.arrivedAt),
    clearSeconds: secondsBetween(alert.arrivedAt ?? alert.acknowledgedAt, alert.resolvedAt),
    activeTimerStartedAt: activeTimerStartedAt(alert),
    activeTimerStage: activeTimerStage(alert),
    createdAt: alert.createdAt,
    acknowledgedAt: alert.acknowledgedAt,
    arrivedAt: alert.arrivedAt,
    resolvedAt: alert.resolvedAt,
    cancelledAt: alert.cancelledAt,
    messages,
    events: [...legacyNotes, ...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    timelineEvents: alert.events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      actorNameText: event.actorNameText,
      note: event.note,
      createdAt: event.createdAt
    }))
  };
}

export function serializePagerAlert(alert: IncludedPagerAlert) {
  const issueName = alert.issueType?.name ?? "General help";
  return {
    id: alert.id,
    command_id: alert.commandId,
    command_label: alertCommandLabel(alert),
    machine: {
      id: alert.machine.id,
      name: alert.machine.name,
      machine_code: alert.machine.code,
      code: alert.machine.code
    },
    department: {
      id: alert.department.id,
      name: alert.department.name
    },
    issue_category: {
      id: alert.department.id,
      name: alert.department.name
    },
    issue_problem: alert.issueType ? {
      id: alert.issueType.id,
      name: alert.issueType.name
    } : {
      id: null,
      name: "General help"
    },
    issue_text: `${alert.department.name} / ${issueName}`,
    display_message: alert.displayMessage ?? alert.operatorNote ?? "",
    status: alert.status,
    status_label: statusLabel(alert.status),
    action_available: actionAvailable(alert),
    responder_name_text: alert.responderNameText ?? "",
    responder_name: alert.responderNameText ?? "",
    elapsed_seconds: elapsedSeconds(activeTimerStartedAt(alert)),
    active_timer_started_at: activeTimerStartedAt(alert),
    active_timer_stage: activeTimerStage(alert),
    priority: alert.priority
  };
}

export async function recalculateCommandStatus(db: Db, commandId: string | null) {
  if (!commandId) return;
  const alerts = await db.andonAlert.findMany({ where: { commandId }, select: { status: true } });
  if (alerts.length === 0) return;

  const active = alerts.filter((alert) => (ACTIVE_ALERT_STATUSES as readonly string[]).includes(alert.status));
  let status: "OPEN" | "IN_PROGRESS" | "PARTIAL" | "CLOSED" | "CANCELLED" = "CLOSED";
  if (active.some((alert) => alert.status === "OPEN")) {
    status = "OPEN";
  } else if (active.length > 0) {
    status = alerts.some((alert) => alert.status === "RESOLVED" || alert.status === "CANCELLED") ? "PARTIAL" : "IN_PROGRESS";
  } else if (alerts.every((alert) => alert.status === "CANCELLED")) {
    status = "CANCELLED";
  } else {
    status = "CLOSED";
  }

  await db.andonCommand.update({
    where: { id: commandId },
    data: {
      status,
      closedAt: status === "CLOSED" || status === "CANCELLED" ? new Date() : null
    }
  });
}

export async function addEvent(db: Db, input: {
  alertId: string;
  eventType: AlertEventType;
  actorUserId?: string | null;
  actorNameText?: string | null;
  note?: string | null;
  metadata?: Prisma.InputJsonValue;
}) {
  return db.alertEvent.create({
    data: {
      alertId: input.alertId,
      eventType: input.eventType,
      actorUserId: input.actorUserId ?? null,
      actorNameText: input.actorNameText ?? null,
      note: input.note ?? null,
      metadata: input.metadata ?? undefined
    }
  });
}

export async function transitionAlert(db: Db, input: {
  alertId: string;
  companyId: string;
  departmentId?: string;
  action: "acknowledge" | "arrive" | "resolve" | "cancel" | "note";
  actorUserId?: string | null;
  actorNameText?: string | null;
  responderNameText?: string | null;
  note?: string | null;
}) {
  const alert = await db.andonAlert.findFirst({
    where: {
      id: input.alertId,
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {})
    }
  });

  if (!alert) {
    const err = new Error("Alert not found in scope.") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }

  const now = new Date();
  const actorNameText = input.actorNameText ?? input.responderNameText ?? null;

  if (input.action === "note") {
    await addEvent(db, {
      alertId: alert.id,
      eventType: "NOTE",
      actorUserId: input.actorUserId ?? null,
      actorNameText,
      note: input.note ?? null
    });
    return db.andonAlert.findUniqueOrThrow({ where: { id: alert.id }, include: includeAlert() });
  }

  if (input.action === "acknowledge") {
    if (alert.status !== "OPEN") {
      const err = new Error("Alert is not open.") as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    await db.andonAlert.update({
      where: { id: alert.id },
      data: {
        status: "ACKNOWLEDGED",
        acknowledgedAt: now,
        acknowledgedByUserId: input.actorUserId ?? null,
        responderNameText: input.responderNameText ?? actorNameText ?? alert.responderNameText
      }
    });
    await addEvent(db, { alertId: alert.id, eventType: "ACKNOWLEDGED", actorUserId: input.actorUserId ?? null, actorNameText, note: input.note ?? null });
  }

  if (input.action === "arrive") {
    if (alert.status !== "OPEN" && alert.status !== "ACKNOWLEDGED") {
      const err = new Error("Alert cannot be marked arrived from its current state.") as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    await db.andonAlert.update({
      where: { id: alert.id },
      data: {
        status: "ARRIVED",
        acknowledgedAt: alert.acknowledgedAt ?? now,
        acknowledgedByUserId: alert.acknowledgedByUserId ?? input.actorUserId ?? null,
        arrivedAt: now,
        arrivedByUserId: input.actorUserId ?? null,
        responderNameText: input.responderNameText ?? actorNameText ?? alert.responderNameText
      }
    });
    await addEvent(db, { alertId: alert.id, eventType: "ARRIVED", actorUserId: input.actorUserId ?? null, actorNameText, note: input.note ?? null });
  }

  if (input.action === "resolve") {
    if (alert.status !== "ACKNOWLEDGED" && alert.status !== "ARRIVED") {
      const err = new Error("Alert must be acknowledged before it can be resolved.") as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    await db.andonAlert.update({
      where: { id: alert.id },
      data: {
        status: "RESOLVED",
        acknowledgedAt: alert.acknowledgedAt ?? now,
        acknowledgedByUserId: alert.acknowledgedByUserId ?? input.actorUserId ?? null,
        arrivedAt: alert.arrivedAt,
        arrivedByUserId: alert.arrivedByUserId,
        resolvedAt: now,
        resolvedByUserId: input.actorUserId ?? null,
        responderNameText: input.responderNameText ?? actorNameText ?? alert.responderNameText
      }
    });
    await addEvent(db, { alertId: alert.id, eventType: "RESOLVED", actorUserId: input.actorUserId ?? null, actorNameText, note: input.note ?? null });
  }

  if (input.action === "cancel") {
    if (alert.status === "RESOLVED" || alert.status === "CANCELLED") {
      const err = new Error("Alert is already closed.") as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    await db.andonAlert.update({
      where: { id: alert.id },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: input.actorUserId ?? null
      }
    });
    await addEvent(db, { alertId: alert.id, eventType: "CANCELLED", actorUserId: input.actorUserId ?? null, actorNameText, note: input.note ?? null });
  }

  await recalculateCommandStatus(db, alert.commandId);
  return db.andonAlert.findUniqueOrThrow({ where: { id: alert.id }, include: includeAlert() });
}
