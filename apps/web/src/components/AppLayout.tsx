import { useEffect, useState } from "react";
import type { ReactElement, ReactNode, SVGProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Alert, NavItem } from "../lib/types";
import {
  BellRingIcon,
  ChartIcon,
  ChevronLeftIcon,
  GridIcon,
  MoonIcon,
  SettingsIcon,
  SignOutIcon,
  StationIcon,
  SunIcon
} from "./icons";
import { useApplyTheme, useTheme } from "../lib/theme";
import "../styles/ui.css";
import "../styles/shell.css";

type Icon = (props: SVGProps<SVGSVGElement>) => ReactElement;

/** Frontend names for each page; the API's nav ids stay the same. */
const NAV_META: Record<string, { label: string; icon: Icon; section: "live" | "insights" | "utility" }> = {
  floor: { label: "Floor Status", icon: GridIcon, section: "live" },
  queue: { label: "Response Queue", icon: BellRingIcon, section: "live" },
  operator: { label: "Machine Station", icon: StationIcon, section: "live" },
  reports: { label: "Reports", icon: ChartIcon, section: "insights" },
  admin: { label: "Settings", icon: SettingsIcon, section: "utility" }
};

/** Pages hidden from the sidebar for now (their routes still work). */
const HIDDEN_NAV = new Set(["channels"]);

const SECTION_ORDER: Record<string, string[]> = {
  live: ["floor", "queue", "operator"],
  insights: ["reports"],
  utility: ["admin"]
};

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Administrator",
  MANAGER: "Manager",
  OPERATOR: "Operator",
  RESPONDER: "Responder",
  VIEWER: "Viewer"
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function sectionItems(nav: NavItem[], section: "live" | "insights" | "utility") {
  const order = SECTION_ORDER[section];
  const items = nav.filter((item) => (NAV_META[item.id]?.section ?? "live") === section);
  return items.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("pg_sidebar_collapsed") === "true");
  const { theme, toggle: toggleTheme } = useTheme();
  useApplyTheme();
  const location = useLocation();
  const nav = (session?.nav ?? []).filter((item) => !HIDDEN_NAV.has(item.id));
  const hasQueue = nav.some((item) => item.id === "queue");

  const waitingQuery = useQuery({
    queryKey: ["active-alerts", "nav-count"],
    queryFn: () => api<{ data?: Alert[] }>("/api/alerts/active"),
    enabled: hasQueue,
    refetchInterval: 15000
  });

  useEffect(() => localStorage.setItem("pg_sidebar_collapsed", String(collapsed)), [collapsed]);

  if (!session) return null;

  // Operator accounts on Machine Station get a full-screen kiosk: no sidebar (one page,
  // and no one-tap sign-out). Theme and sign-out live in the station's own menu.
  const kiosk = session.membership.role === "OPERATOR" && location.pathname.startsWith("/operator");

  const waiting = (waitingQuery.data?.data ?? []).filter((alert) => alert.status === "OPEN").length;
  const badges: Record<string, number> = { queue: waiting };
  const companyLabel = session.company.name === "Five Star Demo" ? "Five Star" : session.company.name;

  const renderItem = (item: NavItem) => {
    const meta = NAV_META[item.id];
    const Glyph = meta?.icon ?? GridIcon;
    const label = meta?.label ?? item.label;
    const count = badges[item.id] ?? 0;
    return (
      <NavLink key={item.id} to={item.path} className={({ isActive }) => `pg-nav-item ${isActive ? "active" : ""}`} title={collapsed ? label : undefined}>
        <Glyph className="pg-nav-icon" />
        <span className="pg-nav-label">{label}</span>
        {count > 0 && <em className="pg-nav-badge" aria-label={`${count} new`}>{count > 99 ? "99+" : count}</em>}
      </NavLink>
    );
  };

  const live = sectionItems(nav, "live");
  const insights = sectionItems(nav, "insights");
  const utility = sectionItems(nav, "utility");

  return (
    <div className={`pg-shell ${collapsed ? "collapsed" : ""} ${kiosk ? "kiosk" : ""}`}>
      <aside className="pg-sidebar" hidden={kiosk}>
        <div className="pg-sidebar-top">
          <div className="pg-lockup">
            <div className="pg-mark" aria-hidden="true">PG</div>
            <div className="pg-lockup-text">
              <strong>ProcessGuard</strong>
              <span>Workflow</span>
            </div>
          </div>
          <button
            type="button"
            className="pg-collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand" : "Collapse"}
          >
            <ChevronLeftIcon />
          </button>
        </div>

        <nav className="pg-nav" aria-label="Main">
          {live.length > 0 && (
            <div className="pg-nav-section">
              <span className="pg-nav-heading">Live</span>
              {live.map(renderItem)}
            </div>
          )}
          {insights.length > 0 && (
            <div className="pg-nav-section">
              <span className="pg-nav-heading">Insights</span>
              {insights.map(renderItem)}
            </div>
          )}
          {utility.length > 0 && <div className="pg-nav-section pg-nav-utility">{utility.map(renderItem)}</div>}
        </nav>

        <div className="pg-user">
          <div className="pg-avatar" aria-hidden="true">{initials(session.user.displayName)}</div>
          <div className="pg-user-text">
            <strong>{session.user.displayName}</strong>
            <span title={companyLabel}>{ROLE_LABEL[session.membership.role] ?? session.membership.role}</span>
          </div>
          <div className="pg-user-actions">
            <button
              type="button"
              className="pg-icon-button"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Light mode" : "Dark mode"}
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <button type="button" className="pg-icon-button pg-signout" onClick={logout} aria-label="Sign out" title="Sign out">
              <SignOutIcon />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-panel pg-main">{children}</main>
    </div>
  );
}
