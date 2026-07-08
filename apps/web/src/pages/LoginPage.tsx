import { useState } from "react";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { login, demoLogin } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [companies, setCompanies] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDepartments, setShowDepartments] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState("");

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
    <div className="login-page">
      <div className="login-backdrop" aria-hidden="true">
        <div className="login-backdrop-grid" />
      </div>
      <section className="login-card">
        <div className="login-card-header">
          <div className="brand-mark large">PG</div>
          <div>
            <h1>ProcessGuard Andon</h1>
            <p>Fast manufacturing help calls, department queues, live floor visibility, and M5 pager support.</p>
          </div>
        </div>

        <div className="demo-panel">
          <div className="demo-panel-header">
            <strong>Demo workspace</strong>
            <span>Choose the view you want to test</span>
          </div>
          <div className="demo-grid">
            <button className="demo-button operator" onClick={() => demo("operator")} disabled={busy}>
              <strong>Operator</strong>
              <span>Call help</span>
            </button>
            <button className={`demo-button department ${showDepartments ? "active" : ""}`} onClick={() => setShowDepartments((current) => !current)} disabled={busy}>
              <strong>Department</strong>
              <span>Queue view</span>
            </button>
            <button className="demo-button manager" onClick={() => demo("manager")} disabled={busy}>
              <strong>Manager</strong>
              <span>Live floor</span>
            </button>
            <button className="demo-button admin" onClick={() => demo("admin")} disabled={busy}>
              <strong>Admin</strong>
              <span>Setup</span>
            </button>
          </div>
          {showDepartments && (
            <div className="department-picker">
              {["quality", "supervisor"].map((profile) => (
                <button key={profile} className={selectedDepartment === profile ? "selected" : ""} onClick={() => demo(profile)} disabled={busy}>{profile}</button>
              ))}
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
      </section>
    </div>
  );
}
