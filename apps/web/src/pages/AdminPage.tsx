import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postJson, patchJson, deleteJson } from "../lib/api";

const priorities = ["LOW", "NORMAL", "HIGH", "CRITICAL"];
const roles = ["ADMIN", "MANAGER", "OPERATOR", "RESPONDER", "VIEWER"];

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
        {["machines", "departments", "commands", "users", "communication", "pagers"].map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}
      </div>
      {tab === "machines" && <MachinesAdmin data={data} />}
      {tab === "departments" && <DepartmentsAdmin data={data} />}
      {tab === "commands" && <CommandsAdmin data={data} />}
      {tab === "users" && <UsersAdmin data={data} />}
      {tab === "communication" && <CommunicationChannelsAdmin />}
      {tab === "pagers" && <PagersAdmin data={data} />}
    </div>
  );
}

function MachinesAdmin({ data }: any) {
  const queryClient = useQueryClient();
  const [groupName, setGroupName] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [machine, setMachine] = useState({ name: "", code: "", machineGroupId: "" });
  const machineGroups = data?.machineGroups ?? [];
  const activeMachineGroups = machineGroups.filter((group: any) => group.active);
  const machines = data?.machines ?? [];
  const selectedGroup = machineGroups.find((group: any) => group.id === selectedGroupId);
  const visibleMachines = selectedGroupId ? machines.filter((item: any) => item.machineGroupId === selectedGroupId) : machines;
  const selectGroup = (groupId: string) => {
    const group = machineGroups.find((item: any) => item.id === groupId);
    setSelectedGroupId(groupId);
    setMachine((current) => ({ ...current, machineGroupId: group?.active ? groupId : "" }));
  };
  const createGroup = useMutation({ mutationFn: () => postJson("/api/admin/machine-groups", { name: groupName }), onSuccess: () => { setGroupName(""); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const createMachine = useMutation({ mutationFn: () => postJson("/api/admin/machines", machine), onSuccess: () => { setMachine({ name: "", code: "", machineGroupId: selectedGroupId }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggleGroup = useMutation({ mutationFn: (group: any) => patchJson(`/api/admin/machine-groups/${group.id}`, { active: !group.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const deleteGroup = useMutation({ mutationFn: (group: any) => deleteJson(`/api/admin/machine-groups/${group.id}`), onSuccess: (_result, group: any) => { if (selectedGroupId === group.id) selectGroup(""); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggleMachine = useMutation({ mutationFn: (m: any) => patchJson(`/api/admin/machines/${m.id}`, { active: !m.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const deleteMachine = useMutation({ mutationFn: (m: any) => deleteJson(`/api/admin/machines/${m.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  return (
    <div className="admin-grid">
      <section className="panel">
        <div className="admin-panel-header">
          <h2>Machine groups</h2>
          <button className={`admin-filter-pill ${selectedGroupId === "" ? "active" : ""}`} onClick={() => selectGroup("")}>All</button>
        </div>
        <div className="inline-form">
          <TextInput value={groupName} onChange={setGroupName} placeholder="Press" />
          <button onClick={() => createGroup.mutate()} disabled={!groupName.trim() || createGroup.isPending}>Add group</button>
        </div>
        <div className="admin-list">
          {machineGroups.length === 0 && <div className="empty-state small">No items yet.</div>}
          {machineGroups.map((item: any) => (
            <div key={item.id} className={`admin-row admin-group-row ${selectedGroupId === item.id ? "selected" : ""}`} onClick={() => selectGroup(item.id)}>
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
          <select value={machine.machineGroupId} onChange={(event) => selectGroup(event.target.value)}>
            <option value="">Machine group</option>
            {activeMachineGroups.map((group: any) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <button onClick={() => createMachine.mutate()} disabled={!machine.name.trim() || !machine.code.trim() || !machine.machineGroupId || createMachine.isPending}>Add machine</button>
        </div>
        <AdminList items={visibleMachines} render={(item: any) => <><strong>{item.name}</strong><span>{item.code} | {item.machineGroup?.name}</span><AdminActions active={item.active} onToggle={() => toggleMachine.mutate(item)} onDelete={() => deleteMachine.mutate(item)} /></>} />
      </section>
    </div>
  );
}

function DepartmentsAdmin({ data }: any) {
  const queryClient = useQueryClient();
  const [department, setDepartment] = useState({ name: "" });
  const [selectedDepartmentId, setSelectedDepartmentId] = useState("");
  const [issue, setIssue] = useState({ name: "", departmentId: "", defaultPriority: "NORMAL" });
  const departments = data?.departments ?? [];
  const activeDepartments = departments.filter((item: any) => item.active);
  const selectedDepartment = departments.find((item: any) => item.id === selectedDepartmentId);
  const visibleIssues = selectedDepartmentId ? (data?.issueTypes ?? []).filter((item: any) => item.departmentId === selectedDepartmentId) : data?.issueTypes ?? [];
  const selectDepartment = (departmentId: string) => {
    const selected = departments.find((item: any) => item.id === departmentId);
    setSelectedDepartmentId(departmentId);
    setIssue((current) => ({ ...current, departmentId: selected?.active ? departmentId : "" }));
  };
  const createDepartment = useMutation({ mutationFn: () => postJson("/api/admin/departments", department), onSuccess: () => { setDepartment({ name: "" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggle = useMutation({ mutationFn: (d: any) => patchJson(`/api/admin/departments/${d.id}`, { active: !d.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const remove = useMutation({ mutationFn: (d: any) => deleteJson(`/api/admin/departments/${d.id}`), onSuccess: (_result, item: any) => { if (selectedDepartmentId === item.id) selectDepartment(""); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const createIssue = useMutation({ mutationFn: () => postJson("/api/admin/issue-types", issue), onSuccess: () => { setIssue({ name: "", departmentId: selectedDepartmentId, defaultPriority: "NORMAL" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggleIssue = useMutation({ mutationFn: (item: any) => patchJson(`/api/admin/issue-types/${item.id}`, { active: !item.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const removeIssue = useMutation({ mutationFn: (item: any) => deleteJson(`/api/admin/issue-types/${item.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  return (
    <div className="admin-grid">
      <section className="panel">
        <div className="admin-panel-header">
          <h2>Departments</h2>
          <button className={`admin-filter-pill ${selectedDepartmentId === "" ? "active" : ""}`} onClick={() => selectDepartment("")}>All</button>
        </div>
        <div className="inline-form">
          <TextInput value={department.name} onChange={(name: string) => setDepartment({ name })} placeholder="Quality" />
          <button onClick={() => createDepartment.mutate()} disabled={!department.name.trim() || createDepartment.isPending}>Add department</button>
        </div>
        <div className="admin-list">
          {departments.length === 0 && <div className="empty-state small">No items yet.</div>}
          {departments.map((item: any) => (
            <div key={item.id} className={`admin-row admin-group-row ${selectedDepartmentId === item.id ? "selected" : ""}`} onClick={() => selectDepartment(item.id)}>
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
          <select value={issue.departmentId} onChange={(event) => selectDepartment(event.target.value)}>
            <option value="">Department</option>
            {activeDepartments.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <select value={issue.defaultPriority} onChange={(event) => setIssue({ ...issue, defaultPriority: event.target.value })}>{priorities.map((p) => <option key={p}>{p}</option>)}</select>
          <button onClick={() => createIssue.mutate()} disabled={!issue.name.trim() || !issue.departmentId || createIssue.isPending}>Add issue</button>
        </div>
        <AdminList items={visibleIssues} render={(item: any) => <><strong>{item.name}</strong><span>{item.department?.name} | {item.defaultPriority} | {item.active ? "active" : "inactive"}</span><AdminActions active={item.active} onToggle={() => toggleIssue.mutate(item)} onDelete={() => removeIssue.mutate(item)} /></>} />
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
  const createUser = useMutation({ mutationFn: () => postJson("/api/admin/users", user), onSuccess: () => { setUser({ username: "", password: "", displayName: "", role: "OPERATOR" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggle = useMutation({ mutationFn: (item: any) => patchJson(`/api/admin/users/${item.id}`, { active: !item.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const remove = useMutation({ mutationFn: (item: any) => deleteJson(`/api/admin/users/${item.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const users = data?.users ?? [];
  const selectedUser = users.find((item: any) => item.id === selectedUserId) ?? users[0];
  return (
    <div className="admin-grid">
      <section className="panel">
        <h2>Users</h2>
        <div className="inline-form stack">
          <TextInput value={user.username} onChange={(username: string) => setUser({ ...user, username })} placeholder="jsmith" />
          <TextInput value={user.displayName} onChange={(displayName: string) => setUser({ ...user, displayName })} placeholder="John Smith" />
          <TextInput type="password" value={user.password} onChange={(password: string) => setUser({ ...user, password })} placeholder="Password" />
          <select value={user.role} onChange={(event) => setUser({ ...user, role: event.target.value })}>{roles.map((role) => <option key={role}>{role}</option>)}</select>
          <button onClick={() => createUser.mutate()} disabled={!user.username.trim() || !user.displayName.trim() || !user.password || createUser.isPending}>Create user</button>
        </div>
        <div className="admin-list">
          {users.map((item: any) => (
            <div key={item.id} className={`admin-row admin-group-row ${selectedUser?.id === item.id ? "selected" : ""}`} onClick={() => setSelectedUserId(item.id)}>
              <strong>{item.username}</strong>
              <span>{item.displayName} | {item.memberships?.[0]?.role ?? "no role"} | {item.active ? "active" : "inactive"}</span>
              <AdminActions active={item.active} onToggle={() => toggle.mutate(item)} onDelete={() => remove.mutate(item)} />
            </div>
          ))}
          {users.length === 0 && <div className="empty-state small">No items yet.</div>}
        </div>
      </section>
      <ChannelAccessPanel user={selectedUser} />
    </div>
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
  const [rawToken, setRawToken] = useState("");
  const activeDepartments = (data?.departments ?? []).filter((department: any) => department.active);
  const visiblePagers = pager.departmentId ? (data?.pagerDevices ?? []).filter((item: any) => item.departmentId === pager.departmentId) : data?.pagerDevices ?? [];
  const createPager = useMutation({ mutationFn: () => postJson<any>("/api/admin/pager-devices", pager), onSuccess: (result: any) => { setRawToken(result.data.rawToken); setPager({ name: "", departmentId: "" }); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const rotatePager = useMutation({ mutationFn: (id: string) => patchJson<any>(`/api/admin/pager-devices/${id}`, { rotate: true }), onSuccess: (result: any) => { setRawToken(result.data.rawToken); queryClient.invalidateQueries({ queryKey: ["admin"] }); } });
  const toggle = useMutation({ mutationFn: (item: any) => patchJson(`/api/admin/pager-devices/${item.id}`, { active: !item.active }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  const remove = useMutation({ mutationFn: (item: any) => deleteJson(`/api/admin/pager-devices/${item.id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }) });
  return <section className="panel"><div className="admin-panel-header"><h2>M5 pager devices</h2><span>{visiblePagers.length} shown</span></div><div className="inline-form stack"><TextInput value={pager.name} onChange={(name: string) => setPager({ ...pager, name })} placeholder="Quality M5 Pager" /><select value={pager.departmentId} onChange={(event) => setPager({ ...pager, departmentId: event.target.value })}><option value="">All active departments</option>{activeDepartments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select><button onClick={() => createPager.mutate()} disabled={!pager.name.trim() || !pager.departmentId || createPager.isPending}>Create pager token</button></div>{rawToken && <div className="token-box"><strong>Raw token shown once</strong><code>{rawToken}</code><span>Put this value in CONFIG_PAGER_TOKEN on the device.</span></div>}<AdminList items={visiblePagers} render={(item: any) => <><strong>{item.name}</strong><span>{item.department?.name} | {item.tokenFingerprint} | {item.active ? "active" : "inactive"}</span><div className="admin-actions"><button onClick={() => rotatePager.mutate(item.id)}>Rotate</button><AdminActions active={item.active} onToggle={() => toggle.mutate(item)} onDelete={() => remove.mutate(item)} /></div></>} /></section>;
}

function AdminList({ items, render }: { items: any[]; render: (item: any) => ReactNode }) {
  if (!items?.length) return <div className="empty-state small">No items yet.</div>;
  return <div className="admin-list">{items.map((item) => <div key={item.id} className="admin-row">{render(item)}</div>)}</div>;
}
