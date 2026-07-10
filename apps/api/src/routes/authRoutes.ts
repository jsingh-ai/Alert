import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { homeForRole, navForRole } from "../nav.js";
import { signSession } from "../services/auth.js";
import { departmentWhereForContext, machineWhereForContext } from "../services/permissions.js";

function publicMembership(membership: any) {
  return {
    id: membership.id,
    companyId: membership.companyId,
    companyName: membership.company.name,
    role: membership.role
  };
}

async function sessionPayload(membershipId: string) {
  const membership = await prisma.membership.findUniqueOrThrow({
    where: { id: membershipId },
    include: { user: true, company: true, scopes: true }
  });
  const departments = await prisma.department.findMany({ where: departmentWhereForContext(membership), orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const machines = await prisma.machine.findMany({ where: machineWhereForContext(membership), include: { machineGroup: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });

  return {
    user: {
      id: membership.user.id,
      username: membership.user.username,
      displayName: membership.user.displayName,
      workId: membership.user.workId,
      email: membership.user.email
    },
    company: {
      id: membership.company.id,
      name: membership.company.name,
      slug: membership.company.slug
    },
    membership: {
      id: membership.id,
      role: membership.role,
      scopes: membership.scopes
    },
    departments,
    machines,
    nav: navForRole(membership.role as any),
    homePath: homeForRole(membership.role as any),
    demoMode: config.demoMode
  };
}

export async function authRoutes(app: FastifyInstance) {
  const authRateLimit = { config: { rateLimit: { max: config.rateLimit.authMax, timeWindow: config.rateLimit.timeWindow } } };

  app.post("/api/auth/login", authRateLimit, async (request, reply) => {
    const body = request.body as { username?: string; password?: string; companyId?: string };
    const username = body.username?.trim().toLowerCase();
    const password = body.password ?? "";

    if (!username || !password) {
      return reply.code(400).send({ success: false, error: "Username and password are required." });
    }

    const user = await prisma.user.findUnique({
      where: { username },
      include: { memberships: { where: { active: true }, include: { company: true } } }
    });

    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ success: false, error: "Invalid username or password." });
    }

    const memberships = user.memberships.filter((membership) => membership.company.active);
    if (memberships.length === 0) {
      return reply.code(403).send({ success: false, error: "No active company access." });
    }

    if (!body.companyId && memberships.length > 1) {
      return reply.send({ success: true, needsCompany: true, companies: memberships.map(publicMembership) });
    }

    const membership = body.companyId ? memberships.find((item) => item.companyId === body.companyId) : memberships[0];
    if (!membership) {
      return reply.code(403).send({ success: false, error: "Selected company is not available for this user." });
    }

    const token = signSession(app, membership);
    return reply.send({ success: true, token, session: await sessionPayload(membership.id) });
  });

  app.post("/api/auth/demo", authRateLimit, async (request, reply) => {
    if (config.isProduction || !config.demoMode) {
      return reply.code(403).send({ success: false, error: "Demo mode is disabled." });
    }

    const body = request.body as { profile?: string; role?: string };
    const requested = (body.profile ?? body.role ?? "operator").toLowerCase();
    const usernameByProfile: Record<string, string> = {
      admin: "admin",
      manager: "manager",
      operator: "operator",
      quality: "quality",
      supervisor: "supervisor",
      responder: "quality",
      viewer: "viewer"
    };
    const username = usernameByProfile[requested] ?? "operator";

    const user = await prisma.user.findUnique({
      where: { username },
      include: { memberships: { where: { active: true }, include: { company: true } } }
    });
    const membership = user?.memberships.find((item) => item.company.active);
    if (!user?.active || !membership) {
      return reply.code(404).send({ success: false, error: `Demo user ${username} not found. Run npm run db:seed.` });
    }

    const token = signSession(app, membership);
    return reply.send({ success: true, token, session: await sessionPayload(membership.id) });
  });

  app.get("/api/session", { preHandler: app.authenticate }, async (request) => {
    return { success: true, session: await sessionPayload(request.session.membershipId) };
  });
}
