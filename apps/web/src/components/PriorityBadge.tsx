import { AlertTriangleIcon } from "./icons";

const PRIORITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  normal: "Normal",
  low: "Low"
};

export function PriorityBadge({ priority }: { priority: string }) {
  const key = priority.toLowerCase();
  const label = PRIORITY_LABEL[key] ?? priority;
  return (
    <span className={`priority-badge priority-badge-${key}`}>
      {key === "critical" && <AlertTriangleIcon className="priority-badge-icon" />}
      {label}
    </span>
  );
}
