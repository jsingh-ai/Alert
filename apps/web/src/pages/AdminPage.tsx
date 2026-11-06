import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, deleteJson, patchJson, postJson, putJson } from "../lib/api";
import { SuiteHeader, TeamIcon } from "../components/Suite";
import { BellRingIcon, ChartIcon, ChevronRightIcon, LayersIcon, MessageIcon, PlusIcon, StationIcon, UserIcon, UsersIcon, WrenchIcon } from "../components/icons";
import "../styles/admin.css";

/*
 * Admin: one page, a side menu in four groups instead of a row of tabs.
 *   People   Users (role first, then exactly the access that role takes), Quick login
 *   Floor    Machines (by machine group), Pagers
 *   Calls    Departments and the reasons operators pick, Call buttons on Machine Station
 *   System   Status, Message channels
 * Each section is one or two cards with their own headings; lists are rows with quiet actions.
 */

type Role = "OPERATOR" | "RESPONDER" | "MANAGER" | "ADMIN";
type SectionId = "users" | "quick" | "machines" | "pagers" | "departments" | "buttons" | "status" | "channels";

const SECTIONS: Array<{ group: string; items: Array<{ id: SectionId; label: string; icon: typeof UsersIcon }> }> = [
  { group: "People", items: [{ id: "users", label: "Users", icon: UsersIcon }, { id: "quick", label: "Quick login", icon: UserIcon }] },
  { group: "Floor", items: [{ id: "machines", label: "Machines", icon: StationIcon }, { id: "pagers", label: "Pagers", icon: BellRingIcon }] },
  { group: "Calls", items: [{ id: "departments", label: "Departments", icon: WrenchIcon }, { id: "buttons", label: "Call buttons", icon: LayersIcon }] },
  { group: "System", items: [{ id: "status", label: "Status", icon: ChartIcon }, { id: "channels", label: "Message channels", icon: MessageIcon }] }
];

const ROLES: Array<{ id: Role; label: string; detail: string }> = [
  { id: "OPERATOR", label: "Operator", detail: "Runs a Machine Station. Opens straight on their machine." },
  { id: "RESPONDER", label: "Responder", detail: "Answers calls for their department on Team Calls." },
  { id: "MANAGER", label: "Manager", detail: "Floor Status, reports and every page, for some or all machine groups." },
  { id: "ADMIN", label: "Admin", detail: "Everything, including this setup page." }
];
const ROLE_LABEL: Record<string, string> = { OPERATOR: "Operator", RESPONDER: "Responder", MANAGER: "Manager", ADMIN: "Admin", VIEWER: "Viewer" };
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"];
const QUICK_LOGIN = [
  { id: "operator", label: "Operator", detail: "Machine Station" },
  { id: "quality", label: "Quality", detail: "Team Calls" },
  { id: "supervisor", label: "Supervisor", detail: "Team Calls" },
  { id: "maintenance", label: "Maintenance", detail: "Team Calls" },
  { id: "manager", label: "Manager", detail: "Floor Status and reports" }
];
const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const SECTION_KEY = "pg_admin_section";

function errorText(error: unknown, fallback = "That didn't go through. Try again.") {
  return error instanceof Error && error.message ? error.message : fallback;
}

function useAdmin() {
  return useQuery({ queryKey: ["admin"], queryFn: () => api<any>("/api/admin/bootstrap", { cache: "no-store" }), refetchOnWindowFocus: true, refetchInterval: 30_000 });
}

/** Saves, then refreshes the admin data (and anything else named). */
function useSave<T>(fn: (input: T) => Promise<unknown>, also: string[][] = []) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all([["admin"], ...also].map((queryKey) => queryClient.invalidateQueries({ queryKey })))
  });
}

/* ---------- Page ---------- */

