import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { optionalEnv } from "@/lib/env";
import { cliqFetch } from "@/lib/zoho-cliq/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const env = {
    clientId: Boolean(optionalEnv("ZOHO_CLIQ_CLIENT_ID")),
    clientSecret: Boolean(optionalEnv("ZOHO_CLIQ_CLIENT_SECRET")),
    refreshToken: Boolean(optionalEnv("ZOHO_CLIQ_REFRESH_TOKEN")),
    webhookSecret: Boolean(optionalEnv("ZOHO_CLIQ_WEBHOOK_SECRET")),
  };

  if (!env.clientId || !env.clientSecret || !env.refreshToken) {
    return NextResponse.json({
      ok: false,
      env,
      cliq: { ok: false, skipped: true, reason: "Cliq OAuth environment is incomplete" },
    });
  }

  try {
    const result = await cliqFetch<{ data?: unknown[] }>("/bots");
    return NextResponse.json({
      ok: true,
      env,
      cliq: { ok: true, botCountOnPage: result.data?.length ?? 0 },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        env,
        cliq: {
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 300) : "Unknown Cliq API error",
        },
      },
      { status: 502 },
    );
  }
}
