import { cliqFetch } from "@/lib/zoho-cliq/client";

const MCC_BOT_UNIQUE_NAME = "mccmessagesx";

type BotMessageResponse = {
  chat_id?: string;
  message_id?: string;
  id?: string;
};

export type IncomingSmsCliqNotification = {
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

  return cliqFetch<BotMessageResponse>(
    `/bots/${encodeURIComponent(MCC_BOT_UNIQUE_NAME)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        text,
        sync_message: true,
      }),
    },
  );
}
