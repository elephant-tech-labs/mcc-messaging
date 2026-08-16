import { requiredEnv } from "@/lib/env";
import { CliqApiError, cliqFetch } from "@/lib/zoho-cliq/client";

const BOT_NAME = "MCC Messages";
const LEGACY_PREFIX = "MCC Empty";
const REPLY_FUNCTION_NAME = "mccsmsreply";
const VIEW_FUNCTION_NAME = "mccsmsview";
const NEW_SMS_FUNCTION_NAME = "mccnewsms";
const NEW_SMS_MENU_NAME = "New SMS";

type CliqHandler = {
  type?: string;
  id?: string;
  display_props?: { name?: string; position?: number };
};

type CliqBot = {
  id: string;
  unique_name: string;
  name: string;
  execution_type?: string;
  execution_url?: string;
  handlers?: CliqHandler[];
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

function viewFunctionExecutionUrl(): string {
  return baseExecutionUrl("/api/cliq/functions/view");
}

function newSmsFunctionExecutionUrl(): string {
  return baseExecutionUrl("/api/cliq/functions/new-sms");
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

async function ensureNewSmsMenu(botId: string): Promise<"created" | "existing"> {
  const detail = await cliqFetch<BotResponse>(`/bots/${encodeURIComponent(botId)}`);
  const existing = (detail.data.handlers ?? []).find(
    (handler) =>
      handler.type === "menu_handler" &&
      handler.display_props?.name?.toLowerCase() === NEW_SMS_MENU_NAME.toLowerCase(),
  );
  if (existing) return "existing";

  await cliqFetch(`/bots/${encodeURIComponent(botId)}/handlers`, {
    method: "POST",
    body: JSON.stringify({
      type: "menu_handler",
      name: NEW_SMS_MENU_NAME,
      permissions: ["chat"],
    }),
  });
  return "created";
}

async function getOrCreateFunction(input: {
  name: string;
  description: string;
  functionType: "button" | "form";
  executionUrl: string;
}): Promise<{ fn: CliqFunction; created: boolean }> {
  const list = await cliqFetch<ListFunctionsResponse>("/functions");
  const existing = (list.data ?? []).find((item) => item.name === input.name);

  if (existing) {
    if (existing.function_type && existing.function_type !== input.functionType) {
      throw new Error(
        `Cliq function ${input.name} exists but is not a ${input.functionType} function.`,
      );
    }
    if (existing.execution_type && existing.execution_type !== "webhook") {
      throw new Error(`Cliq function ${input.name} exists but is not a webhook function.`);
    }

    if (existing.execution_url !== input.executionUrl) {
      const updated = await cliqFetch<FunctionResponse>(
        `/functions/${encodeURIComponent(existing.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ execution_url: input.executionUrl }),
        },
      );
      return { fn: updated.data, created: false };
    }

    return { fn: existing, created: false };
  }

  const created = await cliqFetch<FunctionResponse>("/functions", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      function_type: input.functionType,
      execution_type: "webhook",
      execution_url: input.executionUrl,
    }),
  });

  return { fn: created.data, created: true };
}

async function ensureFunctionHandler(
  functionId: string,
  type:
    | "button_handler"
    | "form_submit_handler"
    | "form_dynamic_select_handler",
  permissions: string[],
): Promise<"created" | "existing"> {
  try {
    await cliqFetch(`/functions/${encodeURIComponent(functionId)}/handlers/${type}`);
    return "existing";
  } catch (error) {
    if (!isMissingHandlerError(error)) throw error;
  }

  await cliqFetch(`/functions/${encodeURIComponent(functionId)}/handlers`, {
    method: "POST",
    body: JSON.stringify({ type, permissions }),
  });
  return "created";
}

export async function provisionMccCliqBot() {
  const { bot, created, renamedLegacyBot } = await getOrCreateBot();
  const welcomeHandler = await ensureBotHandler(bot.id, "welcome_handler", ["user"]);
  const messageHandler = await ensureBotHandler(bot.id, "message_handler", ["chat", "message", "user"]);
  const newSmsMenu = await ensureNewSmsMenu(bot.id);

  const { fn: replyFunction, created: replyFunctionCreated } =
    await getOrCreateFunction({
      name: REPLY_FUNCTION_NAME,
      description: "Safely reply to an MCC SMS conversation from Zoho Cliq.",
      functionType: "button",
      executionUrl: replyFunctionExecutionUrl(),
    });
  const replyFunctionHandler = await ensureFunctionHandler(
    replyFunction.id,
    "button_handler",
    ["chat", "message", "user"],
  );

  const { fn: viewFunction, created: viewFunctionCreated } =
    await getOrCreateFunction({
      name: VIEW_FUNCTION_NAME,
      description: "View recent messages in an MCC SMS conversation from Zoho Cliq.",
      functionType: "button",
      executionUrl: viewFunctionExecutionUrl(),
    });
  const viewFunctionHandler = await ensureFunctionHandler(
    viewFunction.id,
    "button_handler",
    ["chat", "message", "user"],
  );

  const { fn: newSmsFunction, created: newSmsFunctionCreated } =
    await getOrCreateFunction({
      name: NEW_SMS_FUNCTION_NAME,
      description: "Search a Zoho CRM Contact and start a new MCC SMS from Zoho Cliq.",
      functionType: "form",
      executionUrl: newSmsFunctionExecutionUrl(),
    });
  const newSmsSubmitHandler = await ensureFunctionHandler(
    newSmsFunction.id,
    "form_submit_handler",
    ["chat", "user"],
  );
  const newSmsSearchHandler = await ensureFunctionHandler(
    newSmsFunction.id,
    "form_dynamic_select_handler",
    ["chat", "user"],
  );

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
      newSmsMenu,
    },
    replyFunction: {
      id: replyFunction.id,
      name: replyFunction.name,
      executionType: replyFunction.execution_type ?? "webhook",
      created: replyFunctionCreated,
      handler: replyFunctionHandler,
    },
    viewFunction: {
      id: viewFunction.id,
      name: viewFunction.name,
      executionType: viewFunction.execution_type ?? "webhook",
      created: viewFunctionCreated,
      handler: viewFunctionHandler,
    },
    newSmsFunction: {
      id: newSmsFunction.id,
      name: newSmsFunction.name,
      executionType: newSmsFunction.execution_type ?? "webhook",
      created: newSmsFunctionCreated,
      handlers: {
        submit: newSmsSubmitHandler,
        dynamicContactSearch: newSmsSearchHandler,
      },
    },
  };
}
