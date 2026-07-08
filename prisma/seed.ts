import { createHash } from "node:crypto";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { PrismaClient, Priority, Role, ScopeType } from "@prisma/client";

dotenv.config();

const prisma = new PrismaClient();

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenFingerprint(token: string) {
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

async function user(username: string, displayName: string, role: Role, companyId: string, password = `${username}123`) {
  const passwordHash = await bcrypt.hash(password, 10);
  const u = await prisma.user.upsert({
    where: { username },
    update: { displayName, passwordHash, active: true },
    create: { username, displayName, passwordHash, active: true }
  });

  const membership = await prisma.membership.upsert({
    where: { userId_companyId: { userId: u.id, companyId } },
    update: { role, active: true },
    create: { userId: u.id, companyId, role, active: true }
  });

  return { user: u, membership };
}

async function resetScopes(membershipId: string, scopes: Array<{ scopeType: ScopeType; scopeId: string }>) {
  await prisma.membershipScope.deleteMany({ where: { membershipId } });
  if (scopes.length) {
    await prisma.membershipScope.createMany({ data: scopes.map((s) => ({ ...s, membershipId })) });
  }
}

async function main() {
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS andon_alert_active_machine_department_idx ON "andon_alerts" ("machine_id", "department_id") WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'ARRIVED')`);

  if (process.env.SEED_DEMO === "false") {
    console.log("SEED_DEMO=false, skipping demo seed.");
    return;
  }

  const company = await prisma.company.upsert({
    where: { slug: "five-star-demo" },
    update: { name: "Five Star Demo", active: true },
    create: { name: "Five Star Demo", slug: "five-star-demo", active: true }
  });

  const groups = await Promise.all([
    prisma.machineGroup.upsert({
      where: { companyId_name: { companyId: company.id, name: "Press" } },
      update: { active: true, sortOrder: 10 },
      create: { companyId: company.id, name: "Press", sortOrder: 10 }
    }),
    prisma.machineGroup.upsert({
      where: { companyId_name: { companyId: company.id, name: "Packaging" } },
      update: { active: true, sortOrder: 20 },
      create: { companyId: company.id, name: "Packaging", sortOrder: 20 }
    })
  ]);
  const [pressGroup, packagingGroup] = groups;

  const machineSeeds = [
    ["P1", "Press 1", pressGroup.id, 10],
    ["P2", "Press 2", pressGroup.id, 20],
    ["P3", "Press 3", pressGroup.id, 30],
    ["P4", "Press 4", pressGroup.id, 40],
    ["B1", "Bag Line 1", packagingGroup.id, 50],
    ["B2", "Bag Line 2", packagingGroup.id, 60]
  ] as const;

  const machines = [];
  for (const [code, name, machineGroupId, sortOrder] of machineSeeds) {
    machines.push(await prisma.machine.upsert({
      where: { companyId_code: { companyId: company.id, code } },
      update: { name, machineGroupId, active: true, sortOrder },
      create: { companyId: company.id, code, name, machineGroupId, sortOrder }
    }));
  }

  const removedDepartmentNames = ["Maintenance", "Material Handler"];
  const oldTemplateNames = ["Quality Hold", "Machine Down", "Bad Material", "Need Supervisor", "Safety Stop"];
  const departmentSeeds = [
    ["Quality", "#2563eb", 10],
    ["Supervisor", "#2563eb", 20]
  ] as const;

  const departments: Record<string, Awaited<ReturnType<typeof prisma.department.upsert>>> = {} as any;
  for (const [name, color, sortOrder] of departmentSeeds) {
    departments[name] = await prisma.department.upsert({
      where: { companyId_name: { companyId: company.id, name } },
      update: { color, sortOrder, active: true },
      create: { companyId: company.id, name, color, sortOrder }
    });
  }

  await prisma.department.updateMany({ where: { companyId: company.id, name: { in: removedDepartmentNames } }, data: { active: false } });
  const removedDepartments = await prisma.department.findMany({ where: { companyId: company.id, name: { in: removedDepartmentNames } }, select: { id: true } });
  const removedDepartmentIds = removedDepartments.map((department) => department.id);
  if (removedDepartmentIds.length) {
    await prisma.issueType.updateMany({ where: { companyId: company.id, departmentId: { in: removedDepartmentIds } }, data: { active: false } });
    await prisma.pagerDevice.updateMany({ where: { companyId: company.id, departmentId: { in: removedDepartmentIds } }, data: { active: false } });
  }

  const issueSeeds = [
    ["Quality", "Quality support", Priority.NORMAL, 10],
    ["Quality", "Material clear", Priority.NORMAL, 20],
    ["Supervisor", "Supervisor support", Priority.NORMAL, 10],
    ["Supervisor", "Material clear", Priority.NORMAL, 20]
  ] as const;

  const issues: Record<string, Awaited<ReturnType<typeof prisma.issueType.upsert>>> = {} as any;
  for (const [departmentName, name, defaultPriority, sortOrder] of issueSeeds) {
    const department = departments[departmentName];
    const key = `${departmentName}:${name}`;
    issues[key] = await prisma.issueType.upsert({
      where: { departmentId_name: { departmentId: department.id, name } },
      update: { defaultPriority, sortOrder, active: true },
      create: { companyId: company.id, departmentId: department.id, name, defaultPriority, sortOrder }
    });
  }

  async function template(name: string, buttonLabel: string, color: string, targets: Array<{ department: string; issue: string; message?: string | null; priority?: Priority }>) {
    const t = await prisma.commandTemplate.upsert({
      where: { companyId_name: { companyId: company.id, name } },
      update: { buttonLabel, color, active: true },
      create: { companyId: company.id, name, buttonLabel, color, active: true }
    });
    await prisma.commandTemplateTarget.deleteMany({ where: { commandTemplateId: t.id } });
    await prisma.commandTemplateTarget.createMany({
      data: targets.map((target, index) => ({
        commandTemplateId: t.id,
        departmentId: departments[target.department].id,
        issueTypeId: issues[`${target.department}:${target.issue}`].id,
        targetMessage: target.message ?? null,
        priority: target.priority ?? issues[`${target.department}:${target.issue}`].defaultPriority,
        sortOrder: (index + 1) * 10
      }))
    });
    return t;
  }

  await prisma.commandTemplate.updateMany({ where: { companyId: company.id, name: { in: oldTemplateNames } }, data: { active: false } });

  await template("Call Quality", "Call Quality", "#2563eb", [
    { department: "Quality", issue: "Quality support", priority: Priority.NORMAL }
  ]);

  await template("Call Supervisor", "Call Supervisor", "#2563eb", [
    { department: "Supervisor", issue: "Supervisor support", priority: Priority.NORMAL }
  ]);

  await template("Material Clear", "Material Clear", "#2563eb", [
    { department: "Quality", issue: "Material clear", priority: Priority.NORMAL },
    { department: "Supervisor", issue: "Material clear", priority: Priority.NORMAL }
  ]);

  const admin = await user("admin", "Admin User", Role.ADMIN, company.id, "admin123");
  const manager = await user("manager", "Plant Manager", Role.MANAGER, company.id, "manager123");
  const operator = await user("operator", "Line Operator", Role.OPERATOR, company.id, "operator123");
  const quality = await user("quality", "Quality Pager User", Role.RESPONDER, company.id, "quality123");
  const supervisor = await user("supervisor", "Supervisor User", Role.RESPONDER, company.id, "supervisor123");
  const viewer = await user("viewer", "Board Viewer", Role.VIEWER, company.id, "viewer123");
  await prisma.user.updateMany({ where: { username: "maintenance" }, data: { active: false } });

  await resetScopes(admin.membership.id, []);
  await resetScopes(manager.membership.id, []);
  await resetScopes(operator.membership.id, [{ scopeType: ScopeType.MACHINE_GROUP, scopeId: pressGroup.id }]);
  await resetScopes(quality.membership.id, [{ scopeType: ScopeType.DEPARTMENT, scopeId: departments["Quality"].id }]);
  await resetScopes(supervisor.membership.id, [{ scopeType: ScopeType.DEPARTMENT, scopeId: departments["Supervisor"].id }]);
  await resetScopes(viewer.membership.id, [{ scopeType: ScopeType.DEPARTMENT, scopeId: departments["Quality"].id }]);

  const pagerTokens = [
    ["Quality M5 Pager", "Quality", "demo-quality-pager-token"],
    ["Supervisor M5 Pager", "Supervisor", "demo-supervisor-pager-token"]
  ] as const;

  for (const [name, departmentName, rawToken] of pagerTokens) {
    await prisma.pagerDevice.upsert({
      where: { tokenHash: tokenHash(rawToken) },
      update: { name, departmentId: departments[departmentName].id, active: true, tokenFingerprint: tokenFingerprint(rawToken) },
      create: {
        companyId: company.id,
        departmentId: departments[departmentName].id,
        name,
        tokenHash: tokenHash(rawToken),
        tokenFingerprint: tokenFingerprint(rawToken),
        active: true
      }
    });
  }

  console.log("Seed complete.");
  console.log("Demo users:");
  console.log("  admin / admin123");
  console.log("  manager / manager123");
  console.log("  operator / operator123");
  console.log("  quality / quality123");
  console.log("  supervisor / supervisor123");
  console.log("  viewer / viewer123");
  console.log("Demo pager tokens:");
  console.log("  Quality: demo-quality-pager-token");
  console.log("  Supervisor: demo-supervisor-pager-token");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
