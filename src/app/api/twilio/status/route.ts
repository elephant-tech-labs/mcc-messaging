import { NextResponse } from "next/server";
import { syncBulkSmsRecipientStatus } from "@/lib/messaging/bulk-sms";
import { projectConversationToZoho } from "@/lib/messaging/crm-reconciliation";
import { applyMessageStatus } from "@/lib/messaging/repository";
import { formDataToRecord, validateTwilioWebhook } from "@/lib/twilio/validate";
import { normalizeTwilioStatus } from "@/lib/twilio/status";

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

    // Only project bulk status after the canonical message accepted this callback.
    // This prevents a stale/out-of-order Twilio callback from downgrading bulk reporting.
    if (result.applied) {
      try {
        await syncBulkSmsRecipientStatus({
          twilioMessageSid: messageSid,
          status,
          errorCode: params.ErrorCode || null,
          errorMessage: params.ErrorMessage || null,
        });
      } catch {
        // Canonical messaging remains authoritative; bulk reporting is repairable.
      }
    }

    if (result.applied && result.isLatestOutgoing && result.conversation?.zoho_contact_id) {
      try {
        await projectConversationToZoho(result.conversation.id);
      } catch {
        // The database trigger leaves this conversation dirty for later repair.
      }
    }

    return new Response(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Status callback persistence failed" }, { status: 500 });
  }
}
