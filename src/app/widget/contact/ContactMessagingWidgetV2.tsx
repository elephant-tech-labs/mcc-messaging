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

type MessagingTemplate = {
  id: string;
  name: string;
  body: string;
  category: string | null;
  status: "Active" | "Archived";
};

type HistoryPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  contact?: Contact;
  conversations?: Conversation[];
  messages?: Message[];
  has_more?: boolean;
  next_before?: string | null;
};

type SendPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
};

type TemplatePayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  templates?: MessagingTemplate[];
};

type ScheduledPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
};

const SDK_URL = "https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js";
const PROXY_FUNCTION = "mcc_messaging_widget_proxy";
const POLL_INTERVAL_MS = 4000;
const STICK_TO_BOTTOM_THRESHOLD_PX = 96;

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

function localInputValue(value?: string | null): string {
  const date = value ? new Date(value) : new Date(Date.now() + 15 * 60 * 1000);
  const safe = Number.isNaN(date.getTime()) ? new Date(Date.now() + 15 * 60 * 1000) : date;
  const local = new Date(safe.getTime() - safe.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
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

function contactsEqual(left: Contact | null, right: Contact): boolean {
  return Boolean(
    left &&
      left.id === right.id &&
      left.name === right.name &&
      left.phone === right.phone,
  );
}

function conversationsEqual(left: Conversation[], right: Conversation[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const next = right[index];
    return Boolean(
      next &&
        item.id === next.id &&
        item.status === next.status &&
        item.unread_count === next.unread_count &&
        item.opt_out_status === next.opt_out_status,
    );
  });
}

function messagesEqual(left: Message[], right: Message[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const next = right[index];
    return Boolean(
      next &&
        item.id === next.id &&
        item.direction === next.direction &&
        item.body === next.body &&
        item.status === next.status &&
        item.sent_by_name === next.sent_by_name &&
        item.created_at === next.created_at,
    );
  });
}

function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => {
    const time = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    return time !== 0 ? time : left.id.localeCompare(right.id);
  });
}

function isNearBottom(element: HTMLDivElement | null): boolean {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TO_BOTTOM_THRESHOLD_PX;
}

