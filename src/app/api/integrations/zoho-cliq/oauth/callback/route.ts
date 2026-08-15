import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  CLIQ_OAUTH_STATE_COOKIE,
  exchangeCliqAuthorizationCode,
} from "@/lib/zoho-cliq/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function validState(expected: string | null, actual: string | null): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function page(title: string, body: string, status = 200): NextResponse {
  const response = new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1020;color:#eef2ff;margin:0;padding:32px}main{max-width:760px;margin:40px auto;background:#141b2d;border:1px solid #27314d;border-radius:18px;padding:28px}h1{margin-top:0;font-size:26px}p{line-height:1.55;color:#cbd5e1}code{display:block;overflow-wrap:anywhere;background:#090d18;border:1px solid #334155;border-radius:10px;padding:14px;color:#f8fafc}strong{color:#fff}</style></head><body><main><h1>${htmlEscape(title)}</h1>${body}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
  response.cookies.set(CLIQ_OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/integrations/zoho-cliq/oauth",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return page("Zoho Cliq authorization failed", `<p>Zoho returned: <strong>${htmlEscape(error)}</strong></p>`, 400);
  }

  const state = url.searchParams.get("state");
  const expectedState = cookieValue(request, CLIQ_OAUTH_STATE_COOKIE);
  if (!validState(expectedState, state)) {
    return page("Zoho Cliq authorization rejected", "<p>The OAuth state check failed. Start the authorization flow again from the MCC Messaging OAuth start URL.</p>", 400);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return page("Zoho Cliq authorization failed", "<p>Zoho did not return an authorization code.</p>", 400);
  }

  try {
    const token = await exchangeCliqAuthorizationCode(code);
    const refreshToken = token.refresh_token!;
    return page(
      "Zoho Cliq authorization successful",
      `<p>The MCC Messaging app received a Cliq refresh token. Copy it <strong>once</strong> into the Vercel Production environment variable <strong>ZOHO_CLIQ_REFRESH_TOKEN</strong>. Do not paste it into ChatGPT or any ticket/chat.</p><code>${htmlEscape(refreshToken)}</code><p>After saving the variable in Vercel, redeploy the production project and return to ChatGPT.</p>`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OAuth error";
    return page("Zoho Cliq authorization failed", `<p>${htmlEscape(message)}</p>`, 502);
  }
}
