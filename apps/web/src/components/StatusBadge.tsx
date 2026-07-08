import type { AlertStatus } from "../lib/types";

export function StatusBadge({ status }: { status: AlertStatus | string }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}>{status.replace("_", " ")}</span>;
}
