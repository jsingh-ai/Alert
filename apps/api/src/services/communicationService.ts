import type { CommunicationChannel, CommunicationChannelMember, CommunicationMessage, Prisma } from "@prisma/client";
import { prisma } from "../db.js";

const CommunicationChannelType = {
  DEPARTMENT: "DEPARTMENT",
  MACHINE_GROUP: "MACHINE_GROUP",
  MACHINE: "MACHINE",
  CUSTOM: "CUSTOM"
} as const;

const CommunicationMemberRole = {
  MEMBER: "MEMBER",
  MODERATOR: "MODERATOR",
  OWNER: "OWNER"
} as const;

type CommunicationChannelTypeValue = typeof CommunicationChannelType[keyof typeof CommunicationChannelType];
type CommunicationMemberRoleValue = typeof CommunicationMemberRole[keyof typeof CommunicationMemberRole];

type ChannelWithMembership = CommunicationChannel & {
  members?: CommunicationChannelMember[];
  _count?: { members: number };
};

type MessageWithUser = CommunicationMessage & {
  user: { id: string; username: string; displayName: string } | null;
};

function httpError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

function isUniqueConflict(error: unknown) {
  return typeof error === "object" && error !== null && (error as any).code === "P2002";
}

async function createChannelRaceSafe(db: Prisma.TransactionClient, data: Prisma.CommunicationChannelUncheckedCreateInput) {
  try {
    return await db.communicationChannel.create({ data });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const channel = await db.communicationChannel.findUniqueOrThrow({
      where: { companyId_canonicalKey: { companyId: data.companyId, canonicalKey: data.canonicalKey } }
    });
    if (!channel.active || channel.archivedAt) {
      throw httpError("The communication channel is disabled.", 409);
    }
    return channel;
  }
}

export function serializeChannel(channel: ChannelWithMembership, member?: CommunicationChannelMember | null) {
  const membership = member ?? channel.members?.[0] ?? null;
  return {
    id: channel.id,
    canonicalKey: channel.canonicalKey,
    type: channel.type,
    name: channel.name,
    active: channel.active,
    archivedAt: channel.archivedAt,
    disabledAt: channel.disabledAt,
    lastMessageSeq: channel.lastMessageSeq,
    memberCount: channel._count?.members ?? 0,
    membership: membership ? {
      id: membership.id,
      role: membership.role,
      canRead: membership.canRead,
      canWrite: membership.canWrite,
      muted: membership.muted,
      lastReadSeq: membership.lastReadSeq,
      unreadCount: Math.max(0, channel.lastMessageSeq - membership.lastReadSeq)
    } : null,
    source: {
      departmentId: channel.departmentId,
      machineGroupId: channel.machineGroupId,
      machineId: channel.machineId
    },
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt
  };
}

export function serializeMessage(message: MessageWithUser) {
  const actorNameText = (message as any).actorNameText ?? message.user?.displayName ?? "System";
  return {
    id: message.id,
    channelId: message.channelId,
    alertId: (message as any).alertId ?? null,
    seq: message.seq,
    messageType: message.messageType,
    body: message.deletedAt ? "" : message.body,
    deletedAt: message.deletedAt,
    clientMessageId: message.clientMessageId,
    actorNameText,
    user: message.user ? {
      id: message.user.id,
      username: message.user.username,
      displayName: message.user.displayName
    } : null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  };
}

export async function ensureMachineCommunicationChannel(db: Prisma.TransactionClient, companyId: string, machineId: string) {
  const machine = await db.machine.findFirst({
    where: { id: machineId, companyId },
    select: { id: true, name: true }
  });
  if (!machine) throw httpError("Machine not found.", 404);

  const canonicalKey = `machine:${machine.id}`;
  const existing = await db.communicationChannel.findUnique({
    where: { companyId_canonicalKey: { companyId, canonicalKey } }
  });

  if (existing) {
    if (!existing.active || existing.archivedAt) {
      throw httpError("The machine communication channel is disabled.", 409);
    }
    if (existing.name !== machine.name || existing.machineId !== machine.id || existing.type !== CommunicationChannelType.MACHINE) {
      return db.communicationChannel.update({
        where: { id: existing.id },
        data: {
          type: CommunicationChannelType.MACHINE,
          name: machine.name,
          machineId: machine.id,
          departmentId: null,
          machineGroupId: null
        }
      });
    }
    return existing;
  }

  return createChannelRaceSafe(db, {
    companyId,
    canonicalKey,
    type: CommunicationChannelType.MACHINE,
    name: machine.name,
    machineId: machine.id
  });
}

