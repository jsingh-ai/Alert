import type { SVGProps } from "react";

/**
 * Small hand-authored line-icon set (2px stroke, 24x24, currentColor) used to give
 * roles / departments / command types a distinct glyph instead of text initials.
 * No icon library dependency — keep these additive as more are needed.
 */

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props
  };
}

export function BoltIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <path d="M13 3 6 14h5l-1 7 7-11h-5l1-7Z" />
    </svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <path d="M12 4 3 9l9 5 9-5-9-5Z" />
      <path d="M3 14l9 5 9-5" />
    </svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
    </svg>
  );
}

export function ShieldCheckIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
      <path d="M9 12.2 11.2 14.4 15.3 10" />
    </svg>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9.5" r="2.3" />
      <path d="M15.2 13.4c2.1.6 3.6 2.4 3.8 4.6" />
    </svg>
  );
}

export function AlertTriangleIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <path d="M10.3 3.9 2.6 18a1.8 1.8 0 0 0 1.55 2.7h15.7A1.8 1.8 0 0 0 21.4 18L13.7 3.9a1.8 1.8 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 16.8h.01" />
    </svg>
  );
}

export function BellRingIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9Z" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.3 12.5 10.8 15l5-5" />
    </svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export function WrenchIcon(props: IconProps) {
  return (
    <svg {...base(props)} aria-hidden="true" focusable="false">
      <path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-3 3-2-2 3-3Z" />
    </svg>
  );
}
