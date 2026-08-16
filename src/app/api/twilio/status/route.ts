import { NextResponse } from "next/server";
import { syncBulkSmsRecipientStatus } from "@/lib/messaging/bulk-sms";
import { applyMessageStatus } from "@/lib/messaging/repository";
import { formDataToRecord, validateTwilioWebhook } from "@/lib/twilio/validate";
import { normalizeTwilioStatus, toZohoMessageStatus } from "@/lib/twilio/status";
import { updateZohoMessagingConversation } from "@/lib/zoho/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData();
  const params = formDataToRecord(form);

  if (!validateTwilioWebhook(request, params)) {
    return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  }

  const messageSid = params.MessageSid || params.SmsSid;
  const rawStatus = params.MessageStatus || params.SmsStatus;
  if (!messageSid || !rawStatus) {
    return NextResponse.json({ error: "Missing MessageSid or MessageStatus" }, { status: 400 });
  }

  const status = normalizeTwilioStatus(rawStatus);

  try {
    const result = await applyMessageStatus({
      twilioMessageSid: messageSid,
      nextStatus: status,
      errorCode: params.ErrorCode || null,
      errorMessage: params.ErrorMessage || null,
    });

    if (!result.message) return new Response(null, { status: 204 });

    // Bulk reporting is a projection of the canonical messaging message status.
    // Do not make Twilio retry a callback if the optional bulk projection is unavailable.
    try {
      await syncBulkSmsRecipientStatus({
        twilioMessageSid: messageSid,
        status,
        errorCode: params.ErrorCode || null,
        errorMessage: params.ErrorMessage || null,
      });
    } catch {
      // A later widget refresh/reconciliation can repair bulk reporting.
    }

    if (result.applied && result.isLatestOutgoing && result.conversation?.zoho_conversation_id) {
      try {
        await updateZohoMessagingConversation(result.conversation.zoho_conversation_id, {
          lastMessageStatus: toZohoMessageStatus(status),
        });
      } catch {
        // Supabase is canonical; CRM summary sync is recoverable.
      }
    }

    return new Response(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Status callback persistence failed" }, { status: 500 });
  }
}
