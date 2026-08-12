import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { getContactThread } from "@/lib/messaging/repository";
import { getZohoContactById } from "@/lib/zoho/contacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ contactId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { contactId } = await context.params;
  const zohoContactId = contactId?.trim();
  if (!zohoContactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  try {
    const [contact, thread] = await Promise.all([
      getZohoContactById(zohoContactId),
      getContactThread(zohoContactId),
    ]);

    if (!contact) {
      return NextResponse.json({ error: "Zoho Contact not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      contact: {
        id: contact.id,
        name:
          contact.Full_Name ??
          [contact.First_Name, contact.Last_Name].filter(Boolean).join(" ") ??
          null,
        phone: contact.Phone ?? null,
      },
      conversations: thread.conversations,
      messages: thread.messages,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
    return NextResponse.json(
      { error: "Contact SMS history failed", detail },
      { status: 502 },
    );
  }
}
