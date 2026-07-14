import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson, patchJson, putJson, deleteJson } from "../lib/api";

const priorities = ["LOW", "NORMAL", "HIGH", "CRITICAL"];
const roles = ["ADMIN", "MANAGER", "OPERATOR", "RESPONDER", "VIEWER"];
const quickLoginProfiles = [
  { id: "operator", label: "Operator", detail: "Operator page" },
  { id: "quality", label: "Quality", detail: "Department queue" },
  { id: "supervisor", label: "Supervisor", detail: "Department queue" },
  { id: "manager", label: "Manager", detail: "Live floor and reports" }
];

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function useAdmin() {
  return useQuery({ queryKey: ["admin"], queryFn: () => api<any>("/api/admin/bootstrap") });
}

function TextInput({ value, onChange, placeholder, type = "text" }: any) {
  return <input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
}

function AdminActions({ active, onToggle, onDelete }: { active?: boolean; onToggle?: () => void; onDelete: () => void }) {
  return (
    <div className="admin-actions" onClick={(event) => event.stopPropagation()}>
      {onToggle && <button onClick={onToggle}>{active ? "Disable" : "Enable"}</button>}
      <button className="danger" onClick={() => window.confirm("Delete this item? This cannot be undone.") && onDelete()}>Delete</button>
    </div>
  );
}

export function AdminPage() {
  const [tab, setTab] = useState("machines");
  const admin = useAdmin();
  const data = admin.data?.data;
  return (
    <div className="page-stack admin-page">
      <header className="page-header"><div><h1>Admin Setup</h1><p>Configure machines, departments, issue buttons, command buttons, users, and M5 pagers.</p></div></header>
      <div className="tab-row">
        {["status", "settings", "machines", "departments", "commands", "users", "communication", "pagers"].map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}
      </div>
      {tab === "status" && <StatusAdmin />}
      {tab === "settings" && <SettingsAdmin data={data} />}
      {tab === "machines" && <MachinesAdmin data={data} />}
      {tab === "departments" && <DepartmentsAdmin data={data} />}
      {tab === "commands" && <CommandsAdmin data={data} />}
      {tab === "users" && <UsersAdmin data={data} />}
      {tab === "communication" && <CommunicationChannelsAdmin />}
      {tab === "pagers" && <PagersAdmin data={data} />}
    </div>
  );
}