export async function ensureDepartmentCommunicationChannel(db: Prisma.TransactionClient, companyId: string, departmentId: string) {
  const department = await db.department.findFirst({
    where: { id: departmentId, companyId },
    select: { id: true, name: true }
  });
  if (!department) throw httpError("Department not found.", 404);

  const canonicalKey = `department:${department.id}`;
  const existing = await db.communicationChannel.findUnique({
    where: { companyId_canonicalKey: { companyId, canonicalKey } }
  });

  if (existing) {
    if (!existing.active || existing.archivedAt) {
      throw httpError("The department communication channel is disabled.", 409);
    }
    if (existing.name !== department.name || existing.departmentId !== department.id || existing.type !== CommunicationChannelType.DEPARTMENT) {
      return db.communicationChannel.update({
        where: { id: existing.id },
        data: {
          type: CommunicationChannelType.DEPARTMENT,
          name: department.name,
          departmentId: department.id,
          machineGroupId: null,
          machineId: null
        }
      });
    }
    return existing;
  }

  return createChannelRaceSafe(db, {
    companyId,
    canonicalKey,
    type: CommunicationChannelType.DEPARTMENT,
    name: department.name,
    departmentId: department.id
  });
}

export async function createCommunicationMessage(db: Prisma.TransactionClient, input: {
  companyId: string;
  channelId: string;
  userId?: string | null;
  body: string;
  clientMessageId?: string | null;
  alertId?: string | null;
  messageType?: string;
  actorNameText?: string | null;
}) {
  const messageType = input.messageType ?? "TEXT";
  if (messageType === "TEXT" && !input.userId) {
    throw httpError("User is required for text messages.", 400);
  }
  const channel = await db.communicationChannel.update({
    where: { id: input.channelId, companyId: input.companyId },
    data: { lastMessageSeq: { increment: 1 } }
  });
  const message = await db.communicationMessage.create({
    data: {
      companyId: input.companyId,
      channelId: input.channelId,
      seq: channel.lastMessageSeq,
      userId: input.userId ?? null,
      body: input.body,
      messageType,
      clientMessageId: input.clientMessageId ?? null,
      alertId: input.alertId ?? null,
      actorNameText: input.actorNameText ?? null
    } as any,
    include: { user: { select: { id: true, username: true, displayName: true } } }
  });

  if (input.userId) {
    await db.communicationChannelMember.updateMany({
      where: {
        companyId: input.companyId,
        channelId: input.channelId,
        userId: input.userId,
        lastReadSeq: { lt: channel.lastMessageSeq }
      },
      data: { lastReadSeq: channel.lastMessageSeq }
    });
  }

  return message;
}

export async function createAlertSystemMessages(db: Prisma.TransactionClient, input: {
  companyId: string;
  userId?: string | null;
  machineId: string;
  departmentId: string;
  alertId: string;
  body: string;
  clientMessageKey: string;
  actorNameText?: string | null;
}) {
  const machineChannel = await ensureMachineCommunicationChannel(db, input.companyId, input.machineId);
  const departmentChannel = await ensureDepartmentCommunicationChannel(db, input.companyId, input.departmentId);

  const channels = [
    { channel: machineChannel, suffix: "machine" },
    { channel: departmentChannel, suffix: "department" }
  ];
  const notifications: Array<{ channelId: string; message: MessageWithUser }> = [];

  for (const { channel, suffix } of channels) {
    const message = await createCommunicationMessage(db, {
      companyId: input.companyId,
      channelId: channel.id,
      userId: input.userId,
      body: input.body,
      alertId: input.alertId,
      messageType: "SYSTEM",
      actorNameText: input.actorNameText ?? null,
      clientMessageId: `${input.clientMessageKey}:${input.alertId}:${suffix}`
    });
    notifications.push({ channelId: channel.id, message });
  }

  return notifications;
}

export async function findReadableMembership(companyId: string, userId: string, channelId: string) {
  return prisma.communicationChannelMember.findFirst({
    where: {
      companyId,
      userId,
      channelId,
      canRead: true,
      channel: { companyId, active: true, archivedAt: null }
    },
    include: { channel: true }
  });
}

export async function findWritableMembership(companyId: string, userId: string, channelId: string) {
  return prisma.communicationChannelMember.findFirst({
    where: {
      companyId,
      userId,
      channelId,
      canRead: true,
      canWrite: true,
      channel: { companyId, active: true, archivedAt: null }
    },
    include: { channel: true }
  });
}

