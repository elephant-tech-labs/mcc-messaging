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

export async function POST(request: Request) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const botList = await cliqFetch<ListResponse<Bot>>("/bots");
    const bot = (botList.data ?? []).find((item) => item.name === BOT_NAME);
    if (!bot) throw new Error("MCC Messages bot was not found.");

    const existingMenu = (bot.handlers ?? []).find(
      (handler) =>
        handler.type === "menu_handler" &&
        (handler.display_props?.name ?? handler.name)?.toLowerCase() ===
          INBOX_MENU_NAME.toLowerCase(),
    );

    let menuStatus: "existing" | "created" = existingMenu ? "existing" : "created";
    if (!existingMenu) {
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
        if (alreadyExists(error)) menuStatus = "existing";
        else throw error;
      }
    }

    const functionList = await cliqFetch<ListResponse<CliqFunction>>("/functions");
    const functions = functionList.data ?? [];
    const url = executionUrl();
    let inboxFunction = functions.find((item) => item.name === INBOX_FUNCTION_NAME);
    let functionCreated = false;

    if (!inboxFunction) {
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
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Unknown Cliq inbox provisioning error",
      },
      { status: 502 },
    );
  }
}