function SettingsAdmin({ data }: any) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set(data?.quickLoginProfiles ?? []));
  }, [data?.quickLoginProfiles]);
  const save = useMutation({
    mutationFn: () => putJson("/api/admin/quick-login", { profiles: [...selected] }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin"] });
      queryClient.invalidateQueries({ queryKey: ["quick-login"] });
    }
  });
  const toggle = (profile: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(profile)) next.delete(profile);
      else next.add(profile);
      return next;
    });
  };

  return (
    <section className="panel">
      <div className="admin-panel-header">
        <div>
          <h2>Quick Login</h2>
          <span>Admin always requires username and password.</span>
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving" : "Save"}</button>
      </div>
      <div className="quick-login-settings">
        {quickLoginProfiles.map((profile) => (
          <label key={profile.id} className="quick-login-setting">
            <input type="checkbox" checked={selected.has(profile.id)} onChange={() => toggle(profile.id)} />
            <span>
              <strong>{profile.label}</strong>
              <em>{profile.detail}</em>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function StatusMetric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="status-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <em>{detail}</em>}
    </div>
  );
}

function StatusAdmin() {
  const status = useQuery({ queryKey: ["admin-status"], queryFn: () => api<any>("/api/admin/status"), refetchInterval: 30000 });
  const data = status.data?.data;
  const pagers = data?.pagers ?? [];
  const onlinePagers = pagers.filter((pager: any) => pager.status === "online").length;

  return (
    <div className="admin-status-grid">
      <section className="panel admin-status-hero">
        <div className="admin-panel-header">
          <div>
            <h2>System Status</h2>
            <span>{data ? `Updated ${new Date(data.server.now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Loading status"}</span>
          </div>
          <button onClick={() => status.refetch()} disabled={status.isFetching}>{status.isFetching ? "Refreshing" : "Refresh"}</button>
        </div>
        {status.isError && <div className="empty-state small">Status is unavailable.</div>}
        {data && (
          <div className="status-metric-grid">
            <StatusMetric label="Database" value={data.database.status.toUpperCase()} detail={`${data.database.latencyMs} ms`} />
            <StatusMetric label="API Uptime" value={formatDuration(data.server.uptimeSeconds)} detail={data.server.nodeEnv} />
            <StatusMetric label="Connected Users" value={data.realtime.connectedUsers} detail={`${data.realtime.connectedSockets} sockets`} />
            <StatusMetric label="Active Alerts" value={data.activity.activeAlerts} detail={`${data.activity.alertsCreatedToday} created today`} />
          </div>
        )}
      </section>

      {data && (
        <>
          <section className="panel">
            <div className="admin-panel-header"><h2>Storage</h2><span>Current company</span></div>
            <div className="status-metric-grid compact">
              <StatusMetric label="Machines" value={data.storage.machines} />
              <StatusMetric label="Departments" value={data.storage.departments} />
              <StatusMetric label="Users" value={data.storage.users} />
              <StatusMetric label="Channels" value={data.storage.channels} />
              <StatusMetric label="Messages" value={data.storage.messages} />
              <StatusMetric label="Heap Used" value={formatBytes(data.server.memory.heapUsedBytes)} detail={`${formatBytes(data.server.memory.rssBytes)} RSS`} />
            </div>
          </section>

          <section className="panel">
            <div className="admin-panel-header"><h2>Pager Devices</h2><span>{onlinePagers}/{pagers.length} online</span></div>
            <div className="admin-list">
              {pagers.map((pager: any) => (
                <div key={pager.id} className="admin-row status-pager-row">
                  <strong>{pager.name}</strong>
                  <span>{pager.departmentName} | {pager.lastSeenAt ? new Date(pager.lastSeenAt).toLocaleString() : "never seen"}</span>
                  <em className={`status-pill ${pager.status}`}>{pager.status}</em>
                </div>
              ))}
              {pagers.length === 0 && <div className="empty-state small">No pager devices configured.</div>}
            </div>
          </section>

          <section className="panel">
            <div className="admin-panel-header"><h2>Runtime</h2><span>{data.server.nodeVersion}</span></div>
            <div className="status-runtime-list">
              <div><span>Server time</span><strong>{new Date(data.server.now).toLocaleString()}</strong></div>
              <div><span>Report timezone</span><strong>{data.server.reportTimeZone}</strong></div>
              <div><span>Resolved today</span><strong>{data.activity.alertsResolvedToday}</strong></div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MachinesAdmin({ data }: any) {
  const queryClient = useQueryClient();
  const [groupName, setGroupName] = useState("");
  const [groupFilterId, setGroupFilterId] = useState("");
  const [machine, setMachine] = useState({ name: "", code: "", machineGroupId: "" });
  const machineGroups = data?.machineGroups ?? [];
  const activeMachineGroups = machineGroups.filter((group: any) => group.active);
  const machines = data?.machines ?? [];
  const selectedGroup = machineGroups.find((group: any) => group.id === groupFilterId);
  const visibleMachines = groupFilterId ? machines.filter((item: any) => item.machineGroupId === groupFilterId) : machines;
  const createGroup = useMutation({ mutationFn: () => postJson("/api/admin/machine-groups", { name: groupName }), onSuccess: () => { setGroupName(""); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const createMachine = useMutation({ mutationFn: () => postJson("/api/admin/machines", machine), onSuccess: () => { setMachine({ name: "", code: "", machineGroupId: "" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggleGroup = useMutation({ mutationFn: (group: any) => patchJson(`/api/admin/machine-groups/${group.id}`, { active: !group.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const deleteGroup = useMutation({ mutationFn: (group: any) => deleteJson(`/api/admin/machine-groups/${group.id}`), onSuccess: (_result, group: any) => { if (groupFilterId === group.id) setGroupFilterId(""); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggleMachine = useMutation({ mutationFn: (m: any) => patchJson(`/api/admin/machines/${m.id}`, { active: !m.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const deleteMachine = useMutation({ mutationFn: (m: any) => deleteJson(`/api/admin/machines/${m.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  return (
    <div className="admin-grid">
      <section className="panel">
        <div className="admin-panel-header">
          <h2>Machine groups</h2>
          <button className={`admin-filter-pill ${groupFilterId === "" ? "active" : ""}`} onClick={() => setGroupFilterId("")}>All</button>
        </div>
        <div className="inline-form">
          <TextInput value={groupName} onChange={setGroupName} placeholder="Press" />
          <button onClick={() => createGroup.mutate()} disabled={!groupName.trim() || createGroup.isPending}>Add group</button>
        </div>
        <div className="admin-list">
          {machineGroups.length === 0 && <div className="empty-state small">No items yet.</div>}
          {machineGroups.map((item: any) => (
            <div key={item.id} className={`admin-row admin-group-row ${groupFilterId === item.id ? "selected" : ""}`} onClick={() => setGroupFilterId(item.id)}>
              <strong>{item.name}</strong>
              <span>{item.active ? "active" : "inactive"}</span>
              <AdminActions active={item.active} onToggle={() => toggleGroup.mutate(item)} onDelete={() => deleteGroup.mutate(item)} />
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="admin-panel-header">
          <h2>{selectedGroup ? `${selectedGroup.name} machines` : "Machines"}</h2>
          <span>{visibleMachines.length} shown</span>
        </div>
        <div className="inline-form stack">
          <TextInput value={machine.name} onChange={(name: string) => setMachine({ ...machine, name })} placeholder="Press 5" />
          <TextInput value={machine.code} onChange={(code: string) => setMachine({ ...machine, code })} placeholder="P5" />
          <select value={machine.machineGroupId} onChange={(event) => setMachine({ ...machine, machineGroupId: event.target.value })}>
            <option value="">Machine group</option>
            {activeMachineGroups.map((group: any) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <button onClick={() => createMachine.mutate()} disabled={!machine.name.trim() || !machine.code.trim() || !machine.machineGroupId || createMachine.isPending}>Add machine</button>
        </div>
        <AdminList items={visibleMachines} render={(item: any) => <><strong>{item.name}</strong><span>{item.code} | {item.machineGroup?.name} | {item.active && item.machineGroup?.active ? "active" : "inactive"}</span><AdminActions active={item.active} onToggle={() => toggleMachine.mutate(item)} onDelete={() => deleteMachine.mutate(item)} /></>} />
      </section>
    </div>
  );
}

function DepartmentsAdmin({ data }: any) {
  const queryClient = useQueryClient();
  const [department, setDepartment] = useState({ name: "" });
  const [departmentFilterId, setDepartmentFilterId] = useState("");
  const [issue, setIssue] = useState({ name: "", departmentId: "", defaultPriority: "NORMAL" });
  const departments = data?.departments ?? [];
  const activeDepartments = departments.filter((item: any) => item.active);
  const selectedDepartment = departments.find((item: any) => item.id === departmentFilterId);
  const visibleIssues = departmentFilterId ? (data?.issueTypes ?? []).filter((item: any) => item.departmentId === departmentFilterId) : data?.issueTypes ?? [];
  const createDepartment = useMutation({ mutationFn: () => postJson("/api/admin/departments", department), onSuccess: () => { setDepartment({ name: "" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggle = useMutation({ mutationFn: (d: any) => patchJson(`/api/admin/departments/${d.id}`, { active: !d.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const remove = useMutation({ mutationFn: (d: any) => deleteJson(`/api/admin/departments/${d.id}`), onSuccess: (_result, item: any) => { if (departmentFilterId === item.id) setDepartmentFilterId(""); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const createIssue = useMutation({ mutationFn: () => postJson("/api/admin/issue-types", issue), onSuccess: () => { setIssue({ name: "", departmentId: "", defaultPriority: "NORMAL" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggleIssue = useMutation({ mutationFn: (item: any) => patchJson(`/api/admin/issue-types/${item.id}`, { active: !item.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const removeIssue = useMutation({ mutationFn: (item: any) => deleteJson(`/api/admin/issue-types/${item.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  return (
    <div className="admin-grid">
      <section className="panel">
        <div className="admin-panel-header">
          <h2>Departments</h2>
          <button className={`admin-filter-pill ${departmentFilterId === "" ? "active" : ""}`} onClick={() => setDepartmentFilterId("")}>All</button>
        </div>
        <div className="inline-form">
          <TextInput value={department.name} onChange={(name: string) => setDepartment({ name })} placeholder="Quality" />
          <button onClick={() => createDepartment.mutate()} disabled={!department.name.trim() || createDepartment.isPending}>Add department</button>
        </div>
        <div className="admin-list">
          {departments.length === 0 && <div className="empty-state small">No items yet.</div>}
          {departments.map((item: any) => (
            <div key={item.id} className={`admin-row admin-group-row ${departmentFilterId === item.id ? "selected" : ""}`} onClick={() => setDepartmentFilterId(item.id)}>
              <strong>{item.name}</strong>
              <span>{item.active ? "active" : "inactive"}</span>
              <AdminActions active={item.active} onToggle={() => toggle.mutate(item)} onDelete={() => remove.mutate(item)} />
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="admin-panel-header">
          <h2>{selectedDepartment ? `${selectedDepartment.name} issues` : "Issue buttons"}</h2>
          <span>{visibleIssues.length} shown</span>
        </div>
        <div className="inline-form stack">
          <TextInput value={issue.name} onChange={(name: string) => setIssue({ ...issue, name })} placeholder="Bad seal" />
          <select value={issue.departmentId} onChange={(event) => setIssue({ ...issue, departmentId: event.target.value })}>
            <option value="">Department</option>
            {activeDepartments.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <select value={issue.defaultPriority} onChange={(event) => setIssue({ ...issue, defaultPriority: event.target.value })}>{priorities.map((p) => <option key={p}>{p}</option>)}</select>
          <button onClick={() => createIssue.mutate()} disabled={!issue.name.trim() || !issue.departmentId || createIssue.isPending}>Add issue</button>
        </div>
        <AdminList items={visibleIssues} render={(item: any) => <><strong>{item.name}</strong><span>{item.department?.name} | {item.defaultPriority} | {item.active && item.department?.active ? "active" : "inactive"}</span><AdminActions active={item.active} onToggle={() => toggleIssue.mutate(item)} onDelete={() => removeIssue.mutate(item)} /></>} />
      </section>
    </div>
  );
}

function CommandsAdmin({ data }: any) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#ef4444");
  const [departmentId, setDepartmentId] = useState("");
  const [targets, setTargets] = useState<Record<string, string>>({});
  const activeDepartments = (data?.departments ?? []).filter((department: any) => department.active);
  const visibleTemplates = departmentId
    ? (data?.commandTemplates ?? []).filter((template: any) => template.targets?.some((target: any) => target.departmentId === departmentId))
    : data?.commandTemplates ?? [];
  const createCommand = useMutation({
    mutationFn: () => postJson("/api/admin/command-templates", {
      name,
      buttonLabel: name,
      color,
      targets: Object.entries(targets).filter(([, issueTypeId]) => issueTypeId).map(([departmentId, issueTypeId]) => ({ departmentId, issueTypeId }))
    }),
    onSuccess: () => { setName(""); setTargets({}); queryClient.invalidateQueries({ queryKey: ["admin"] }); }
  });
  const toggle = useMutation({ mutationFn: (item: any) => patchJson(`/api/admin/command-templates/${item.id}`, { active: !item.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const remove = useMutation({ mutationFn: (item: any) => deleteJson(`/api/admin/command-templates/${item.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const issueByDepartment = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const issue of data?.issueTypes ?? []) {
      if (!issue.active) continue;
      map.set(issue.departmentId, [...(map.get(issue.departmentId) ?? []), issue]);
    }
    return map;
  }, [data]);
  return <div className="admin-grid"><section className="panel"><h2>New command button</h2><div className="inline-form stack"><TextInput value={name} onChange={setName} placeholder="Quality Hold" /><input type="color" value={color} onChange={(event) => setColor(event.target.value)} />{activeDepartments.map((department: any) => <label key={department.id} className="manual-row"><span>{department.name}</span><select value={targets[department.id] ?? ""} onChange={(event) => setTargets((current) => ({ ...current, [department.id]: event.target.value }))}><option value="">Do not call</option>{(issueByDepartment.get(department.id) ?? []).map((issue: any) => <option key={issue.id} value={issue.id}>{issue.name}</option>)}</select></label>)}<button onClick={() => createCommand.mutate()} disabled={!name.trim() || Object.values(targets).every((value) => !value) || createCommand.isPending}>Create command</button></div></section><section className="panel"><div className="admin-panel-header"><h2>Command buttons</h2><span>{visibleTemplates.length} shown</span></div><div className="inline-form stack"><select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">All active departments</option>{activeDepartments.map((department: any) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div><AdminList items={visibleTemplates} render={(item: any) => <><strong>{item.buttonLabel}</strong><span>{item.targets?.map((t: any) => t.department.name).join(" + ")} | {item.active ? "active" : "inactive"}</span><AdminActions active={item.active} onToggle={() => toggle.mutate(item)} onDelete={() => remove.mutate(item)} /></>} /></section></div>;
}

function UsersAdmin({ data }: any) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState({ username: "", password: "", displayName: "", role: "OPERATOR" });
  const [selectedUserId, setSelectedUserId] = useState("");
  const [editingUserId, setEditingUserId] = useState("");
  const [editUser, setEditUser] = useState({ username: "", displayName: "", password: "", role: "OPERATOR" });
  const createUser = useMutation({ mutationFn: () => postJson("/api/admin/users", user), onSuccess: () => { setUser({ username: "", password: "", displayName: "", role: "OPERATOR" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const createUserError = createUser.error instanceof Error ? createUser.error.message : "Unable to create the user.";
  const toggle = useMutation({ mutationFn: (item: any) => patchJson(`/api/admin/users/${item.id}`, { active: !item.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const remove = useMutation({ mutationFn: (item: any) => deleteJson(`/api/admin/users/${item.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const updateUser = useMutation({
    mutationFn: () => patchJson(`/api/admin/users/${editingUserId}`, {
      username: editUser.username,
      displayName: editUser.displayName,
      role: editUser.role,
      ...(editUser.password ? { password: editUser.password } : {})
    }),
    onSuccess: () => {
      setEditUser((current) => ({ ...current, password: "" }));
      queryClient.invalidateQueries({ queryKey: ["admin"] });
    }
  });
  const users = data?.users ?? [];
  const selectedUser = users.find((item: any) => item.id === selectedUserId) ?? users[0];
  const editingUser = users.find((item: any) => item.id === editingUserId);
  const startViewUser = (item: any) => {
    setSelectedUserId(item.id);
    setEditingUserId(item.id);
    setEditUser({
      username: item.username ?? "",
      displayName: item.displayName ?? "",
      password: "",
      role: item.memberships?.[0]?.role ?? "OPERATOR"
    });
  };

  useEffect(() => {
    if (!editingUserId || editingUser) return;
    setEditingUserId("");
    setEditUser({ username: "", displayName: "", password: "", role: "OPERATOR" });
  }, [editingUserId, editingUser]);

  return (
    <div className="admin-grid">
      <section className="panel">
        <h2>Users</h2>
        <div className="inline-form stack">
          <TextInput value={user.username} onChange={(username: string) => setUser({ ...user, username })} placeholder="jsmith" />
          <TextInput value={user.displayName} onChange={(displayName: string) => setUser({ ...user, displayName })} placeholder="John Smith" />
          <TextInput type="password" value={user.password} onChange={(password: string) => setUser({ ...user, password })} placeholder="Password" />
          <p className="form-note">Passwords must contain at least 8 characters.</p>
          <select value={user.role} onChange={(event) => setUser({ ...user, role: event.target.value })}>{roles.map((role) => <option key={role}>{role}</option>)}</select>
          <button onClick={() => createUser.mutate()} disabled={!user.username.trim() || !user.displayName.trim() || user.password.length < 8 || createUser.isPending}>{createUser.isPending ? "Creating" : "Create user"}</button>
          {createUser.isError && <p className="form-error" role="alert">{createUserError}</p>}
        </div>
        <div className="admin-list">
          {users.map((item: any) => (
            <div key={item.id} className={`admin-row admin-group-row ${selectedUser?.id === item.id ? "selected" : ""}`} onClick={() => setSelectedUserId(item.id)}>
              <strong>{item.username}</strong>
              <span>{item.displayName} | {item.memberships?.[0]?.role ?? "no role"} | {item.active ? "active" : "inactive"}</span>
              <div className="admin-actions" onClick={(event) => event.stopPropagation()}>
                <button onClick={() => startViewUser(item)}>View</button>
                <button onClick={() => toggle.mutate(item)}>{item.active ? "Disable" : "Enable"}</button>
                <button className="danger" onClick={() => window.confirm("Delete this user? This disables access but keeps history.") && remove.mutate(item)}>Delete</button>
              </div>
            </div>
          ))}
          {users.length === 0 && <div className="empty-state small">No items yet.</div>}
        </div>
      </section>
      <section className="panel user-detail-panel">
        <div className="admin-panel-header">
          <div>
            <h2>User Details</h2>
            <span>{editingUser ? editingUser.displayName : "Select View on a user"}</span>
          </div>
        </div>
        {!editingUser && <div className="empty-state small">Click View next to a user to update login details.</div>}
        {editingUser && (
          <div className="inline-form stack">
            <label className="field-label">
              <span>Username</span>
              <TextInput value={editUser.username} onChange={(username: string) => setEditUser({ ...editUser, username })} placeholder="username" />
            </label>
            <label className="field-label">
              <span>Display name</span>
              <TextInput value={editUser.displayName} onChange={(displayName: string) => setEditUser({ ...editUser, displayName })} placeholder="Display name" />
            </label>
            <label className="field-label">
              <span>Role</span>
              <select value={editUser.role} onChange={(event) => setEditUser({ ...editUser, role: event.target.value })}>{roles.map((role) => <option key={role}>{role}</option>)}</select>
            </label>
            <label className="field-label">
              <span>New password</span>
              <TextInput type="password" value={editUser.password} onChange={(password: string) => setEditUser({ ...editUser, password })} placeholder="Leave blank to keep current password" />
            </label>
            <button
              onClick={() => updateUser.mutate()}
              disabled={!editUser.username.trim() || !editUser.displayName.trim() || (editUser.password.length > 0 && editUser.password.length < 8) || updateUser.isPending}
            >
              {updateUser.isPending ? "Saving" : "Save user"}
            </button>
            <p className="form-note">Current passwords cannot be viewed. Leave this blank to keep it, or enter at least 8 characters to reset it.</p>
          </div>
        )}
      </section>
      <ScopeAccessPanel user={selectedUser} />
      <ChannelAccessPanel user={selectedUser} />
    </div>
  );
}

function ScopeAccessPanel({ user }: { user: any }) {
  const queryClient = useQueryClient();
  const scopesQuery = useQuery({
    queryKey: ["admin-user-scopes", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => api<any>(`/api/admin/users/${user.id}/scopes`)
  });
  const [selected, setSelected] = useState({ departments: new Set<string>(), machineGroups: new Set<string>(), machines: new Set<string>() });
  const data = scopesQuery.data?.data;

  useEffect(() => {
    const scopes = data?.scopes ?? [];
    setSelected({
      departments: new Set(scopes.filter((scope: any) => scope.scopeType === "DEPARTMENT").map((scope: any) => scope.scopeId)),
      machineGroups: new Set(scopes.filter((scope: any) => scope.scopeType === "MACHINE_GROUP").map((scope: any) => scope.scopeId)),
      machines: new Set(scopes.filter((scope: any) => scope.scopeType === "MACHINE").map((scope: any) => scope.scopeId))
    });
  }, [data]);

  const save = useMutation({
    mutationFn: () => api(`/api/admin/users/${user.id}/scopes`, {
      method: "PUT",
      body: JSON.stringify({
        departmentIds: Array.from(selected.departments),
        machineGroupIds: Array.from(selected.machineGroups),
        machineIds: Array.from(selected.machines)
      })
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-scopes", user?.id] });
      queryClient.invalidateQueries({ queryKey: ["admin"] });
    }
  });

  if (!user) return <section className="panel"><div className="empty-state">Create a user first.</div></section>;

  const toggle = (group: "departments" | "machineGroups" | "machines", id: string) => {
    setSelected((current) => {
      const nextGroup = new Set(current[group]);
      if (nextGroup.has(id)) nextGroup.delete(id);
      else nextGroup.add(id);
      return { ...current, [group]: nextGroup };
    });
  };

  const renderChecks = (title: string, items: any[], group: "departments" | "machineGroups" | "machines", detail?: (item: any) => string) => (
    <div className="scope-section">
      <h3>{title}</h3>
      <div className="scope-check-grid">
        {items.map((item: any) => (
          <label key={item.id} className="scope-check">
            <input type="checkbox" checked={selected[group].has(item.id)} onChange={() => toggle(group, item.id)} />
            <span>{item.name}</span>
            {detail && <em>{detail(item)}</em>}
          </label>
        ))}
        {items.length === 0 && <div className="empty-state small">No items configured.</div>}
      </div>
    </div>
  );

  return (
    <section className="panel">
      <div className="admin-panel-header">
        <div>
          <h2>User Access</h2>
          <span>{user.displayName}</span>
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending || !scopesQuery.data}>{save.isPending ? "Saving" : "Save"}</button>
      </div>
      {scopesQuery.isLoading && <div className="empty-state small">Loading access.</div>}
      {data && (
        <div className="scope-access-grid">
          {renderChecks("Department Access", data.departments ?? [], "departments")}
          {renderChecks("Machine Group Access", data.machineGroups ?? [], "machineGroups")}
          {renderChecks("Machine Access", data.machines ?? [], "machines", (machine) => machine.machineGroup?.name ?? "")}
        </div>
      )}
    </section>
  );
}

function CommunicationChannelsAdmin() {
  const queryClient = useQueryClient();
  const channelsQuery = useQuery({ queryKey: ["admin-communication-channels"], queryFn: () => api<any>("/api/admin/communication-channels") });
  const channels = channelsQuery.data?.data ?? [];
  const sync = useMutation({ mutationFn: () => postJson("/api/admin/communication-channels/sync", {}), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["admin-communication-channels"] }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggle = useMutation({ mutationFn: (channel: any) => patchJson(`/api/admin/communication-channels/${channel.id}`, { active: !channel.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-communication-channels"] }) });
  const archive = useMutation({ mutationFn: (channel: any) => patchJson(`/api/admin/communication-channels/${channel.id}/archive`, {}), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-communication-channels"] }) });
  const groups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const channel of channels) map.set(channel.type, [...(map.get(channel.type) ?? []), channel]);
    return Array.from(map, ([type, items]) => ({ type, items }));
  }, [channels]);
  return (
    <section className="panel">
      <div className="admin-panel-header">
        <div>
          <h2>Communication Channels</h2>
          <span>{channels.length} channels</span>
        </div>
        <button onClick={() => sync.mutate()} disabled={sync.isPending}>Sync Channels</button>
      </div>
      <div className="communication-channel-groups">
        {groups.map((group) => (
          <section key={group.type} className="communication-channel-group">
            <h3>{group.type.replace("_", " ").toLowerCase()}</h3>
            <div className="admin-list">
              {group.items.map((channel: any) => (
                <div key={channel.id} className="admin-row">
                  <strong>{channel.name}</strong>
                  <span>{channel.active ? "active" : "disabled"} | {channel.membership?.unreadCount ?? 0} unread | {channel.memberCount ?? 0} members</span>
                  <div className="admin-actions">
                    <button onClick={() => toggle.mutate(channel)}>{channel.active ? "Disable" : "Enable"}</button>
                    <button className="danger" onClick={() => window.confirm("Archive this channel?") && archive.mutate(channel)}>Archive</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        {channels.length === 0 && <div className="empty-state">No communication channels yet. Click Sync Channels.</div>}
      </div>
    </section>
  );
}

function ChannelAccessPanel({ user }: { user: any }) {
  const queryClient = useQueryClient();
  const membershipsQuery = useQuery({
    queryKey: ["admin-user-channel-memberships", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => api<any>(`/api/admin/users/${user.id}/channel-memberships`)
  });
  const [selected, setSelected] = useState<Record<string, { canWrite: boolean }>>({});
  const channels = membershipsQuery.data?.data?.channels ?? [];

  useEffect(() => {
    const next: Record<string, { canWrite: boolean }> = {};
    for (const channel of channels) {
      if (channel.membership?.canRead) next[channel.id] = { canWrite: channel.membership.canWrite };
    }
    setSelected(next);
  }, [membershipsQuery.data]);

  const save = useMutation({
    mutationFn: () => api(`/api/admin/users/${user.id}/channel-memberships`, { method: "PUT", body: JSON.stringify({
      memberships: Object.entries(selected).map(([channelId, value]) => ({ channelId, canRead: true, canWrite: value.canWrite }))
    }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-user-channel-memberships", user?.id] });
      queryClient.invalidateQueries({ queryKey: ["admin-communication-channels"] });
    }
  });

  if (!user) return <section className="panel"><div className="empty-state">Create a user first.</div></section>;

  const toggleRead = (channelId: string) => setSelected((current) => {
    const next = { ...current };
    if (next[channelId]) delete next[channelId];
    else next[channelId] = { canWrite: true };
    return next;
  });
  const toggleWrite = (channelId: string) => setSelected((current) => ({ ...current, [channelId]: { canWrite: !current[channelId]?.canWrite } }));

  return (
    <section className="panel">
      <div className="admin-panel-header">
        <div>
          <h2>Channel Access</h2>
          <span>{user.displayName}</span>
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending || !membershipsQuery.data}>Save</button>
      </div>
      <div className="channel-access-list">
        {channels.map((channel: any) => (
          <div key={channel.id} className="channel-access-row">
            <label className="inline-check">
              <input type="checkbox" checked={Boolean(selected[channel.id])} onChange={() => toggleRead(channel.id)} />
              <span>{channel.name}</span>
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={Boolean(selected[channel.id]?.canWrite)} disabled={!selected[channel.id]} onChange={() => toggleWrite(channel.id)} />
              <span>Can write</span>
            </label>
          </div>
        ))}
        {channels.length === 0 && <div className="empty-state small">Sync communication channels first.</div>}
      </div>
    </section>
  );
}

function PagersAdmin({ data }: any) {
  const queryClient = useQueryClient();
  const [pager, setPager] = useState({ name: "", departmentId: "" });
  const [pagerDepartmentFilterId, setPagerDepartmentFilterId] = useState("");
  const [rawToken, setRawToken] = useState("");
  const activeDepartments = (data?.departments ?? []).filter((department: any) => department.active);
  const visiblePagers = pagerDepartmentFilterId ? (data?.pagerDevices ?? []).filter((item: any) => item.departmentId === pagerDepartmentFilterId) : data?.pagerDevices ?? [];
  const createPager = useMutation({ mutationFn: () => postJson<any>("/api/admin/pager-devices", pager), onSuccess: (result: any) => { setRawToken(result.data.rawToken); setPager({ name: "", departmentId: "" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const rotatePager = useMutation({ mutationFn: (id: string) => patchJson<any>(`/api/admin/pager-devices/${id}`, { rotate: true }), onSuccess: (result: any) => { setRawToken(result.data.rawToken); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggle = useMutation({ mutationFn: (item: any) => patchJson(`/api/admin/pager-devices/${item.id}`, { active: !item.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const remove = useMutation({ mutationFn: (item: any) => deleteJson(`/api/admin/pager-devices/${item.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  return <section className="panel"><div className="admin-panel-header"><h2>M5 pager devices</h2><span>{visiblePagers.length} shown</span></div><div className="inline-form stack"><TextInput value={pager.name} onChange={(name: string) => setPager({ ...pager, name })} placeholder="Quality M5 Pager" /><select value={pager.departmentId} onChange={(event) => setPager({ ...pager, departmentId: event.target.value })}><option value="">Department for this pager</option>{activeDepartments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select><button onClick={() => createPager.mutate()} disabled={!pager.name.trim() || !pager.departmentId || createPager.isPending}>Create pager token</button></div>{rawToken && <div className="token-box"><strong>Raw token shown once</strong><code>{rawToken}</code><span>Put this value in CONFIG_PAGER_TOKEN on the device.</span></div>}<div className="inline-form"><select value={pagerDepartmentFilterId} onChange={(event) => setPagerDepartmentFilterId(event.target.value)}><option value="">Show all departments</option>{(data?.departments ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div><AdminList items={visiblePagers} render={(item: any) => <><strong>{item.name}</strong><span>{item.department?.name} | {item.tokenFingerprint} | {item.active && item.department?.active ? "active" : "inactive"}</span><div className="admin-actions"><button onClick={() => rotatePager.mutate(item.id)}>Rotate</button><AdminActions active={item.active} onToggle={() => toggle.mutate(item)} onDelete={() => remove.mutate(item)} /></div></>} /></section>;
}

function AdminList({ items, render }: { items: any[]; render: (item: any) => ReactNode }) {
  if (!items?.length) return <div className="empty-state small">No items yet.</div>;
  return <div className="admin-list">{items.map((item) => <div key={item.id} className="admin-row">{render(item)}</div>)}</div>;
}
