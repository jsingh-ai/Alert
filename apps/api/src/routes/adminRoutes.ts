import type { FastifyInstance } from "fastify";
import { performance } from "node:perf_hooks";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { generatePagerToken, sha256, tokenFingerprint } from "../utils/crypto.js";
import { ACTIVE_ALERT_STATUSES } from "../services/permissions.js";
import { getQuickLoginProfiles, normalizeQuickLoginProfiles, QUICK_LOGIN_PROFILES, setQuickLoginProfiles } from "../services/quickLoginService.js";
import { emitCompany, getRealtimeStats } from "../services/realtime.js";
import { startOfDayInTimeZone } from "../utils/time.js";

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown) {
  if (value === undefined) return undefined;
  const text = cleanString(value);
  return text || undefined;
}

function optionalBoolean(value: unknown) {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

function optionalSortOrder(value: unknown, fallback?: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000) return null;
  return parsed;
}

function optionalPriority(value: unknown) {
  if (value === undefined) return undefined;
  return ["LOW", "NORMAL", "HIGH", "CRITICAL"].includes(String(value)) ? value : null;
}

function normalizedPriority(value: unknown) {
  const priority = optionalPriority(value);
  return priority === null ? null : priority ?? "NORMAL";
}

function optionalRole(value: unknown) {
  return ["ADMIN", "MANAGER", "OPERATOR", "RESPONDER", "VIEWER"].includes(String(value)) ? value : null;
}

function changed(companyId: string) {
  emitCompany(companyId, "admin.changed", { at: new Date().toISOString() });
}

function pagerStatus(lastSeenAt: Date | null) {
  if (!lastSeenAt) return "never";
  const ageMs = Date.now() - lastSeenAt.getTime();
  if (ageMs <= 2 * 60_000) return "online";
  if (ageMs <= 15 * 60_000) return "recent";
  return "offline";
}

async function deleteOrConflict(reply: any, action: () => Promise<any>, companyId: string) {
  try {
    const result = await action();
    changed(companyId);
    return { success: true, data: result };
  } catch (error: any) {
    if (error?.code === "P2003") {
      return reply.code(409).send({ success: false, error: "This item is still referenced by other records and cannot be deleted yet. Disable it instead, or remove the dependent records first." });
    }
    throw error;
  }
}

async function updateOwned(reply: any, delegate: any, companyId: string, id: string, data: any, include?: any) {
  const updated = await delegate.updateMany({ where: { id, companyId }, data });
  if (updated.count === 0) {
    return reply.code(404).send({ success: false, error: "Item not found." });
  }
  return delegate.findFirstOrThrow({ where: { id, companyId }, ...(include ? { include } : {}) });
}

