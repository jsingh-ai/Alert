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

export function AppLayout({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("pg_sidebar_collapsed") === "true");
  const [width, setWidth] = useState(() => Number(localStorage.getItem("pg_sidebar_width") ?? 260));
  const [dragging, setDragging] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(() => JSON.parse(localStorage.getItem("pg_sidebar_order") || "[]"));
  const nav = useMemo(() => orderedNav(session?.nav ?? [], order), [session?.nav, order]);

  useEffect(() => localStorage.setItem("pg_sidebar_collapsed", String(collapsed)), [collapsed]);
  useEffect(() => localStorage.setItem("pg_sidebar_width", String(width)), [width]);
  useEffect(() => localStorage.setItem("pg_sidebar_order", JSON.stringify(order)), [order]);

  if (!session) return null;

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
          {!collapsed && <div><strong>ProcessGuard</strong><span>{session.company.name}</span></div>}
        </div>
        <button className="sidebar-toggle" onClick={() => setCollapsed((value) => !value)}>{collapsed ? ">" : "Collapse"}</button>
        <nav className="side-nav">
          {nav.map((item) => (
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
              <span className="nav-icon">{item.icon.slice(0, 1).toUpperCase()}</span>
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {!collapsed && <div className="user-mini"><strong>{session.user.displayName}</strong><span>{session.membership.role}</span></div>}
          <button className="ghost signout-button" onClick={logout}>{collapsed ? "X" : "Sign out"}</button>
        </div>
        {!collapsed && <div className="resize-handle" onMouseDown={startResize} />}
      </aside>
      <main className="main-panel">{children}</main>
    </div>
  );
}
