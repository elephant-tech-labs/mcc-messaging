import { requiredEnv } from "@/lib/env";
import { CliqApiError, cliqFetch } from "@/lib/zoho-cliq/client";

const BOT_NAME = "MCC Messages";
const LEGACY_PREFIX = "MCC Empty";
const REPLY_FUNCTION_NAME = "mccsmsreply";

type CliqBot = {
  id: string;
  unique_name: string;
  name: string;
  execution_type?: string;
  execution_url?: string;
  handlers?: Array<{ type?: string; id?: string }>;
};

type CliqFunction = {
  id: string;
  name: string;
  function_type?: string;
  execution_type?: string;
  execution_url?: string;
  handlers?: Array<{ type?: string; id?: string }>;
};

type ListBotsResponse = { data?: CliqBot[] };
type BotResponse = { data: CliqBot };
type ListFunctionsResponse = { data?: CliqFunction[] };
type FunctionResponse = { data: CliqFunction };

type ProvisionResult = {
  bot: CliqBot;
  created: boolean;
  renamedLegacyBot?: { id: string; oldName: string; newName: string };
};

function baseExecutionUrl(path: string): string {
  const baseUrl = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  const secret = encodeURIComponent(requiredEnv("ZOHO_CLIQ_WEBHOOK_SECRET"));
  return `${baseUrl}${path}?secret=${secret}`;
}

function botExecutionUrl(): string {
  return baseExecutionUrl("/api/cliq/bot");
}

function replyFunctionExecutionUrl(): string {
  return baseExecutionUrl("/api/cliq/functions/reply");
}

function legacyName(bot: CliqBot, allBots: CliqBot[]): string {
  const suffix = bot.id.slice(-4);
  const preferred = `${LEGACY_PREFIX} ${suffix}`.slice(0, 20);
  if (!allBots.some((item) => item.name === preferred)) return preferred;

  const fallback = `MCC Setup ${suffix}`.slice(0, 20);
  if (!allBots.some((item) => item.name === fallback)) return fallback;

  throw new Error("Unable to choose a safe temporary name for the existing empty MCC bot.");
}

function isMissingHandlerError(error: unknown): boolean {
  if (!(error instanceof CliqApiError)) return false;
  if (error.status === 404) return true;

  if (error.status === 400 && error.payload && typeof error.payload === "object") {
    const payload = error.payload as { code?: unknown };
    return payload.code === "execution_handler_not_found";
  }

  return false;
}

async function ensureLegacyShellHasHandler(bot: CliqBot): Promise<void> {
  if ((bot.handlers ?? []).length > 0) return;

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

async function ensureBotHandler(
  botId: string,
  type: "welcome_handler" | "message_handler",
  permissions: string[],
): Promise<"created" | "existing"> {
  try {
    await cliqFetch(`/bots/${encodeURIComponent(botId)}/handlers/${type}`);
    return "existing";
  } catch (error) {
    if (!isMissingHandlerError(error)) throw error;
  }

  await cliqFetch(`/bots/${encodeURIComponent(botId)}/handlers`, {
    method: "POST",
    body: JSON.stringify({ type, permissions }),
  });
  return "created";
}

async function getOrCreateReplyFunction(): Promise<{
  fn: CliqFunction;
  created: boolean;
}> {
  const list = await cliqFetch<ListFunctionsResponse>("/functions");
  const existing = (list.data ?? []).find((item) => item.name === REPLY_FUNCTION_NAME);
  const executionUrl = replyFunctionExecutionUrl();

  if (existing) {
    if (existing.function_type && existing.function_type !== "button") {
      throw new Error(`Cliq function ${REPLY_FUNCTION_NAME} exists but is not a button function.`);
    }
    if (existing.execution_type && existing.execution_type !== "webhook") {
      throw new Error(`Cliq function ${REPLY_FUNCTION_NAME} exists but is not a webhook function.`);
    }

    if (existing.execution_url !== executionUrl) {
      const updated = await cliqFetch<FunctionResponse>(
        `/functions/${encodeURIComponent(existing.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ execution_url: executionUrl }),
        },
      );
      return { fn: updated.data, created: false };
    }

    return { fn: existing, created: false };
  }

  const created = await cliqFetch<FunctionResponse>("/functions", {
    method: "POST",
    body: JSON.stringify({
      name: REPLY_FUNCTION_NAME,
      description: "Safely reply to an MCC SMS conversation from Zoho Cliq.",
      function_type: "button",
      execution_type: "webhook",
      execution_url: executionUrl,
    }),
  });

  return { fn: created.data, created: true };
}

async function ensureFunctionButtonHandler(
  functionId: string,
): Promise<"created" | "existing"> {
  try {
    await cliqFetch(
      `/functions/${encodeURIComponent(functionId)}/handlers/button_handler`,
    );
    return "existing";
  } catch (error) {
    if (!isMissingHandlerError(error)) throw error;
  }

  await cliqFetch(`/functions/${encodeURIComponent(functionId)}/handlers`, {
    method: "POST",
    body: JSON.stringify({
      type: "button_handler",
      permissions: ["chat", "message", "user"],
    }),
  });
  return "created";
}

export async function provisionMccCliqBot() {
  const { bot, created, renamedLegacyBot } = await getOrCreateBot();
  const welcomeHandler = await ensureBotHandler(bot.id, "welcome_handler", ["user"]);
  const messageHandler = await ensureBotHandler(bot.id, "message_handler", ["chat", "message", "user"]);

  const { fn: replyFunction, created: replyFunctionCreated } =
    await getOrCreateReplyFunction();
  const replyFunctionHandler = await ensureFunctionButtonHandler(replyFunction.id);

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
    replyFunction: {
      id: replyFunction.id,
      name: replyFunction.name,
      executionType: replyFunction.execution_type ?? "webhook",
      created: replyFunctionCreated,
      handler: replyFunctionHandler,
    },
  };
}
