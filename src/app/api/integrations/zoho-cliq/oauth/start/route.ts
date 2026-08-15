import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  buildCliqAuthorizationUrl,
  CLIQ_OAUTH_STATE_COOKIE,
} from "@/lib/zoho-cliq/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = randomBytes(32).toString("hex");
  const response = NextResponse.redirect(buildCliqAuthorizationUrl(state));
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(CLIQ_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/integrations/zoho-cliq/oauth",
    maxAge: 10 * 60,
  });
  return response;
}
