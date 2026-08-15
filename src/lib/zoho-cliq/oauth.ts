import { optionalEnv, requiredEnv } from "@/lib/env";

export const CLIQ_OAUTH_STATE_COOKIE = "mcc_cliq_oauth_state";

export const CLIQ_OAUTH_SCOPES = [
  "ZohoCliq.Bots.CREATE",
  "ZohoCliq.Bots.READ",
  "ZohoCliq.Bots.UPDATE",
  "ZohoCliq.BotMessages.CREATE",
  "ZohoCliq.Webhooks.CREATE",
  "ZohoCliq.Functions.CREATE",
  "ZohoCliq.Functions.READ",
  "ZohoCliq.Functions.UPDATE",
  "ZohoCliq.Users.READ",
] as const;

export function cliqAccountsUrl(): string {
  return optionalEnv("ZOHO_CLIQ_ACCOUNTS_URL", "https://accounts.zoho.com")!.replace(/\/$/, "");
}

export function cliqRedirectUri(): string {
  return `${requiredEnv("APP_BASE_URL").replace(/\/$/, "")}/api/integrations/zoho-cliq/oauth/callback`;
}

export function buildCliqAuthorizationUrl(state: string): string {
  const url = new URL(`${cliqAccountsUrl()}/oauth/v2/auth`);
  url.searchParams.set("scope", CLIQ_OAUTH_SCOPES.join(","));
  url.searchParams.set("client_id", requiredEnv("ZOHO_CLIQ_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("redirect_uri", cliqRedirectUri());
  return url.toString();
}

export type CliqOAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_in_sec?: number;
  api_domain?: string;
  token_type?: string;
  error?: string;
};

export async function exchangeCliqAuthorizationCode(code: string): Promise<CliqOAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: requiredEnv("ZOHO_CLIQ_CLIENT_ID"),
    client_secret: requiredEnv("ZOHO_CLIQ_CLIENT_SECRET"),
    redirect_uri: cliqRedirectUri(),
    code,
  });

  const response = await fetch(`${cliqAccountsUrl()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const payload = (await response.json()) as CliqOAuthTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(`Zoho Cliq OAuth exchange failed: ${payload.error ?? response.status}`);
  }
  if (!payload.refresh_token) {
    throw new Error("Zoho Cliq OAuth exchange did not return a refresh token. Re-authorize with offline access and consent.");
  }

  return payload;
}
