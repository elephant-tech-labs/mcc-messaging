import { NextResponse } from "next/server";
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

    // Status callbacks may also arrive for messages still sent by the legacy Zoho Flow.
    // Ignore unknown SIDs instead of causing Twilio retries while both systems coexist.
    if (!result.message) {
      return new Response(null, { status: 204 });
    }

    if (
      result.applied &&
      result.isLatestOutgoing &&
      result.conversation?.zoho_conversation_id
    ) {
      try {
        await updateZohoMessagingConversation(
          result.conversation.zoho_conversation_id,
          { lastMessageStatus: toZohoMessageStatus(status) },
        );
      } catch {
        // Twilio should receive success once the authoritative delivery state is persisted.
        // Zoho summary sync is recoverable and must not trigger duplicate callback retries.
      }
    }

    return new Response(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Status callback persistence failed" }, { status: 500 });
  }
}
