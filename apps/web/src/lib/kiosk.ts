import { useAuth } from "./auth";
import type { NavItem, Session } from "./types";

/** Pages hidden from the sidebar for now (their routes still work). */
export const HIDDEN_NAV = new Set(["channels"]);

export function visibleNav(session: Session | null | undefined): NavItem[] {
  return (session?.nav ?? []).filter((item) => !HIDDEN_NAV.has(item.id));
}

/**
 * People who can reach only one page (an operator on Machine Station, a responder on their department's
 * queue) get it full screen with no sidebar. Anyone with more than one page (managers, admins) keeps the
 * sidebar. In kiosk mode the page's own menu carries theme and sign-out.
 */
export function isKiosk(session: Session | null | undefined) {
  return Boolean(session) && visibleNav(session).length <= 1;
}

export function useKiosk() {
  const { session } = useAuth();
  return isKiosk(session);
}
