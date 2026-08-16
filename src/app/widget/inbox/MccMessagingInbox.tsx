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
import styles from "./messaging-inbox.module.css";

type ZohoUser = {
  id?: string;
  full_name?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
};

type ZohoSdk = {
  embeddedApp: {
    on: (event: string, handler: (data: unknown) => void) => void;
    init: () => Promise<unknown> | unknown;
  };
  CRM: {
    CONFIG?: {
      getCurrentUser?: () => Promise<unknown>;
    };
    FUNCTIONS: {
      execute: (name: string, request: { arguments: string }) => Promise<unknown>;
    };
  };
};

declare global {
  interface Window {
    ZOHO?: ZohoSdk;
  }
}

type ContactView = {
  id: string;
  name: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  status: string | null;
  owner: string | null;
  crm_url: string;
};

type InboxConversation = {
  id: string;
  status: string;
  customer_phone: string;
  last_message: string | null;
  last_message_at: string | null;
  last_message_direction: string | null;
  last_message_status: string | null;
  unread_count: number;
  opt_out_status: string;
  zoho_contact_id: string | null;
  contact: ContactView | null;
};

type Message = {
  id: string;
  direction: string;
  body: string | null;
  status: string;
  sent_by_name: string | null;
  created_at: string;
  error_code?: string | null;
  error_message?: string | null;
};

type Conversation = {
  id: string;
  status: string;
  customer_phone: string;
  opt_out_status: string;
  unread_count: number;
};

type InboxPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  unread_count?: number;
  conversations?: InboxConversation[];
};

type ConversationPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  conversation?: Conversation;
  contact?: ContactView | null;
  messages?: Message[];
};

type ContactSearchPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  contacts?: ContactView[];
};

type HistoryPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  contact?: ContactView;
  conversations?: Array<{ id: string; status: string; last_message_at?: string | null }>;
};

type SendPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  conversationId?: string;
};

const SDK_URL = "https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js";
const PROXY_FUNCTION = "mcc_messaging_widget_proxy";

function loadZohoSdk(): Promise<void> {
  if (window.ZOHO) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Zoho widget SDK failed to load")), { once: true });
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

function parseCurrentUser(data: unknown): ZohoUser | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const users = record.users;
  if (Array.isArray(users) && users[0] && typeof users[0] === "object") return users[0] as ZohoUser;
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
  const parts = (name ?? "Contact").split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("") || "C";
}

function shortTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function statusLabel(status: string): string {
  const value = status.toLowerCase();
  if (["delivered", "read"].includes(value)) return "✓✓";
  if (["sent", "sending", "queued", "accepted"].includes(value)) return "✓";
  if (["failed", "undelivered", "canceled"].includes(value)) return "Failed";
  return status;
}

