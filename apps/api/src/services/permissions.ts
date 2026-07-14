import type { Prisma } from "@prisma/client";
import type { MembershipContext } from "./auth.js";

export const ACTIVE_ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED", "ARRIVED"] as const;

function scopeIds(ctx: MembershipContext, type: "DEPARTMENT" | "MACHINE_GROUP" | "MACHINE") {
  return ctx.scopes.filter((scope) => scope.scopeType === type).map((scope) => scope.scopeId);
}

export function hasScopedRestriction(ctx: MembershipContext, types: Array<"DEPARTMENT" | "MACHINE_GROUP" | "MACHINE">) {
  if (ctx.role === "ADMIN") return false;
  return ctx.scopes.some((scope) => types.includes(scope.scopeType as any));
}

export function machineWhereForContext(ctx: MembershipContext): Prisma.MachineWhereInput {
  const base: Prisma.MachineWhereInput = { companyId: ctx.companyId, active: true, machineGroup: { active: true } };
  const machineIds = scopeIds(ctx, "MACHINE");
  const groupIds = scopeIds(ctx, "MACHINE_GROUP");
  if (ctx.role === "ADMIN") return base;
  if (ctx.role === "MANAGER" && machineIds.length === 0 && groupIds.length === 0) return base;
  if (machineIds.length === 0 && groupIds.length === 0) return { ...base, id: { in: [] } };
  return {
    ...base,
    OR: [
      machineIds.length ? { id: { in: machineIds } } : undefined,
      groupIds.length ? { machineGroupId: { in: groupIds } } : undefined
    ].filter(Boolean) as Prisma.MachineWhereInput[]
  };
}

export function departmentWhereForContext(ctx: MembershipContext): Prisma.DepartmentWhereInput {
  const base: Prisma.DepartmentWhereInput = { companyId: ctx.companyId, active: true };
  const departmentIds = scopeIds(ctx, "DEPARTMENT");
  if (ctx.role === "ADMIN") return base;
  if (ctx.role === "MANAGER" && departmentIds.length === 0) return base;
  if (departmentIds.length === 0) return { ...base, id: { in: [] } };
  return { ...base, id: { in: departmentIds } };
}

export function scopedDepartmentIds(ctx: MembershipContext) {
  return scopeIds(ctx, "DEPARTMENT");
}

export function canSeeDepartment(ctx: MembershipContext, departmentId: string) {
  if (ctx.role === "ADMIN") return true;
  const ids = scopedDepartmentIds(ctx);
  if (ctx.role === "MANAGER" && ids.length === 0) return true;
  return ids.includes(departmentId);
}

export function canActAsResponder(ctx: MembershipContext, departmentId: string) {
  if (ctx.role === "ADMIN") return true;
  if (ctx.role === "MANAGER") return canSeeDepartment(ctx, departmentId);
  if (ctx.role !== "RESPONDER") return false;
  return canSeeDepartment(ctx, departmentId);
}

export async function canUseMachine(ctx: MembershipContext, machineId: string, prisma: { machine: { findFirst: Function } }) {
  const machine = await prisma.machine.findFirst({
    where: { ...machineWhereForContext(ctx), id: machineId },
    select: { id: true }
  });
  return Boolean(machine);
}
