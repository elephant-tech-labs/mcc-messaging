"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./contact-widget.module.css";

type ZohoPageLoad = {
  Entity?: string;
  EntityId?: string | string[];
};

type ZohoUser = {
  id?: string;
  full_name?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
};

type ZohoSdk = {
  embeddedApp: {
    on: (event: string, handler: (data: ZohoPageLoad) => void) => void;
    init: () => Promise<unknown> | unknown;
  };
  CRM: {
    CONFIG?: {
      getCurrentUser?: () => Promise<unknown>;
    };
    FUNCTIONS: {
      execute: (name: string, request: { arguments: string }) => Promise<unknown>;
    };
    UI?: {
      Resize?: (size: { height: string; width: string }) => Promise<unknown>;
    };
  };
};

declare global {
  interface Window {
    ZOHO?: ZohoSdk;
  }
}

type Contact = {
  id: string;
  name: string | null;
  phone: string | null;
};

type Conversation = {
  id: string;
  status: string;
  unread_count: number;
  opt_out_status: string;
};

type Message = {
  id: string;
  direction: "Incoming" | "Outgoing" | string;
  body: string | null;
  status: string;
  sent_by_name: string | null;
  created_at: string;
};

type HistoryPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  contact?: Contact;
  conversations?: Conversation[];
  messages?: Message[];
};

type SendPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
};

const SDK_URL = "https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js";
const PROXY_FUNCTION = "mcc_messaging_widget_proxy";

function loadZohoSdk(): Promise<void> {
  if (window.ZOHO) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    if (existing) {
      if (window.ZOHO) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Zoho widget SDK failed to load")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Zoho widget SDK failed to load"));
    document.head.appendChild(script);
  });
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function unwrapFunctionOutput(value: unknown): unknown {
  let current: unknown = value;
  if (current && typeof current === "object") {
    const record = current as Record<string, unknown>;
    const details = record.details;
    if (details && typeof details === "object" && "output" in (details as Record<string, unknown>)) {
      current = (details as Record<string, unknown>).output;
    } else if ("output" in record) {
      current = record.output;
    }
  }

  const first = parseMaybeJson(current);
  return typeof first === "string" ? parseMaybeJson(first) : first;
}

function parseCurrentUser(data: unknown): ZohoUser | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const users = record.users;
  if (Array.isArray(users) && users[0] && typeof users[0] === "object") {
    return users[0] as ZohoUser;
  }
  return record as ZohoUser;
}

function userDisplayName(user: ZohoUser | null): string | undefined {
  if (!user) return undefined;
  if (user.full_name?.trim()) return user.full_name.trim();
  if (user.name?.trim()) return user.name.trim();
  const composite = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return composite || undefined;
}