export async function adminRoutes(app: FastifyInstance) {
  const adminWriteOptions = {
    preHandler: app.requireAdmin,
    config: { rateLimit: { max: config.rateLimit.adminWriteMax, timeWindow: config.rateLimit.timeWindow } }
  };

  app.get("/api/admin/bootstrap", { preHandler: app.requireAdmin }, async (request) => {
    const companyId = request.session.companyId;
    const [machineGroups, machines, departments, issueTypes, commandTemplates, users, pagerDevices, quickLoginProfiles] = await Promise.all([
      prisma.machineGroup.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.machine.findMany({ where: { companyId }, include: { machineGroup: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.department.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.issueType.findMany({ where: { companyId }, include: { department: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.commandTemplate.findMany({ where: { companyId }, include: { targets: { include: { department: true, issueType: true }, orderBy: { sortOrder: "asc" } } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.user.findMany({ where: { memberships: { some: { companyId } } }, include: { memberships: { where: { companyId }, include: { scopes: true } } }, orderBy: { username: "asc" } }),
      prisma.pagerDevice.findMany({ where: { companyId }, include: { department: true }, orderBy: { name: "asc" } }),
      getQuickLoginProfiles(companyId)
    ]);
    const scopedUsers = users.map((user) => ({
      ...user,
      active: user.active && Boolean(user.memberships[0]?.active)
    }));
    return { success: true, data: { machineGroups, machines, departments, issueTypes, commandTemplates, users: scopedUsers, pagerDevices, quickLoginProfiles } };
  });

  app.put("/api/admin/quick-login", adminWriteOptions, async (request, reply) => {
    const body = request.body as { profiles?: unknown };
    if (!Array.isArray(body.profiles)) {
      return reply.code(400).send({ success: false, error: "Quick login profiles must be an array." });
    }
    const profiles = normalizeQuickLoginProfiles(body.profiles);
    if (profiles.length !== body.profiles.length) {
      return reply.code(400).send({ success: false, error: "One or more quick login profiles are invalid." });
    }
    await setQuickLoginProfiles(request.session.companyId, profiles);
    changed(request.session.companyId);
    return { success: true, data: { availableProfiles: QUICK_LOGIN_PROFILES, enabledProfiles: profiles } };
  });

  app.get("/api/admin/status", { preHandler: app.requireAdmin }, async (request, reply) => {
    const companyId = request.session.companyId;
    const dbStart = performance.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return reply.code(503).send({ success: false, error: "Database is unavailable." });
    }
    const dbLatencyMs = Math.round(performance.now() - dbStart);
    const todayStart = startOfDayInTimeZone(new Date(), config.reportTimeZone);
    const [
      realtime,
      activeAlerts,
      alertsCreatedToday,
      alertsResolvedToday,
      machineCount,
      departmentCount,
      userCount,
      channelCount,
      messageCount,
      pagers
    ] = await Promise.all([
      getRealtimeStats(companyId),
      prisma.andonAlert.count({ where: { companyId, status: { in: [...ACTIVE_ALERT_STATUSES] } } }),
      prisma.andonAlert.count({ where: { companyId, createdAt: { gte: todayStart } } }),
      prisma.andonAlert.count({ where: { companyId, resolvedAt: { gte: todayStart } } }),
      prisma.machine.count({ where: { companyId } }),
      prisma.department.count({ where: { companyId } }),
      prisma.user.count({ where: { memberships: { some: { companyId } } } }),
      prisma.communicationChannel.count({ where: { companyId, archivedAt: null } }),
      prisma.communicationMessage.count({ where: { companyId } }),
      prisma.pagerDevice.findMany({
        where: { companyId },
        select: { id: true, name: true, active: true, lastSeenAt: true, department: { select: { name: true } } },
        orderBy: { name: "asc" }
      })
    ]);

    const memory = process.memoryUsage();
    return {
      success: true,
      data: {
        server: {
          now: new Date().toISOString(),
          nodeEnv: config.nodeEnv,
          nodeVersion: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          reportTimeZone: config.reportTimeZone,
          memory: {
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
            heapTotalBytes: memory.heapTotal
          }
        },
        database: {
          status: "ok",
          latencyMs: dbLatencyMs
        },
        realtime,
        activity: {
          activeAlerts,
          alertsCreatedToday,
          alertsResolvedToday
        },
        storage: {
          machines: machineCount,
          departments: departmentCount,
          users: userCount,
          channels: channelCount,
          messages: messageCount
        },
        pagers: pagers.map((pager) => ({
          id: pager.id,
          name: pager.name,
          departmentName: pager.department.name,
          active: pager.active,
          lastSeenAt: pager.lastSeenAt,
          status: pager.active ? pagerStatus(pager.lastSeenAt) : "disabled"
        }))
      }
    };
  });

  app.post("/api/admin/machine-groups", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; sortOrder?: number };
    const name = cleanString(body.name);
    const sortOrder = optionalSortOrder(body.sortOrder, 0);
    if (!name) return reply.code(400).send({ success: false, error: "Name is required." });
    if (sortOrder === null) return reply.code(400).send({ success: false, error: "Sort order must be a whole number." });
    const item = await prisma.machineGroup.create({ data: { companyId: request.session.companyId, name, sortOrder } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/machine-groups/:id", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    const active = optionalBoolean(body.active);
    const sortOrder = optionalSortOrder(body.sortOrder);
    if (active === null) return reply.code(400).send({ success: false, error: "Active must be true or false." });
    if (sortOrder === null) return reply.code(400).send({ success: false, error: "Sort order must be a whole number." });
    const data = { name: optionalString(body.name), active, sortOrder };
    if (Object.values(data).every((value) => value === undefined)) return reply.code(400).send({ success: false, error: "No changes provided." });
    const item = await updateOwned(reply, prisma.machineGroup, request.session.companyId, params.id, data);
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/machine-groups/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.machineGroup.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/machines", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; code?: string; machineGroupId?: string; sortOrder?: number };
    const name = cleanString(body.name);
    const code = cleanString(body.code).toUpperCase();
    const sortOrder = optionalSortOrder(body.sortOrder, 0);
    if (!name || !code || !body.machineGroupId) return reply.code(400).send({ success: false, error: "Name, code, and machine group are required." });
    if (sortOrder === null) return reply.code(400).send({ success: false, error: "Sort order must be a whole number." });
    const group = await prisma.machineGroup.findFirst({ where: { id: body.machineGroupId, companyId: request.session.companyId }, select: { id: true } });
    if (!group) return reply.code(400).send({ success: false, error: "Machine group is not valid for this company." });
    const item = await prisma.machine.create({ data: { companyId: request.session.companyId, name, code, machineGroupId: body.machineGroupId, sortOrder } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/machines/:id", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; code?: string; machineGroupId?: string; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    if (body.machineGroupId) {
      const group = await prisma.machineGroup.findFirst({ where: { id: body.machineGroupId, companyId: request.session.companyId }, select: { id: true } });
      if (!group) return reply.code(400).send({ success: false, error: "Machine group is not valid for this company." });
    }
    const active = optionalBoolean(body.active);
    const sortOrder = optionalSortOrder(body.sortOrder);
    if (active === null) return reply.code(400).send({ success: false, error: "Active must be true or false." });
    if (sortOrder === null) return reply.code(400).send({ success: false, error: "Sort order must be a whole number." });
    const data = {
      name: optionalString(body.name),
      code: optionalString(body.code)?.toUpperCase(),
      machineGroupId: body.machineGroupId,
      active,
      sortOrder
    };
    if (Object.values(data).every((value) => value === undefined)) return reply.code(400).send({ success: false, error: "No changes provided." });
    const item = await updateOwned(reply, prisma.machine, request.session.companyId, params.id, data);
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/machines/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.machine.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/departments", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; color?: string; sortOrder?: number };
    const name = cleanString(body.name);
    const sortOrder = optionalSortOrder(body.sortOrder, 0);
    if (!name) return reply.code(400).send({ success: false, error: "Name is required." });
    if (sortOrder === null) return reply.code(400).send({ success: false, error: "Sort order must be a whole number." });
    const item = await prisma.department.create({ data: { companyId: request.session.companyId, name, color: optionalString(body.color) || "#2563eb", sortOrder } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/departments/:id", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; color?: string; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    const active = optionalBoolean(body.active);
    const sortOrder = optionalSortOrder(body.sortOrder);
    if (active === null) return reply.code(400).send({ success: false, error: "Active must be true or false." });
    if (sortOrder === null) return reply.code(400).send({ success: false, error: "Sort order must be a whole number." });
    const data = { name: optionalString(body.name), color: optionalString(body.color), active, sortOrder };
    if (Object.values(data).every((value) => value === undefined)) return reply.code(400).send({ success: false, error: "No changes provided." });
    const item = await updateOwned(reply, prisma.department, request.session.companyId, params.id, data);
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/departments/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.department.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/issue-types", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; departmentId?: string; defaultPriority?: any; sortOrder?: number };
    const name = cleanString(body.name);
    const defaultPriority = normalizedPriority(body.defaultPriority);
    const sortOrder = optionalSortOrder(body.sortOrder, 0);
    if (!name || !body.departmentId) return reply.code(400).send({ success: false, error: "Name and department are required." });
    if (defaultPriority === null) return reply.code(400).send({ success: false, error: "Priority is not valid." });
    if (sortOrder === null) return reply.code(400).send({ success: false, error: "Sort order must be a whole number." });
    const department = await prisma.department.findFirst({ where: { id: body.departmentId, companyId: request.session.companyId }, select: { id: true } });
    if (!department) return reply.code(400).send({ success: false, error: "Department is not valid for this company." });
    const item = await prisma.issueType.create({ data: { companyId: request.session.companyId, departmentId: body.departmentId, name, defaultPriority: defaultPriority as any, sortOrder } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/issue-types/:id", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; departmentId?: string; defaultPriority?: any; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    if (body.departmentId) {
      const department = await prisma.department.findFirst({ where: { id: body.departmentId, companyId: request.session.companyId }, select: { id: true } });
      if (!department) return reply.code(400).send({ success: false, error: "Department is not valid for this company." });
    }
    const active = optionalBoolean(body.active);
    const defaultPriority = optionalPriority(body.defaultPriority);
    const sortOrder = optionalSortOrder(body.sortOrder);
    if (active === null) return reply.code(400).send({ success: false, error: "Active must be true or false." });
    if (defaultPriority === null) return reply.code(400).send({ success: false, error: "Priority is not valid." });
    if (sortOrder === null) return reply.code(400).send({ success: false, error: "Sort order must be a whole number." });
    const data = { name: optionalString(body.name), departmentId: body.departmentId, defaultPriority, active, sortOrder };
    if (Object.values(data).every((value) => value === undefined)) return reply.code(400).send({ success: false, error: "No changes provided." });
    const item = await updateOwned(reply, prisma.issueType, request.session.companyId, params.id, data);
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/issue-types/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.issueType.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/command-templates", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; buttonLabel?: string; color?: string; targets?: Array<{ departmentId: string; issueTypeId: string; targetMessage?: string; priority?: any }> };
    const name = cleanString(body.name);
    if (!name || !Array.isArray(body.targets) || !body.targets.length) return reply.code(400).send({ success: false, error: "Name and at least one target are required." });
    const targetPriorities = body.targets.map((target) => normalizedPriority(target.priority));
    if (targetPriorities.some((priority) => priority === null)) {
      return reply.code(400).send({ success: false, error: "One or more command target priorities are not valid." });
    }
    const validTargets = await prisma.issueType.findMany({
      where: {
        companyId: request.session.companyId,
        OR: body.targets.map((target) => ({ id: target.issueTypeId, departmentId: target.departmentId }))
      },
      select: { id: true, departmentId: true }
    });
    if (validTargets.length !== body.targets.length) {
      return reply.code(400).send({ success: false, error: "One or more command targets are not valid for this company." });
    }
    const template = await prisma.commandTemplate.create({
      data: {
        companyId: request.session.companyId,
        name,
        buttonLabel: cleanString(body.buttonLabel) || name,
        color: optionalString(body.color) || "#ef4444",
        targets: {
          create: body.targets.map((target, index) => ({
            departmentId: target.departmentId,
            issueTypeId: target.issueTypeId,
            targetMessage: target.targetMessage || null,
            priority: targetPriorities[index] as any,
            sortOrder: (index + 1) * 10
          }))
        }
      },
      include: { targets: true }
    });
    changed(request.session.companyId);
    return { success: true, data: template };
  });

  app.patch("/api/admin/command-templates/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { name?: string; buttonLabel?: string; color?: string; active?: boolean; targets?: Array<{ departmentId: string; issueTypeId: string; targetMessage?: string; priority?: any }> };
    const active = optionalBoolean(body.active);
    if (active === null) return reply.code(400).send({ success: false, error: "Active must be true or false." });
    const templateData = { name: optionalString(body.name), buttonLabel: optionalString(body.buttonLabel), color: optionalString(body.color), active };
    if (!body.targets && Object.values(templateData).every((value) => value === undefined)) {
      return reply.code(400).send({ success: false, error: "No changes provided." });
    }
    let targetPriorities: Array<unknown> | null = null;
    if (body.targets) {
      if (!Array.isArray(body.targets) || !body.targets.length) {
        return reply.code(400).send({ success: false, error: "At least one target is required." });
      }
      targetPriorities = body.targets.map((target) => normalizedPriority(target.priority));
      if (targetPriorities.some((priority) => priority === null)) {
        return reply.code(400).send({ success: false, error: "One or more command target priorities are not valid." });
      }
      const validTargets = await prisma.issueType.findMany({
        where: {
          companyId: request.session.companyId,
          OR: body.targets.map((target) => ({ id: target.issueTypeId, departmentId: target.departmentId }))
        },
        select: { id: true, departmentId: true }
      });
      if (validTargets.length !== body.targets.length) {
        return reply.code(400).send({ success: false, error: "One or more command targets are not valid for this company." });
      }
    }
    const item = await prisma.$transaction(async (tx) => {
      const updated = await tx.commandTemplate.updateMany({
        where: { id: params.id, companyId: request.session.companyId },
        data: templateData
      });
      if (updated.count === 0) return null;
      const template = await tx.commandTemplate.findFirstOrThrow({ where: { id: params.id, companyId: request.session.companyId } });
      if (body.targets) {
        await tx.commandTemplateTarget.deleteMany({ where: { commandTemplateId: template.id } });
        if (body.targets.length) {
          await tx.commandTemplateTarget.createMany({ data: body.targets.map((target, index) => ({ commandTemplateId: template.id, departmentId: target.departmentId, issueTypeId: target.issueTypeId, targetMessage: cleanString(target.targetMessage) || null, priority: targetPriorities![index] as any, sortOrder: (index + 1) * 10 })) });
        }
      }
      return tx.commandTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { targets: true } });
    });
    if (!item) return reply.code(404).send({ success: false, error: "Item not found." });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/command-templates/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.commandTemplate.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/users", adminWriteOptions, async (request, reply) => {
    const body = request.body as { username?: string; password?: string; displayName?: string; role?: any };
    const username = cleanString(body.username).toLowerCase();
    const displayName = cleanString(body.displayName);
    const role = optionalRole(body.role);
    if (!username || !body.password || !displayName || !role) return reply.code(400).send({ success: false, error: "Username, password, displayName, and valid role are required." });
    if (body.password.length < 8) return reply.code(400).send({ success: false, error: "Password must be at least 8 characters." });
    const passwordHash = await bcrypt.hash(body.password, 10);
    const item = await prisma.user.create({
      data: {
        username,
        passwordHash,
        displayName,
        memberships: { create: { companyId: request.session.companyId, role: role as any } }
      }
    });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/users/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { active?: boolean; username?: string; displayName?: string; password?: string; role?: any };
    const active = optionalBoolean(body.active);
    if (active === null) return reply.code(400).send({ success: false, error: "Active must be true or false." });

    const username = body.username === undefined ? undefined : cleanString(body.username).toLowerCase();
    const displayName = body.displayName === undefined ? undefined : cleanString(body.displayName);
    const role = body.role === undefined ? undefined : optionalRole(body.role);
    const password = body.password === undefined ? undefined : String(body.password);
    if (body.username !== undefined && !username) return reply.code(400).send({ success: false, error: "Username is required." });
    if (body.displayName !== undefined && !displayName) return reply.code(400).send({ success: false, error: "Display name is required." });
    if (role === null) return reply.code(400).send({ success: false, error: "Role is invalid." });
    if (password !== undefined && password.length > 0 && password.length < 8) return reply.code(400).send({ success: false, error: "Password must be at least 8 characters." });

    const userData: any = {};
    if (username !== undefined) userData.username = username;
    if (displayName !== undefined) userData.displayName = displayName;
    if (password) userData.passwordHash = await bcrypt.hash(password, 10);

    const membershipData: any = {};
    if (active !== undefined) membershipData.active = active;
    if (role !== undefined) membershipData.role = role;

    if (Object.keys(userData).length === 0 && Object.keys(membershipData).length === 0) {
      return reply.code(400).send({ success: false, error: "No changes provided." });
    }

    const allowed = await prisma.membership.findFirst({ where: { userId: params.id, companyId: request.session.companyId }, select: { id: true } });
    if (!allowed) return reply.code(404).send({ success: false, error: "User not found." });
    try {
      const item = await prisma.$transaction(async (tx) => {
        if (Object.keys(membershipData).length) await tx.membership.update({ where: { id: allowed.id }, data: membershipData });
        if (Object.keys(userData).length) await tx.user.update({ where: { id: params.id }, data: userData });
        if (active) await tx.user.update({ where: { id: params.id }, data: { active: true } });
        const user = await tx.user.findUniqueOrThrow({ where: { id: params.id }, include: { memberships: { where: { companyId: request.session.companyId }, include: { scopes: true } } } });
        return { ...user, active: user.active && Boolean(user.memberships[0]?.active) };
      });
      changed(request.session.companyId);
      return { success: true, data: item };
    } catch (error: any) {
      if (error?.code === "P2002") {
        return reply.code(409).send({ success: false, error: "That username is already in use." });
      }
      throw error;
    }
  });

  app.delete("/api/admin/users/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    const allowed = await prisma.membership.findFirst({ where: { userId: params.id, companyId: request.session.companyId }, select: { id: true } });
    if (!allowed) return reply.code(404).send({ success: false, error: "User not found." });
    const item = await prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: allowed.id }, data: { active: false } });
      const user = await tx.user.findUniqueOrThrow({ where: { id: params.id }, include: { memberships: { where: { companyId: request.session.companyId }, include: { scopes: true } } } });
      return { ...user, active: false };
    });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.get("/api/admin/users/:userId/scopes", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { userId: string };
    const companyId = request.session.companyId;
    const membership = await prisma.membership.findFirst({
      where: { userId: params.userId, companyId },
      include: { scopes: true }
    });
    if (!membership) return reply.code(404).send({ success: false, error: "User not found." });
    const [departments, machineGroups, machines] = await Promise.all([
      prisma.department.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.machineGroup.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.machine.findMany({ where: { companyId }, include: { machineGroup: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })
    ]);
    return {
      success: true,
      data: {
        scopes: membership.scopes,
        departments,
        machineGroups,
        machines
      }
    };
  });

  app.put("/api/admin/users/:userId/scopes", adminWriteOptions, async (request, reply) => {
    const params = request.params as { userId: string };
    const companyId = request.session.companyId;
    const body = request.body as { departmentIds?: unknown; machineGroupIds?: unknown; machineIds?: unknown };
    if (!Array.isArray(body.departmentIds) || !Array.isArray(body.machineGroupIds) || !Array.isArray(body.machineIds)) {
      return reply.code(400).send({ success: false, error: "Scope selections must be arrays." });
    }
    const normalizeScopeIds = (values: unknown[], label: string) => {
      const ids: string[] = [];
      for (const value of values) {
        const id = cleanString(value);
        if (!id) {
          return { ids: [], error: `${label} contains an invalid id.` };
        }
        ids.push(id);
      }
      return { ids, error: null };
    };
    const departmentScope = normalizeScopeIds(body.departmentIds, "Department access");
    const machineGroupScope = normalizeScopeIds(body.machineGroupIds, "Machine group access");
    const machineScope = normalizeScopeIds(body.machineIds, "Machine access");
    if (departmentScope.error || machineGroupScope.error || machineScope.error) {
      return reply.code(400).send({ success: false, error: departmentScope.error ?? machineGroupScope.error ?? machineScope.error });
    }
    const departmentIds = departmentScope.ids;
    const machineGroupIds = machineGroupScope.ids;
    const machineIds = machineScope.ids;
    if (departmentIds.length !== new Set(departmentIds).size || machineGroupIds.length !== new Set(machineGroupIds).size || machineIds.length !== new Set(machineIds).size) {
      return reply.code(400).send({ success: false, error: "Duplicate scopes are not allowed." });
    }

    const membership = await prisma.membership.findFirst({ where: { userId: params.userId, companyId }, select: { id: true } });
    if (!membership) return reply.code(404).send({ success: false, error: "User not found." });

    const [departmentCount, machineGroupCount, machineCount] = await Promise.all([
      departmentIds.length ? prisma.department.count({ where: { companyId, id: { in: departmentIds } } }) : 0,
      machineGroupIds.length ? prisma.machineGroup.count({ where: { companyId, id: { in: machineGroupIds } } }) : 0,
      machineIds.length ? prisma.machine.count({ where: { companyId, id: { in: machineIds } } }) : 0
    ]);
    if (departmentCount !== departmentIds.length) return reply.code(400).send({ success: false, error: "One or more departments are invalid." });
    if (machineGroupCount !== machineGroupIds.length) return reply.code(400).send({ success: false, error: "One or more machine groups are invalid." });
    if (machineCount !== machineIds.length) return reply.code(400).send({ success: false, error: "One or more machines are invalid." });

    const scopes = [
      ...departmentIds.map((scopeId) => ({ membershipId: membership.id, scopeType: "DEPARTMENT" as const, scopeId })),
      ...machineGroupIds.map((scopeId) => ({ membershipId: membership.id, scopeType: "MACHINE_GROUP" as const, scopeId })),
      ...machineIds.map((scopeId) => ({ membershipId: membership.id, scopeType: "MACHINE" as const, scopeId }))
    ];
    const saved = await prisma.$transaction(async (tx) => {
      await tx.membershipScope.deleteMany({ where: { membershipId: membership.id } });
      if (scopes.length) await tx.membershipScope.createMany({ data: scopes });
      return tx.membershipScope.findMany({ where: { membershipId: membership.id }, orderBy: [{ scopeType: "asc" }, { scopeId: "asc" }] });
    });
    changed(companyId);
    return { success: true, data: { scopes: saved } };
  });

  app.post("/api/admin/pager-devices", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; departmentId?: string };
    const name = cleanString(body.name);
    if (!name || !body.departmentId) return reply.code(400).send({ success: false, error: "Name and department are required." });
    const department = await prisma.department.findFirst({ where: { id: body.departmentId, companyId: request.session.companyId }, select: { id: true } });
    if (!department) return reply.code(400).send({ success: false, error: "Department is not valid for this company." });
    const token = generatePagerToken();
    const item = await prisma.pagerDevice.create({
      data: { companyId: request.session.companyId, departmentId: body.departmentId, name, tokenHash: sha256(token), tokenFingerprint: tokenFingerprint(token), active: true }
    });
    changed(request.session.companyId);
    return { success: true, data: { ...item, rawToken: token } };
  });

  app.patch("/api/admin/pager-devices/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { name?: string; active?: boolean; departmentId?: string; rotate?: boolean };
    const active = optionalBoolean(body.active);
    if (active === null) return reply.code(400).send({ success: false, error: "Active must be true or false." });
    const existing = await prisma.pagerDevice.findFirst({ where: { id: params.id, companyId: request.session.companyId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ success: false, error: "Pager not found." });
    if (body.departmentId) {
      const department = await prisma.department.findFirst({ where: { id: body.departmentId, companyId: request.session.companyId }, select: { id: true } });
      if (!department) return reply.code(400).send({ success: false, error: "Department is not valid for this company." });
    }
    if (body.rotate) {
      const token = generatePagerToken();
      await prisma.pagerDevice.updateMany({ where: { id: params.id, companyId: request.session.companyId }, data: { tokenHash: sha256(token), tokenFingerprint: tokenFingerprint(token) } });
      const item = await prisma.pagerDevice.findFirstOrThrow({ where: { id: params.id, companyId: request.session.companyId } });
      changed(request.session.companyId);
      return { success: true, data: { ...item, rawToken: token } };
    }
    const data = { name: optionalString(body.name), active, departmentId: body.departmentId };
    if (Object.values(data).every((value) => value === undefined)) return reply.code(400).send({ success: false, error: "No changes provided." });
    await prisma.pagerDevice.updateMany({ where: { id: params.id, companyId: request.session.companyId }, data });
    const item = await prisma.pagerDevice.findFirstOrThrow({ where: { id: params.id, companyId: request.session.companyId } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/pager-devices/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.pagerDevice.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });
}
