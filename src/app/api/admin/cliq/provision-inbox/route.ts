import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { requiredEnv } from "@/lib/env";
import { CliqApiError, cliqFetch } from "@/lib/zoho-cliq/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOT_NAME = "MCC Messages";
const INBOX_MENU_NAME = "Inbox";
const INBOX_FUNCTION_NAME = "mccsmsinbox";

type Handler = {
  id?: string;
  type?: string;
  name?: string;
  display_props?: { name?: string };
};

type Bot = {
  id: string;
  name: string;
  handlers?: Handler[];
};

type CliqFunction = {
  id: string;
  name: string;
  function_type?: string;
  execution_type?: string;
  execution_url?: string;
  handlers?: Handler[];
};

type ListResponse<T> = { data?: T[] };
type FunctionResponse = { data: CliqFunction };

function executionUrl(): string {
  const base = requiredEnv("APP_BASE_URL").replace(/\/$/, "");
  const secret = encodeURIComponent(requiredEnv("ZOHO_CLIQ_WEBHOOK_SECRET"));
  return `${base}/api/cliq/functions/inbox?secret=${secret}`;
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof CliqApiError)) return null;
  if (!error.payload || typeof error.payload !== "object") return null;
  const value = (error.payload as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

function alreadyExists(error: unknown): boolean {
  if (!(error instanceof CliqApiError)) return false;
  const payload =
    error.payload && typeof error.payload === "object"
      ? (error.payload as { code?: unknown; message?: unknown })
      : {};
  const code = typeof payload.code === "string" ? payload.code.toLowerCase() : "";
  const message = typeof payload.message === "string" ? payload.message.toLowerCase() : "";
  return code.includes("already") || message.includes("already");
}

function menuHandlers(bot: Bot): Handler[] {
  return (bot.handlers ?? []).filter((handler) => handler.type === "menu_handler");
}

function menuName(handler: Handler): string | null {
  return handler.display_props?.name ?? handler.name ?? null;
}

function findInboxMenu(bot: Bot): Handler | undefined {
  return menuHandlers(bot).find(
    (handler) => menuName(handler)?.toLowerCase() === INBOX_MENU_NAME.toLowerCase(),
  );
}

async function loadBot(): Promise<Bot> {
  const botList = await cliqFetch<ListResponse<Bot>>("/bots");
  const bot = (botList.data ?? []).find((item) => item.name === BOT_NAME);
  if (!bot) throw new Error("MCC Messages bot was not found.");
  return bot;
}

export async function POST(request: Request) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let stage = "load_bot";
  let observedMenuNames: string[] = [];

  try {
    let bot = await loadBot();
    observedMenuNames = menuHandlers(bot).map(menuName).filter((value): value is string => Boolean(value));

    let existingMenu = findInboxMenu(bot);
    let menuStatus: "existing" | "created" = existingMenu ? "existing" : "created";

    if (!existingMenu) {
      stage = "create_inbox_menu";
      try {
        await cliqFetch(`/bots/${encodeURIComponent(bot.id)}/handlers`, {
          method: "POST",
          body: JSON.stringify({
            type: "menu_handler",
            name: INBOX_MENU_NAME,
            permissions: ["chat", "user"],
          }),
        });
      } catch (error) {
        if (alreadyExists(error)) {
          menuStatus = "existing";
        } else {
          // Cliq occasionally returns a generic operation_failed even when handler
          // metadata has already changed. Re-read the bot before deciding it failed.
          bot = await loadBot();
          observedMenuNames = menuHandlers(bot)
            .map(menuName)
            .filter((value): value is string => Boolean(value));
          existingMenu = findInboxMenu(bot);
          if (existingMenu) {
            menuStatus = "existing";
          } else {
            throw error;
          }
        }
      }
    }

    stage = "list_functions";
    const functionList = await cliqFetch<ListResponse<CliqFunction>>("/functions");
    const functions = functionList.data ?? [];
    const url = executionUrl();
    let inboxFunction = functions.find((item) => item.name === INBOX_FUNCTION_NAME);
    let functionCreated = false;

    if (!inboxFunction) {
      stage = "create_inbox_function";
      const created = await cliqFetch<FunctionResponse>("/functions", {
        method: "POST",
        body: JSON.stringify({
          name: INBOX_FUNCTION_NAME,
          description: "Show recent and unread MCC SMS conversations in Zoho Cliq.",
          function_type: "button",
          execution_type: "webhook",
          execution_url: url,
        }),
      });
      inboxFunction = created.data;
      functionCreated = true;
    } else {
      if (inboxFunction.function_type && inboxFunction.function_type !== "button") {
        throw new Error(`${INBOX_FUNCTION_NAME} exists but is not a button function.`);
      }
      if (inboxFunction.execution_type && inboxFunction.execution_type !== "webhook") {
        throw new Error(`${INBOX_FUNCTION_NAME} exists but is not a webhook function.`);
      }
      if (inboxFunction.execution_url !== url) {
        stage = "update_inbox_function";
        const updated = await cliqFetch<FunctionResponse>(
          `/functions/${encodeURIComponent(inboxFunction.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ execution_url: url }),
          },
        );
        inboxFunction = updated.data;
      }
    }

    const hasButtonHandler = (inboxFunction.handlers ?? []).some(
      (handler) => handler.type === "button_handler",
    );
    let handlerStatus: "existing" | "created" = hasButtonHandler ? "existing" : "created";

    if (!hasButtonHandler) {
      stage = "create_inbox_button_handler";
      try {
        await cliqFetch(`/functions/${encodeURIComponent(inboxFunction.id)}/handlers`, {
          method: "POST",
          body: JSON.stringify({
            type: "button_handler",
            permissions: ["chat", "message", "user"],
          }),
        });
      } catch (error) {
        if (alreadyExists(error)) handlerStatus = "existing";
        else throw error;
      }
    }

    return NextResponse.json({
      ok: true,
      inboxMenu: {
        name: INBOX_MENU_NAME,
        status: menuStatus,
      },
      inboxFunction: {
        id: inboxFunction.id,
        name: inboxFunction.name,
        created: functionCreated,
        handler: handlerStatus,
      },
    });
  } catch (error) {
    console.error("Cliq inbox provisioning failed", {
      stage,
      code: errorCode(error) ?? "unknown",
      menuCount: observedMenuNames.length,
      menuNames: observedMenuNames,
    });

    return NextResponse.json(
      {
        ok: false,
        stage,
        menuCount: observedMenuNames.length,
        menuNames: observedMenuNames,
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Unknown Cliq inbox provisioning error",
      },
      { status: 502 },
    );
  }
}
