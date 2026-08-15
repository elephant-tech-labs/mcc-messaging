import { optionalEnv, requiredEnv } from "@/lib/env";
import { cliqAccountsUrl } from "@/lib/zoho-cliq/oauth";

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export class CliqApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Zoho Cliq API request failed (${status}): ${JSON.stringify(payload)}`);
    this.name = "CliqApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function refreshCliqAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: requiredEnv("ZOHO_CLIQ_CLIENT_ID"),
    client_secret: requiredEnv("ZOHO_CLIQ_CLIENT_SECRET"),
    refresh_token: requiredEnv("ZOHO_CLIQ_REFRESH_TOKEN"),
  });

  const response = await fetch(`${cliqAccountsUrl()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    expires_in_sec?: number;
    error?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(`Zoho Cliq token refresh failed: ${payload.error ?? response.status}`);
  }

  const expiresIn = payload.expires_in_sec ?? payload.expires_in ?? 3600;
  cachedToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return cachedToken.accessToken;
}

export async function cliqFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await refreshCliqAccessToken();
  const apiBase = optionalEnv("ZOHO_CLIQ_API_BASE", "https://cliq.zoho.com/api/v3")!.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const response = await fetch(`${apiBase}${normalizedPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (response.status === 204) {
    return {} as T;
  }

  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    throw new CliqApiError(response.status, payload);
  }

  return payload as T;
}
