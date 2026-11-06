import type { Prisma } from "@prisma/client";
import type { MembershipContext } from "./auth.js";

export const ACTIVE_ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED", "ARRIVED"] as const;

/** Only the role and scopes matter, so these also work for a membership loaded without its user and company. */
type ScopedRole = Pick<MembershipContext, "role" | "scopes">;

function scopeIds(ctx: ScopedRole, type: "DEPARTMENT" | "MACHINE_GROUP" | "MACHINE") {
  return ctx.scopes.filter((scope) => scope.scopeType === type).map((scope) => scope.scopeId);
}

export function hasScopedRestriction(ctx: MembershipContext, types: Array<"DEPARTMENT" | "MACHINE_GROUP" | "MACHINE">) {
  if (ctx.role === "ADMIN") return false;
  return ctx.scopes.some((scope) => types.includes(scope.scopeType as any));
}

/*
 * Who covers what (set in Admin -> Users):
 *   Operator   one machine (their station opens on it), or machine groups for a shared station
 *   Responder  one or more departments, AND the machines they cover: machine groups and/or single
 *              machines, or every machine when none are picked. They see and take a call only when
 *              both match: "Maintenance, Press 1-6" never sees Quality's calls or Extrusion's.
 *              ("Every machine" applies to their calls only: Team Calls, accepting, phone notifications.
 *              machineWhereForContext, which other pages use, still gives a responder only picked machines.)
 *   Manager    machine groups, or everything when none are picked
 *   Admin      everything
 */
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

export function scopedDepartmentIds(ctx: ScopedRole) {
  return scopeIds(ctx, "DEPARTMENT");
}

export function canSeeDepartment(ctx: ScopedRole, departmentId: string) {
  if (ctx.role === "ADMIN") return true;
  const ids = scopedDepartmentIds(ctx);
  if (ctx.role === "MANAGER" && ids.length === 0) return true;
  return ids.includes(departmentId);
}

/** Whether the machine is one this person covers. No machine limits: every machine (managers and responders). */
export function coversMachine(ctx: ScopedRole, machine: { id: string; machineGroupId: string }) {
  if (ctx.role === "ADMIN") return true;
  const machineIds = scopeIds(ctx, "MACHINE");
  const groupIds = scopeIds(ctx, "MACHINE_GROUP");
  if (machineIds.length === 0 && groupIds.length === 0) return ctx.role === "MANAGER" || ctx.role === "RESPONDER";
  return machineIds.includes(machine.id) || groupIds.includes(machine.machineGroupId);
}

/** Can take this call: the department is theirs and (when the machine is known) they cover the machine. */
export function canActAsResponder(ctx: ScopedRole, departmentId: string, machine?: { id: string; machineGroupId: string }) {
  if (ctx.role === "ADMIN") return true;
  if (ctx.role !== "MANAGER" && ctx.role !== "RESPONDER") return false;
  return canSeeDepartment(ctx, departmentId) && (!machine || coversMachine(ctx, machine));
}

export async function canUseMachine(ctx: MembershipContext, machineId: string, prisma: { machine: { findFirst: Function } }) {
  const machine = await prisma.machine.findFirst({
    where: { ...machineWhereForContext(ctx), id: machineId },
    select: { id: true }
  });
  return Boolean(machine);
}
