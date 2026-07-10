import type { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";

export const QUICK_LOGIN_PREFERENCE_KEY = "quick_login_profiles";
export const QUICK_LOGIN_PROFILES = ["operator", "manager", "quality", "supervisor"] as const;
export type QuickLoginProfile = typeof QUICK_LOGIN_PROFILES[number];

const quickLoginProfileSet = new Set<string>(QUICK_LOGIN_PROFILES);
const defaultDevProfiles: QuickLoginProfile[] = ["operator", "manager", "quality", "supervisor"];

export const quickLoginUsernameByProfile: Record<QuickLoginProfile, string> = {
  operator: "operator",
  manager: "manager",
  quality: "quality",
  supervisor: "supervisor"
};

export function normalizeQuickLoginProfiles(value: unknown): QuickLoginProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: QuickLoginProfile[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const profile = item.trim().toLowerCase();
    if (quickLoginProfileSet.has(profile) && !profiles.includes(profile as QuickLoginProfile)) {
      profiles.push(profile as QuickLoginProfile);
    }
  }
  return profiles;
}

async function storedProfiles(companyId: string) {
  const preference = await prisma.companyPreference.findUnique({
    where: { companyId_key: { companyId, key: QUICK_LOGIN_PREFERENCE_KEY } }
  });
  return preference ? normalizeQuickLoginProfiles(preference.value) : null;
}

export async function getQuickLoginProfiles(companyId: string) {
  const profiles = await storedProfiles(companyId);
  if (profiles) return profiles;
  return !config.isProduction && config.demoMode ? defaultDevProfiles : [];
}

export async function getPublicQuickLoginProfiles() {
  const companies = await prisma.company.findMany({ where: { active: true }, select: { id: true } });
  const enabled = new Set<QuickLoginProfile>();
  for (const company of companies) {
    for (const profile of await getQuickLoginProfiles(company.id)) enabled.add(profile);
  }
  return QUICK_LOGIN_PROFILES.filter((profile) => enabled.has(profile));
}

export async function setQuickLoginProfiles(companyId: string, profiles: QuickLoginProfile[]) {
  return prisma.companyPreference.upsert({
    where: { companyId_key: { companyId, key: QUICK_LOGIN_PREFERENCE_KEY } },
    update: { value: profiles as Prisma.InputJsonValue },
    create: {
      companyId,
      key: QUICK_LOGIN_PREFERENCE_KEY,
      value: profiles as Prisma.InputJsonValue
    }
  });
}
