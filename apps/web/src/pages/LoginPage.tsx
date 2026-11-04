import { useState } from "react";
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { BoltIcon, LayersIcon, GridIcon, ShieldIcon, ShieldCheckIcon, UsersIcon, WrenchIcon, BellRingIcon, CheckCircleIcon, SunIcon, MoonIcon } from "../components/icons";
import fiveStarLogo from "../assets/logos/five-star-logo.svg";

const THEME_STORAGE_KEY = "pg-login-theme";

function readStoredTheme(): "light" | "dark" {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const DEPARTMENT_ICONS: Record<string, (props: { className?: string }) => ReactElement> = {
  quality: ShieldCheckIcon,
  supervisor: UsersIcon,
  maintenance: WrenchIcon
};

const WORKFLOW_STEPS = [
  {
    icon: BoltIcon,
    title: "Call for help",
    body: "An operator presses a button on the machine. A timer starts instantly."
  },
  {
    icon: LayersIcon,
    title: "Routed to the right team",
    body: "Maintenance, QC, or any department is notified right away."
  },
  {
    icon: BellRingIcon,
    title: "Acknowledged on phone or pager",
    body: "Responders accept from their phone, the M5 pager, or Teams."
  },
  {
    icon: CheckCircleIcon,
    title: "Closed out on the machine",
    body: "Every status change is logged and visible to everyone in real time."
  }
];

export function LoginPage() {
  const { login, demoLogin } = useAuth();
  const quickLogin = useQuery({ queryKey: ["quick-login"], queryFn: () => api<any>("/api/auth/quick-login") });
  const enabledProfiles = new Set((quickLogin.data?.data?.enabledProfiles ?? []) as string[]);
  const departmentProfiles = ["quality", "supervisor", "maintenance"].filter((profile) => enabledProfiles.has(profile));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [companies, setCompanies] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDepartments, setShowDepartments] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(readStoredTheme);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore - theme just won't persist across visits
    }
  }

  async function submit(companyId?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await login(username, password, companyId);
      if (result?.needsCompany) setCompanies(result.companies ?? []);
    } catch (err: any) {
      setError(err.message ?? "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function demo(profile: string) {
    if (!enabledProfiles.has(profile)) return;
    setBusy(true);
    setError("");
    if (["quality", "supervisor", "maintenance"].includes(profile)) setSelectedDepartment(profile);
    try {
      await demoLogin(profile);
    } catch (err: any) {
      setError(err.message ?? "Demo sign-in failed. Run npm run db:seed.");
      setSelectedDepartment("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page" data-theme={theme}>
      <div className="login-shell">
        <section className="login-brand-panel">
          <div className="login-brand-header">
            <div className="brand-mark large">PG</div>
            <div>
              <h1>ProcessGuard Andon</h1>
              <p>Fast manufacturing help calls, department queues, live floor visibility, and M5 pager support.</p>
            </div>
          </div>
          <ol className="login-workflow">
            {WORKFLOW_STEPS.map((step) => (
              <li key={step.title}>
                <span className="login-workflow-icon"><step.icon /></span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="login-brand-footer">
            <img src={fiveStarLogo} alt="Five Star Family of Companies" />
            <span>Part of the Five Star family of companies</span>
          </div>
        </section>
        <section className="login-form-panel">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? <MoonIcon /> : <SunIcon />}
          </button>
          <div className="login-card">
            <div className="demo-panel">
              <div className="demo-panel-header">
                <strong>Quick Login</strong>
                <span>Choose a view</span>
              </div>
              <div className="demo-grid">
                <button className="demo-button operator" onClick={() => demo("operator")} disabled={busy || !enabledProfiles.has("operator")}>
                  <span className="demo-button-icon"><BoltIcon /></span>
                  <strong>Operator</strong>
                  <span>{enabledProfiles.has("operator") ? "Call help" : "Disabled"}</span>
                </button>
                <button className={`demo-button department ${showDepartments ? "active" : ""}`} onClick={() => setShowDepartments((current) => !current)} disabled={busy || departmentProfiles.length === 0}>
                  <span className="demo-button-icon"><LayersIcon /></span>
                  <strong>Department</strong>
                  <span>{departmentProfiles.length ? "Queue view" : "Disabled"}</span>
                </button>
                <button className="demo-button manager" onClick={() => demo("manager")} disabled={busy || !enabledProfiles.has("manager")}>
                  <span className="demo-button-icon"><GridIcon /></span>
                  <strong>Manager</strong>
                  <span>{enabledProfiles.has("manager") ? "Live floor" : "Disabled"}</span>
                </button>
                <button className="demo-button admin" disabled>
                  <span className="demo-button-icon"><ShieldIcon /></span>
                  <strong>Admin</strong>
                  <span>Sign in below</span>
                </button>
              </div>
              {showDepartments && (
                <div className="department-picker">
                  {departmentProfiles.map((profile) => {
                    const Icon = DEPARTMENT_ICONS[profile] ?? ShieldIcon;
                    return (
                      <button key={profile} className={selectedDepartment === profile ? "selected" : ""} onClick={() => demo(profile)} disabled={busy}>
                        <span className="department-picker-icon"><Icon /></span>
                        {profile}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="divider">or sign in</div>
            <div className="login-form-grid">
              <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} /></label>
              <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            </div>
            <button className="primary wide" onClick={() => submit()} disabled={busy}>Sign in</button>
            {companies.length > 0 && (
              <div className="company-picker">
                <strong>Choose workspace</strong>
                {companies.map((company) => <button key={company.companyId} onClick={() => submit(company.companyId)}>{company.companyName} - {company.role}</button>)}
              </div>
            )}
            {error && <div className="error-box">{error}</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
