import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { toZohoMessageStatus } from "@/lib/twilio/status";
import { updateZohoMessagingConversation } from "@/lib/zoho/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ conversationId: string }>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
}

export async function POST(request: Request, context: RouteContext) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { conversationId } = await context.params;
  const { data: conversation, error } = await getSupabaseAdmin()
    .from("messaging_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: "Conversation lookup failed", detail: error.message },
      { status: 500 },
    );
  }

  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  if (!conversation.zoho_conversation_id) {
    return NextResponse.json(
      { error: "Conversation has no Zoho conversation ID" },
      { status: 409 },
    );
  }

  try {
    await updateZohoMessagingConversation(conversation.zoho_conversation_id, {
      lastMessage: conversation.last_message,
      lastMessageAt: conversation.last_message_at,
      lastMessageDirection:
        conversation.last_message_direction === "Incoming" ||
        conversation.last_message_direction === "Outgoing"
          ? conversation.last_message_direction
          : null,
      lastMessageStatus: conversation.last_message_status
        ? toZohoMessageStatus(conversation.last_message_status)
        : null,
      unreadCount: conversation.unread_count,
      lastIncomingAt: conversation.last_incoming_at,
      lastOutgoingAt: conversation.last_outgoing_at,
      optOutStatus:
        conversation.opt_out_status === "Opted Out" ||
        conversation.opt_out_status === "Do Not Message"
          ? conversation.opt_out_status
          : "Active",
    });

    return NextResponse.json({
      ok: true,
      conversationId: conversation.id,
      zohoConversationId: conversation.zoho_conversation_id,
      lastMessageStatus: conversation.last_message_status,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "CRM conversation resync failed", detail: errorMessage(error) },
      { status: 502 },
    );
  }
}
