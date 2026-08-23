"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  browserTimeZone,
  instantToZonedInput,
  zonedInputToUtcIso,
} from "@/lib/messaging/timezone";
import styles from "./bulk-sms.module.css";

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
    UI?: {
      Resize?: (size: { width: string; height: string }) => Promise<unknown> | unknown;
    };
  };
};

type PreviewRecipient = {
  zohoContactId: string;
  name: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  normalizedPhone: string | null;
  eligible: boolean;
  skipReason: string | null;
};

type MessagingTemplate = {
  id: string;
  name: string;
  body: string;
  category: string | null;
  status: "Active" | "Archived";
};

type PreviewPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  totalSelected?: number;
  eligibleCount?: number;
  skippedCount?: number;
  recipients?: PreviewRecipient[];
};

type TemplatePayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  templates?: MessagingTemplate[];
};

type JobStatus = {
  job: {
    id: string;
    status: string;
    total_selected: number;
    eligible_count: number;
    skipped_count: number;
  };
  pendingCount: number;
  deliveredCount: number;
  acceptedCount: number;
  failedCount: number;
  skippedCount: number;
  recipients: Array<{
    id: string;
    contact_name: string | null;
    customer_phone: string | null;
    status: string;
    skip_reason: string | null;
    error_message: string | null;
  }>;
};

type CreatePayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  jobId?: string;
  eligibleCount?: number;
  skippedCount?: number;
};

type ProcessPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  processed?: number;
  done?: boolean;
  status?: JobStatus;
};

type BulkSchedulePayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  scheduledCount?: number;
  skippedCount?: number;
  scheduledFor?: string;
  timezone?: string;
};

type BulkStep = "compose" | "review" | "sending" | "done" | "scheduling" | "scheduled";

type TimezoneOption = {
  value: string;
  label: string;
};

const SDK_URL = "https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js";
const PROXY_FUNCTION = "mcc_messaging_widget_proxy";
const MERGE_FIELDS = ["{{First_Name}}", "{{Last_Name}}", "{{Full_Name}}"];
const MCC_DEFAULT_TIMEZONE = "America/Chicago";
const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: "America/New_York", label: "Eastern Time (America/New_York)" },
  { value: "America/Chicago", label: "Central Time (America/Chicago) · MCC default" },
  { value: "America/Denver", label: "Mountain Time (America/Denver)" },
  { value: "America/Los_Angeles", label: "Pacific Time (America/Los_Angeles)" },
  { value: "Asia/Kolkata", label: "India Time (Asia/Kolkata)" },
];

function sdk(): ZohoSdk | undefined {
  return (window as unknown as { ZOHO?: ZohoSdk }).ZOHO;
}

function loadZohoSdk(): Promise<void> {
  if (sdk()) return Promise.resolve();
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
  try {
    return JSON.parse(value);
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
  const once = parseMaybeJson(current);
  return typeof once === "string" ? parseMaybeJson(once) : once;
}

async function executeProxy<T>(args: Record<string, unknown>): Promise<T> {
  const zoho = sdk();
  if (!zoho) throw new Error("Zoho CRM widget context is unavailable");
  const response = await zoho.CRM.FUNCTIONS.execute(PROXY_FUNCTION, {
    arguments: JSON.stringify({ payload: JSON.stringify(args) }),
  });
  const output = unwrapFunctionOutput(response);
  if (!output || typeof output !== "object") throw new Error("Messaging proxy returned an invalid response");
  return output as T;
}

function pageIds(data: unknown): { entity: string; ids: string[] } {
  if (!data || typeof data !== "object") return { entity: "", ids: [] };
  const record = data as Record<string, unknown>;
  const entity = typeof record.Entity === "string" ? record.Entity : "";
  const raw = record.EntityId;
  const source = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[|,]/) : [];
  const ids = [...new Set(source.map(String).map((id) => id.trim()).filter((id) => /^\d{10,25}$/.test(id)))];
  return { entity, ids };
}

function parseUser(data: unknown): ZohoUser | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const users = record.users;
  if (Array.isArray(users) && users[0] && typeof users[0] === "object") return users[0] as ZohoUser;
  return record as ZohoUser;
}

