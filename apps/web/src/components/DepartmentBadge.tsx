import type { CSSProperties, ReactElement, SVGProps } from "react";
import { AlertTriangleIcon, BoxIcon, ShieldCheckIcon, UsersIcon, WrenchIcon } from "./icons";

type Icon = (props: SVGProps<SVGSVGElement>) => ReactElement;
type DepartmentLike = { id?: string; name: string; color?: string | null };

/**
 * Departments are identified by icon first and colour second, so the design holds up as
 * more departments are added. Icons are matched from the department name; anything
 * unrecognised gets its initial. Colour comes from the department's admin setting.
 */
const ICON_RULES: Array<[RegExp, Icon]> = [
  [/quality|\bqa\b|\bqc\b|inspect/i, ShieldCheckIcon],
  [/maint|mechanic|electric|repair|engineer|tech/i, WrenchIcon],
  [/supervis|lead|manager|shift|foreman/i, UsersIcon],
  [/safety|\behs\b|\bhse\b/i, AlertTriangleIcon],
  [/material|logistic|forklift|warehouse|handler|supply|shipping|receiving/i, BoxIcon]
];

const FALLBACK_COLORS = ["#0284c7", "#7c3aed", "#0d9488", "#db2777", "#4f46e5", "#0891b2", "#9333ea", "#475569"];

function hash(text: string) {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

export function departmentColor(department: DepartmentLike) {
  const color = department.color?.trim();
  if (color && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return color;
  return FALLBACK_COLORS[hash(department.name) % FALLBACK_COLORS.length];
}

export function departmentIcon(department: DepartmentLike): Icon | null {
  return ICON_RULES.find(([pattern]) => pattern.test(department.name))?.[1] ?? null;
}

type Variant = "solid" | "plain";

export function DepartmentIcon({ department, size = "md", variant = "solid" }: { department: DepartmentLike; size?: "sm" | "md" | "lg"; variant?: Variant }) {
  const Glyph = departmentIcon(department);
  return (
    <span
      className={`dept-icon dept-icon-${size} ${variant === "plain" ? "dept-icon-plain" : ""}`}
      style={{ "--dept": departmentColor(department) } as CSSProperties}
      title={department.name}
      aria-hidden="true"
    >
      {Glyph ? <Glyph /> : <span className="dept-icon-letter">{department.name.trim().charAt(0).toUpperCase() || "?"}</span>}
    </span>
  );
}

export function DepartmentBadge({ department, size = "md", variant = "solid" }: { department: DepartmentLike; size?: "sm" | "md" | "lg"; variant?: Variant }) {
  return (
    <span className="dept-badge">
      <DepartmentIcon department={department} size={size} variant={variant} />
      <span className="dept-badge-name">{department.name}</span>
    </span>
  );
}

/** Up to `max` department icons, then "+N". */
export function DepartmentIconStack({ departments, max = 4, variant = "solid" }: { departments: DepartmentLike[]; max?: number; variant?: Variant }) {
  const shown = departments.slice(0, max);
  const extra = departments.length - shown.length;
  return (
    <span className="dept-stack" aria-label={departments.map((d) => d.name).join(", ")}>
      {shown.map((department) => <DepartmentIcon key={department.id ?? department.name} department={department} size="sm" variant={variant} />)}
      {extra > 0 && <span className="dept-stack-more">+{extra}</span>}
    </span>
  );
}
