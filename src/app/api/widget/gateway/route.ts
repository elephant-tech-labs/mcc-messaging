import { NextResponse } from "next/server";
import { hasValidWidgetKey } from "@/lib/auth/widget-key";
import { requiredEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WidgetAction = "history" | "send";

type WidgetRequest = {
  action?: WidgetAction;
  zohoContactId?: string;
  body?: string;
  sentByZohoUserId?: string;
  sentByName?: string;
};

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

async function proxyInternal(path: string, init?: RequestInit): Promise<NextResponse> {
  const baseUrl = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-mcc-service-key": requiredEnv("MCC_SERVICE_KEY"),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  const text = await response.text();
  return new NextResponse(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  if (!hasValidWidgetKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: WidgetRequest;
  try {
    input = (await request.json()) as WidgetRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = input.action;
  const zohoContactId = cleanText(input.zohoContactId);

  if (!action || !["history", "send"].includes(action)) {
    return NextResponse.json({ error: "Unsupported widget action" }, { status: 400 });
  }

  if (!zohoContactId || !/^\d{10,25}$/.test(zohoContactId)) {
    return NextResponse.json({ error: "Valid zohoContactId is required" }, { status: 400 });
  }

  if (action === "history") {
    return proxyInternal(`/api/messages/contact/${encodeURIComponent(zohoContactId)}`);
  }

  const body = cleanText(input.body);
  if (!body) {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }

  return proxyInternal("/api/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      zohoContactId,
      body,
      sentByZohoUserId: cleanText(input.sentByZohoUserId),
      sentByName: cleanText(input.sentByName),
    }),
  });
}
