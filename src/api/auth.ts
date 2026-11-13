import { acceptSessionPayload, ApiRequestError, request } from "./core";

export type AuthMethod = "local" | "network" | "password" | "token";

export interface AuthInfo {
  method: AuthMethod;
  password_configured: boolean;
  password_min_length: number;
  can_set_password_without_current: boolean;
  trusted_networks: string[];
  allowed_hosts: string[];
}

export type AuthCheck =
  | { status: "signed_in"; auth: AuthInfo }
  | { status: "login_required"; passwordConfigured: boolean };

type SessionPayload = { ok: true; csrf_token: string; auth: AuthInfo };

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Checks (and if allowed, establishes) this browser's session without retry or login side effects. */
export async function checkAuthSession(): Promise<AuthCheck> {
  const response = await fetch("/api/auth/session", { credentials: "same-origin" });
  const body = await readJson(response);
  if (response.ok && body) {
    acceptSessionPayload(body as { csrf_token?: unknown });
    return { status: "signed_in", auth: (body as unknown as SessionPayload).auth };
  }
  if (response.status === 401) {
    return { status: "login_required", passwordConfigured: body?.password_configured === true };
  }
  throw new ApiRequestError(`Session check failed: ${response.status}`, {
    status: response.status,
    code: typeof body?.error === "string" ? body.error : null,
    details: body,
    url: "/api/auth/session",
  });
}

export type LoginResult =
  | { ok: true; auth: AuthInfo }
  | {
      ok: false;
      error: "invalid_credentials" | "too_many_attempts" | "password_not_set" | "network";
      retryAfterSeconds?: number;
    };

export async function loginWithPassword(password: string): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const body = await readJson(response);
  if (response.ok && body) {
    acceptSessionPayload(body as { csrf_token?: unknown });
    return { ok: true, auth: (body as unknown as SessionPayload).auth };
  }
  if (response.status === 429) {
    const retry = Number(body?.retry_after_seconds);
    return { ok: false, error: "too_many_attempts", retryAfterSeconds: Number.isFinite(retry) ? retry : undefined };
  }
  if (response.status === 409) return { ok: false, error: "password_not_set" };
  return { ok: false, error: response.status === 401 ? "invalid_credentials" : "network" };
}

export async function logout(): Promise<{ automaticSignIn: boolean }> {
  const body = await request<{ automatic_sign_in?: boolean }>("/api/auth/logout", { method: "POST" }, false);
  acceptSessionPayload(null);
  return { automaticSignIn: body.automatic_sign_in === true };
}

export async function changeLoginPassword(newPassword: string, currentPassword?: string): Promise<AuthInfo> {
  const body = await request<SessionPayload>("/api/auth/password", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      new_password: newPassword,
      ...(currentPassword ? { current_password: currentPassword } : {}),
    }),
  });
  acceptSessionPayload(body);
  return body.auth;
}

export async function signOutEverywhere(): Promise<AuthInfo> {
  const body = await request<SessionPayload>("/api/auth/sessions/revoke", { method: "POST" });
  acceptSessionPayload(body);
  return body.auth;
}

export async function getAuthInfo(): Promise<AuthInfo> {
  const body = await request<SessionPayload>("/api/auth/session");
  acceptSessionPayload(body);
  return body.auth;
}
