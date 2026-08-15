import { NextResponse } from "next/server";
import { hasValidServiceKey } from "@/lib/auth/service-key";
import { cliqFetch } from "@/lib/zoho-cliq/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CliqBot = {
  id: string;
  unique_name?: string;
  name?: string;
  description?: string;
  scope?: string;
  execution_type?: string;
  execution_url?: string;
  handlers?: Array<{ type?: string; id?: string; name?: string }>;
  creator?: { name?: string; id?: string };
  status?: string;
  type?: string;
  default?: boolean;
  subscriber_count?: number;
  calls?: string;
  channel_participation?: string[];
};

type ListBotsResponse = { data?: CliqBot[] };
type BotResponse = { data?: CliqBot };

export async function GET(request: Request) {
  if (!hasValidServiceKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const listed = await cliqFetch<ListBotsResponse>("/bots");
    const matches = (listed.data ?? []).filter((bot) => bot.name === "MCC Messages");

    const detailed = await Promise.all(
      matches.map(async (bot) => {
        try {
          const result = await cliqFetch<BotResponse>(`/bots/${encodeURIComponent(bot.id)}`);
          return result.data ?? bot;
        } catch {
          return bot;
        }
      }),
    );

    return NextResponse.json({
      ok: true,
      matchCount: detailed.length,
      bots: detailed.map((bot) => ({
        id: bot.id,
        uniqueName: bot.unique_name ?? null,
        name: bot.name ?? null,
        description: bot.description ?? null,
        scope: bot.scope ?? null,
        executionType: bot.execution_type ?? null,
        executionUrlConfigured: Boolean(bot.execution_url),
        handlers: bot.handlers ?? [],
        creator: bot.creator ?? null,
        status: bot.status ?? null,
        type: bot.type ?? null,
        default: bot.default ?? false,
        subscriberCount: bot.subscriber_count ?? 0,
        calls: bot.calls ?? null,
        channelParticipation: bot.channel_participation ?? [],
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 500) : "Unknown Cliq inspection error",
      },
      { status: 502 },
    );
  }
}