function initials(name: string | null | undefined): string {
  const parts = (name ?? "Contact")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("") || "C";
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function messageState(status: string): { label: string; failed: boolean } {
  const normalized = status.toLowerCase();
  if (["failed", "undelivered", "canceled"].includes(normalized)) {
    return { label: "Failed", failed: true };
  }
  if (["delivered", "read"].includes(normalized)) {
    return { label: "✓✓", failed: false };
  }
  if (["sent", "sending"].includes(normalized)) {
    return { label: "✓", failed: false };
  }
  return { label: "Sending", failed: false };
}

async function executeProxy<T>(args: Record<string, unknown>): Promise<T> {
  const sdk = window.ZOHO;
  if (!sdk) throw new Error("Zoho CRM widget context is unavailable");

  const response = await sdk.CRM.FUNCTIONS.execute(PROXY_FUNCTION, {
    arguments: JSON.stringify({ payload: JSON.stringify(args) }),
  });
  const output = unwrapFunctionOutput(response);
  if (!output || typeof output !== "object") {
    throw new Error("Messaging proxy returned an invalid response");
  }
  return output as T;
}

export default function ContactMessagingWidgetV2() {
  const [contactId, setContactId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<ZohoUser | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const loadingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.status === "Active") ?? conversations[0] ?? null,
    [conversations],
  );
  const messagingBlocked = Boolean(
    activeConversation && activeConversation.opt_out_status !== "Active",
  );

  const fetchHistory = useCallback(async (showLoading: boolean) => {
    if (!contactId || loadingRef.current) return;
    loadingRef.current = true;
    if (showLoading) setLoading(true);

    try {
      const payload = await executeProxy<HistoryPayload>({
        action: "history",
        zohoContactId: contactId,
      });
      if (!payload.ok || !payload.contact) {
        throw new Error(payload.detail || payload.error || "Unable to load conversation");
      }

      setContact(payload.contact);
      setConversations(payload.conversations ?? []);
      setMessages(payload.messages ?? []);
      setError(null);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
    } catch (fetchError) {
      if (showLoading || messages.length === 0) {
        setError(fetchError instanceof Error ? fetchError.message : "Unable to load conversation");
      }
    } finally {
      loadingRef.current = false;
      if (showLoading) setLoading(false);
    }
  }, [contactId, messages.length]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        await loadZohoSdk();
        const sdk = window.ZOHO;
        if (cancelled || !sdk) return;

        sdk.embeddedApp.on("PageLoad", (data) => {
          if (cancelled) return;
          if (data.Entity && data.Entity !== "Contacts") {
            setError("This messaging widget is configured for Contact records only.");
            setLoading(false);
            return;
          }

          const rawId = Array.isArray(data.EntityId) ? data.EntityId[0] : data.EntityId;
          if (!rawId) {
            setError("Zoho CRM did not provide a Contact record ID.");
            setLoading(false);
            return;
          }

          setContactId(String(rawId));
          setReady(true);
        });

        // Zoho context must be initialized before any CRM.CONFIG/FUNCTIONS API is used.
        await Promise.resolve(sdk.embeddedApp.init());
        if (cancelled) return;

        try {
          const getCurrentUser = sdk.CRM.CONFIG?.getCurrentUser;
          if (getCurrentUser) {
            const userResponse = await getCurrentUser();
            if (!cancelled) setCurrentUser(parseCurrentUser(userResponse));
          }
        } catch {
          // Staff identity is optional; never block the conversation if this lookup fails.
        }

        void sdk.CRM.UI?.Resize?.({ height: "600", width: "1000" });
      } catch (bootstrapError) {
        if (!cancelled) {
          setError(
            bootstrapError instanceof Error
              ? bootstrapError.message
              : "Open this widget from a Zoho CRM Contact record.",
          );
          setLoading(false);
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !contactId) return;
    void fetchHistory(true);
    const timer = window.setInterval(() => void fetchHistory(false), 4000);
    return () => window.clearInterval(timer);
  }, [contactId, fetchHistory, ready]);

  const sendMessage = useCallback(async () => {
    if (!contactId || sending || messagingBlocked) return;
    const body = draft.trim();
    if (!body) return;

    setSending(true);
    setError(null);
    try {
      const payload = await executeProxy<SendPayload>({
        action: "send",
        zohoContactId: contactId,
        body,
        sentByZohoUserId: currentUser?.id,
        sentByName: userDisplayName(currentUser),
      });
      if (!payload.ok) {
        throw new Error(payload.detail || payload.error || "Message could not be sent");
      }
      setDraft("");
      await fetchHistory(false);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Message could not be sent");
    } finally {
      setSending(false);
    }
  }, [contactId, currentUser, draft, fetchHistory, messagingBlocked, sending]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void sendMessage();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const empty = !loading && messages.length === 0 && !error;

  return (
    <main className={styles.shell}>
      <section className={styles.chat} aria-label="MCC contact messaging">
        <header className={styles.header}>
          <div className={styles.avatar} aria-hidden="true">{initials(contact?.name)}</div>
          <div className={styles.identity}>
            <div className={styles.nameRow}>
              <h1>{contact?.name || "Contact messages"}</h1>
              <span className={styles.channel}>SMS</span>
            </div>
            <p>{contact?.phone || (loading ? "Loading phone…" : "No Phone value")}</p>
          </div>
          <div className={styles.connection} title="Conversation refreshes automatically">
            <span className={styles.liveDot} /> Live
          </div>
        </header>

        {messagingBlocked ? (
          <div className={styles.blockedBanner} role="status">
            Messaging is blocked: {activeConversation?.opt_out_status}.
          </div>
        ) : null}

        {error ? (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            {contactId ? <button type="button" onClick={() => void fetchHistory(true)}>Retry</button> : null}
          </div>
        ) : null}

        <div className={styles.messages} aria-live="polite">
          {loading ? (
            <div className={styles.loadingState}><span className={styles.spinner} />Loading conversation…</div>
          ) : null}

          {empty ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon} aria-hidden="true">✦</div>
              <h2>Start the conversation</h2>
              <p>Messages sent here use the Contact&apos;s Phone field and stay attached to this CRM thread.</p>
            </div>
          ) : null}

          {!loading ? messages.map((item) => {
            const outgoing = item.direction === "Outgoing";
            const state = messageState(item.status);
            return (
              <article
                className={`${styles.messageRow} ${outgoing ? styles.outgoingRow : styles.incomingRow}`}
                key={item.id}
              >
                <div className={`${styles.bubble} ${outgoing ? styles.outgoingBubble : styles.incomingBubble}`}>
                  {outgoing && item.sent_by_name ? <div className={styles.sender}>{item.sent_by_name}</div> : null}
                  <div className={styles.body}>{item.body || "(No text)"}</div>
                  <div className={styles.meta}>
                    <span>{formatMessageTime(item.created_at)}</span>
                    {outgoing ? (
                      <span className={state.failed ? styles.failedStatus : styles.deliveryStatus}>{state.label}</span>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          }) : null}
          <div ref={bottomRef} />
        </div>

        <form className={styles.composer} onSubmit={handleSubmit}>
          <textarea
            aria-label="Message"
            disabled={!contact?.phone || messagingBlocked || sending || !ready}
            maxLength={1600}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              messagingBlocked
                ? "Messaging disabled for this contact"
                : contact?.phone
                  ? "Type a message…"
                  : "Add a Phone value to this Contact to send SMS"
            }
            rows={1}
            value={draft}
          />
          <button
            aria-label="Send SMS"
            className={styles.sendButton}
            disabled={!draft.trim() || !contact?.phone || messagingBlocked || sending || !ready}
            type="submit"
          >
            {sending ? <span className={styles.buttonSpinner} /> : (
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M3.4 20.2 21 12 3.4 3.8l.1 6.4L16 12 3.5 13.8l-.1 6.4Z" />
              </svg>
            )}
          </button>
        </form>
        <div className={styles.footerHint}>Enter to send · Shift + Enter for a new line</div>
      </section>
    </main>
  );
}
