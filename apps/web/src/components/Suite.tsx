import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { DepartmentIcon } from "./DepartmentBadge";
import { MoonIcon, MoreIcon, SignOutIcon, SunIcon } from "./icons";
import fiveStarLogo from "../assets/logos/five-star-logo.svg";
import fiveStarLogoWhite from "../assets/logos/five-star-logo-white.svg";
import "../styles/suite.css";

/*
 * Suite chrome shared by every page, so Machine Station, Response Queue, Floor Status and Reports read
 * as one product: the app bar, the status pill, the station menu, the status bar, and team colours.
 */

export type Connection = "connecting" | "live" | "offline";
export type Tone = "neutral" | "clear" | "waiting" | "late" | "accepted";

/**
 * Offline is judged by how old the data is, not by one failed request (a dropped poll is retried a few
 * seconds later). Before the first success, it is offline only once a fetch has failed.
 */
export function connectionState(query: { dataUpdatedAt: number; errorUpdatedAt: number }, now: number, offlineAfterMs: number): Connection {
  if (query.dataUpdatedAt === 0) return query.errorUpdatedAt > 0 ? "offline" : "connecting";
  return now - query.dataUpdatedAt > offlineAfterMs ? "offline" : "live";
}

export function timeOfDay(value: string | number | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function useClock(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** App bar: Five Star logo (or page controls) on the left, the title centred with a small label above, live state on the right. */
export function SuiteHeader({ eyebrow, title, start, status, children }: {
  eyebrow?: string;
  title: ReactNode;
  /** Replaces the logo (e.g. filters on a page that already shows the sidebar brand). */
  start?: ReactNode;
  status?: { tone: Tone; text: string };
  /** Extra controls on the right, before the time (e.g. the station menu goes last via `children`). */
  children?: ReactNode;
}) {
  const { theme } = useTheme();
  const now = useClock();
  return (
    <header className="su-head">
      <div className="su-head-left">
        {start ?? <img className="su-logo" src={theme === "dark" ? fiveStarLogoWhite : fiveStarLogo} alt="Five Star" />}
      </div>
      <div className="su-title">
        {eyebrow && <span className="su-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
      </div>
      <div className="su-head-side">
        {status && (
          <span className={`su-status ${status.tone}`} role="status">
            <i aria-hidden="true" />
            {status.text}
          </span>
        )}
        <span className="su-time">{timeOfDay(now)}</span>
        {children}
      </div>
    </header>
  );
}

/** Always-on system status at the foot of the screen: is this data live, and how fresh is it. */
export function SuiteStatusBar({ connection, lastGood, children }: { connection: Connection; lastGood: number; children?: ReactNode }) {
  return (
    <footer className={`su-statusbar ${connection}`}>
      {/* Not a live region: the header pill and the offline notice already announce changes */}
      <span className="su-sync">
        <i />
        {connection === "live"
          ? `Live · updated ${timeOfDay(lastGood)}`
          : connection === "offline"
            ? lastGood ? `Offline · last update ${timeOfDay(lastGood)}` : "Offline · no data yet"
            : "Connecting…"}
      </span>
      {children && <span className="su-statusbar-side">{children}</span>}
    </footer>
  );
}

/** The one banner on these screens, only when the data shown may be wrong. */
export function OfflineNotice({ lastGood, what = "Calls" }: { lastGood: number; what?: string }) {
  return (
    <div className="su-notice" role="alert">
      <strong>Connection lost.</strong>
      <span>{lastGood ? `Last update ${timeOfDay(lastGood)}. ` : ""}{what} on this screen may be out of date. Reconnecting…</span>
    </div>
  );
}

/** Station menu: theme and sign out, plus page-specific items (rendered with a `close` callback). */
export function SuiteMenu({ label = "Station menu", signOutLabel = "Sign out", items }: { label?: string; signOutLabel?: string; items?: (close: () => void) => ReactNode }) {
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="su-menu">
      <button ref={trigger} type="button" className="su-menu-trigger" aria-label={label} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreIcon />
      </button>
      {open && (
        <>
          <div className="su-menu-scrim" aria-hidden="true" onClick={close} />
          <div ref={list} className="su-menu-list">
            <button type="button" onClick={() => { toggle(); close(); }}>
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            {items?.(close)}
            <button type="button" className="danger" onClick={logout}>
              <SignOutIcon />
              {signOutLabel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A calm identity colour per team, kept clear of the status colours (red, amber, blue, green).
 * Departments all default to #2563eb in the database, so a colour is only taken from admin
 * settings when someone actually chose one; otherwise it comes from the kind of team.
 */
const DEFAULT_DEPARTMENT_COLOR = "#2563eb";
const TEAM_HUES: Array<[RegExp, string]> = [
  [/maint|mechanic|electric|repair|engineer|tech/i, "#a75a2a"], // copper
  [/quality|\bqa\b|\bqc\b|inspect/i, "#46775a"], // forest
  [/supervis|lead|manager|shift|foreman/i, "#4f5b93"], // slate
  [/safety|\behs\b|\bhse\b/i, "#8a6d1f"], // ochre
  [/material|logistic|forklift|warehouse|handler|supply|shipping|receiving/i, "#7a4f7d"] // plum
];

export function teamHue(department: { name: string; color?: string | null }) {
  const chosen = department.color?.trim();
  if (chosen && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(chosen) && chosen.toLowerCase() !== DEFAULT_DEPARTMENT_COLOR) return chosen;
  return TEAM_HUES.find(([pattern]) => pattern.test(department.name))?.[1] ?? "#475569";
}

/** Department glyph on a soft tint of the team's colour. */
export function TeamIcon({ department, size = "md" }: { department: { id?: string; name: string; color?: string | null }; size?: "sm" | "md" | "lg" }) {
  return (
    <span className="su-hue" style={{ "--hue": teamHue(department) } as CSSProperties}>
      <DepartmentIcon department={department} size={size} variant="plain" />
    </span>
  );
}
