import { notifyAppError } from "./errorToast";

export type ApiResult<T> = { success: true; data?: T; session?: any; token?: string; needsCompany?: boolean; companies?: any[] } | { success: false; error: string };

export function getToken() {
  return localStorage.getItem("pg_token");
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem("pg_token", token);
  else localStorage.removeItem("pg_token");
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    notifyAppError("Network request failed.");
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.error || `Request failed: ${response.status}`;
    if (path.startsWith("/api/admin/") || ![400, 401, 403].includes(response.status)) {
      notifyAppError(message);
    }
    throw new Error(message);
  }
  return payload;
}

export function postJson<T = any>(path: string, body: unknown) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function patchJson<T = any>(path: string, body: unknown) {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function putJson<T = any>(path: string, body: unknown) {
  return api<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export function deleteJson<T = any>(path: string) {
  return api<T>(path, { method: "DELETE" });
}
