"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  browserTimeZone,
  instantToZonedInput,
  zonedInputToUtcIso,
} from "@/lib/messaging/timezone";
import styles from "./sms-productivity.module.css";

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
    CONFIG?: { getCurrentUser?: () => Promise<unknown> };
    FUNCTIONS: {
      execute: (name: string, request: { arguments: string }) => Promise<unknown>;
    };
  };
};

type Template = {
  id: string;
  name: string;
  body: string;
  category: string | null;
  status: "Active" | "Archived";
  created_by_name: string | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
};

type Contact = {
  id: string;
  name: string | null;
  phone: string | null;
  email?: string | null;
  crm_url?: string;
};

type ScheduledSms = {
  id: string;
  zoho_contact_id: string;
  template_id: string | null;
  template_name_snapshot: string | null;
  message_body: string;
  phone_at_scheduling: string | null;
  phone_sent_to: string | null;
  scheduled_for: string;
  timezone: string;
  status: "Scheduled" | "Processing" | "Sent" | "Failed" | "Canceled";
  created_by_name: string | null;
  updated_by_name: string | null;
  twilio_message_sid: string | null;
  delivery_status: string | null;
  sent_at: string | null;
  canceled_at: string | null;
  error_message: string | null;
  created_at: string;
  contact: Contact | null;
};

type ProxyPayload<T> = {
  ok?: boolean;
  error?: string;
  detail?: string;
} & T;

const SDK_URL = "https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js";
const PROXY_FUNCTION = "mcc_messaging_widget_proxy";
const MERGE_FIELDS = ["First_Name", "Last_Name", "Full_Name"] as const;

function getZohoSdk(): ZohoSdk | undefined {
  return (window as Window & { ZOHO?: ZohoSdk }).ZOHO;
}

function loadZohoSdk(): Promise<void> {
  if (getZohoSdk()) return Promise.resolve();
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
  const text = value.trim();
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function unwrapFunctionOutput(value: unknown): unknown {
  let current = value;
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

async function executeProxy<T>(args: Record<string, unknown>): Promise<ProxyPayload<T>> {
  const sdk = getZohoSdk();
  if (!sdk) throw new Error("Zoho CRM widget context is unavailable");
  const response = await sdk.CRM.FUNCTIONS.execute(PROXY_FUNCTION, {
    arguments: JSON.stringify({ payload: JSON.stringify(args) }),
  });
  const output = unwrapFunctionOutput(response);
  if (!output || typeof output !== "object") throw new Error("Messaging proxy returned an invalid response");
  return output as ProxyPayload<T>;
}

function parseCurrentUser(data: unknown): ZohoUser | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.users) && record.users[0] && typeof record.users[0] === "object") {
    return record.users[0] as ZohoUser;
  }
  return record as ZohoUser;
}

