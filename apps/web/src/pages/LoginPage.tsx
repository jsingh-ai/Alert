import { useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent, ReactElement, SVGProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  BoltIcon,
  LayersIcon,
  GridIcon,
  ShieldIcon,
  ShieldCheckIcon,
  UsersIcon,
  WrenchIcon,
  BellRingIcon,
  CheckCircleIcon,
  UserIcon,
  LockIcon,
  EyeIcon,
  EyeOffIcon,
  ChevronRightIcon
} from "../components/icons";
import polytexLogo from "../assets/logos/polytex.svg";
import starpakLogo from "../assets/logos/starpak.svg";
import freshpakLogo from "../assets/logos/freshpak.svg";
import anduroLogo from "../assets/logos/anduro.svg";
import superbagLogo from "../assets/logos/superbag.svg";
import fiveStarCanadaLogo from "../assets/logos/five-star-canada.svg";
import fiveStarLogo from "../assets/logos/five-star-logo.svg";
import "../styles/login.css";

type Icon = (props: SVGProps<SVGSVGElement>) => ReactElement;

type WorkspaceOption = { companyId: string; companyName: string; role?: string };

const SIBLING_LOGOS = [
  { name: "Polytex", src: polytexLogo },
  { name: "Starpak", src: starpakLogo },
  { name: "Freshpak", src: freshpakLogo },
  { name: "Anduro", src: anduroLogo },
  { name: "Superbag", src: superbagLogo },
  { name: "Five Star Canada", src: fiveStarCanadaLogo }
];

const WORKFLOW_STEPS: { icon: Icon; title: string; body: string }[] = [
  { icon: BoltIcon, title: "Call for help", body: "Operators raise an alert from the machine in one tap." },
  { icon: LayersIcon, title: "Routed to the right team", body: "Quality, maintenance or supervisors are notified instantly." },
  { icon: BellRingIcon, title: "Acknowledged anywhere", body: "Responders accept from their phone or pager." },
  { icon: CheckCircleIcon, title: "Closed out on the machine", body: "Every alert is logged and visible in real time." }
];

const DEPARTMENT_PROFILES = ["quality", "supervisor", "maintenance"] as const;

const DEPARTMENT_ICONS: Record<string, Icon> = {
  quality: ShieldCheckIcon,
  supervisor: UsersIcon,
  maintenance: WrenchIcon
};