export default function MccMessagingInbox() {
  const [ready, setReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<ZohoUser | null>(null);
  const [mode, setMode] = useState<"recent" | "unread">("recent");
  const [inbox, setInbox] = useState<InboxConversation[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [contact, setContact] = useState<ContactView | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [listSearch, setListSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSmsOpen, setNewSmsOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactView[]>([]);
  const [searchingContacts, setSearchingContacts] = useState(false);
  const [composeContact, setComposeContact] = useState<ContactView | null>(null);
  const messagePaneRef = useRef<HTMLDivElement | null>(null);
  const previousMessageSignature = useRef("");
  const initialContactHandled = useRef(false);

  const filteredInbox = useMemo(() => {
    const query = listSearch.trim().toLowerCase();
    if (!query) return inbox;
    return inbox.filter((item) => {
      const haystack = [
        item.contact?.name,
        item.contact?.phone,
        item.customer_phone,
        item.last_message,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [inbox, listSearch]);

  const activeContact = composeContact ?? contact;
  const messagingBlocked = Boolean(conversation && conversation.opt_out_status !== "Active");

  const scrollThreadToBottom = useCallback(() => {
    const pane = messagePaneRef.current;
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
  }, []);

  const refreshInbox = useCallback(async (nextMode: "recent" | "unread", showLoading = false) => {
    if (!ready) return;
    if (showLoading) setLoading(true);
    try {
      const payload = await executeProxy<InboxPayload>({ action: "inbox", mode: nextMode });
      if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to load MCC Messages");
      setInbox(payload.conversations ?? []);
      setUnreadCount(payload.unread_count ?? 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load MCC Messages");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [ready]);

  const openConversation = useCallback(async (conversationId: string, showLoading = true) => {
    if (!ready) return;
    const pane = messagePaneRef.current;
    const wasNearBottom = !pane || pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
    if (showLoading) setThreadLoading(true);
    try {
      const payload = await executeProxy<ConversationPayload>({
        action: "conversation",
        conversationId,
      });
      if (!payload.ok || !payload.conversation) {
        throw new Error(payload.detail || payload.error || "Unable to load conversation");
      }
      const nextMessages = payload.messages ?? [];
      const signature = nextMessages.map((item) => `${item.id}:${item.status}`).join("|");
      const changed = signature !== previousMessageSignature.current;
      previousMessageSignature.current = signature;
      setSelectedId(conversationId);
      setConversation(payload.conversation);
      setContact(payload.contact ?? null);
      setComposeContact(null);
      if (changed) setMessages(nextMessages);
      setError(null);
      if (showLoading || (changed && wasNearBottom)) {
        requestAnimationFrame(scrollThreadToBottom);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load conversation");
    } finally {
      if (showLoading) setThreadLoading(false);
    }
  }, [ready, scrollThreadToBottom]);

  const openContactContext = useCallback(async (contactId: string) => {
    try {
      const payload = await executeProxy<HistoryPayload>({ action: "history", zohoContactId: contactId });
      if (!payload.ok || !payload.contact) return;
      const latest = (payload.conversations ?? []).sort((a, b) => {
        const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
        const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
        return bt - at;
      })[0];
      if (latest?.id) {
        await openConversation(latest.id, true);
      } else {
        setSelectedId(null);
        setConversation(null);
        setMessages([]);
        setContact(null);
        setComposeContact(payload.contact);
        setDraft("");
      }
    } catch {
      // The inbox itself remains usable if contextual pre-selection fails.
    }
  }, [openConversation]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        await loadZohoSdk();
        const sdk = window.ZOHO;
        if (!sdk || cancelled) return;
        sdk.embeddedApp.on("PageLoad", () => undefined);
        await Promise.resolve(sdk.embeddedApp.init());
        if (cancelled) return;
        try {
          const getCurrentUser = sdk.CRM.CONFIG?.getCurrentUser;
          if (getCurrentUser) setCurrentUser(parseCurrentUser(await getCurrentUser()));
        } catch {
          // Staff identity is optional for sending.
        }
        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to initialize MCC Messages in Zoho CRM");
        setLoading(false);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refreshInbox(mode, true);
  }, [mode, ready, refreshInbox]);

  useEffect(() => {
    if (!ready || initialContactHandled.current) return;
    initialContactHandled.current = true;
    const contactId = new URLSearchParams(window.location.search).get("contactId");
    if (contactId && /^\d{10,25}$/.test(contactId)) void openContactContext(contactId);
  }, [openContactContext, ready]);

  useEffect(() => {
    if (!ready || selectedId || composeContact || inbox.length === 0) return;
    void openConversation(inbox[0].id, true);
  }, [composeContact, inbox, openConversation, ready, selectedId]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshInbox(mode, false);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [mode, ready, refreshInbox]);

  useEffect(() => {
    if (!ready || !selectedId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void openConversation(selectedId, false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [openConversation, ready, selectedId]);

  useEffect(() => {
    if (!newSmsOpen || contactQuery.trim().length < 2) {
      setContactResults([]);
      setSearchingContacts(false);
      return;
    }
    const timer = window.setTimeout(async () => {
      setSearchingContacts(true);
      try {
        const payload = await executeProxy<ContactSearchPayload>({
          action: "searchContacts",
          query: contactQuery,
        });
        setContactResults(payload.contacts ?? []);
      } catch {
        setContactResults([]);
      } finally {
        setSearchingContacts(false);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [contactQuery, newSmsOpen]);

  const sendMessage = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending || messagingBlocked || !activeContact) return;
    setSending(true);
    setError(null);
    try {
      const payload = await executeProxy<SendPayload>({
        action: "send",
        ...(selectedId ? { conversationId: selectedId } : { zohoContactId: activeContact.id }),
        body,
        sentByZohoUserId: currentUser?.id,
        sentByName: userDisplayName(currentUser),
      });
      if (!payload.ok || !payload.conversationId) {
        throw new Error(payload.detail || payload.error || "Message could not be sent");
      }
      setDraft("");
      setSelectedId(payload.conversationId);
      setComposeContact(null);
      await Promise.all([
        openConversation(payload.conversationId, false),
        refreshInbox(mode, false),
      ]);
      requestAnimationFrame(scrollThreadToBottom);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message could not be sent");
    } finally {
      setSending(false);
    }
  }, [activeContact, currentUser, draft, messagingBlocked, mode, openConversation, refreshInbox, scrollThreadToBottom, selectedId, sending]);

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

  function startNewSms(target: ContactView) {
    setNewSmsOpen(false);
    setContactQuery("");
    setContactResults([]);
    setSelectedId(null);
    setConversation(null);
    setMessages([]);
    setContact(null);
    setComposeContact(target);
    setDraft("");
  }

  return (
    <main className={styles.app}>
      <aside className={styles.sidebar}>
        <div className={styles.brandRow}>
          <div>
            <h1>MCC Messages</h1>
            <p>Shared SMS inbox</p>
          </div>
          <button className={styles.newButton} type="button" onClick={() => setNewSmsOpen(true)}>+ New SMS</button>
        </div>

        <div className={styles.tabs}>
          <button className={mode === "recent" ? styles.activeTab : ""} onClick={() => setMode("recent")} type="button">Recent</button>
          <button className={mode === "unread" ? styles.activeTab : ""} onClick={() => setMode("unread")} type="button">Unread <span>{unreadCount}</span></button>
        </div>

        <div className={styles.searchBox}>
          <span>⌕</span>
          <input value={listSearch} onChange={(event) => setListSearch(event.target.value)} placeholder="Search conversations" />
        </div>

        <div className={styles.conversationList}>
          {loading ? <div className={styles.listState}>Loading conversations…</div> : null}
          {!loading && filteredInbox.length === 0 ? <div className={styles.listState}>No conversations here yet.</div> : null}
          {filteredInbox.map((item) => {
            const name = item.contact?.name || item.customer_phone;
            return (
              <button
                className={`${styles.conversationItem} ${selectedId === item.id ? styles.selectedConversation : ""}`}
                key={item.id}
                onClick={() => void openConversation(item.id, true)}
                type="button"
              >
                <div className={styles.listAvatar}>{initials(name)}</div>
                <div className={styles.listCopy}>
                  <div className={styles.listTopline}>
                    <strong>{name}</strong>
                    <time>{shortTime(item.last_message_at)}</time>
                  </div>
                  <div className={styles.listPreview}>
                    <span>{item.last_message_direction === "Outgoing" ? "You: " : ""}{item.last_message || "No message"}</span>
                    {item.unread_count > 0 ? <b>{item.unread_count}</b> : null}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section className={styles.chatColumn}>
        {activeContact ? (
          <>
            <header className={styles.chatHeader}>
              <div className={styles.headerIdentity}>
                <div className={styles.headerAvatar}>{initials(activeContact.name)}</div>
                <div>
                  <h2>{activeContact.name || "Contact"}</h2>
                  <p>{activeContact.phone || "No Phone value"} <span>SMS</span></p>
                </div>
              </div>
              <div className={styles.liveState}><i /> Live</div>
            </header>

            {messagingBlocked ? <div className={styles.blocked}>Messaging blocked: {conversation?.opt_out_status}</div> : null}
            {error ? <div className={styles.errorBanner}>{error}</div> : null}

            <div className={styles.messagePane} ref={messagePaneRef}>
              {threadLoading ? <div className={styles.threadState}>Loading conversation…</div> : null}
              {!threadLoading && messages.length === 0 ? (
                <div className={styles.emptyThread}>
                  <div>✦</div>
                  <h3>Start the conversation</h3>
                  <p>Send an SMS to {activeContact.name || activeContact.phone}.</p>
                </div>
              ) : null}
              {!threadLoading && messages.map((item) => {
                const outgoing = item.direction === "Outgoing";
                const failed = ["failed", "undelivered", "canceled"].includes(item.status.toLowerCase());
                return (
                  <article className={`${styles.messageRow} ${outgoing ? styles.outgoingRow : styles.incomingRow}`} key={item.id}>
                    <div className={`${styles.bubble} ${outgoing ? styles.outgoingBubble : styles.incomingBubble}`}>
                      {outgoing && item.sent_by_name ? <div className={styles.sender}>{item.sent_by_name}</div> : null}
                      <div className={styles.messageBody}>{item.body || "(No text)"}</div>
                      <div className={styles.messageMeta}>
                        <span>{messageTime(item.created_at)}</span>
                        {outgoing ? <span className={failed ? styles.failed : ""}>{statusLabel(item.status)}</span> : null}
                      </div>
                      {failed && item.error_message ? <div className={styles.failureDetail}>{item.error_message}</div> : null}
                    </div>
                  </article>
                );
              })}
            </div>

            <form className={styles.composer} onSubmit={handleSubmit}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={messagingBlocked ? "Messaging disabled for this contact" : "Type a message…"}
                disabled={!activeContact.phone || messagingBlocked || sending}
                maxLength={1600}
                rows={1}
              />
              <button type="submit" disabled={!draft.trim() || !activeContact.phone || messagingBlocked || sending}>{sending ? "…" : "➤"}</button>
            </form>
            <div className={styles.composerHint}>Enter to send · Shift + Enter for a new line</div>
          </>
        ) : (
          <div className={styles.noSelection}>
            <div className={styles.noSelectionIcon}>✉</div>
            <h2>MCC Messages</h2>
            <p>Select a conversation or start a new SMS.</p>
            <button type="button" onClick={() => setNewSmsOpen(true)}>Start New SMS</button>
          </div>
        )}
      </section>

      <aside className={styles.contextPanel}>
        {activeContact ? (
          <>
            <div className={styles.contextAvatar}>{initials(activeContact.name)}</div>
            <h3>{activeContact.name || "Contact"}</h3>
            <p className={styles.contextSub}>{activeContact.status || "CRM Contact"}</p>
            <div className={styles.contextDetails}>
              <div><span>Phone</span><strong>{activeContact.phone || "—"}</strong></div>
              <div><span>Email</span><strong>{activeContact.email || "—"}</strong></div>
              <div><span>Owner</span><strong>{activeContact.owner || "—"}</strong></div>
              <div><span>SMS status</span><strong>{conversation?.opt_out_status || "Active"}</strong></div>
            </div>
            <a className={styles.crmLink} href={activeContact.crm_url} target="_top" rel="noreferrer">Open CRM Contact ↗</a>
          </>
        ) : <div className={styles.contextEmpty}>Contact details will appear here.</div>}
      </aside>

      {newSmsOpen ? (
        <div className={styles.modalBackdrop} onMouseDown={() => setNewSmsOpen(false)}>
          <section className={styles.modal} onMouseDown={(event) => event.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div><h2>New SMS</h2><p>Search CRM Contacts using the canonical Phone field.</p></div>
              <button type="button" onClick={() => setNewSmsOpen(false)}>×</button>
            </div>
            <input
              autoFocus
              className={styles.contactSearch}
              value={contactQuery}
              onChange={(event) => setContactQuery(event.target.value)}
              placeholder="Search name, company, email…"
            />
            <div className={styles.contactResults}>
              {searchingContacts ? <div className={styles.listState}>Searching CRM…</div> : null}
              {!searchingContacts && contactQuery.trim().length >= 2 && contactResults.length === 0 ? <div className={styles.listState}>No SMS-eligible Contacts found.</div> : null}
              {contactResults.map((item) => (
                <button key={item.id} type="button" onClick={() => startNewSms(item)}>
                  <div className={styles.listAvatar}>{initials(item.name)}</div>
                  <div><strong>{item.name || "Contact"}</strong><span>{item.phone}</span></div>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
