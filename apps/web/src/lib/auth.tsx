import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, getToken, postJson, setToken } from "./api";
import type { Session } from "./types";

type AuthContextValue = {
  token: string | null;
  session: Session | null;
  loading: boolean;
  login: (username: string, password: string, companyId?: string) => Promise<any>;
  demoLogin: (profile: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(token));

  const applyToken = (newToken: string | null) => {
    setToken(newToken);
    setTokenState(newToken);
  };

  async function refresh() {
    if (!getToken()) {
      setSession(null);
      setLoading(false);
      return;
    }
    try {
      const result = await api<{ success: true; session: Session }>("/api/session");
      setSession(result.session);
    } catch {
      applyToken(null);
      setSession(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function login(username: string, password: string, companyId?: string) {
    const result = await postJson<any>("/api/auth/login", { username, password, companyId });
    if (result.needsCompany) return result;
    applyToken(result.token);
    setSession(result.session);
    return result;
  }

  async function demoLogin(profile: string) {
    const result = await postJson<any>("/api/auth/demo", { profile });
    applyToken(result.token);
    setSession(result.session);
  }

  function logout() {
    applyToken(null);
    setSession(null);
  }

  const value = useMemo(() => ({ token, session, loading, login, demoLogin, logout, refresh }), [token, session, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