const QUICK_PROFILES: { key: "operator" | "department" | "manager"; label: string; hint: string; icon: Icon }[] = [
  { key: "operator", label: "Operator", hint: "Call for help", icon: BoltIcon },
  { key: "department", label: "Department", hint: "Response queue", icon: LayersIcon },
  { key: "manager", label: "Manager", hint: "Live floor", icon: GridIcon }
];

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function LoginPage() {
  const { login, demoLogin } = useAuth();
  const quickLogin = useQuery({ queryKey: ["quick-login"], queryFn: () => api<{ data?: { enabledProfiles?: string[] } }>("/api/auth/quick-login") });
  const enabledProfiles = new Set(quickLogin.data?.data?.enabledProfiles ?? []);
  const departmentProfiles = DEPARTMENT_PROFILES.filter((profile) => enabledProfiles.has(profile));
  const quickProfiles = QUICK_PROFILES.filter((profile) => (profile.key === "department" ? departmentProfiles.length > 0 : enabledProfiles.has(profile.key)));

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [companies, setCompanies] = useState<WorkspaceOption[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDepartments, setShowDepartments] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedCompany, setSelectedCompany] = useState("");

  async function submit(companyId?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await login(username, password, companyId);
      if (result?.needsCompany) setCompanies(result.companies ?? []);
    } catch (err) {
      setError(errorMessage(err, "Sign-in failed. Check your username and password."));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError("Enter your username and password.");
      return;
    }
    void submit();
  }

  function trackCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState("CapsLock"));
  }

  async function demo(profile: string) {
    if (!enabledProfiles.has(profile)) return;
    setBusy(true);
    setError("");
    if ((DEPARTMENT_PROFILES as readonly string[]).includes(profile)) setSelectedDepartment(profile);
    try {
      await demoLogin(profile);
    } catch (err) {
      setError(errorMessage(err, "Quick sign-in failed. Run npm run db:seed."));
      setSelectedDepartment("");
    } finally {
      setBusy(false);
    }
  }

  function onQuickProfile(key: string) {
    if (key === "department") setShowDepartments((current) => !current);
    else void demo(key);
  }

  const choosingWorkspace = companies.length > 0;

  return (
    <div className="login-page">
      <div className="login-shell">
        <section className="login-brand-panel" aria-label="About ProcessGuard">
          <div className="login-orbit" aria-hidden="true" />

          <div className="login-lockup">
            <div className="login-mark" aria-hidden="true">PG</div>
            <div className="login-lockup-text">
              <strong>ProcessGuard</strong>
              <span>Workflow</span>
            </div>
          </div>

          <div className="login-hero">
            <p className="login-eyebrow">Live floor visibility</p>
            <h1>From call for help to close{"‑"}out, in real time.</h1>
            <p className="login-hero-sub">One workflow for operators, responders and managers across every line.</p>
          </div>

          <ol className="login-workflow">
            {WORKFLOW_STEPS.map((step) => (
              <li key={step.title}>
                <span className="login-workflow-icon" aria-hidden="true"><step.icon /></span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          {/* Company picker. Selection is UI-only for now; wire selectedCompany into sign-in later. */}
          <div className="login-family">
            <span className="login-family-label">
              <span className="login-family-label-wide">Part of the Five Star family of companies</span>
              <span className="login-family-label-phone">Select your company</span>
            </span>
            <ul className={`login-family-logos ${selectedCompany ? "has-selection" : ""}`} aria-label="Five Star companies">
              {SIBLING_LOGOS.map((logo) => (
                <li key={logo.name}>
                  <button
                    type="button"
                    className={`login-family-tile ${selectedCompany === logo.name ? "selected" : ""}`}
                    onClick={() => setSelectedCompany((current) => (current === logo.name ? "" : logo.name))}
                    aria-pressed={selectedCompany === logo.name}
                    title={logo.name}
                  >
                    <img src={logo.src} alt={logo.name} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="login-form-panel">
          <div className="login-card">
            <header className="login-card-header">
              <img className="login-card-logo" src={fiveStarLogo} alt="Five Star Family of Companies" />
              <h2>{choosingWorkspace ? "Choose a workspace" : "Sign in"}</h2>
              <p>{choosingWorkspace ? "Your account has access to more than one company." : "Welcome back. Sign in to continue to ProcessGuard."}</p>
            </header>

            {error && <div className="login-error" role="alert">{error}</div>}

            {choosingWorkspace ? (
              <div className="login-workspaces">
                {companies.map((company) => (
                  <button type="button" key={company.companyId} className="login-workspace" onClick={() => submit(company.companyId)} disabled={busy}>
                    <span className="login-workspace-name">{company.companyName}</span>
                    {company.role && <span className="login-workspace-role">{company.role}</span>}
                    <ChevronRightIcon className="login-workspace-chevron" />
                  </button>
                ))}
                <button type="button" className="login-text-button" onClick={() => setCompanies([])} disabled={busy}>
                  Back to sign in
                </button>
              </div>
            ) : (
              <form className="login-form" onSubmit={onSubmit} noValidate>
                <div className="login-field">
                  <label htmlFor="login-username">Username</label>
                  <div className="login-input">
                    <UserIcon className="login-input-icon" />
                    <input
                      id="login-username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="Enter your username"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      disabled={busy}
                    />
                  </div>
                </div>

                <div className="login-field">
                  <label htmlFor="login-password">Password</label>
                  <div className="login-input">
                    <LockIcon className="login-input-icon" />
                    <input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      onKeyUp={trackCapsLock}
                      onKeyDown={trackCapsLock}
                      onBlur={() => setCapsLock(false)}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="login-reveal"
                      onClick={() => setShowPassword((current) => !current)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                  <p className="login-hint" aria-live="polite">{capsLock ? "Caps Lock is on" : ""}</p>
                </div>

                <button type="submit" className="login-submit" disabled={busy} aria-busy={busy}>
                  {busy && <span className="login-spinner" aria-hidden="true" />}
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
            )}

            {!choosingWorkspace && quickProfiles.length > 0 && (
              <div className="login-quick">
                <div className="login-quick-divider"><span>Quick access</span></div>
                <div className="login-quick-grid" style={{ "--lp-quick-cols": quickProfiles.length } as CSSProperties}>
                  {quickProfiles.map((profile) => (
                    <button
                      type="button"
                      key={profile.key}
                      className={`login-quick-button ${profile.key === "department" && showDepartments ? "active" : ""}`}
                      onClick={() => onQuickProfile(profile.key)}
                      disabled={busy}
                      aria-expanded={profile.key === "department" ? showDepartments : undefined}
                    >
                      <span className="login-quick-icon" aria-hidden="true"><profile.icon /></span>
                      <strong>{profile.label}</strong>
                      <span className="login-quick-hint">{profile.hint}</span>
                    </button>
                  ))}
                </div>
                {showDepartments && departmentProfiles.length > 0 && (
                  <div className="login-departments" role="group" aria-label="Choose a department">
                    {departmentProfiles.map((profile) => {
                      const DeptIcon = DEPARTMENT_ICONS[profile] ?? ShieldIcon;
                      return (
                        <button
                          type="button"
                          key={profile}
                          className={selectedDepartment === profile ? "selected" : ""}
                          onClick={() => demo(profile)}
                          disabled={busy}
                        >
                          <DeptIcon aria-hidden="true" />
                          {profile}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <footer className="login-card-footer">Need access? Contact your plant administrator.</footer>
          </div>
          <p className="login-legal">© {new Date().getFullYear()} Five Star Family of Companies</p>
        </section>
      </div>
    </div>
  );
}