function scrollMessagePaneToBottom(element: HTMLDivElement | null): void {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
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
  const [templates, setTemplates] = useState<MessagingTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleLocal, setScheduleLocal] = useState(localInputValue());
  const [scheduleTimezone, setScheduleTimezone] = useState("UTC");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const loadingRef = useRef(false);
  const messagesPaneRef = useRef<HTMLDivElement | null>(null);
  const contactDataRef = useRef<Contact | null>(null);
  const conversationsDataRef = useRef<Conversation[]>([]);
  const messagesDataRef = useRef<Message[]>([]);
  const nextBeforeRef = useRef<string | null>(null);
  const firstHistoryLoadRef = useRef(true);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.status === "Active") ?? conversations[0] ?? null,
    [conversations],
  );
  const messagingBlocked = Boolean(
    activeConversation && activeConversation.opt_out_status !== "Active",
  );

  const fetchHistory = useCallback(async (
    showLoading: boolean,
    forceScroll = false,
    kind: "initial" | "poll" = "poll",
  ) => {
    if (!contactId || loadingRef.current) return;
    loadingRef.current = true;
    if (showLoading) setLoading(true);

    try {
      const pane = messagesPaneRef.current;
      const wasNearBottom = isNearBottom(pane);
      const previousMessages = messagesDataRef.current;
      const previousIds = new Set(previousMessages.map((item) => item.id));

      const payload = await executeProxy<HistoryPayload>({
        action: kind === "initial" ? "history" : "historyPoll",
        zohoContactId: contactId,
      });
      if (!payload.ok || (kind === "initial" && !payload.contact)) {
        throw new Error(payload.detail || payload.error || "Unable to load conversation");
      }

      if (payload.contact && !contactsEqual(contactDataRef.current, payload.contact)) {
        contactDataRef.current = payload.contact;
        setContact(payload.contact);
      }

      const nextConversations = payload.conversations ?? [];
      if (!conversationsEqual(conversationsDataRef.current, nextConversations)) {
        conversationsDataRef.current = nextConversations;
        setConversations(nextConversations);
      }

      const incomingMessages = payload.messages ?? [];
      const hasNewMessage = incomingMessages.some((item) => !previousIds.has(item.id));
      const nextMessages = kind === "initial"
        ? incomingMessages
        : mergeMessages(previousMessages, incomingMessages);

      if (!messagesEqual(previousMessages, nextMessages)) {
        messagesDataRef.current = nextMessages;
        setMessages(nextMessages);
      }

      if (kind === "initial") {
        setHasMore(Boolean(payload.has_more));
        nextBeforeRef.current = payload.next_before ?? null;
      }

      setError(null);
      const firstLoad = firstHistoryLoadRef.current;
      firstHistoryLoadRef.current = false;

      if (forceScroll || firstLoad || (hasNewMessage && wasNearBottom)) {
        requestAnimationFrame(() => scrollMessagePaneToBottom(messagesPaneRef.current));
      }
    } catch (fetchError) {
      if (showLoading || messagesDataRef.current.length === 0) {
        setError(fetchError instanceof Error ? fetchError.message : "Unable to load conversation");
      }
    } finally {
      loadingRef.current = false;
      if (showLoading) setLoading(false);
    }
  }, [contactId]);

  const loadEarlier = useCallback(async () => {
    if (!contactId || loadingOlder || !hasMore || !nextBeforeRef.current) return;
    const pane = messagesPaneRef.current;
    const oldHeight = pane?.scrollHeight ?? 0;
    const oldTop = pane?.scrollTop ?? 0;

    setLoadingOlder(true);
    try {
      const payload = await executeProxy<HistoryPayload>({
        action: "historyOlder",
        zohoContactId: contactId,
        before: nextBeforeRef.current,
      });
      if (!payload.ok) {
        throw new Error(payload.detail || payload.error || "Unable to load earlier messages");
      }

      const nextMessages = mergeMessages(messagesDataRef.current, payload.messages ?? []);
      messagesDataRef.current = nextMessages;
      setMessages(nextMessages);
      setHasMore(Boolean(payload.has_more));
      nextBeforeRef.current = payload.next_before ?? null;
      setError(null);

      requestAnimationFrame(() => {
        const currentPane = messagesPaneRef.current;
        if (!currentPane) return;
        currentPane.scrollTop = oldTop + (currentPane.scrollHeight - oldHeight);
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load earlier messages");
    } finally {
      setLoadingOlder(false);
    }
  }, [contactId, hasMore, loadingOlder]);

  const loadTemplates = useCallback(async () => {
    if (!ready) return;
    try {
      const payload = await executeProxy<TemplatePayload>({ action: "templateList", includeArchived: false });
      if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to load templates");
      setTemplates(payload.templates ?? []);
    } catch {
      // Templates are a productivity enhancement; do not block normal messaging if unavailable.
      setTemplates([]);
    }
  }, [ready]);

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

        if (!cancelled) {
          setScheduleTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
        }
        void sdk.CRM.UI?.Resize?.({ height: "680", width: "1000" });
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

    firstHistoryLoadRef.current = true;
    messagesDataRef.current = [];
    nextBeforeRef.current = null;
    setMessages([]);
    setHasMore(false);
    void fetchHistory(true, false, "initial");
    void loadTemplates();

    const poll = () => {
      if (document.visibilityState === "visible") {
        void fetchHistory(false, false, "poll");
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchHistory(false, false, "poll");
      }
    };

    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [contactId, fetchHistory, loadTemplates, ready]);

  const sendMessage = useCallback(async () => {
    if (!contactId || sending || messagingBlocked) return;
    const body = draft.trim();
    if (!body) return;

    setSending(true);
    setError(null);
    setNotice(null);
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
      setSelectedTemplateId("");
      await fetchHistory(false, true, "poll");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Message could not be sent");
    } finally {
      setSending(false);
    }
  }, [contactId, currentUser, draft, fetchHistory, messagingBlocked, sending]);

  function chooseTemplate(templateId: string) {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const template = templates.find((item) => item.id === templateId);
    if (template) setDraft(template.body);
  }

  function openSchedule() {
    if (!draft.trim() || !contact?.phone || messagingBlocked) return;
    setError(null);
    setNotice(null);
    setScheduleLocal(localInputValue());
    setScheduleTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setScheduleOpen(true);
  }

  async function scheduleMessage(event: FormEvent) {
    event.preventDefault();
    if (!contactId || !draft.trim() || !scheduleLocal || scheduling) return;
    const scheduledDate = new Date(scheduleLocal);
    if (Number.isNaN(scheduledDate.getTime())) {
      setError("Choose a valid date and time.");
      return;
    }

    setScheduling(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await executeProxy<ScheduledPayload>({
        action: "scheduledCreate",
        zohoContactId: contactId,
        body: draft.trim(),
        templateId: selectedTemplateId || undefined,
        scheduledFor: scheduledDate.toISOString(),
        timezone: scheduleTimezone,
        sentByZohoUserId: currentUser?.id,
        sentByName: userDisplayName(currentUser),
      });
      if (!payload.ok) throw new Error(payload.detail || payload.error || "Message could not be scheduled");
      setScheduleOpen(false);
      setDraft("");
      setSelectedTemplateId("");
      setNotice(`SMS scheduled for ${formatMessageTime(scheduledDate.toISOString())}.`);
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : "Message could not be scheduled");
    } finally {
      setScheduling(false);
    }
  }

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

        {notice ? <div className={styles.noticeBanner} role="status">{notice}</div> : null}

        {error ? (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            {contactId ? <button type="button" onClick={() => void fetchHistory(true, false, "initial")}>Retry</button> : null}
          </div>
        ) : null}

        <div ref={messagesPaneRef} className={styles.messages} aria-live="polite">
          {loading ? (
            <div className={styles.loadingState}><span className={styles.spinner} />Loading conversation…</div>
          ) : null}

          {!loading && messages.length > 0 && hasMore ? (
            <div className={styles.loadEarlierWrap}>
              <button type="button" onClick={() => void loadEarlier()} disabled={loadingOlder}>
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
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
        </div>

        <div className={styles.composerTools}>
          <select
            aria-label="SMS template"
            disabled={!contact?.phone || messagingBlocked || sending || !ready}
            onChange={(event) => chooseTemplate(event.target.value)}
            value={selectedTemplateId}
          >
            <option value="">{templates.length > 0 ? "Insert template…" : "No saved templates"}</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </select>
          <button
            className={styles.scheduleButton}
            disabled={!draft.trim() || !contact?.phone || messagingBlocked || sending || scheduling || !ready}
            onClick={openSchedule}
            type="button"
          >
            Schedule
          </button>
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
            aria-label="Send SMS now"
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
        <div className={styles.footerHint}>Enter to send now · Shift + Enter for a new line</div>
      </section>

      {scheduleOpen ? (
        <div className={styles.scheduleBackdrop} role="presentation">
          <section className={styles.scheduleDialog} role="dialog" aria-modal="true" aria-label="Schedule SMS">
            <div className={styles.scheduleHeader}>
              <div>
                <strong>Schedule SMS</strong>
                <span>{contact?.name || "Contact"}</span>
              </div>
              <button onClick={() => setScheduleOpen(false)} type="button">×</button>
            </div>
            <form onSubmit={scheduleMessage}>
              <label>
                <span>Date & time</span>
                <input min={localInputValue()} onChange={(event) => setScheduleLocal(event.target.value)} type="datetime-local" value={scheduleLocal} />
              </label>
              <label>
                <span>Timezone</span>
                <input onChange={(event) => setScheduleTimezone(event.target.value)} value={scheduleTimezone} />
              </label>
              <div className={styles.schedulePreview}>{draft}</div>
              <p>The message is frozen when scheduled. The Contact&apos;s current Phone and opt-out status are checked again at send time.</p>
              <div className={styles.scheduleActions}>
                <button className={styles.cancelScheduleButton} onClick={() => setScheduleOpen(false)} type="button">Cancel</button>
                <button className={styles.confirmScheduleButton} disabled={scheduling || !scheduleLocal} type="submit">{scheduling ? "Scheduling…" : "Schedule SMS"}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
