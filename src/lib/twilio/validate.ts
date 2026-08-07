import twilio from "twilio";
import { optionalEnv, requiredEnv } from "@/lib/env";

export function formDataToRecord(form: FormData): Record<string, string> {
  const params: Record<string, string> = {};

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  return params;
}

export function canonicalRequestUrl(request: Request): string {
  const requestUrl = new URL(request.url);
  const baseUrl = optionalEnv("APP_BASE_URL");

  if (!baseUrl) return request.url;

  const base = new URL(baseUrl);
  base.pathname = requestUrl.pathname;
  base.search = requestUrl.search;
  return base.toString();
}

export function validateTwilioWebhook(
  request: Request,
  params: Record<string, string>,
): boolean {
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return false;

  return twilio.validateRequest(
    requiredEnv("TWILIO_AUTH_TOKEN"),
    signature,
    canonicalRequestUrl(request),
    params,
  );
}
