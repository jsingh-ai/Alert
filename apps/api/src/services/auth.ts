import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import type { Membership, MembershipScope, User, Company } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { navForRole } from "../nav.js";

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

/**
 * Sign-in plus: this person's role has this page in its menu (nav.ts). A page's API answers exactly
 * the roles that can open the page, so calling the API directly gets no more than the screens show.
 */
export function requirePage(app: FastifyInstance, pageId: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    const role = (request.membershipContext?.role ?? "") as Role;
    if (!navForRole(role).some((item) => item.id === pageId)) {
      return reply.code(403).send({ success: false, error: "Your role doesn't have this page." });
    }
  };
}

export const authPlugin = fp(async (app) => {
  await app.register(jwt, { secret: config.jwtSecret });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify<SessionToken>();
      const token = request.user as SessionToken;
      const membership = await getMembershipContext(token.membershipId);
      if (
        !membership
        || !membership.active
        || !membership.user.active
        || !membership.company.active
        || membership.userId !== token.userId
        || membership.companyId !== token.companyId
      ) {
        return reply.code(401).send({ success: false, error: "Session is no longer active." });
      }
      request.session = {
        userId: membership.userId,
        membershipId: membership.id,
        companyId: membership.companyId,
        role: membership.role as Role
      };
      request.membershipContext = membership;
    } catch {
      return reply.code(401).send({ success: false, error: "Authentication required." });
    }
  });

  app.decorate("requireAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.membershipContext?.role !== "ADMIN") {
      return reply.code(403).send({ success: false, error: "Admin role required." });
    }
  });

  app.decorate("requireManagerOrAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!["ADMIN", "MANAGER"].includes(request.membershipContext?.role ?? "")) {
      return reply.code(403).send({ success: false, error: "Manager or admin role required." });
    }
  });
});
