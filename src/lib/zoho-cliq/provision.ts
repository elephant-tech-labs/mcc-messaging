import { requiredEnv } from "@/lib/env";
import { CliqApiError, cliqFetch } from "@/lib/zoho-cliq/client";

const BOT_NAME = "MCC Messages";
const LEGACY_PREFIX = "MCC Empty";

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

type ProvisionResult = {
  bot: CliqBot;
  created: boolean;
  renamedLegacyBot?: { id: string; oldName: string; newName: string };
};

function botExecutionUrl(): string {
  const baseUrl = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  const secret = encodeURIComponent(requiredEnv("ZOHO_CLIQ_WEBHOOK_SECRET"));
  return `${baseUrl}/api/cliq/bot?secret=${secret}`;
}

function legacyName(bot: CliqBot, allBots: CliqBot[]): string {
  const suffix = bot.id.slice(-4);
  const preferred = `${LEGACY_PREFIX} ${suffix}`.slice(0, 20);
  if (!allBots.some((item) => item.name === preferred)) return preferred;

  const fallback = `MCC Setup ${suffix}`.slice(0, 20);
  if (!allBots.some((item) => item.name === fallback)) return fallback;

  throw new Error("Unable to choose a safe temporary name for the existing empty MCC bot.");
}

async function ensureLegacyShellHasHandler(bot: CliqBot): Promise<void> {
  if ((bot.handlers ?? []).length > 0) return;

  // Cliq's bot-update API can reject a completely handler-less Deluge shell with
  // execution_handler_not_found. Add a harmless placeholder so the user's empty
  // setup shell can be renamed and preserved rather than deleted.
  await cliqFetch(`/bots/${encodeURIComponent(bot.id)}/handlers`, {
    method: "POST",
    body: JSON.stringify({
      type: "welcome_handler",
      script: 'response = Map();\nresponse.put("text", "Unused MCC setup shell.");\nreturn response;',
    }),
  });
}

async function createWebhookBot(): Promise<CliqBot> {
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

  return created.data;
}

async function getOrCreateBot(): Promise<ProvisionResult> {
  const existing = await cliqFetch<ListBotsResponse>("/bots");
  const allBots = existing.data ?? [];
  const bot = allBots.find((item) => item.name === BOT_NAME);

  if (bot) {
    if (bot.execution_type && bot.execution_type !== "webhook") {
      // The user confirmed this is the empty shell they manually created earlier.
      // Cliq cannot convert a Deluge bot into a Webhook bot after creation, so
      // preserve it under a harmless temporary display name and create the real bot.
      await ensureLegacyShellHasHandler(bot);

      const newName = legacyName(bot, allBots);
      await cliqFetch<BotResponse>(`/bots/${encodeURIComponent(bot.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: newName,
          description: "Unused setup shell preserved while MCC Messages moved to webhook execution.",
        }),
      });

      const webhookBot = await createWebhookBot();
      return {
        bot: webhookBot,
        created: true,
        renamedLegacyBot: { id: bot.id, oldName: BOT_NAME, newName },
      };
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

  return { bot: await createWebhookBot(), created: true };
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
  const { bot, created, renamedLegacyBot } = await getOrCreateBot();
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
    ...(renamedLegacyBot ? { renamedLegacyBot } : {}),
    handlers: {
      welcome: welcomeHandler,
      message: messageHandler,
    },
  };
}
