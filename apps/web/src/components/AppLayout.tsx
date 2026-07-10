import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { NavItem } from "../lib/types";

function orderedNav(items: NavItem[], order: string[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean) as NavItem[];
  const missing = items.filter((item) => !order.includes(item.id));
  const nav = [...ordered, ...missing];
  const operatorIndex = nav.findIndex((item) => item.id === "operator");
  const queueIndex = nav.findIndex((item) => item.id === "queue");
  if (operatorIndex >= 0 && queueIndex >= 0 && queueIndex < operatorIndex) {
    const [operator] = nav.splice(operatorIndex, 1);
    nav.splice(queueIndex, 0, operator);
  }
  return nav;
}

function navIconContent(item: NavItem): ReactNode {
  switch (item.id) {
    case "operator":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 6.75A2.75 2.75 0 0 1 7.75 4h8.5A2.75 2.75 0 0 1 19 6.75v10.5A2.75 2.75 0 0 1 16.25 20h-8.5A2.75 2.75 0 0 1 5 17.25V6.75Z" />
          <path d="M8 8h8" />
          <path d="M8.5 12h2.25M13.25 12h2.25M8.5 15.75h2.25M13.25 15.75h2.25" />
        </svg>
      );
    case "queue":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 5.75A2.75 2.75 0 0 1 7.75 3h8.5A2.75 2.75 0 0 1 19 5.75v12.5A2.75 2.75 0 0 1 16.25 21h-8.5A2.75 2.75 0 0 1 5 18.25V5.75Z" />
          <path d="M8.25 8h7.5M8.25 12h7.5M8.25 16h4.5" />
        </svg>
      );
    case "channels":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4.5 6.25A3.25 3.25 0 0 1 7.75 3h8.5a3.25 3.25 0 0 1 3.25 3.25v5.5A3.25 3.25 0 0 1 16.25 15H12l-4.2 3.15A1.05 1.05 0 0 1 6.1 17.3V15A3.25 3.25 0 0 1 3.5 11.75v-5.5Z" />
          <path d="M8 8h8M8 11h5.8" />
        </svg>
      );
    case "floor":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5v6h-6.5V5.5Z" />
          <path d="M13.5 4h5A1.5 1.5 0 0 1 20 5.5V10h-6.5V4Z" />
          <path d="M4 14h6.5v6h-5A1.5 1.5 0 0 1 4 18.5V14Z" />
          <path d="M13.5 14H20v4.5a1.5 1.5 0 0 1-1.5 1.5h-5v-6Z" />
        </svg>
      );
    case "reports":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 19V5" />
          <path d="M5 19h14" />
          <path d="M8.5 16v-4" />
          <path d="M12 16V8" />
          <path d="M15.5 16v-6" />
          <path d="M8 7.5h8" />
        </svg>
      );
    case "admin":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3.75v2.1M12 18.15v2.1M5.63 5.63l1.48 1.48M16.89 16.89l1.48 1.48M3.75 12h2.1M18.15 12h2.1M5.63 18.37l1.48-1.48M16.89 7.11l1.48-1.48" />
        </svg>
      );
    default:
      if (item.icon === "text") {
        return (
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4.5 6.25A3.25 3.25 0 0 1 7.75 3h8.5a3.25 3.25 0 0 1 3.25 3.25v5.5A3.25 3.25 0 0 1 16.25 15H12l-4.2 3.15A1.05 1.05 0 0 1 6.1 17.3V15A3.25 3.25 0 0 1 3.5 11.75v-5.5Z" />
            <path d="M8 8h8M8 11h5.8" />
          </svg>
        );
      }
      return item.icon.slice(0, 1).toUpperCase();
  }
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("pg_sidebar_collapsed") === "true");
  const [width, setWidth] = useState(() => Number(localStorage.getItem("pg_sidebar_width") ?? 260));
  const [dragging, setDragging] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(() => JSON.parse(localStorage.getItem("pg_sidebar_order") || "[]"));
  const nav = useMemo(() => orderedNav(session?.nav ?? [], order), [session?.nav, order]);
  const communicationItem = nav.find((item) => item.id === "channels");
  const mainNav = nav.filter((item) => item.id !== "channels");

  useEffect(() => localStorage.setItem("pg_sidebar_collapsed", String(collapsed)), [collapsed]);
  useEffect(() => localStorage.setItem("pg_sidebar_width", String(width)), [width]);
  useEffect(() => localStorage.setItem("pg_sidebar_order", JSON.stringify(order)), [order]);

  if (!session) return null;
  const companyLabel = session.company.name === "Five Star Demo" ? "Five Star Workflow" : session.company.name;

  const startResize = (event: ReactMouseEvent) => {
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (move: globalThis.MouseEvent) => setWidth(Math.min(420, Math.max(210, startWidth + move.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const dropOn = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const current = nav.map((item) => item.id);
    const from = current.indexOf(dragging);
    const to = current.indexOf(targetId);
    current.splice(from, 1);
    current.splice(to, 0, dragging);
    setOrder(current);
  };

  return (
    <div className="app-shell" style={{ gridTemplateColumns: collapsed ? "72px 1fr" : `${width}px 1fr` }}>
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark">PG</div>
          {!collapsed && <div><strong>ProcessGuard</strong><span>{companyLabel}</span></div>}
        </div>
        <button className="sidebar-toggle" onClick={() => setCollapsed((value) => !value)}>{collapsed ? ">" : "Collapse"}</button>
        <nav className="side-nav">
          {mainNav.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              draggable={!collapsed}
              onDragStart={() => setDragging(item.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => dropOn(item.id)}
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              title={item.label}
            >
              <span className="nav-icon">{navIconContent(item)}</span>
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {!collapsed && <div className="user-mini"><strong>{session.user.displayName}</strong><span>{session.membership.role}</span></div>}
          {communicationItem && (
            <NavLink
              to={communicationItem.path}
              className={({ isActive }) => `nav-item footer-nav-item ${isActive ? "active" : ""}`}
              title={communicationItem.label}
            >
              <span className="nav-icon">{navIconContent(communicationItem)}</span>
              {!collapsed && <span>{communicationItem.label}</span>}
            </NavLink>
          )}
          <button className="ghost signout-button" onClick={logout}>{collapsed ? "X" : "Sign out"}</button>
        </div>
        {!collapsed && <div className="resize-handle" onMouseDown={startResize} />}
      </aside>
      <main className="main-panel">{children}</main>
    </div>
  );
}
