import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import type { Membership, MembershipScope, User, Company } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";

export type SessionToken = {
  userId: string;
  membershipId: string;
  companyId: string;
  role: Role;
};

export type Role = "ADMIN" | "MANAGER" | "OPERATOR" | "RESPONDER" | "VIEWER";

export type MembershipContext = Membership & {
  user: User;
  company: Company;
  scopes: MembershipScope[];
};

declare module "fastify" {
  interface FastifyRequest {
    session: SessionToken;
    membershipContext?: MembershipContext;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireManagerOrAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function getMembershipContext(membershipId: string) {
  return prisma.membership.findUnique({
    where: { id: membershipId },
    include: { user: true, company: true, scopes: true }
  });
}

export function signSession(app: FastifyInstance, membership: Membership) {
  const payload: SessionToken = {
    userId: membership.userId,
    membershipId: membership.id,
    companyId: membership.companyId,
    role: membership.role as Role
  };
  return app.jwt.sign(payload, { expiresIn: "12h" });
}

export const authPlugin = fp(async (app) => {
  await app.register(jwt, { secret: config.jwtSecret });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify<SessionToken>();
      request.session = request.user as SessionToken;
      const membership = await getMembershipContext(request.session.membershipId);
      if (!membership || !membership.active || !membership.user.active || !membership.company.active) {
        return reply.code(401).send({ success: false, error: "Session is no longer active." });
      }
      request.membershipContext = membership;
    } catch {
      return reply.code(401).send({ success: false, error: "Authentication required." });
    }
  });

  app.decorate("requireAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.session.role !== "ADMIN") {
      return reply.code(403).send({ success: false, error: "Admin role required." });
    }
  });

  app.decorate("requireManagerOrAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!["ADMIN", "MANAGER"].includes(request.session.role)) {
      return reply.code(403).send({ success: false, error: "Manager or admin role required." });
    }
  });
});