function displayName(user: ZohoUser | null): string | undefined {
  if (!user) return undefined;
  if (user.full_name?.trim()) return user.full_name.trim();
  if (user.name?.trim()) return user.name.trim();
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function formatDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function deliveryLabel(value: string | null): string {
  if (!value) return "";
  const normalized = value.toLowerCase();
  if (["delivered", "read"].includes(normalized)) return "Delivered";
  if (["failed", "undelivered", "canceled"].includes(normalized)) return "Failed";
  if (["queued", "accepted", "sending", "sent"].includes(normalized)) return "Sent";
  return value;
}

export default function SmsProductivityWorkspace() {
  const [ready, setReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<ZohoUser | null>(null);
  const [tab, setTab] = useState<"templates" | "scheduled">("templates");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateSearch, setTemplateSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateCategory, setTemplateCategory] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [scheduledMode, setScheduledMode] = useState<"upcoming" | "history">("upcoming");
  const [scheduled, setScheduled] = useState<ScheduledSms[]>([]);
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [editingScheduled, setEditingScheduled] = useState<ScheduledSms | null>(null);
  const [scheduleContact, setScheduleContact] = useState<Contact | null>(null);
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<Contact[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [scheduleBody, setScheduleBody] = useState("");
  const [scheduleLocal, setScheduleLocal] = useState(() => instantToZonedInput());
  const [timezone, setTimezone] = useState("UTC");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchingContacts, setSearchingContacts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const userName = displayName(currentUser);
  const activeTemplates = useMemo(() => templates.filter((item) => item.status === "Active"), [templates]);
  const filteredTemplates = useMemo(() => {
    const query = templateSearch.trim().toLowerCase();
    return templates.filter((item) => {
      if (!showArchived && item.status !== "Active") return false;
      if (!query) return true;
      return [item.name, item.category, item.body].filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [showArchived, templateSearch, templates]);

  const loadTemplates = useCallback(async () => {
    if (!ready) return;
    const payload = await executeProxy<{ templates?: Template[] }>({ action: "templateList", includeArchived: true });
    if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to load SMS templates");
    setTemplates(payload.templates ?? []);
  }, [ready]);

  const loadScheduled = useCallback(async () => {
    if (!ready) return;
    const payload = await executeProxy<{ scheduled?: ScheduledSms[] }>({
      action: "scheduledList",
      scheduledMode,
    });
    if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to load scheduled SMS");
    setScheduled(payload.scheduled ?? []);
  }, [ready, scheduledMode]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        await loadZohoSdk();
        const sdk = getZohoSdk();
        if (!sdk || cancelled) return;
        sdk.embeddedApp.on("PageLoad", () => {
          if (!cancelled) setReady(true);
        });
        await Promise.resolve(sdk.embeddedApp.init());
        try {
          const getCurrentUser = sdk.CRM.CONFIG?.getCurrentUser;
          if (getCurrentUser) {
            const response = await getCurrentUser();
            if (!cancelled) setCurrentUser(parseCurrentUser(response));
          }
        } catch {
          // User audit metadata is optional.
        }
        if (!cancelled) {
          setTimezone(browserTimeZone());
          setReady(true);
        }
      } catch (bootstrapError) {
        if (!cancelled) setError(bootstrapError instanceof Error ? bootstrapError.message : "Unable to initialize Zoho widget");
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([loadTemplates(), loadScheduled()])
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load SMS tools");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadScheduled, loadTemplates, ready]);

  useEffect(() => {
    if (!ready || tab !== "scheduled") return;
    const timer = window.setInterval(() => void loadScheduled().catch(() => undefined), 30_000);
    return () => window.clearInterval(timer);
  }, [loadScheduled, ready, tab]);

  useEffect(() => {
    if (!ready || contactQuery.trim().length < 2 || editingScheduled) {
      setContactResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      setSearchingContacts(true);
      try {
        const payload = await executeProxy<{ contacts?: Contact[] }>({ action: "searchContacts", query: contactQuery.trim() });
        if (!payload.ok) throw new Error(payload.detail || payload.error || "Contact search failed");
        setContactResults(payload.contacts ?? []);
      } catch (searchError) {
        setError(searchError instanceof Error ? searchError.message : "Contact search failed");
      } finally {
        setSearchingContacts(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [contactQuery, editingScheduled, ready]);

  function resetMessages() {
    setError(null);
    setNotice(null);
  }

  function openNewTemplate() {
    resetMessages();
    setEditingTemplate(null);
    setTemplateName("");
    setTemplateCategory("");
    setTemplateBody("");
    setTemplateEditorOpen(true);
  }

  function openEditTemplate(template: Template) {
    resetMessages();
    setEditingTemplate(template);
    setTemplateName(template.name);
    setTemplateCategory(template.category ?? "");
    setTemplateBody(template.body);
    setTemplateEditorOpen(true);
  }

  function insertTemplateMergeField(field: (typeof MERGE_FIELDS)[number]) {
    const token = `{{${field}}}`;
    setTemplateBody((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${token}`);
  }

  async function saveTemplate(event: FormEvent) {
    event.preventDefault();
    if (!templateName.trim() || !templateBody.trim() || saving) return;
    setSaving(true);
    resetMessages();
    try {
      const payload = await executeProxy<{ template?: Template }>({
        action: editingTemplate ? "templateUpdate" : "templateCreate",
        templateId: editingTemplate?.id,
        templateName,
        templateCategory,
        templateBody,
        sentByZohoUserId: currentUser?.id,
        sentByName: userName,
      });
      if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to save SMS template");
      await loadTemplates();
      setTemplateEditorOpen(false);
      setNotice(editingTemplate ? "Template updated." : "Template created.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save SMS template");
    } finally {
      setSaving(false);
    }
  }

  async function templateAction(template: Template, action: "templateArchive" | "templateRestore" | "templateDuplicate") {
    setSaving(true);
    resetMessages();
    try {
      const payload = await executeProxy<{ template?: Template }>({
        action,
        templateId: template.id,
        sentByZohoUserId: currentUser?.id,
        sentByName: userName,
      });
      if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to update template");
      await loadTemplates();
      setNotice(action === "templateDuplicate" ? "Template duplicated." : action === "templateArchive" ? "Template archived." : "Template restored.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update template");
    } finally {
      setSaving(false);
    }
  }

  function openNewSchedule() {
    resetMessages();
    setEditingScheduled(null);
    setScheduleContact(null);
    setContactQuery("");
    setContactResults([]);
    setSelectedTemplateId("");
    setScheduleBody("");
    const currentTimezone = browserTimeZone();
    setScheduleLocal(instantToZonedInput(Date.now() + 15 * 60 * 1000, currentTimezone));
    setTimezone(currentTimezone);
    setScheduleEditorOpen(true);
  }

  function openEditSchedule(item: ScheduledSms) {
    resetMessages();
    setEditingScheduled(item);
    setScheduleContact(item.contact ?? { id: item.zoho_contact_id, name: null, phone: item.phone_at_scheduling });
    setContactQuery("");
    setContactResults([]);
    setSelectedTemplateId(item.template_id ?? "");
    setScheduleBody(item.message_body);
    setScheduleLocal(instantToZonedInput(item.scheduled_for, item.timezone || "UTC"));
    setTimezone(item.timezone || "UTC");
    setScheduleEditorOpen(true);
  }

  function chooseTemplateForSchedule(templateId: string) {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const template = activeTemplates.find((item) => item.id === templateId);
    if (template) setScheduleBody(template.body);
  }

  function insertScheduleMergeField(field: (typeof MERGE_FIELDS)[number]) {
    const token = `{{${field}}}`;
    setScheduleBody((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${token}`);
  }

  async function saveScheduled(event: FormEvent) {
    event.preventDefault();
    if (!scheduleContact || !scheduleBody.trim() || !scheduleLocal || saving) return;
    setSaving(true);
    resetMessages();
    try {
      const scheduledFor = zonedInputToUtcIso(scheduleLocal, timezone);
      const payload = await executeProxy<{ scheduled?: ScheduledSms }>({
        action: editingScheduled ? "scheduledUpdate" : "scheduledCreate",
        scheduledId: editingScheduled?.id,
        zohoContactId: scheduleContact.id,
        body: scheduleBody,
        templateId: selectedTemplateId || undefined,
        scheduledFor,
        timezone,
        sentByZohoUserId: currentUser?.id,
        sentByName: userName,
      });
      if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to schedule SMS");
      await loadScheduled();
      setScheduleEditorOpen(false);
      setNotice(editingScheduled ? "Scheduled SMS updated." : "SMS scheduled.");
    } catch (scheduleError) {
      setError(scheduleError instanceof Error ? scheduleError.message : "Unable to schedule SMS");
    } finally {
      setSaving(false);
    }
  }

  async function cancelSchedule(item: ScheduledSms) {
    setSaving(true);
    resetMessages();
    try {
      const payload = await executeProxy<{ scheduled?: ScheduledSms }>({
        action: "scheduledCancel",
        scheduledId: item.id,
        sentByZohoUserId: currentUser?.id,
        sentByName: userName,
      });
      if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to cancel scheduled SMS");
      await loadScheduled();
      setNotice("Scheduled SMS canceled.");
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Unable to cancel scheduled SMS");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>MCC MESSAGING</div>
          <h1>SMS Tools</h1>
          <p>Create reusable SMS templates and manage one-time scheduled messages.</p>
        </div>
        <div className={styles.headerActions}>
          {tab === "templates" ? (
            <button className={styles.primaryButton} onClick={openNewTemplate} type="button">+ New Template</button>
          ) : (
            <button className={styles.primaryButton} onClick={openNewSchedule} type="button">+ Schedule SMS</button>
          )}
        </div>
      </header>

      <nav className={styles.tabs} aria-label="SMS tools">
        <button className={tab === "templates" ? styles.activeTab : ""} onClick={() => setTab("templates")} type="button">Templates</button>
        <button className={tab === "scheduled" ? styles.activeTab : ""} onClick={() => setTab("scheduled")} type="button">Scheduled</button>
      </nav>

      {error ? <div className={styles.errorBanner}>{error}</div> : null}
      {notice ? <div className={styles.noticeBanner}>{notice}</div> : null}

      {loading ? <div className={styles.loading}>Loading SMS tools…</div> : null}

      {!loading && tab === "templates" ? (
        <section className={styles.panel}>
          <div className={styles.toolbar}>
            <input
              className={styles.searchInput}
              onChange={(event) => setTemplateSearch(event.target.value)}
              placeholder="Search templates…"
              value={templateSearch}
            />
            <label className={styles.checkboxLabel}>
              <input checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} type="checkbox" />
              Show archived
            </label>
          </div>

          {filteredTemplates.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>✦</div>
              <h2>No SMS templates yet</h2>
              <p>Create the first reusable message. Nothing is hardcoded into the system.</p>
              <button className={styles.primaryButton} onClick={openNewTemplate} type="button">Create Template</button>
            </div>
          ) : (
            <div className={styles.templateGrid}>
              {filteredTemplates.map((template) => (
                <article className={styles.templateCard} key={template.id}>
                  <div className={styles.cardTop}>
                    <div>
                      <h2>{template.name}</h2>
                      <div className={styles.metaRow}>
                        {template.category ? <span className={styles.category}>{template.category}</span> : null}
                        <span className={template.status === "Active" ? styles.activePill : styles.archivedPill}>{template.status}</span>
                      </div>
                    </div>
                  </div>
                  <p className={styles.templateBody}>{template.body}</p>
                  <div className={styles.cardFooter}>
                    <span>Updated {formatDateTime(template.updated_at)}</span>
                    <div className={styles.cardActions}>
                      <button onClick={() => openEditTemplate(template)} type="button">Edit</button>
                      <button disabled={saving} onClick={() => void templateAction(template, "templateDuplicate")} type="button">Duplicate</button>
                      <button
                        disabled={saving}
                        onClick={() => void templateAction(template, template.status === "Active" ? "templateArchive" : "templateRestore")}
                        type="button"
                      >
                        {template.status === "Active" ? "Archive" : "Restore"}
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {!loading && tab === "scheduled" ? (
        <section className={styles.panel}>
          <div className={styles.toolbar}>
            <div className={styles.segmented}>
              <button className={scheduledMode === "upcoming" ? styles.segmentActive : ""} onClick={() => setScheduledMode("upcoming")} type="button">Upcoming</button>
              <button className={scheduledMode === "history" ? styles.segmentActive : ""} onClick={() => setScheduledMode("history")} type="button">History</button>
            </div>
            <button className={styles.secondaryButton} onClick={() => void loadScheduled()} type="button">Refresh</button>
          </div>

          {scheduled.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>◷</div>
              <h2>{scheduledMode === "upcoming" ? "No scheduled messages" : "No scheduling history yet"}</h2>
              <p>{scheduledMode === "upcoming" ? "Schedule a one-time SMS for a Zoho CRM Contact." : "Sent, failed, and canceled scheduled messages will appear here."}</p>
              {scheduledMode === "upcoming" ? <button className={styles.primaryButton} onClick={openNewSchedule} type="button">Schedule SMS</button> : null}
            </div>
          ) : (
            <div className={styles.scheduleList}>
              {scheduled.map((item) => (
                <article className={styles.scheduleCard} key={item.id}>
                  <div className={styles.scheduleMain}>
                    <div className={styles.scheduleIdentity}>
                      <div className={styles.avatar}>{(item.contact?.name || "C").charAt(0).toUpperCase()}</div>
                      <div>
                        <h2>{item.contact?.name || `Contact ${item.zoho_contact_id}`}</h2>
                        <p>{item.contact?.phone || item.phone_at_scheduling || "Phone unavailable"}</p>
                      </div>
                    </div>
                    <div className={styles.scheduleWhen}>
                      <strong>{formatDateTime(item.scheduled_for)}</strong>
                      <span>{item.timezone}</span>
                    </div>
                  </div>
                  <p className={styles.scheduleBody}>{item.message_body}</p>
                  <div className={styles.scheduleFooter}>
                    <div className={styles.metaRow}>
                      <span className={styles.statusPill}>{item.status}</span>
                      {item.template_name_snapshot ? <span>Template: {item.template_name_snapshot}</span> : <span>Custom message</span>}
                      {item.delivery_status ? <span>Delivery: {deliveryLabel(item.delivery_status)}</span> : null}
                      {item.error_message ? <span className={styles.errorText}>{item.error_message}</span> : null}
                    </div>
                    {item.status === "Scheduled" ? (
                      <div className={styles.cardActions}>
                        <button onClick={() => openEditSchedule(item)} type="button">Edit</button>
                        <button disabled={saving} onClick={() => void cancelSchedule(item)} type="button">Cancel</button>
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {templateEditorOpen ? (
        <div className={styles.modalBackdrop} role="presentation">
          <section className={styles.modal} role="dialog" aria-modal="true" aria-label={editingTemplate ? "Edit SMS template" : "Create SMS template"}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.eyebrow}>SMS TEMPLATE</div>
                <h2>{editingTemplate ? "Edit Template" : "New Template"}</h2>
              </div>
              <button className={styles.iconButton} onClick={() => setTemplateEditorOpen(false)} type="button">×</button>
            </div>
            <form onSubmit={saveTemplate}>
              <label className={styles.field}>
                <span>Name</span>
                <input maxLength={120} onChange={(event) => setTemplateName(event.target.value)} placeholder="e.g. Speaker reminder" value={templateName} />
              </label>
              <label className={styles.field}>
                <span>Category <small>optional</small></span>
                <input maxLength={80} onChange={(event) => setTemplateCategory(event.target.value)} placeholder="e.g. Speakers" value={templateCategory} />
              </label>
              <label className={styles.field}>
                <span>Message</span>
                <textarea maxLength={1600} onChange={(event) => setTemplateBody(event.target.value)} rows={7} value={templateBody} />
              </label>
              <div className={styles.mergeRow}>
                <span>Insert field:</span>
                {MERGE_FIELDS.map((field) => <button key={field} onClick={() => insertTemplateMergeField(field)} type="button">{field.replaceAll("_", " ")}</button>)}
              </div>
              <div className={styles.counter}>{templateBody.length}/1600</div>
              <div className={styles.modalFooter}>
                <button className={styles.secondaryButton} onClick={() => setTemplateEditorOpen(false)} type="button">Cancel</button>
                <button className={styles.primaryButton} disabled={saving || !templateName.trim() || !templateBody.trim()} type="submit">{saving ? "Saving…" : "Save Template"}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {scheduleEditorOpen ? (
        <div className={styles.modalBackdrop} role="presentation">
          <section className={`${styles.modal} ${styles.scheduleModal}`} role="dialog" aria-modal="true" aria-label={editingScheduled ? "Edit scheduled SMS" : "Schedule SMS"}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.eyebrow}>SCHEDULED SMS</div>
                <h2>{editingScheduled ? "Edit Scheduled SMS" : "Schedule SMS"}</h2>
              </div>
              <button className={styles.iconButton} onClick={() => setScheduleEditorOpen(false)} type="button">×</button>
            </div>
            <form onSubmit={saveScheduled}>
              <div className={styles.field}>
                <span>Contact</span>
                {scheduleContact ? (
                  <div className={styles.selectedContact}>
                    <div><strong>{scheduleContact.name || `Contact ${scheduleContact.id}`}</strong><span>{scheduleContact.phone || "No phone"}</span></div>
                    {!editingScheduled ? <button onClick={() => setScheduleContact(null)} type="button">Change</button> : null}
                  </div>
                ) : (
                  <div className={styles.contactSearchWrap}>
                    <input onChange={(event) => setContactQuery(event.target.value)} placeholder="Search Zoho Contacts…" value={contactQuery} />
                    {searchingContacts ? <div className={styles.searchHint}>Searching…</div> : null}
                    {contactResults.length > 0 ? (
                      <div className={styles.contactResults}>
                        {contactResults.map((result) => (
                          <button key={result.id} onClick={() => { setScheduleContact(result); setContactQuery(""); setContactResults([]); }} type="button">
                            <strong>{result.name || `Contact ${result.id}`}</strong><span>{result.phone || "No Phone"}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <label className={styles.field}>
                <span>Template <small>optional</small></span>
                <select onChange={(event) => chooseTemplateForSchedule(event.target.value)} value={selectedTemplateId}>
                  <option value="">Custom message</option>
                  {activeTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                </select>
              </label>

              <label className={styles.field}>
                <span>Message</span>
                <textarea maxLength={1600} onChange={(event) => setScheduleBody(event.target.value)} rows={6} value={scheduleBody} />
              </label>
              <div className={styles.mergeRow}>
                <span>Insert field:</span>
                {MERGE_FIELDS.map((field) => <button key={field} onClick={() => insertScheduleMergeField(field)} type="button">{field.replaceAll("_", " ")}</button>)}
              </div>
              <div className={styles.counter}>{scheduleBody.length}/1600</div>

              <div className={styles.twoColumn}>
                <label className={styles.field}>
                  <span>Date & time</span>
                  <input onChange={(event) => setScheduleLocal(event.target.value)} type="datetime-local" value={scheduleLocal} />
                </label>
                <label className={styles.field}>
                  <span>Timezone</span>
                  <input onChange={(event) => setTimezone(event.target.value)} value={timezone} />
                </label>
              </div>

              <div className={styles.scheduleNote}>The final message is frozen when scheduled. At send time the system re-checks the Contact&apos;s current Phone and opt-out status before sending.</div>

              <div className={styles.modalFooter}>
                <button className={styles.secondaryButton} onClick={() => setScheduleEditorOpen(false)} type="button">Cancel</button>
                <button className={styles.primaryButton} disabled={saving || !scheduleContact || !scheduleBody.trim() || !scheduleLocal} type="submit">{saving ? "Saving…" : editingScheduled ? "Update Schedule" : "Schedule SMS"}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