export function AdminPage() {
  const admin = useAdmin();
  const data = admin.data?.data;
  const [section, setSection] = useState<SectionId>(() => {
    try {
      const saved = localStorage.getItem(SECTION_KEY) as SectionId | null;
      return saved && SECTIONS.some((group) => group.items.some((item) => item.id === saved)) ? saved : "users";
    } catch {
      return "users";
    }
  });
  const choose = (id: SectionId) => {
    setSection(id);
    try {
      localStorage.setItem(SECTION_KEY, id);
    } catch {
      // private mode: it just opens on Users next time
    }
  };
  const current = SECTIONS.flatMap((group) => group.items).find((item) => item.id === section);

  return (
    <div className="su-page ad-page">
      <SuiteHeader eyebrow="Settings" title="Admin" />
      <div className="ad-layout">
        <nav className="ad-nav" aria-label="Admin sections">
          {SECTIONS.map((group) => (
            <div key={group.group} className="ad-nav-group">
              <h2>{group.group}</h2>
              {group.items.map((item) => (
                <button key={item.id} type="button" className={section === item.id ? "on" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => choose(item.id)}>
                  <item.icon />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <main className="ad-main" aria-label={current?.label}>
          {section === "status" ? (
            <StatusSection />
          ) : section === "channels" ? (
            <ChannelsSection />
          ) : !data ? (
            <section className="ad-card">
              <p className="ad-empty">{admin.isError ? "Admin data couldn't be loaded." : "Loading…"}</p>
              {admin.isError && <div className="ad-card-foot"><button type="button" className="ad-btn" onClick={() => void admin.refetch()}>Try again</button></div>}
            </section>
          ) : section === "users" ? (
            <UsersSection data={data} />
          ) : section === "quick" ? (
            <QuickLoginSection data={data} />
          ) : section === "machines" ? (
            <MachinesSection data={data} />
          ) : section === "pagers" ? (
            <PagersSection data={data} />
          ) : section === "departments" ? (
            <DepartmentsSection data={data} />
          ) : (
            <CallButtonsSection data={data} />
          )}
        </main>
      </div>
    </div>
  );
}

/* ---------- Building blocks ---------- */

function Card({ title, meta, actions, children, className = "" }: { title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`ad-card ${className}`}>
      <header className="ad-card-head">
        <div>
          <h2>{title}</h2>
          {meta && <p>{meta}</p>}
        </div>
        {actions && <div className="ad-card-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function Status({ active }: { active: boolean }) {
  return <span className={`ad-badge ${active ? "on" : "off"}`}>{active ? "Active" : "Off"}</span>;
}

/** Turn on/off and delete, small and to the right of a row. */
function RowActions({ active, onToggle, onDelete, deleteLabel = "Delete this? It can't be undone." }: { active?: boolean; onToggle?: () => void; onDelete?: () => void; deleteLabel?: string }) {
  return (
    <span className="ad-row-actions">
      {onToggle && <button type="button" className="ad-link" onClick={onToggle}>{active ? "Turn off" : "Turn on"}</button>}
      {onDelete && <button type="button" className="ad-link danger" onClick={() => window.confirm(deleteLabel) && onDelete()}>Delete</button>}
    </span>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ad-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Problem({ error }: { error: unknown }) {
  return error ? <p className="ad-error" role="alert">{errorText(error)}</p> : null;
}

/* ---------- People: users ---------- */

type Access = { departmentIds: string[]; machineGroupIds: string[]; machineIds: string[] };

function scopesOf(user: any): Access {
  const scopes: any[] = user?.memberships?.[0]?.scopes ?? [];
  const of = (type: string) => scopes.filter((scope) => scope.scopeType === type).map((scope) => scope.scopeId as string);
  return { departmentIds: of("DEPARTMENT"), machineGroupIds: of("MACHINE_GROUP"), machineIds: of("MACHINE") };
}

function roleOf(user: any): string {
  return user?.memberships?.[0]?.role ?? "OPERATOR";
}

/** One line under a user's name: what they cover. */
function accessSummary(user: any, data: any) {
  const role = roleOf(user);
  const access = scopesOf(user);
  const names = (list: any[], ids: string[]) => ids.map((id) => list.find((item: any) => item.id === id)?.name).filter(Boolean).sort(naturalSort.compare) as string[];
  const groups = names(data.machineGroups, access.machineGroupIds);
  const machines = names(data.machines, access.machineIds);
  const machinesText = [...groups.map((name) => `all ${name}`), ...(machines.length > 3 ? [`${machines.length} machines`] : machines)].join(", ");
  switch (role) {
    case "ADMIN":
      return "Everything";
    case "OPERATOR":
      return machines.length === 1 && !groups.length ? machines[0] : groups.length ? `Shared station · ${groups.join(", ")}` : machines.length ? `${machines.length} machines (old setup)` : "No machine yet";
    case "RESPONDER":
      return `${names(data.departments, access.departmentIds).join(", ") || "No department yet"} · ${machinesText || "every machine"}`;
    case "MANAGER":
      return groups.length ? groups.join(", ") : "Every machine group";
    default:
      return "Viewer, no longer used: pick a new role";
  }
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function UsersSection({ data }: { data: any }) {
  const users: any[] = data.users ?? [];
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [filter, setFilter] = useState<"ALL" | Role>("ALL");
  const [search, setSearch] = useState("");
  const shown = users
    .filter((user) => filter === "ALL" || roleOf(user) === filter)
    .filter((user) => !search.trim() || `${user.displayName} ${user.username}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(b.active) - Number(a.active) || naturalSort.compare(a.displayName, b.displayName));
  const selected = selectedId && selectedId !== "new" ? users.find((user) => user.id === selectedId) : null;
  // A deleted or vanished user closes the editor
  useEffect(() => {
    if (selectedId && selectedId !== "new" && !selected) setSelectedId(null);
  }, [selectedId, selected]);
  const counts = (role: Role) => users.filter((user) => roleOf(user) === role).length;

  return (
    <div className="ad-split">
      <Card
        title="Users"
        meta={`${users.filter((user) => user.active).length} active`}
        actions={<button type="button" className="ad-btn primary" onClick={() => setSelectedId("new")}><PlusIcon />New user</button>}
        className="ad-users"
      >
        <div className="ad-toolbar">
          <input className="ad-input" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name" aria-label="Search users" />
          <div className="ad-seg" role="group" aria-label="Show">
            {(["ALL", "OPERATOR", "RESPONDER", "MANAGER", "ADMIN"] as const).map((role) => (
              <button key={role} type="button" aria-pressed={filter === role} className={filter === role ? "on" : ""} onClick={() => setFilter(role)}>
                {role === "ALL" ? "All" : `${ROLE_LABEL[role]}s`}{role !== "ALL" && <em>{counts(role)}</em>}
              </button>
            ))}
          </div>
        </div>
        <ul className="ad-list">
          {shown.map((user) => (
            <li key={user.id}>
              <button type="button" className={`ad-user ${selectedId === user.id ? "on" : ""} ${user.active ? "" : "inactive"}`} onClick={() => setSelectedId(user.id)}>
                <span className="ad-avatar" aria-hidden="true">{initials(user.displayName)}</span>
                <span className="ad-user-main">
                  <strong>{user.displayName}<small>@{user.username}</small></strong>
                  <span>{accessSummary(user, data)}</span>
                </span>
                <span className={`ad-role ${roleOf(user).toLowerCase()}`}>{ROLE_LABEL[roleOf(user)] ?? roleOf(user)}</span>
                {!user.active && <span className="ad-badge off">Off</span>}
                <ChevronRightIcon className="ad-chev" />
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="ad-empty">{users.length ? "No users match." : "No users yet."}</li>}
        </ul>
      </Card>

      {selectedId ? (
        <UserEditor key={selectedId} user={selected} data={data} onDone={(id) => setSelectedId(id)} onClose={() => setSelectedId(null)} />
      ) : (
        <section className="ad-card ad-hint">
          <UsersIcon />
          <p><strong>Pick a user to change them, or add a new one.</strong><span>Each role gets exactly the access it needs: an operator their machine, a responder their department and machines, a manager their machine groups.</span></p>
        </section>
      )}
    </div>
  );
}

type Draft = {
  role: Role | "";
  displayName: string;
  username: string;
  password: string;
  /** Operator: "one" machine or a "shared" station. Responder / manager: "all" machines or "some". */
  mode: "one" | "shared" | "all" | "some";
  machineId: string;
  departmentIds: Set<string>;
  machineGroupIds: Set<string>;
  machineIds: Set<string>;
};

/** Access set up before these rules, which the editor can't show as it is (saving replaces it with what's shown). */
function legacyAccess(user: any) {
  if (!user) return "";
  const role = roleOf(user);
  const access = scopesOf(user);
  if (role === "OPERATOR" && (access.departmentIds.length || access.machineIds.length > 1 || (access.machineIds.length && access.machineGroupIds.length)))
    return "This operator was set up with several machines. Pick their one machine, or make it a shared station.";
  if (role === "MANAGER" && (access.departmentIds.length || access.machineIds.length))
    return "This manager was limited by department or single machines. Managers now see machine groups (or everything): check below before saving.";
  if (role === "RESPONDER" && !access.departmentIds.length) return "This responder has no department yet. Pick theirs: until then they keep their old view.";
  if (role === "ADMIN" && (access.departmentIds.length || access.machineGroupIds.length || access.machineIds.length)) return "";
  return "";
}

function draftOf(user: any): Draft {
  const role = roleOf(user);
  const access = scopesOf(user);
  const anyMachines = access.machineGroupIds.length + access.machineIds.length > 0;
  return {
    role: user ? (role === "VIEWER" ? "" : (role as Role)) : "OPERATOR",
    displayName: user?.displayName ?? "",
    username: user?.username ?? "",
    password: "",
    mode: role === "OPERATOR" ? (access.machineIds.length === 1 && !access.machineGroupIds.length ? "one" : user ? "shared" : "one") : anyMachines ? "some" : "all",
    machineId: access.machineIds.length === 1 ? access.machineIds[0] : "",
    departmentIds: new Set(access.departmentIds),
    machineGroupIds: new Set(access.machineGroupIds),
    machineIds: new Set(access.machineIds)
  };
}

/** The access to save for the chosen role, and what is still missing. */
function accessFor(draft: Draft, machines: any[]): { access: Access; missing: string } {
  const none: Access = { departmentIds: [], machineGroupIds: [], machineIds: [] };
  const groups = Array.from(draft.machineGroupIds);
  switch (draft.role) {
    case "OPERATOR":
      if (draft.mode === "one") return { access: { ...none, machineIds: draft.machineId ? [draft.machineId] : [] }, missing: draft.machineId ? "" : "Pick the operator's machine." };
      return { access: { ...none, machineGroupIds: groups }, missing: groups.length ? "" : "Pick at least one machine group for the shared station." };
    case "RESPONDER": {
      const departmentIds = Array.from(draft.departmentIds);
      // A machine inside a group that's already picked is covered by the group
      const machineIds = draft.mode === "some" ? Array.from(draft.machineIds).filter((id) => !draft.machineGroupIds.has(machines.find((m) => m.id === id)?.machineGroupId)) : [];
      const access = { departmentIds, machineGroupIds: draft.mode === "some" ? groups : [], machineIds };
      if (!departmentIds.length) return { access, missing: "Pick at least one department." };
      if (draft.mode === "some" && !access.machineGroupIds.length && !machineIds.length) return { access, missing: "Pick the machines they cover, or choose every machine." };
      return { access, missing: "" };
    }
    case "MANAGER": {
      const access = { ...none, machineGroupIds: draft.mode === "some" ? groups : [] };
      return { access, missing: draft.mode === "some" && !groups.length ? "Pick at least one machine group, or choose every machine group." : "" };
    }
    case "ADMIN":
      return { access: none, missing: "" };
    default:
      return { access: none, missing: "Pick a role." };
  }
}

function UserEditor({ user, data, onDone, onClose }: { user: any; data: any; onDone: (id: string) => void; onClose: () => void }) {
  const isNew = !user;
  const [draft, setDraft] = useState<Draft>(() => draftOf(user));
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const toggle = (key: "departmentIds" | "machineGroupIds" | "machineIds", id: string) =>
    setDraft((current) => {
      const next = new Set(current[key]);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...current, [key]: next };
    });
  const machines: any[] = data.machines ?? [];
  const { access, missing } = accessFor(draft, machines);
  const basicsMissing = !draft.displayName.trim() ? "Enter their name." : !draft.username.trim() ? "Enter a username." : isNew && draft.password.length < 8 ? "The password needs at least 8 characters." : !isNew && draft.password && draft.password.length < 8 ? "A new password needs at least 8 characters." : "";
  const blocker = basicsMissing || missing;

  const save = useSave(async () => {
    const body = { displayName: draft.displayName.trim(), username: draft.username.trim(), role: draft.role, access, ...(draft.password ? { password: draft.password } : {}) };
    const result = isNew ? await postJson<any>("/api/admin/users", body) : await patchJson<any>(`/api/admin/users/${user.id}`, body);
    return result;
  }, [["admin-user-channel-memberships"]]);
  const setActive = useSave((active: boolean) => patchJson(`/api/admin/users/${user.id}`, { active }));
  const remove = useSave(() => deleteJson(`/api/admin/users/${user.id}`));

  return (
    <Card
      title={isNew ? "New user" : user.displayName}
      meta={isNew ? "Role first, then what they cover." : <>@{user.username} · {user.active ? "Active" : "Turned off"}</>}
      actions={<button type="button" className="ad-link" onClick={onClose}>Close</button>}
      className="ad-editor"
    >
      <form
        className="ad-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocker) save.mutate(undefined, { onSuccess: (result: any) => { set({ password: "" }); if (isNew && result?.data?.id) onDone(result.data.id); } });
        }}
      >
        <fieldset className="ad-fieldset">
          <legend>Role</legend>
          {!isNew && roleOf(user) === "VIEWER" && <p className="ad-note">Viewer is no longer used. Pick the role this person should have.</p>}
          {!isNew && legacyAccess(user) && <p className="ad-note">{legacyAccess(user)}</p>}
          <div className="ad-roles">
            {ROLES.map((role) => (
              <label key={role.id} className={`ad-role-card ${draft.role === role.id ? "on" : ""}`}>
                <input type="radio" name="role" value={role.id} checked={draft.role === role.id} onChange={() => set({ role: role.id, mode: role.id === "OPERATOR" ? "one" : draft.mode === "one" || draft.mode === "shared" ? "all" : draft.mode })} />
                <strong>{role.label}</strong>
                <span>{role.detail}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="ad-fieldset">
          <legend>Sign-in</legend>
          <div className="ad-grid2">
            <Field label="Name"><input className="ad-input" value={draft.displayName} onChange={(event) => set({ displayName: event.target.value })} placeholder="John Smith" autoComplete="off" /></Field>
            <Field label="Username"><input className="ad-input" value={draft.username} onChange={(event) => set({ username: event.target.value })} placeholder="jsmith" autoComplete="off" /></Field>
          </div>
          <Field label={isNew ? "Password" : "New password"} hint={isNew ? "At least 8 characters." : "Leave blank to keep their password."}>
            <input className="ad-input" type="password" value={draft.password} onChange={(event) => set({ password: event.target.value })} autoComplete="new-password" />
          </Field>
        </fieldset>

        {draft.role && draft.role !== "ADMIN" && (
          <fieldset className="ad-fieldset">
            <legend>{draft.role === "OPERATOR" ? "Machine" : draft.role === "RESPONDER" ? "What they answer" : "What they see"}</legend>
            <AccessPicker draft={draft} data={data} set={set} toggle={toggle} />
          </fieldset>
        )}
        {draft.role === "ADMIN" && <p className="ad-note">Admins see and manage everything, so there's nothing to limit.</p>}

        <div className="ad-form-foot">
          {blocker ? <span className="ad-missing">{blocker}</span> : <Problem error={save.error} />}
          {save.isSuccess && !save.isPending && !blocker && <span className="ad-saved">Saved</span>}
          <button type="submit" className="ad-btn primary" disabled={Boolean(blocker) || save.isPending}>{save.isPending ? "Saving…" : isNew ? "Create user" : "Save changes"}</button>
        </div>
      </form>

      {!isNew && (
        <>
          <details className="ad-more">
            <summary>Message channels</summary>
            <ChannelAccess userId={user.id} />
          </details>
          <div className="ad-danger-zone">
            <button type="button" className="ad-btn" onClick={() => setActive.mutate(!user.active)} disabled={setActive.isPending}>{user.active ? "Turn off sign-in" : "Turn sign-in back on"}</button>
            <button type="button" className="ad-btn danger" onClick={() => window.confirm(`Remove ${user.displayName}? They can't sign in any more; their history is kept.`) && remove.mutate(undefined, { onSuccess: onClose })} disabled={remove.isPending}>Remove user</button>
            <Problem error={setActive.error || remove.error} />
          </div>
        </>
      )}
    </Card>
  );
}

function Choice({ checked, onChange, label, detail }: { checked: boolean; onChange: () => void; label: string; detail?: string }) {
  return (
    <label className={`ad-choice ${checked ? "on" : ""}`}>
      <input type="radio" checked={checked} onChange={onChange} />
      <span><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
    </label>
  );
}

function AccessPicker({ draft, data, set, toggle }: { draft: Draft; data: any; set: (patch: Partial<Draft>) => void; toggle: (key: "departmentIds" | "machineGroupIds" | "machineIds", id: string) => void }) {
  const chosenMachine = (machine: any) => draft.machineIds.has(machine.id) || draft.machineId === machine.id;
  // Switched-off groups and machines still show when this user already has them, so nothing is dropped unseen
  const groups: any[] = (data.machineGroups ?? []).filter((group: any) => group.active || draft.machineGroupIds.has(group.id) || (data.machines ?? []).some((machine: any) => machine.machineGroupId === group.id && chosenMachine(machine)));
  const machines: any[] = (data.machines ?? []).filter((machine: any) => machine.active || chosenMachine(machine));
  const departments: any[] = (data.departments ?? []).filter((department: any) => department.active || draft.departmentIds.has(department.id));
  const machinesIn = (groupId: string) => machines.filter((machine) => machine.machineGroupId === groupId).sort((a, b) => naturalSort.compare(a.name, b.name));

  if (draft.role === "OPERATOR") {
    return (
      <div className="ad-access">
        <Choice checked={draft.mode === "one"} onChange={() => set({ mode: "one" })} label="Their own machine" detail="Machine Station opens straight on it, with no picking." />
        {draft.mode === "one" && (
          <select className="ad-input" value={draft.machineId} onChange={(event) => set({ machineId: event.target.value })} aria-label="Machine">
            <option value="">Pick a machine…</option>
            {groups.map((group) => (
              <optgroup key={group.id} label={group.name}>
                {machinesIn(group.id).map((machine) => <option key={machine.id} value={machine.id}>{machine.name}{machine.code ? ` (${machine.code})` : ""}</option>)}
              </optgroup>
            ))}
          </select>
        )}
        <Choice checked={draft.mode === "shared"} onChange={() => set({ mode: "shared" })} label="A shared station" detail="One sign-in for a tablet that moves between machines: they pick the machine from these groups." />
        {draft.mode === "shared" && <GroupChecks groups={groups} machinesIn={machinesIn} draft={draft} toggle={toggle} pickMachines={false} />}
      </div>
    );
  }

  if (draft.role === "RESPONDER") {
    return (
      <div className="ad-access">
        <div className="ad-sub">Departments</div>
        <div className="ad-chips">
          {departments.map((department) => (
            <button key={department.id} type="button" className={`ad-chip team ${draft.departmentIds.has(department.id) ? "on" : ""}`} aria-pressed={draft.departmentIds.has(department.id)} onClick={() => toggle("departmentIds", department.id)}>
              <TeamIcon department={department} size="sm" />{department.name}
            </button>
          ))}
          {departments.length === 0 && <span className="ad-empty">Add a department first (Calls → Departments).</span>}
        </div>
        <div className="ad-sub">Machines they cover</div>
        <Choice checked={draft.mode === "all"} onChange={() => set({ mode: "all" })} label="Every machine" />
        <Choice checked={draft.mode === "some"} onChange={() => set({ mode: "some" })} label="Only some machines" detail="Whole machine groups (all Press), single machines (Press 1–6), or both." />
        {draft.mode === "some" && <GroupChecks groups={groups} machinesIn={machinesIn} draft={draft} toggle={toggle} pickMachines />}
      </div>
    );
  }

  return (
    <div className="ad-access">
      <Choice checked={draft.mode === "all"} onChange={() => set({ mode: "all" })} label="Every machine group" detail="The whole floor, every report." />
      <Choice checked={draft.mode === "some"} onChange={() => set({ mode: "some" })} label="Only these machine groups" detail="Floor Status, Team Calls and reports show just these." />
      {draft.mode === "some" && <GroupChecks groups={groups} machinesIn={machinesIn} draft={draft} toggle={toggle} pickMachines={false} />}
    </div>
  );
}

/** Machine groups to tick; for responders, each group can open to pick single machines instead. */
function GroupChecks({ groups, machinesIn, draft, toggle, pickMachines }: { groups: any[]; machinesIn: (groupId: string) => any[]; draft: Draft; toggle: (key: "machineGroupIds" | "machineIds", id: string) => void; pickMachines: boolean }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(groups.filter((group) => machinesIn(group.id).some((machine) => draft.machineIds.has(machine.id))).map((group) => group.id)));
  if (!groups.length) return <p className="ad-empty">Add machine groups first (Floor → Machines).</p>;
  return (
    <ul className="ad-groups">
      {groups.map((group) => {
        const list = machinesIn(group.id);
        const whole = draft.machineGroupIds.has(group.id);
        const picked = list.filter((machine) => draft.machineIds.has(machine.id)).length;
        const expanded = pickMachines && open.has(group.id) && !whole;
        return (
          <li key={group.id} className={whole || picked ? "on" : ""}>
            <div className="ad-group-row">
              <label className="ad-check">
                <input type="checkbox" checked={whole} onChange={() => toggle("machineGroupIds", group.id)} />
                <span><strong>{pickMachines ? `All ${group.name}` : group.name}</strong><small>{list.length} machine{list.length === 1 ? "" : "s"}</small></span>
              </label>
              {pickMachines && !whole && (
                <button type="button" className="ad-link" aria-expanded={expanded} onClick={() => setOpen((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>
                  {picked ? `${picked} of ${list.length} picked` : "Pick machines"}
                </button>
              )}
            </div>
            {expanded && (
              <div className="ad-chips machines">
                {list.map((machine) => (
                  <button key={machine.id} type="button" className={`ad-chip ${draft.machineIds.has(machine.id) ? "on" : ""}`} aria-pressed={draft.machineIds.has(machine.id)} onClick={() => toggle("machineIds", machine.id)}>
                    {machine.name}
                  </button>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ChannelAccess({ userId }: { userId: string }) {
  const memberships = useQuery({ queryKey: ["admin-user-channel-memberships", userId], queryFn: () => api<any>(`/api/admin/users/${userId}/channel-memberships`) });
  const channels: any[] = memberships.data?.data?.channels ?? [];
  const [selected, setSelected] = useState<Record<string, { canWrite: boolean }>>({});
  useEffect(() => {
    const next: Record<string, { canWrite: boolean }> = {};
    for (const channel of channels) if (channel.membership?.canRead) next[channel.id] = { canWrite: channel.membership.canWrite };
    setSelected(next);
  }, [memberships.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useSave(
    () => putJson(`/api/admin/users/${userId}/channel-memberships`, { memberships: Object.entries(selected).map(([channelId, value]) => ({ channelId, canRead: true, canWrite: value.canWrite })) }),
    [["admin-user-channel-memberships", userId], ["admin-communication-channels"]]
  );
  if (memberships.isLoading) return <p className="ad-empty">Loading…</p>;
  if (!channels.length) return <p className="ad-empty">No channels yet. System → Message channels → Sync.</p>;
  return (
    <div className="ad-channel-access">
      <ul className="ad-list compact">
        {channels.map((channel) => (
          <li key={channel.id} className="ad-row">
            <label className="ad-check"><input type="checkbox" checked={Boolean(selected[channel.id])} onChange={() => setSelected((current) => { const next = { ...current }; if (next[channel.id]) delete next[channel.id]; else next[channel.id] = { canWrite: true }; return next; })} /><span><strong>{channel.name}</strong></span></label>
            <label className="ad-check small"><input type="checkbox" checked={Boolean(selected[channel.id]?.canWrite)} disabled={!selected[channel.id]} onChange={() => setSelected((current) => ({ ...current, [channel.id]: { canWrite: !current[channel.id]?.canWrite } }))} /><span>Can write</span></label>
          </li>
        ))}
      </ul>
      <div className="ad-form-foot"><Problem error={save.error} /><button type="button" className="ad-btn" onClick={() => save.mutate(undefined)} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save channels"}</button></div>
    </div>
  );
}

/* ---------- People: quick login ---------- */

function QuickLoginSection({ data }: { data: any }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(data.quickLoginProfiles ?? []));
  useEffect(() => setSelected(new Set(data.quickLoginProfiles ?? [])), [data.quickLoginProfiles]);
  const save = useSave(() => putJson("/api/admin/quick-login", { profiles: Array.from(selected) }), [["quick-login"]]);
  return (
    <Card title="Quick login" meta="One-tap sign-in buttons on the sign-in screen. Each uses a user with that username (operator, quality, …). Admins always sign in with a password.">
      <ul className="ad-list">
        {QUICK_LOGIN.map((profile) => (
          <li key={profile.id} className="ad-row">
            <label className="ad-check">
              <input type="checkbox" checked={selected.has(profile.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(profile.id)) next.delete(profile.id); else next.add(profile.id); return next; })} />
              <span><strong>{profile.label}</strong><small>{profile.detail} · username "{profile.id}"</small></span>
            </label>
          </li>
        ))}
      </ul>
      <div className="ad-card-foot"><Problem error={save.error} /><button type="button" className="ad-btn primary" onClick={() => save.mutate(undefined)} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button></div>
    </Card>
  );
}

/* ---------- Floor: machines ---------- */

function MachinesSection({ data }: { data: any }) {
  const groups: any[] = data.machineGroups ?? [];
  const machines: any[] = data.machines ?? [];
  const [groupName, setGroupName] = useState("");
  const [machine, setMachine] = useState({ name: "", code: "", machineGroupId: "" });
  const addGroup = useSave(() => postJson("/api/admin/machine-groups", { name: groupName.trim() }));
  const addMachine = useSave(() => postJson("/api/admin/machines", { ...machine, name: machine.name.trim(), code: machine.code.trim() }));
  const groupActive = useSave((group: any) => patchJson(`/api/admin/machine-groups/${group.id}`, { active: !group.active }));
  const groupDelete = useSave((group: any) => deleteJson(`/api/admin/machine-groups/${group.id}`));
  const machineActive = useSave((item: any) => patchJson(`/api/admin/machines/${item.id}`, { active: !item.active }));
  const machineDelete = useSave((item: any) => deleteJson(`/api/admin/machines/${item.id}`));
  const ungrouped = machines.filter((item) => !groups.some((group) => group.id === item.machineGroupId));

  return (
    <div className="ad-stack">
      <Card title="Add" meta="Machine groups are the areas on Floor Status (Press, Molding…). Every machine belongs to one.">
        <div className="ad-add-grid">
          <form className="ad-inline" onSubmit={(event) => { event.preventDefault(); if (groupName.trim()) addGroup.mutate(undefined, { onSuccess: () => setGroupName("") }); }}>
            <Field label="New machine group"><input className="ad-input" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Press" /></Field>
            <button type="submit" className="ad-btn" disabled={!groupName.trim() || addGroup.isPending}>Add group</button>
          </form>
          <form className="ad-inline" onSubmit={(event) => { event.preventDefault(); addMachine.mutate(undefined, { onSuccess: () => setMachine({ name: "", code: "", machineGroupId: machine.machineGroupId }) }); }}>
            <Field label="New machine"><input className="ad-input" value={machine.name} onChange={(event) => setMachine({ ...machine, name: event.target.value })} placeholder="Press 5" /></Field>
            <Field label="Code"><input className="ad-input short" value={machine.code} onChange={(event) => setMachine({ ...machine, code: event.target.value })} placeholder="P5" /></Field>
            <Field label="Group">
              <select className="ad-input" value={machine.machineGroupId} onChange={(event) => setMachine({ ...machine, machineGroupId: event.target.value })}>
                <option value="">Pick…</option>
                {groups.filter((group) => group.active).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </Field>
            <button type="submit" className="ad-btn" disabled={!machine.name.trim() || !machine.code.trim() || !machine.machineGroupId || addMachine.isPending}>Add machine</button>
          </form>
        </div>
        <Problem error={addGroup.error || addMachine.error} />
      </Card>

      {groups.map((group) => {
        const list = machines.filter((item) => item.machineGroupId === group.id).sort((a, b) => naturalSort.compare(a.name, b.name));
        return (
          <Card
            key={group.id}
            title={group.name}
            meta={`${list.filter((item) => item.active).length} of ${list.length} machines on`}
            actions={<><Status active={group.active} /><RowActions active={group.active} onToggle={() => groupActive.mutate(group)} onDelete={() => groupDelete.mutate(group)} deleteLabel={`Delete the ${group.name} group? Only possible once it has no machines.`} /></>}
          >
            <ul className="ad-list grid">
              {list.map((item) => (
                <li key={item.id} className={`ad-row ${item.active ? "" : "inactive"}`}>
                  <span className="ad-row-main"><strong>{item.name}</strong><small>{item.code}</small></span>
                  {!item.active && <span className="ad-badge off">Off</span>}
                  <RowActions active={item.active} onToggle={() => machineActive.mutate(item)} onDelete={() => machineDelete.mutate(item)} deleteLabel={`Delete ${item.name}? Turn it off instead if it has call history.`} />
                </li>
              ))}
              {list.length === 0 && <li className="ad-empty">No machines in this group yet.</li>}
            </ul>
          </Card>
        );
      })}
      {ungrouped.length > 0 && (
        <Card title="Without a group">
          <ul className="ad-list grid">{ungrouped.map((item) => <li key={item.id} className="ad-row"><span className="ad-row-main"><strong>{item.name}</strong><small>{item.code}</small></span></li>)}</ul>
        </Card>
      )}
      <Problem error={groupActive.error || groupDelete.error || machineActive.error || machineDelete.error} />
    </div>
  );
}

/* ---------- Floor: pagers ---------- */

function PagersSection({ data }: { data: any }) {
  const departments: any[] = data.departments ?? [];
  const pagers: any[] = data.pagerDevices ?? [];
  const [pager, setPager] = useState({ name: "", departmentId: "" });
  const [token, setToken] = useState("");
  const create = useSave(() => postJson<any>("/api/admin/pager-devices", pager));
  const rotate = useSave((id: string) => patchJson<any>(`/api/admin/pager-devices/${id}`, { rotate: true }));
  const setActive = useSave((item: any) => patchJson(`/api/admin/pager-devices/${item.id}`, { active: !item.active }));
  const remove = useSave((item: any) => deleteJson(`/api/admin/pager-devices/${item.id}`));
  return (
    <div className="ad-stack">
      <Card title="Add a pager" meta="An M5 pager answers calls for one department. Its token is shown once.">
        <form className="ad-inline" onSubmit={(event) => { event.preventDefault(); create.mutate(undefined, { onSuccess: (result: any) => { setToken(result?.data?.rawToken ?? ""); setPager({ name: "", departmentId: "" }); } }); }}>
          <Field label="Name"><input className="ad-input" value={pager.name} onChange={(event) => setPager({ ...pager, name: event.target.value })} placeholder="Maintenance pager 1" /></Field>
          <Field label="Department">
            <select className="ad-input" value={pager.departmentId} onChange={(event) => setPager({ ...pager, departmentId: event.target.value })}>
              <option value="">Pick…</option>
              {departments.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <button type="submit" className="ad-btn" disabled={!pager.name.trim() || !pager.departmentId || create.isPending}>Create pager</button>
        </form>
        {token && (
          <div className="ad-token">
            <strong>Token, shown once</strong>
            <code>{token}</code>
            <span>Put it in CONFIG_PAGER_TOKEN on the device.</span>
          </div>
        )}
        <Problem error={create.error} />
      </Card>
      <Card title="Pagers" meta={`${pagers.length} pager${pagers.length === 1 ? "" : "s"}`}>
        <ul className="ad-list">
          {pagers.map((item) => (
            <li key={item.id} className={`ad-row ${item.active ? "" : "inactive"}`}>
              {item.department && <TeamIcon department={item.department} size="sm" />}
              <span className="ad-row-main"><strong>{item.name}</strong><small>{item.department?.name} · {item.tokenFingerprint}</small></span>
              <Status active={item.active && item.department?.active} />
              <span className="ad-row-actions">
                <button type="button" className="ad-link" onClick={() => rotate.mutate(item.id, { onSuccess: (result: any) => setToken(result?.data?.rawToken ?? "") })}>New token</button>
              </span>
              <RowActions active={item.active} onToggle={() => setActive.mutate(item)} onDelete={() => remove.mutate(item)} />
            </li>
          ))}
          {pagers.length === 0 && <li className="ad-empty">No pagers yet.</li>}
        </ul>
        <Problem error={rotate.error || setActive.error || remove.error} />
      </Card>
    </div>
  );
}

/* ---------- Calls: departments and their reasons ---------- */

function DepartmentsSection({ data }: { data: any }) {
  const departments: any[] = data.departments ?? [];
  const reasons: any[] = data.issueTypes ?? [];
  const [selectedId, setSelectedId] = useState<string>(departments[0]?.id ?? "");
  const selected = departments.find((d) => d.id === selectedId) ?? departments[0];
  const [name, setName] = useState("");
  const [reason, setReason] = useState({ name: "", defaultPriority: "NORMAL" });
  const addDepartment = useSave(() => postJson<any>("/api/admin/departments", { name: name.trim() }));
  const departmentActive = useSave((item: any) => patchJson(`/api/admin/departments/${item.id}`, { active: !item.active }));
  const departmentDelete = useSave((item: any) => deleteJson(`/api/admin/departments/${item.id}`));
  const addReason = useSave(() => postJson("/api/admin/issue-types", { name: reason.name.trim(), departmentId: selected?.id, defaultPriority: reason.defaultPriority }));
  const reasonActive = useSave((item: any) => patchJson(`/api/admin/issue-types/${item.id}`, { active: !item.active }));
  const reasonDelete = useSave((item: any) => deleteJson(`/api/admin/issue-types/${item.id}`));
  const listed = reasons.filter((item) => item.departmentId === selected?.id);

  return (
    <div className="ad-split narrow">
      <Card title="Departments" meta="The teams machines call.">
        <ul className="ad-list">
          {departments.map((item) => (
            <li key={item.id}>
              <button type="button" className={`ad-pick ${selected?.id === item.id ? "on" : ""} ${item.active ? "" : "inactive"}`} onClick={() => setSelectedId(item.id)}>
                <TeamIcon department={item} size="sm" />
                <span className="ad-row-main"><strong>{item.name}</strong><small>{reasons.filter((r) => r.departmentId === item.id && r.active).length} reasons</small></span>
                {!item.active && <span className="ad-badge off">Off</span>}
                <ChevronRightIcon className="ad-chev" />
              </button>
            </li>
          ))}
        </ul>
        <form className="ad-inline ad-card-foot" onSubmit={(event) => { event.preventDefault(); if (name.trim()) addDepartment.mutate(undefined, { onSuccess: (result: any) => { setName(""); if (result?.data?.id) setSelectedId(result.data.id); } }); }}>
          <input className="ad-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="New department" aria-label="New department" />
          <button type="submit" className="ad-btn" disabled={!name.trim() || addDepartment.isPending}>Add</button>
        </form>
        <Problem error={addDepartment.error} />
      </Card>

      {selected ? (
        <Card
          title={selected.name}
          meta="The reasons an operator can pick when calling this team."
          actions={<><Status active={selected.active} /><RowActions active={selected.active} onToggle={() => departmentActive.mutate(selected)} onDelete={() => departmentDelete.mutate(selected)} deleteLabel={`Delete ${selected.name}? Only possible once nothing uses it; turn it off instead.`} /></>}
        >
          <ul className="ad-list">
            {listed.map((item) => (
              <li key={item.id} className={`ad-row ${item.active ? "" : "inactive"}`}>
                <span className="ad-row-main"><strong>{item.name}</strong><small>Priority {String(item.defaultPriority).toLowerCase()}</small></span>
                {!item.active && <span className="ad-badge off">Off</span>}
                <RowActions active={item.active} onToggle={() => reasonActive.mutate(item)} onDelete={() => reasonDelete.mutate(item)} />
              </li>
            ))}
            {listed.length === 0 && <li className="ad-empty">No reasons yet.</li>}
          </ul>
          <form className="ad-inline ad-card-foot" onSubmit={(event) => { event.preventDefault(); if (reason.name.trim()) addReason.mutate(undefined, { onSuccess: () => setReason({ ...reason, name: "" }) }); }}>
            <input className="ad-input" value={reason.name} onChange={(event) => setReason({ ...reason, name: event.target.value })} placeholder="New reason (Jam, Tooling…)" aria-label="New reason" />
            <select className="ad-input short" value={reason.defaultPriority} onChange={(event) => setReason({ ...reason, defaultPriority: event.target.value })} aria-label="Priority">
              {PRIORITIES.map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}
            </select>
            <button type="submit" className="ad-btn" disabled={!reason.name.trim() || addReason.isPending}>Add reason</button>
          </form>
          <Problem error={addReason.error || departmentActive.error || departmentDelete.error || reasonActive.error || reasonDelete.error} />
        </Card>
      ) : (
        <section className="ad-card ad-hint"><WrenchIcon /><p><strong>Add a department to start.</strong><span>Maintenance, Quality, Supervisor…</span></p></section>
      )}
    </div>
  );
}

/* ---------- Calls: call buttons ---------- */

function CallButtonsSection({ data }: { data: any }) {
  const departments: any[] = (data.departments ?? []).filter((d: any) => d.active);
  const templates: any[] = data.commandTemplates ?? [];
  const [name, setName] = useState("");
  const [targets, setTargets] = useState<Record<string, string>>({});
  const reasonsBy = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const issue of data.issueTypes ?? []) if (issue.active) map.set(issue.departmentId, [...(map.get(issue.departmentId) ?? []), issue]);
    return map;
  }, [data.issueTypes]);
  const chosen = Object.entries(targets).filter(([, issueTypeId]) => issueTypeId);
  const create = useSave(() => postJson("/api/admin/command-templates", { name: name.trim(), buttonLabel: name.trim(), color: "#475569", targets: chosen.map(([departmentId, issueTypeId]) => ({ departmentId, issueTypeId })) }));
  const setActive = useSave((item: any) => patchJson(`/api/admin/command-templates/${item.id}`, { active: !item.active }));
  const remove = useSave((item: any) => deleteJson(`/api/admin/command-templates/${item.id}`));
  const single = templates.filter((t) => (t.targets?.length ?? 0) === 1);
  const combined = templates.filter((t) => (t.targets?.length ?? 0) !== 1);
  const row = (item: any) => (
    <li key={item.id} className={`ad-row ${item.active ? "" : "inactive"}`}>
      {item.targets?.length === 1 ? <TeamIcon department={item.targets[0].department} size="sm" /> : <span className="ad-glyph"><LayersIcon /></span>}
      <span className="ad-row-main"><strong>{item.buttonLabel}</strong><small>{item.targets?.map((t: any) => `${t.department?.name}: ${t.issueType?.name ?? "any"}`).join(" + ")}</small></span>
      {!item.active && <span className="ad-badge off">Off</span>}
      <RowActions active={item.active} onToggle={() => setActive.mutate(item)} onDelete={() => remove.mutate(item)} />
    </li>
  );
  return (
    <div className="ad-split">
      <div className="ad-stack">
        <Card title="Team buttons" meta="The big buttons on Machine Station: one team each.">
          <ul className="ad-list">{single.map(row)}{single.length === 0 && <li className="ad-empty">None yet.</li>}</ul>
        </Card>
        <Card title="More requests" meta="Buttons that call several teams at once (Job Approval, Material Clear…).">
          <ul className="ad-list">{combined.map(row)}{combined.length === 0 && <li className="ad-empty">None yet.</li>}</ul>
        </Card>
        <Problem error={setActive.error || remove.error} />
      </div>
      <Card title="New call button" meta="Pick the teams it calls, and the reason each one sees.">
        <form className="ad-form" onSubmit={(event) => { event.preventDefault(); create.mutate(undefined, { onSuccess: () => { setName(""); setTargets({}); } }); }}>
          <Field label="Button name"><input className="ad-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Quality Hold" /></Field>
          <div className="ad-sub">Calls</div>
          <ul className="ad-list compact">
            {departments.map((department) => (
              <li key={department.id} className="ad-row">
                <TeamIcon department={department} size="sm" />
                <span className="ad-row-main"><strong>{department.name}</strong></span>
                <select className="ad-input" value={targets[department.id] ?? ""} onChange={(event) => setTargets((current) => ({ ...current, [department.id]: event.target.value }))} aria-label={`${department.name} reason`}>
                  <option value="">Don't call</option>
                  {(reasonsBy.get(department.id) ?? []).map((issue: any) => <option key={issue.id} value={issue.id}>{issue.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <div className="ad-form-foot">
            {!name.trim() ? <span className="ad-missing">Name the button.</span> : !chosen.length ? <span className="ad-missing">Pick at least one team to call.</span> : <Problem error={create.error} />}
            <button type="submit" className="ad-btn primary" disabled={!name.trim() || !chosen.length || create.isPending}>{create.isPending ? "Creating…" : "Create button"}</button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/* ---------- System: status ---------- */

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "–";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "–";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function StatusSection() {
  const status = useQuery({ queryKey: ["admin-status"], queryFn: () => api<any>("/api/admin/status"), refetchInterval: 30_000 });
  const data = status.data?.data;
  const pagers: any[] = data?.pagers ?? [];
  const metric = (label: string, value: ReactNode, detail?: ReactNode) => (
    <div className="ad-metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>
  );
  return (
    <div className="ad-stack">
      <Card
        title="System"
        meta={data ? `Updated ${new Date(data.server.now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : status.isError ? "Status is unavailable." : "Loading…"}
        actions={<button type="button" className="ad-btn" onClick={() => void status.refetch()} disabled={status.isFetching}>{status.isFetching ? "Refreshing…" : "Refresh"}</button>}
      >
        {data && (
          <div className="ad-metrics">
            {metric("Database", data.database.status === "ok" ? "OK" : String(data.database.status).toUpperCase(), `${data.database.latencyMs} ms`)}
            {metric("Running for", formatDuration(data.server.uptimeSeconds), data.server.nodeVersion)}
            {metric("People online", data.realtime.connectedUsers, `${data.realtime.connectedSockets} connections`)}
            {metric("Open calls", data.activity.activeAlerts, `${data.activity.alertsCreatedToday} today · ${data.activity.alertsResolvedToday} closed`)}
            {metric("Memory", formatBytes(data.server.memory.heapUsedBytes), `${formatBytes(data.server.memory.rssBytes)} total`)}
            {metric("Report time zone", data.server.reportTimeZone)}
          </div>
        )}
      </Card>
      {data && (
        <Card title="Pagers" meta={`${pagers.filter((p) => p.status === "online").length} of ${pagers.length} online`}>
          <ul className="ad-list">
            {pagers.map((pager) => (
              <li key={pager.id} className="ad-row">
                <span className="ad-row-main"><strong>{pager.name}</strong><small>{pager.departmentName} · {pager.lastSeenAt ? `seen ${new Date(pager.lastSeenAt).toLocaleString()}` : "never seen"}</small></span>
                <span className={`ad-badge ${pager.status === "online" ? "on" : pager.status === "recent" ? "warn" : "off"}`}>{pager.status}</span>
              </li>
            ))}
            {pagers.length === 0 && <li className="ad-empty">No pagers.</li>}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* ---------- System: message channels ---------- */

function ChannelsSection() {
  const channelsQuery = useQuery({ queryKey: ["admin-communication-channels"], queryFn: () => api<any>("/api/admin/communication-channels") });
  const channels: any[] = channelsQuery.data?.data ?? [];
  const sync = useSave(() => postJson("/api/admin/communication-channels/sync", {}), [["admin-communication-channels"]]);
  const setActive = useSave((channel: any) => patchJson(`/api/admin/communication-channels/${channel.id}`, { active: !channel.active }), [["admin-communication-channels"]]);
  const archive = useSave((channel: any) => patchJson(`/api/admin/communication-channels/${channel.id}/archive`, {}), [["admin-communication-channels"]]);
  const groups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const channel of channels) map.set(channel.type, [...(map.get(channel.type) ?? []), channel]);
    return Array.from(map, ([type, items]) => ({ type, items }));
  }, [channels]);
  const typeLabel: Record<string, string> = { DEPARTMENT: "Departments", MACHINE_GROUP: "Machine groups", MACHINE: "Machines", CUSTOM: "Other" };
  return (
    <div className="ad-stack">
      <Card
        title="Message channels"
        meta="Conversations on the Communication page, one per department, machine group and machine. Sync adds any that are missing. Who can read each is set per user (People → Users → Message channels)."
        actions={<button type="button" className="ad-btn" onClick={() => sync.mutate(undefined)} disabled={sync.isPending}>{sync.isPending ? "Syncing…" : "Sync channels"}</button>}
      >
        <Problem error={sync.error || setActive.error || archive.error} />
        {channels.length === 0 && <p className="ad-empty">{channelsQuery.isLoading ? "Loading…" : "No channels yet. Sync channels to create them."}</p>}
      </Card>
      {groups.map((group) => (
        <Card key={group.type} title={typeLabel[group.type] ?? group.type} meta={`${group.items.length} channels`}>
          <ul className="ad-list grid">
            {group.items.map((channel) => (
              <li key={channel.id} className={`ad-row ${channel.active ? "" : "inactive"}`}>
                <span className="ad-row-main"><strong>{channel.name}</strong><small>{channel.memberCount ?? 0} people</small></span>
                {!channel.active && <span className="ad-badge off">Off</span>}
                <span className="ad-row-actions">
                  <button type="button" className="ad-link" onClick={() => setActive.mutate(channel)}>{channel.active ? "Turn off" : "Turn on"}</button>
                  <button type="button" className="ad-link danger" onClick={() => window.confirm(`Archive ${channel.name}?`) && archive.mutate(channel)}>Archive</button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
