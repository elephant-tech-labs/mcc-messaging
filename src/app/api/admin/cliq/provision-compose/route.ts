import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { requiredEnv } from "@/lib/env";
import { CliqApiError, cliqFetch } from "@/lib/zoho-cliq/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOT_NAME = "MCC Messages";
const MENU_NAME = "New SMS";
const COMPOSE_FUNCTION = "mccsmscompose";

type Handler = {
  id?: string;
  type?: string;
  name?: string;
  permissions?: string[];
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
  return `${base}/api/cliq/functions/compose?secret=${secret}`;
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

    const menu = (bot.handlers ?? []).find(
      (handler) =>
        handler.type === "menu_handler" &&
        (handler.display_props?.name ?? handler.name)?.toLowerCase() === MENU_NAME.toLowerCase(),
    );
    if (!menu?.id) {
      throw new Error("New SMS menu handler was not found or has no handler ID.");
    }

    await cliqFetch(
      `/bots/${encodeURIComponent(bot.id)}/handlers/menu_handler?handler_id=${encodeURIComponent(menu.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          name: MENU_NAME,
          permissions: ["chat", "user"],
        }),
      },
    );

    const functionList = await cliqFetch<ListResponse<CliqFunction>>("/functions");
    const functions = functionList.data ?? [];
    const url = executionUrl();
    let compose = functions.find((item) => item.name === COMPOSE_FUNCTION);
    let functionCreated = false;

    if (!compose) {
      const created = await cliqFetch<FunctionResponse>("/functions", {
        method: "POST",
        body: JSON.stringify({
          name: COMPOSE_FUNCTION,
          description: "Open the MCC New SMS form from Zoho Cliq.",
          function_type: "button",
          execution_type: "webhook",
          execution_url: url,
        }),
      });
      compose = created.data;
      functionCreated = true;
    } else {
      if (compose.function_type && compose.function_type !== "button") {
        throw new Error(`${COMPOSE_FUNCTION} exists but is not a button function.`);
      }
      if (compose.execution_type && compose.execution_type !== "webhook") {
        throw new Error(`${COMPOSE_FUNCTION} exists but is not a webhook function.`);
      }
      if (compose.execution_url !== url) {
        const updated = await cliqFetch<FunctionResponse>(
          `/functions/${encodeURIComponent(compose.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ execution_url: url }),
          },
        );
        compose = updated.data;
      }
    }

    const hasButtonHandler = (compose.handlers ?? []).some(
      (handler) => handler.type === "button_handler",
    );
    let handlerStatus: "existing" | "created" = hasButtonHandler ? "existing" : "created";

    if (!hasButtonHandler) {
      try {
        await cliqFetch(`/functions/${encodeURIComponent(compose.id)}/handlers`, {
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
      menu: { name: MENU_NAME, permissions: ["chat", "user"] },
      composeFunction: {
        id: compose.id,
        name: compose.name,
        created: functionCreated,
        handler: handlerStatus,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 500) : "Unknown Cliq compose provisioning error",
      },
      { status: 502 },
    );
  }
}
