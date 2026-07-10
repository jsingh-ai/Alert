import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { generatePagerToken, sha256, tokenFingerprint } from "../utils/crypto.js";
import { emitCompany } from "../services/realtime.js";

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function changed(companyId: string) {
  emitCompany(companyId, "admin.changed", { at: new Date().toISOString() });
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
    const [machineGroups, machines, departments, issueTypes, commandTemplates, users, pagerDevices] = await Promise.all([
      prisma.machineGroup.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.machine.findMany({ where: { companyId }, include: { machineGroup: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.department.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.issueType.findMany({ where: { companyId }, include: { department: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.commandTemplate.findMany({ where: { companyId }, include: { targets: { include: { department: true, issueType: true }, orderBy: { sortOrder: "asc" } } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.user.findMany({ where: { memberships: { some: { companyId } } }, include: { memberships: { where: { companyId }, include: { scopes: true } } }, orderBy: { username: "asc" } }),
      prisma.pagerDevice.findMany({ where: { companyId }, include: { department: true }, orderBy: { name: "asc" } })
    ]);
    return { success: true, data: { machineGroups, machines, departments, issueTypes, commandTemplates, users, pagerDevices } };
  });

  app.post("/api/admin/machine-groups", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; sortOrder?: number };
    const name = cleanString(body.name);
    if (!name) return reply.code(400).send({ success: false, error: "Name is required." });
    const item = await prisma.machineGroup.create({ data: { companyId: request.session.companyId, name, sortOrder: body.sortOrder ?? 0 } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/machine-groups/:id", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    const item = await updateOwned(reply, prisma.machineGroup, request.session.companyId, params.id, { name: body.name, active: body.active, sortOrder: body.sortOrder });
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
    if (!name || !code || !body.machineGroupId) return reply.code(400).send({ success: false, error: "Name, code, and machine group are required." });
    const group = await prisma.machineGroup.findFirst({ where: { id: body.machineGroupId, companyId: request.session.companyId }, select: { id: true } });
    if (!group) return reply.code(400).send({ success: false, error: "Machine group is not valid for this company." });
    const item = await prisma.machine.create({ data: { companyId: request.session.companyId, name, code, machineGroupId: body.machineGroupId, sortOrder: body.sortOrder ?? 0 } });
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
    const item = await updateOwned(reply, prisma.machine, request.session.companyId, params.id, body);
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
    if (!name) return reply.code(400).send({ success: false, error: "Name is required." });
    const item = await prisma.department.create({ data: { companyId: request.session.companyId, name, color: body.color || "#2563eb", sortOrder: body.sortOrder ?? 0 } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/departments/:id", adminWriteOptions, async (request, reply) => {
    const body = request.body as { name?: string; color?: string; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    const item = await updateOwned(reply, prisma.department, request.session.companyId, params.id, body);
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
    if (!name || !body.departmentId) return reply.code(400).send({ success: false, error: "Name and department are required." });
    const department = await prisma.department.findFirst({ where: { id: body.departmentId, companyId: request.session.companyId }, select: { id: true } });
    if (!department) return reply.code(400).send({ success: false, error: "Department is not valid for this company." });
    const item = await prisma.issueType.create({ data: { companyId: request.session.companyId, departmentId: body.departmentId, name, defaultPriority: body.defaultPriority ?? "NORMAL", sortOrder: body.sortOrder ?? 0 } });
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
    const item = await updateOwned(reply, prisma.issueType, request.session.companyId, params.id, body);
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
    if (!name || !body.targets?.length) return reply.code(400).send({ success: false, error: "Name and at least one target are required." });
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
        color: body.color || "#ef4444",
        targets: {
          create: body.targets.map((target, index) => ({
            departmentId: target.departmentId,
            issueTypeId: target.issueTypeId,
            targetMessage: target.targetMessage || null,
            priority: target.priority ?? "NORMAL",
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
    if (body.targets) {
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
        data: { name: body.name, buttonLabel: body.buttonLabel, color: body.color, active: body.active }
      });
      if (updated.count === 0) return null;
      const template = await tx.commandTemplate.findFirstOrThrow({ where: { id: params.id, companyId: request.session.companyId } });
      if (body.targets) {
        await tx.commandTemplateTarget.deleteMany({ where: { commandTemplateId: template.id } });
        if (body.targets.length) {
          await tx.commandTemplateTarget.createMany({ data: body.targets.map((target, index) => ({ commandTemplateId: template.id, departmentId: target.departmentId, issueTypeId: target.issueTypeId, targetMessage: target.targetMessage ?? null, priority: target.priority ?? "NORMAL", sortOrder: (index + 1) * 10 })) });
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
    if (!username || !body.password || !body.displayName || !body.role) return reply.code(400).send({ success: false, error: "Username, password, displayName, and role are required." });
    const passwordHash = await bcrypt.hash(body.password, 10);
    const item = await prisma.user.create({
      data: {
        username,
        passwordHash,
        displayName: body.displayName,
        memberships: { create: { companyId: request.session.companyId, role: body.role } }
      }
    });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/users/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { active?: boolean };
    const allowed = await prisma.membership.findFirst({ where: { userId: params.id, companyId: request.session.companyId }, select: { id: true } });
    if (!allowed) return reply.code(404).send({ success: false, error: "User not found." });
    const item = await prisma.user.update({ where: { id: params.id }, data: { active: body.active } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/users/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    const allowed = await prisma.membership.findFirst({ where: { userId: params.id, companyId: request.session.companyId }, select: { id: true } });
    if (!allowed) return reply.code(404).send({ success: false, error: "User not found." });
    const item = await prisma.user.update({ where: { id: params.id }, data: { active: false } });
    changed(request.session.companyId);
    return { success: true, data: item };
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
    const existing = await prisma.pagerDevice.findFirst({ where: { id: params.id, companyId: request.session.companyId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ success: false, error: "Pager not found." });
    if (body.departmentId) {
      const department = await prisma.department.findFirst({ where: { id: body.departmentId, companyId: request.session.companyId }, select: { id: true } });
      if (!department) return reply.code(400).send({ success: false, error: "Department is not valid for this company." });
    }
    if (body.rotate) {
      const token = generatePagerToken();
      const item = await prisma.pagerDevice.update({ where: { id: params.id }, data: { tokenHash: sha256(token), tokenFingerprint: tokenFingerprint(token) } });
      changed(request.session.companyId);
      return { success: true, data: { ...item, rawToken: token } };
    }
    const item = await prisma.pagerDevice.update({ where: { id: params.id }, data: { name: body.name, active: body.active, departmentId: body.departmentId } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/pager-devices/:id", adminWriteOptions, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.pagerDevice.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });
}
