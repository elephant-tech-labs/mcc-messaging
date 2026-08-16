import { cliqFetch } from "@/lib/zoho-cliq/client";
import { zohoContactRecordUrl } from "@/lib/zoho/crm-url";

const MCC_BOT_UNIQUE_NAME = "mccmessagesx";
const MCC_REPLY_FUNCTION_NAME = "mccsmsreply";
const MCC_VIEW_FUNCTION_NAME = "mccsmsview";

type BotMessageResponse = {
  chat_id?: string;
  message_id?: string;
  id?: string;
};

export type IncomingSmsCliqNotification = {
  conversationId: string;
  zohoContactId?: string | null;
  contactName?: string | null;
  customerPhone: string;
  body: string;
  mediaCount?: number;
};

function previewBody(body: string, mediaCount = 0): string {
  const trimmed = body.trim();
  if (trimmed) return trimmed.length > 1000 ? `${trimmed.slice(0, 997)}...` : trimmed;
  if (mediaCount > 0) {
    return `[Incoming MMS: ${mediaCount} attachment${mediaCount === 1 ? "" : "s"}]`;
  }
  return "[Incoming SMS]";
}

export async function sendIncomingSmsCliqNotification(
  input: IncomingSmsCliqNotification,
): Promise<BotMessageResponse> {
  const sender = input.contactName?.trim() || input.customerPhone;
  const phoneSuffix = input.contactName?.trim() ? `\n${input.customerPhone}` : "";
  const text = `📩 New SMS from ${sender}${phoneSuffix}\n\n${previewBody(input.body, input.mediaCount)}`;

  const buttons: Array<Record<string, unknown>> = [
    {
      label: "Reply",
      type: "+",
      key: `reply:${input.conversationId}`,
      action: {
        type: "invoke.function",
        data: { name: MCC_REPLY_FUNCTION_NAME },
        confirm: {
          title: `Reply to ${sender}`.slice(0, 100),
          description: `Send an SMS reply to ${input.customerPhone}`.slice(0, 100),
          input: "Type your SMS reply",
          emotion: "positive",
          button_label: "Send SMS",
          cancel_button_label: "Cancel",
          mandatory: "true",
        },
      },
      arguments: {
        conversationId: input.conversationId,
      },
    },
    {
      label: "View Conversation",
      type: "+",
      key: `view:${input.conversationId}`,
      action: {
        type: "invoke.function",
        data: { name: MCC_VIEW_FUNCTION_NAME },
      },
      arguments: {
        conversationId: input.conversationId,
      },
    },
  ];

  if (input.zohoContactId?.trim()) {
    buttons.push({
      label: "Open in CRM",
      type: "+",
      key: `crm:${input.zohoContactId}`,
      action: {
        type: "open.url",
        data: { web: zohoContactRecordUrl(input.zohoContactId.trim()) },
      },
    });
  }

  return cliqFetch<BotMessageResponse>(
    `/bots/${encodeURIComponent(MCC_BOT_UNIQUE_NAME)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        text,
        buttons,
        sync_message: true,
      }),
    },
  );
}
