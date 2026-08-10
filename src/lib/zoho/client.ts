import { optionalEnv, requiredEnv } from "@/lib/env";

let cachedToken: { accessToken: string; expiresAt: number; apiDomain: string } | null = null;

export class ZohoApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Zoho API request failed (${status}): ${JSON.stringify(payload)}`);
    this.name = "ZohoApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function refreshAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken;
  }

  const accountsUrl = optionalEnv("ZOHO_ACCOUNTS_URL", "https://accounts.zoho.com")!;
  const body = new URLSearchParams({
    refresh_token: requiredEnv("ZOHO_REFRESH_TOKEN"),
    client_id: requiredEnv("ZOHO_CLIENT_ID"),
    client_secret: requiredEnv("ZOHO_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });

  const response = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const payload = (await response.json()) as {
    access_token?: string;
    api_domain?: string;
    expires_in?: number;
    error?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(`Zoho token refresh failed: ${payload.error ?? response.status}`);
  }

  cachedToken = {
    accessToken: payload.access_token,
    apiDomain: payload.api_domain ?? optionalEnv("ZOHO_API_DOMAIN", "https://www.zohoapis.com")!,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };

  return cachedToken;
}

export async function zohoFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await refreshAccessToken();
  const response = await fetch(`${token.apiDomain}${path}`, {
    ...init,
    headers: {
      Authorization: `Zoho-oauthtoken ${token.accessToken}`,
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
    throw new ZohoApiError(response.status, payload);
  }

  return payload as T;
}
