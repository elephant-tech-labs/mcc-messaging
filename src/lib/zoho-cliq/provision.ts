import { requiredEnv } from "@/lib/env";
import { CliqApiError, cliqFetch } from "@/lib/zoho-cliq/client";

const BOT_NAME = "MCC Messages";

type CliqBot = {
  id: string;
  unique_name: string;
  name: string;
  execution_type?: string;
  execution_url?: string;
  handlers?: Array<{ type?: string; id?: string }>;
};

type ListBotsResponse = { data?: CliqBot[] };
type BotResponse = { data: CliqBot };

function botExecutionUrl(): string {
  const baseUrl = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  const secret = encodeURIComponent(requiredEnv("ZOHO_CLIQ_WEBHOOK_SECRET"));
  return `${baseUrl}/api/cliq/bot?secret=${secret}`;
}

async function getOrCreateBot(): Promise<{ bot: CliqBot; created: boolean }> {
  const existing = await cliqFetch<ListBotsResponse>("/bots");
  const bot = (existing.data ?? []).find((item) => item.name === BOT_NAME);

  if (bot) {
    if (bot.execution_type && bot.execution_type !== "webhook") {
      throw new Error(`A Cliq bot named ${BOT_NAME} already exists but is not a webhook bot.`);
    }

    const executionUrl = botExecutionUrl();
    if (bot.execution_url !== executionUrl) {
      const updated = await cliqFetch<BotResponse>(`/bots/${encodeURIComponent(bot.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ execution_url: executionUrl }),
      });
      return { bot: updated.data, created: false };
    }

    return { bot, created: false };
  }

  const created = await cliqFetch<BotResponse>("/bots", {
    method: "POST",
    body: JSON.stringify({
      name: BOT_NAME,
      description: "Send and receive Military Creator Con SMS conversations from Zoho Cliq.",
      scope: "organization",
      execution_type: "webhook",
      execution_url: botExecutionUrl(),
      status_messages: ["MCC SMS messaging"],
      calls: "disabled",
    }),
  });

  return { bot: created.data, created: true };
}

async function ensureHandler(
  botId: string,
  type: "welcome_handler" | "message_handler",
  permissions: string[],
): Promise<"created" | "existing"> {
  try {
    await cliqFetch(`/bots/${encodeURIComponent(botId)}/handlers/${type}`);
    return "existing";
  } catch (error) {
    if (!(error instanceof CliqApiError) || error.status !== 404) throw error;
  }

  await cliqFetch(`/bots/${encodeURIComponent(botId)}/handlers`, {
    method: "POST",
    body: JSON.stringify({ type, permissions }),
  });
  return "created";
}

export async function provisionMccCliqBot() {
  const { bot, created } = await getOrCreateBot();
  const welcomeHandler = await ensureHandler(bot.id, "welcome_handler", ["user"]);
  const messageHandler = await ensureHandler(bot.id, "message_handler", ["chat", "message", "user"]);

  return {
    bot: {
      id: bot.id,
      uniqueName: bot.unique_name,
      name: bot.name,
      executionType: bot.execution_type ?? "webhook",
    },
    botCreated: created,
    handlers: {
      welcome: welcomeHandler,
      message: messageHandler,
    },
  };
}
