import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
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

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/admin/bootstrap", { preHandler: app.requireAdmin }, async (request) => {
    const companyId = request.session.companyId;
    const [machineGroups, machines, departments, issueTypes, commandTemplates, users, pagerDevices] = await Promise.all([
      prisma.machineGroup.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.machine.findMany({ where: { companyId }, include: { machineGroup: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.department.findMany({ where: { companyId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.issueType.findMany({ where: { companyId }, include: { department: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.commandTemplate.findMany({ where: { companyId }, include: { targets: { include: { department: true, issueType: true }, orderBy: { sortOrder: "asc" } } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.user.findMany({ include: { memberships: { where: { companyId }, include: { scopes: true } } }, orderBy: { username: "asc" } }),
      prisma.pagerDevice.findMany({ where: { companyId }, include: { department: true }, orderBy: { name: "asc" } })
    ]);
    return { success: true, data: { machineGroups, machines, departments, issueTypes, commandTemplates, users, pagerDevices } };
  });

  app.post("/api/admin/machine-groups", { preHandler: app.requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; sortOrder?: number };
    const name = cleanString(body.name);
    if (!name) return reply.code(400).send({ success: false, error: "Name is required." });
    const item = await prisma.machineGroup.create({ data: { companyId: request.session.companyId, name, sortOrder: body.sortOrder ?? 0 } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/machine-groups/:id", { preHandler: app.requireAdmin }, async (request) => {
    const body = request.body as { name?: string; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    const item = await prisma.machineGroup.update({
      where: { id: params.id },
      data: { name: body.name, active: body.active, sortOrder: body.sortOrder }
    });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/machine-groups/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.machineGroup.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/machines", { preHandler: app.requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; code?: string; machineGroupId?: string; sortOrder?: number };
    const name = cleanString(body.name);
    const code = cleanString(body.code).toUpperCase();
    if (!name || !code || !body.machineGroupId) return reply.code(400).send({ success: false, error: "Name, code, and machine group are required." });
    const item = await prisma.machine.create({ data: { companyId: request.session.companyId, name, code, machineGroupId: body.machineGroupId, sortOrder: body.sortOrder ?? 0 } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/machines/:id", { preHandler: app.requireAdmin }, async (request) => {
    const body = request.body as { name?: string; code?: string; machineGroupId?: string; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    const item = await prisma.machine.update({ where: { id: params.id }, data: body });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/machines/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.machine.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/departments", { preHandler: app.requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; color?: string; sortOrder?: number };
    const name = cleanString(body.name);
    if (!name) return reply.code(400).send({ success: false, error: "Name is required." });
    const item = await prisma.department.create({ data: { companyId: request.session.companyId, name, color: body.color || "#2563eb", sortOrder: body.sortOrder ?? 0 } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/departments/:id", { preHandler: app.requireAdmin }, async (request) => {
    const body = request.body as { name?: string; color?: string; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    const item = await prisma.department.update({ where: { id: params.id }, data: body });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/departments/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.department.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/issue-types", { preHandler: app.requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; departmentId?: string; defaultPriority?: any; sortOrder?: number };
    const name = cleanString(body.name);
    if (!name || !body.departmentId) return reply.code(400).send({ success: false, error: "Name and department are required." });
    const item = await prisma.issueType.create({ data: { companyId: request.session.companyId, departmentId: body.departmentId, name, defaultPriority: body.defaultPriority ?? "NORMAL", sortOrder: body.sortOrder ?? 0 } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.patch("/api/admin/issue-types/:id", { preHandler: app.requireAdmin }, async (request) => {
    const body = request.body as { name?: string; departmentId?: string; defaultPriority?: any; active?: boolean; sortOrder?: number };
    const params = request.params as { id: string };
    const item = await prisma.issueType.update({ where: { id: params.id }, data: body });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/issue-types/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.issueType.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/command-templates", { preHandler: app.requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; buttonLabel?: string; color?: string; targets?: Array<{ departmentId: string; issueTypeId: string; targetMessage?: string; priority?: any }> };
    const name = cleanString(body.name);
    if (!name || !body.targets?.length) return reply.code(400).send({ success: false, error: "Name and at least one target are required." });
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

  app.patch("/api/admin/command-templates/:id", { preHandler: app.requireAdmin }, async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { name?: string; buttonLabel?: string; color?: string; active?: boolean; targets?: Array<{ departmentId: string; issueTypeId: string; targetMessage?: string; priority?: any }> };
    const item = await prisma.$transaction(async (tx) => {
      const template = await tx.commandTemplate.update({
        where: { id: params.id },
        data: { name: body.name, buttonLabel: body.buttonLabel, color: body.color, active: body.active }
      });
      if (body.targets) {
        await tx.commandTemplateTarget.deleteMany({ where: { commandTemplateId: template.id } });
        if (body.targets.length) {
          await tx.commandTemplateTarget.createMany({ data: body.targets.map((target, index) => ({ commandTemplateId: template.id, departmentId: target.departmentId, issueTypeId: target.issueTypeId, targetMessage: target.targetMessage ?? null, priority: target.priority ?? "NORMAL", sortOrder: (index + 1) * 10 })) });
        }
      }
      return tx.commandTemplate.findUniqueOrThrow({ where: { id: template.id }, include: { targets: true } });
    });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/command-templates/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.commandTemplate.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });

  app.post("/api/admin/users", { preHandler: app.requireAdmin }, async (request, reply) => {
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

  app.patch("/api/admin/users/:id", { preHandler: app.requireAdmin }, async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { active?: boolean };
    const item = await prisma.user.update({ where: { id: params.id }, data: { active: body.active } });
    changed(request.session.companyId);
    return { success: true, data: item };
  });

  app.delete("/api/admin/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.user.delete({ where: { id: params.id } }), request.session.companyId);
  });

  app.post("/api/admin/pager-devices", { preHandler: app.requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; departmentId?: string };
    const name = cleanString(body.name);
    if (!name || !body.departmentId) return reply.code(400).send({ success: false, error: "Name and department are required." });
    const token = generatePagerToken();
    const item = await prisma.pagerDevice.create({
      data: { companyId: request.session.companyId, departmentId: body.departmentId, name, tokenHash: sha256(token), tokenFingerprint: tokenFingerprint(token), active: true }
    });
    changed(request.session.companyId);
    return { success: true, data: { ...item, rawToken: token } };
  });

  app.patch("/api/admin/pager-devices/:id", { preHandler: app.requireAdmin }, async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { name?: string; active?: boolean; departmentId?: string; rotate?: boolean };
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

  app.delete("/api/admin/pager-devices/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const params = request.params as { id: string };
    return deleteOrConflict(reply, () => prisma.pagerDevice.delete({ where: { id: params.id, companyId: request.session.companyId } }), request.session.companyId);
  });
}
