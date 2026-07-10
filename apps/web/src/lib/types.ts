export type Role = "ADMIN" | "MANAGER" | "OPERATOR" | "RESPONDER" | "VIEWER";
export type AlertStatus = "OPEN" | "ACKNOWLEDGED" | "ARRIVED" | "RESOLVED" | "CANCELLED";

export type NavItem = { id: string; label: string; path: string; icon: string };

export type Session = {
  user: { id: string; username: string; displayName: string };
  company: { id: string; name: string; slug: string };
  membership: { id: string; role: Role; scopes: any[] };
  departments: any[];
  machines: any[];
  nav: NavItem[];
  homePath: string;
  demoMode: boolean;
};

export type Alert = {
  id: string;
  commandId?: string | null;
  commandLabel: string;
  machine: { id: string; name: string; code: string; group?: string };
  department: { id: string; name: string; color: string };
  issueType?: { id: string; name: string } | null;
  issueText: string;
  status: AlertStatus;
  statusLabel: string;
  priority: string;
  displayMessage?: string | null;
  operatorNote?: string | null;
  responderNameText?: string | null;
  actionAvailable: string;
  elapsedSeconds: number;
  acknowledgeSeconds?: number | null;
  arriveSeconds?: number | null;
  responseSeconds?: number | null;
  clearSeconds?: number | null;
  activeTimerStartedAt?: string;
  activeTimerStage?: "ACKNOWLEDGE" | "ARRIVE" | "CLEAR";
  createdAt: string;
  acknowledgedAt?: string | null;
  arrivedAt?: string | null;
  resolvedAt?: string | null;
  messages?: any[];
  events?: any[];
};

export type CommandGroup = {
  id: string;
  realCommandId?: string | null;
  commandTemplateId?: string | null;
  commandLabel: string;
  status: string;
  machine: { id: string; name: string; code: string; group?: string };
  sharedNote?: string | null;
  createdAt: string;
  alerts: Alert[];
};