function userName(user: ZohoUser | null): string | undefined {
  if (!user) return undefined;
  return user.full_name?.trim() || user.name?.trim() || [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || undefined;
}

function renderSample(template: string, recipient?: PreviewRecipient): string {
  if (!recipient) return template;
  return template
    .replace(/\{\{\s*First_Name\s*\}\}/g, recipient.firstName)
    .replace(/\{\{\s*Last_Name\s*\}\}/g, recipient.lastName)
    .replace(/\{\{\s*Full_Name\s*\}\}/g, recipient.name);
}

function formatScheduledTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function timezoneDisplayName(value: string, browserTimezone: string): string {
  const known = TIMEZONE_OPTIONS.find((option) => option.value === value);
  if (known) return known.label.replace(" · MCC default", "");
  if (value === browserTimezone) return `Browser timezone (${value})`;
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function BulkSmsWidget() {
  const [recordIds, setRecordIds] = useState<string[]>([]);
  const [currentUser, setCurrentUser] = useState<ZohoUser | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [templates, setTemplates] = useState<MessagingTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [message, setMessage] = useState("");
  const [sendMode, setSendMode] = useState<"now" | "later">("now");
  const [browserTimezone, setBrowserTimezone] = useState("UTC");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [scheduleTimezone, setScheduleTimezone] = useState(MCC_DEFAULT_TIMEZONE);
  const [scheduledResult, setScheduledResult] = useState<BulkSchedulePayload | null>(null);
  const [step, setStep] = useState<BulkStep>("compose");
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const processingRef = useRef(false);

  const eligible = useMemo(() => (preview?.recipients ?? []).filter((item) => item.eligible), [preview]);
  const skipped = useMemo(() => (preview?.recipients ?? []).filter((item) => !item.eligible), [preview]);
  const sample = renderSample(message, eligible[0]);
  const scheduleDate = scheduleLocal.split("T")[0] ?? "";
  const scheduleTime = scheduleLocal.split("T")[1] ?? "";
  const timezoneOptions = useMemo(() => {
    if (!browserTimezone || TIMEZONE_OPTIONS.some((option) => option.value === browserTimezone)) {
      return TIMEZONE_OPTIONS;
    }
    return [
      ...TIMEZONE_OPTIONS,
      { value: browserTimezone, label: `Browser timezone (${browserTimezone})` },
    ];
  }, [browserTimezone]);

  useEffect(() => {
    const detectedTimezone = browserTimeZone();
    setBrowserTimezone(detectedTimezone);
    setScheduleTimezone(MCC_DEFAULT_TIMEZONE);
    setScheduleLocal(instantToZonedInput(Date.now() + 30 * 60 * 1000, MCC_DEFAULT_TIMEZONE));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        await loadZohoSdk();
        const zoho = sdk();
        if (!zoho || cancelled) return;
        zoho.embeddedApp.on("PageLoad", (data) => {
          const context = pageIds(data);
          if (context.entity && context.entity !== "Contacts") {
            setError("MCC Bulk SMS is currently available from the Contacts list view only.");
            setLoading(false);
            return;
          }
          if (context.ids.length > 2000) {
            setError("Select 2,000 Contacts or fewer in one bulk SMS job.");
            setLoading(false);
            return;
          }
          setRecordIds(context.ids);
        });
        await Promise.resolve(zoho.embeddedApp.init());
        try {
          await Promise.resolve(zoho.CRM.UI?.Resize?.({ width: "900", height: "780" }));
        } catch {}
        try {
          const getter = zoho.CRM.CONFIG?.getCurrentUser;
          if (getter) setCurrentUser(parseUser(await getter()));
        } catch {}
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to initialize MCC Bulk SMS");
        setLoading(false);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (recordIds.length === 0) return;
    let cancelled = false;
    async function loadPreview() {
      setLoading(true);
      setError(null);
      try {
        const result = await executeProxy<PreviewPayload>({ action: "bulkPreview", contactIds: recordIds });
        if (!result.ok) throw new Error(result.detail || result.error || "Unable to prepare selected Contacts");
        if (!cancelled) setPreview(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to prepare selected Contacts");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [recordIds]);

  useEffect(() => {
    if (recordIds.length === 0) return;
    let cancelled = false;
    async function loadTemplates() {
      try {
        const result = await executeProxy<TemplatePayload>({ action: "templateList", includeArchived: false });
        if (result.ok && !cancelled) setTemplates(result.templates ?? []);
      } catch {
        if (!cancelled) setTemplates([]);
      }
    }
    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [recordIds]);

  const appendMerge = useCallback((token: string) => {
    setMessage((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${token}`);
  }, []);

  function chooseTemplate(templateId: string) {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const template = templates.find((item) => item.id === templateId);
    if (template) setMessage(template.body);
  }

  function chooseSendMode(mode: "now" | "later") {
    setSendMode(mode);
    if (mode === "later" && !scheduleLocal) {
      setScheduleLocal(instantToZonedInput(Date.now() + 30 * 60 * 1000, scheduleTimezone));
    }
  }

  function updateScheduleDate(value: string) {
    const time = scheduleTime || "09:00";
    setScheduleLocal(value ? `${value}T${time}` : "");
  }

  function updateScheduleTime(value: string) {
    const date = scheduleDate || instantToZonedInput(Date.now() + 30 * 60 * 1000, scheduleTimezone).split("T")[0];
    setScheduleLocal(value ? `${date}T${value}` : "");
  }

  const processJob = useCallback(async (id: string) => {
    if (processingRef.current) return;
    processingRef.current = true;
    setStep("sending");
    setError(null);
    try {
      let done = false;
      while (!done) {
        const result = await executeProxy<ProcessPayload>({ action: "bulkProcess", jobId: id });
        if (!result.ok || !result.status) throw new Error(result.detail || result.error || "Bulk SMS processing failed");
        setJobStatus(result.status);
        done = Boolean(result.done);
        if (!done) await sleep(250);
      }
      setStep("done");
      for (let index = 0; index < 3; index += 1) {
        await sleep(1500);
        const refreshed = await executeProxy<{ ok?: boolean; status?: JobStatus }>({ action: "bulkStatus", jobId: id });
        if (refreshed.ok && refreshed.status) setJobStatus(refreshed.status);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk SMS processing failed");
      setStep("sending");
    } finally {
      processingRef.current = false;
    }
  }, []);

  const startSend = useCallback(async () => {
    if (!preview || !preview.eligibleCount || !confirmed) return;
    const body = message.trim();
    if (!body) {
      setError("Enter a message before sending.");
      return;
    }
    setError(null);
    setStep("sending");
    try {
      const created = await executeProxy<CreatePayload>({
        action: "bulkCreate",
        contactIds: recordIds,
        messageTemplate: body,
        jobName: `MCC Bulk SMS · ${new Date().toLocaleString()}`,
        sentByZohoUserId: currentUser?.id,
        sentByName: userName(currentUser),
      });
      if (!created.ok || !created.jobId) throw new Error(created.detail || created.error || "Unable to create bulk SMS job");
      setJobId(created.jobId);
      await processJob(created.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start bulk SMS");
      setStep("review");
    }
  }, [confirmed, currentUser, message, preview, processJob, recordIds]);

  const startSchedule = useCallback(async () => {
    if (!preview || !preview.eligibleCount || !confirmed) return;
    const body = message.trim();
    if (!body) {
      setError("Enter a message before scheduling.");
      return;
    }
    if (!scheduleLocal) {
      setError("Choose a date and time before scheduling.");
      return;
    }

    setError(null);
    setStep("scheduling");
    try {
      const scheduledFor = zonedInputToUtcIso(scheduleLocal, scheduleTimezone);
      const result = await executeProxy<BulkSchedulePayload>({
        action: "bulkSchedule",
        contactIds: recordIds,
        messageTemplate: body,
        scheduledFor,
        timezone: scheduleTimezone,
        templateId: selectedTemplateId || undefined,
        sentByZohoUserId: currentUser?.id,
        sentByName: userName(currentUser),
      });
      if (!result.ok || !result.scheduledCount || !result.scheduledFor || !result.timezone) {
        throw new Error(result.detail || result.error || "Unable to schedule bulk SMS");
      }
      setScheduledResult(result);
      setStep("scheduled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to schedule bulk SMS");
      setStep("review");
    }
  }, [confirmed, currentUser, message, preview, recordIds, scheduleLocal, scheduleTimezone, selectedTemplateId]);

  const progress = jobStatus?.job.eligible_count
    ? Math.round(((jobStatus.job.eligible_count - jobStatus.pendingCount) / jobStatus.job.eligible_count) * 100)
    : 0;

  if (loading) {
    return <main className={styles.shell}><div className={styles.loading}>Preparing selected Contacts…</div></main>;
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>MCC Messaging</div>
          <h1>Bulk SMS</h1>
          <p>Send now or schedule one personalized SMS to selected CRM Contacts.</p>
        </div>
        <div className={styles.selectedBadge}>{preview?.totalSelected ?? recordIds.length} selected</div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {preview && (step === "compose" || step === "review") && (
        <>
          <section className={styles.stats}>
            <div><strong>{preview.totalSelected ?? 0}</strong><span>Selected</span></div>
            <div className={styles.good}><strong>{preview.eligibleCount ?? 0}</strong><span>Eligible</span></div>
            <div className={styles.warn}><strong>{preview.skippedCount ?? 0}</strong><span>Skipped safely</span></div>
          </section>

          {step === "compose" && (
            <section className={styles.card}>
              <div className={styles.cardTitle}>Compose message</div>

              <label className={styles.templatePicker}>
                <span>Saved template <em>optional</em></span>
                <select onChange={(event) => chooseTemplate(event.target.value)} value={selectedTemplateId}>
                  <option value="">{templates.length > 0 ? "Choose a saved template…" : "No saved templates"}</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.category ? `${template.name} · ${template.category}` : template.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className={styles.mergeRow}>
                <span>Personalize:</span>
                {MERGE_FIELDS.map((field) => <button key={field} type="button" onClick={() => appendMerge(field)}>{field}</button>)}
              </div>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Type the SMS to send…"
                maxLength={1600}
                rows={6}
              />
              <div className={styles.counter}>{message.length}/1600</div>

              {eligible[0] && message.trim() && (
                <div className={styles.previewBox}>
                  <div className={styles.previewLabel}>Preview for {eligible[0].name}</div>
                  <div>{sample}</div>
                </div>
              )}

              <section className={styles.timingBox} aria-labelledby="delivery-timing-label">
                <div className={styles.timingHeader}>
                  <div>
                    <div className={styles.timingLabel} id="delivery-timing-label">Delivery timing</div>
                    <p>Choose when this bulk message should be sent.</p>
                  </div>
                </div>

                <div className={styles.timingChoices} role="radiogroup" aria-label="Delivery timing">
                  <label className={`${styles.timingChoice} ${sendMode === "now" ? styles.timingChoiceSelected : ""}`}>
                    <input
                      type="radio"
                      name="bulk-sms-timing"
                      checked={sendMode === "now"}
                      onChange={() => chooseSendMode("now")}
                    />
                    <span className={styles.timingChoiceCopy}>
                      <strong>Send now</strong>
                      <em>Send to all eligible Contacts immediately after confirmation.</em>
                    </span>
                  </label>

                  <label className={`${styles.timingChoice} ${sendMode === "later" ? styles.timingChoiceSelected : ""}`}>
                    <input
                      type="radio"
                      name="bulk-sms-timing"
                      checked={sendMode === "later"}
                      onChange={() => chooseSendMode("later")}
                    />
                    <span className={styles.timingChoiceCopy}>
                      <strong>Schedule for later</strong>
                      <em>Send to all eligible Contacts at a future date and time.</em>
                    </span>
                  </label>
                </div>

                {sendMode === "later" && (
                  <div className={styles.schedulePanel}>
                    <div className={styles.schedulePanelTitle}>Schedule details</div>
                    <div className={styles.scheduleFields}>
                      <label>
                        <span>Date</span>
                        <input
                          type="date"
                          value={scheduleDate}
                          onChange={(event) => updateScheduleDate(event.target.value)}
                        />
                      </label>
                      <label>
                        <span>Time</span>
                        <input
                          type="time"
                          value={scheduleTime}
                          onChange={(event) => updateScheduleTime(event.target.value)}
                        />
                      </label>
                      <label className={styles.timezoneField}>
                        <span>Timezone</span>
                        <select
                          value={scheduleTimezone}
                          onChange={(event) => setScheduleTimezone(event.target.value)}
                        >
                          {timezoneOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                        <small>
                          MCC defaults to Central Time. Your browser is {timezoneDisplayName(browserTimezone, browserTimezone)}.
                        </small>
                      </label>
                    </div>
                  </div>
                )}
              </section>

              {skipped.length > 0 && (
                <details className={styles.details}>
                  <summary>Review {skipped.length} skipped Contact{skipped.length === 1 ? "" : "s"}</summary>
                  <div className={styles.skipList}>
                    {skipped.slice(0, 25).map((item) => (
                      <div key={item.zohoContactId}><span>{item.name}</span><em>{item.skipReason}</em></div>
                    ))}
                    {skipped.length > 25 && <div>+ {skipped.length - 25} more</div>}
                  </div>
                </details>
              )}

              <div className={styles.actions}>
                <button
                  className={styles.primary}
                  type="button"
                  disabled={!message.trim() || (preview.eligibleCount ?? 0) === 0 || (sendMode === "later" && !scheduleLocal)}
                  onClick={() => {
                    setConfirmed(false);
                    setStep("review");
                  }}
                >
                  {sendMode === "later" ? "Review & Schedule" : "Review & Send"}
                </button>
              </div>
            </section>
          )}

          {step === "review" && (
            <section className={styles.card}>
              <div className={styles.cardTitle}>Final review</div>
              <div className={styles.reviewGrid}>
                <div><span>SMS recipients</span><strong>{preview.eligibleCount ?? 0}</strong></div>
                <div><span>Skipped</span><strong>{preview.skippedCount ?? 0}</strong></div>
                <div><span>Message length</span><strong>{message.trim().length} chars</strong></div>
                <div>
                  <span>Delivery</span>
                  <strong>{sendMode === "later" ? "Scheduled" : "Now"}</strong>
                </div>
              </div>
              {sendMode === "later" && (
                <div className={styles.scheduleReview}>
                  <div>
                    <span>Scheduled for</span>
                    <strong>{scheduleLocal ? scheduleLocal.replace("T", " · ") : "No time selected"}</strong>
                  </div>
                  <div>
                    <span>Timezone</span>
                    <strong>{timezoneDisplayName(scheduleTimezone, browserTimezone)}</strong>
                  </div>
                </div>
              )}
              <div className={styles.finalMessage}>{sample}</div>
              <label className={styles.confirmRow}>
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>I confirm these Contacts are permitted to receive this SMS. MCC opt-outs and invalid/duplicate phone numbers will remain excluded.</span>
              </label>
              <div className={styles.actionsBetween}>
                <button className={styles.secondary} type="button" onClick={() => setStep("compose")}>Back</button>
                <button
                  className={styles.primary}
                  type="button"
                  disabled={!confirmed}
                  onClick={() => sendMode === "later" ? void startSchedule() : void startSend()}
                >
                  {sendMode === "later"
                    ? `Schedule ${preview.eligibleCount ?? 0} SMS`
                    : `Send ${preview.eligibleCount ?? 0} SMS`}
                </button>
              </div>
            </section>
          )}
        </>
      )}

      {step === "scheduling" && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>Scheduling bulk SMS…</div>
          <p className={styles.note}>Preparing personalized scheduled messages for each eligible Contact.</p>
        </section>
      )}

      {step === "scheduled" && scheduledResult && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>Bulk SMS scheduled</div>
          <section className={styles.statsCompact}>
            <div><strong>{scheduledResult.scheduledCount ?? 0}</strong><span>Scheduled</span></div>
            <div><strong>{scheduledResult.skippedCount ?? 0}</strong><span>Skipped</span></div>
            <div className={styles.wideStat}>
              <strong>{scheduledResult.scheduledFor && scheduledResult.timezone
                ? formatScheduledTime(scheduledResult.scheduledFor, scheduledResult.timezone)
                : "Scheduled"}</strong>
              <span>Delivery time</span>
            </div>
          </section>
          <p className={styles.note}>
            Each Contact has an individualized frozen message. Phone and opt-out status are checked again when the scheduled send runs. Upcoming messages can be managed from MCC SMS Tools.
          </p>
        </section>
      )}

      {(step === "sending" || step === "done") && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>{step === "done" ? "Bulk SMS submitted" : "Sending bulk SMS…"}</div>
          <div className={styles.progressTrack}><div className={styles.progressBar} style={{ width: `${progress}%` }} /></div>
          <div className={styles.progressText}>{progress}% processed</div>
          <section className={styles.statsCompact}>
            <div><strong>{jobStatus?.job.eligible_count ?? preview?.eligibleCount ?? 0}</strong><span>Recipients</span></div>
            <div><strong>{jobStatus?.deliveredCount ?? 0}</strong><span>Delivered</span></div>
            <div><strong>{jobStatus?.acceptedCount ?? 0}</strong><span>Sent / accepted</span></div>
            <div><strong>{jobStatus?.failedCount ?? 0}</strong><span>Failed</span></div>
            <div><strong>{jobStatus?.skippedCount ?? preview?.skippedCount ?? 0}</strong><span>Skipped</span></div>
          </section>

          {step === "sending" && error && jobId && (
            <button className={styles.primary} type="button" onClick={() => void processJob(jobId)}>Resume queued recipients</button>
          )}

          {step === "done" && (
            <p className={styles.note}>Replies will appear in the normal MCC Messages inbox, Contact widget, and Cliq. Delivery callbacks may continue updating after this window is closed.</p>
          )}

          {(jobStatus?.recipients?.length ?? 0) > 0 && (
            <details className={styles.details}>
              <summary>View skipped / failed details</summary>
              <div className={styles.skipList}>
                {jobStatus?.recipients.map((item) => (
                  <div key={item.id}><span>{item.contact_name || item.customer_phone || "Contact"}</span><em>{item.skip_reason || item.error_message || item.status}</em></div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}
    </main>
  );
}
