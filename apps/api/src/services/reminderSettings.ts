/*
 * How often a responder is re-notified while a call is still waiting. Set per person on the admin
 * Users page (responders only). Stored as a user preference, so it needs no database change.
 * The shared quick-login accounts always use the default.
 */
import { prisma } from "../db.js";
import { quickLoginUsernameByProfile } from "./quickLoginService.js";

export const REMINDER_PREFERENCE_KEY = "reminder_seconds";
export const DEFAULT_REMINDER_SECONDS = 60;
/** The choices on the admin page, in seconds. There is deliberately no "off": a waiting call always keeps alerting. */
export const REMINDER_CHOICES = [15, 30, 60, 120, 300] as const;

const quickLoginUsernames = new Set<string>(Object.values(quickLoginUsernameByProfile));

export const isQuickLoginUsername = (username: string) => quickLoginUsernames.has(username.toLowerCase());

/** The seconds to save, or null when it isn't one of the choices. */
export function parseReminderSeconds(value: unknown): number | null {
  const seconds = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof seconds === "number" && (REMINDER_CHOICES as readonly number[]).includes(seconds) ? seconds : null;
}

function fromStored(value: unknown) {
  return parseReminderSeconds(value) ?? DEFAULT_REMINDER_SECONDS;
}

/** Seconds between reminders for each of these users (a missing setting means the default). */
export async function reminderSecondsFor(companyId: string, userIds: string[]) {
  const result = new Map<string, number>();
  if (userIds.length === 0) return result;
  const [preferences, users] = await Promise.all([
    prisma.userPreference.findMany({ where: { companyId, userId: { in: userIds }, key: REMINDER_PREFERENCE_KEY }, select: { userId: true, value: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })
  ]);
  const saved = new Map(preferences.map((preference) => [preference.userId, preference.value]));
  for (const user of users) result.set(user.id, isQuickLoginUsername(user.username) ? DEFAULT_REMINDER_SECONDS : fromStored(saved.get(user.id)));
  return result;
}

/** Every saved setting in a company, by user id, for the admin page. */
export async function reminderSettingsByUser(companyId: string) {
  const preferences = await prisma.userPreference.findMany({ where: { companyId, key: REMINDER_PREFERENCE_KEY }, select: { userId: true, value: true } });
  return new Map(preferences.map((preference) => [preference.userId, fromStored(preference.value)]));
}

type Db = Pick<typeof prisma, "userPreference">;

export async function saveReminderSeconds(db: Db, companyId: string, userId: string, seconds: number) {
  await db.userPreference.upsert({
    where: { userId_companyId_key: { userId, companyId, key: REMINDER_PREFERENCE_KEY } },
    update: { value: seconds },
    create: { userId, companyId, key: REMINDER_PREFERENCE_KEY, value: seconds }
  });
}

/*
 * Turning call notifications off. Admin decides per person whether they may (a switch on the Users page);
 * only then does the person get an on/off switch in their own view. Muted people get no push, and
 * their page doesn't ring. Everyone else can't switch notifications off.
 */
const CAN_MUTE_KEY = "can_mute_notifications";
const MUTED_KEY = "notifications_muted";

const isTrue = (value: unknown) => value === true;

/** Users (of these) who are allowed to mute and have. They are skipped when sending pushes. */
export async function mutedUserIds(companyId: string, userIds: string[]) {
  if (userIds.length === 0) return new Set<string>();
  const rows = await prisma.userPreference.findMany({
    where: { companyId, userId: { in: userIds }, key: { in: [CAN_MUTE_KEY, MUTED_KEY] } },
    select: { userId: true, key: true, value: true }
  });
  const can = new Set(rows.filter((row) => row.key === CAN_MUTE_KEY && isTrue(row.value)).map((row) => row.userId));
  return new Set(rows.filter((row) => row.key === MUTED_KEY && isTrue(row.value) && can.has(row.userId)).map((row) => row.userId));
}

/** Who may switch notifications off, for the admin page. */
export async function canMuteByUser(companyId: string) {
  const rows = await prisma.userPreference.findMany({ where: { companyId, key: CAN_MUTE_KEY }, select: { userId: true, value: true } });
  return new Set(rows.filter((row) => isTrue(row.value)).map((row) => row.userId));
}

export async function saveCanMute(db: Db, companyId: string, userId: string, canMute: boolean) {
  await db.userPreference.upsert({
    where: { userId_companyId_key: { userId, companyId, key: CAN_MUTE_KEY } },
    update: { value: canMute },
    create: { userId, companyId, key: CAN_MUTE_KEY, value: canMute }
  });
  // Taking the permission away also switches their notifications back on
  if (!canMute) await db.userPreference.deleteMany({ where: { userId, companyId, key: MUTED_KEY } });
}

/** This person's own setting, as their view needs it. */
export async function muteSettingFor(companyId: string, userId: string) {
  const rows = await prisma.userPreference.findMany({ where: { companyId, userId, key: { in: [CAN_MUTE_KEY, MUTED_KEY] } }, select: { key: true, value: true } });
  const canMute = rows.some((row) => row.key === CAN_MUTE_KEY && isTrue(row.value));
  return { canMute, muted: canMute && rows.some((row) => row.key === MUTED_KEY && isTrue(row.value)) };
}

export async function saveMuted(companyId: string, userId: string, muted: boolean) {
  await prisma.userPreference.upsert({
    where: { userId_companyId_key: { userId, companyId, key: MUTED_KEY } },
    update: { value: muted },
    create: { userId, companyId, key: MUTED_KEY, value: muted }
  });
}
