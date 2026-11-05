import { useCallback, useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const STORAGE_KEY = "pg_theme";

/**
 * One theme for the signed-in app, shared by every component that reads it
 * (sidebar toggle, Machine Station kiosk menu). Light by default; remembered per device.
 */
function readTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

let current: Theme = readTheme();
const listeners = new Set<() => void>();

function setTheme(next: Theme) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable: theme still applies for this visit */
  }
  document.documentElement.dataset.theme = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current, () => current);
  const toggle = useCallback(() => setTheme(current === "dark" ? "light" : "dark"), []);
  return { theme, toggle };
}

/** Applies the theme while the signed-in shell is mounted; the login page stays on its own styles. */
export function useApplyTheme() {
  useEffect(() => {
    document.documentElement.dataset.theme = current;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, []);
}