function generatedChannelData(companyId: string, source: {
  type: CommunicationChannelTypeValue;
  canonicalKey: string;
  name: string;
  departmentId?: string | null;
  machineGroupId?: string | null;
  machineId?: string | null;
}) {
  return {
    companyId,
    canonicalKey: source.canonicalKey,
    type: source.type,
    name: source.name,
    departmentId: source.departmentId ?? null,
    machineGroupId: source.machineGroupId ?? null,
    machineId: source.machineId ?? null
  };
}

export async function syncGeneratedCommunicationChannels(companyId: string) {
  const [departments, machineGroups, machines] = await Promise.all([
    prisma.department.findMany({ where: { companyId, active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.machineGroup.findMany({ where: { companyId, active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.machine.findMany({ where: { companyId, active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })
  ]);

  const sources = [
    ...departments.map((department) => generatedChannelData(companyId, {
      type: CommunicationChannelType.DEPARTMENT,
      canonicalKey: `department:${department.id}`,
      name: department.name,
      departmentId: department.id
    })),
    ...machineGroups.map((group) => generatedChannelData(companyId, {
      type: CommunicationChannelType.MACHINE_GROUP,
      canonicalKey: `machine_group:${group.id}`,
      name: group.name,
      machineGroupId: group.id
    })),
    ...machines.map((machine) => generatedChannelData(companyId, {
      type: CommunicationChannelType.MACHINE,
      canonicalKey: `machine:${machine.id}`,
      name: machine.name,
      machineId: machine.id
    }))
  ];

  let created = 0;
  let updated = 0;
  const channels: CommunicationChannel[] = [];

  for (const source of sources) {
    const existing = await prisma.communicationChannel.findUnique({
      where: { companyId_canonicalKey: { companyId, canonicalKey: source.canonicalKey } }
    });

    channels.push(await prisma.communicationChannel.upsert({
      where: { companyId_canonicalKey: { companyId, canonicalKey: source.canonicalKey } },
      create: source,
      update: {
        name: source.name,
        departmentId: source.departmentId,
        machineGroupId: source.machineGroupId,
        machineId: source.machineId
      }
    }));
    if (existing) updated += 1;
    else created += 1;
  }

  return { created, updated, channels };
}

export async function replaceUserChannelMemberships(companyId: string, userId: string, memberships: Array<{
  channelId: string;
  role?: CommunicationMemberRoleValue;
  canRead?: boolean;
  canWrite?: boolean;
  muted?: boolean;
}>) {
  const user = await prisma.user.findFirst({
    where: { id: userId, memberships: { some: { companyId, active: true } } },
    select: { id: true }
  });
  if (!user) return null;

  const requestedChannelIds = Array.from(new Set(memberships.map((membership) => membership.channelId)));
  const channels = await prisma.communicationChannel.findMany({
    where: { companyId, id: { in: requestedChannelIds }, archivedAt: null },
    select: { id: true }
  });
  const allowedChannelIds = new Set(channels.map((channel) => channel.id));
  const validMemberships = memberships.filter((membership) => allowedChannelIds.has(membership.channelId) && membership.canRead !== false);
  const validChannelIds = validMemberships.map((membership) => membership.channelId);

  await prisma.$transaction(async (tx) => {
    await tx.communicationChannelMember.deleteMany({
      where: {
        companyId,
        userId,
        ...(validChannelIds.length ? { channelId: { notIn: validChannelIds } } : {})
      }
    });

    for (const membership of validMemberships) {
      await tx.communicationChannelMember.upsert({
        where: { channelId_userId: { channelId: membership.channelId, userId } },
        update: {
          role: membership.role ?? CommunicationMemberRole.MEMBER,
          canRead: membership.canRead ?? true,
          canWrite: membership.canWrite ?? true,
          muted: membership.muted ?? false
        },
        create: {
          companyId,
          userId,
          channelId: membership.channelId,
          role: membership.role ?? CommunicationMemberRole.MEMBER,
          canRead: membership.canRead ?? true,
          canWrite: membership.canWrite ?? true,
          muted: membership.muted ?? false
        }
      });
    }
  });

  return prisma.communicationChannelMember.findMany({
    where: { companyId, userId },
    include: { channel: true },
    orderBy: { channel: { name: "asc" } } as Prisma.CommunicationChannelMemberOrderByWithRelationInput
  });
}
