import type { Role } from "./services/auth.js";

export type NavItem = {
  id: string;
  label: string;
  path: string;
  icon: string;
};

const items: Record<string, NavItem> = {
  operator: { id: "operator", label: "Operator", path: "/operator", icon: "radio" },
  queue: { id: "queue", label: "Department Queue", path: "/queue", icon: "inbox" },
  floor: { id: "floor", label: "Live Floor", path: "/floor", icon: "layout" },
  reports: { id: "reports", label: "Reports", path: "/reports", icon: "chart" },
  admin: { id: "admin", label: "Admin Setup", path: "/admin", icon: "settings" }
};

export function navForRole(role: Role): NavItem[] {
  switch (role) {
    case "ADMIN":
      return [items.floor, items.queue, items.operator, items.reports, items.admin];
    case "MANAGER":
      return [items.floor, items.queue, items.operator, items.reports];
    case "OPERATOR":
      return [items.operator];
    case "RESPONDER":
      return [items.queue];
    case "VIEWER":
      return [items.floor, items.queue];
    default:
      return [items.operator];
  }
}

export function homeForRole(role: Role) {
  return navForRole(role)[0]?.path ?? "/operator";
}
