"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./bulk-history.module.css";

type ZohoSdk = {
  embeddedApp: {
    on: (event: string, handler: (data: unknown) => void) => void;
    init: () => Promise<unknown> | unknown;
  };
  CRM: {
    FUNCTIONS: {
      execute: (name: string, request: { arguments: string }) => Promise<unknown>;
    };
  };
};

type BulkJobSummary = {
  id: string;
  name: string | null;
  message_template: string;
  status: string;
  total_selected: number;
  eligible_count: number;
  skipped_count: number;
  created_by_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  pendingCount: number;
  deliveredCount: number;
  acceptedCount: number;
  failedCount: number;
  skippedCount: number;
};

type BulkIssueRecipient = {
  id: string;
  zoho_contact_id: string;
  contact_name: string | null;
  customer_phone: string | null;
  status: string;
  skip_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  twilio_message_sid: string | null;
};

type BulkStatus = {
  job: {
    id: string;
    name: string | null;
    message_template: string;
    status: string;
    total_selected: number;
    eligible_count: number;
    skipped_count: number;
    created_by_name: string | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
  };
  pendingCount: number;
  deliveredCount: number;
  acceptedCount: number;
  failedCount: number;
  skippedCount: number;
  recipients: BulkIssueRecipient[];
};

type BulkListPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  jobs?: BulkJobSummary[];
};

type BulkStatusPayload = {
  ok?: boolean;
  error?: string;
  detail?: string;
  status?: BulkStatus;
};

const SDK_URL = "https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js";
const PROXY_FUNCTION = "mcc_messaging_widget_proxy";

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
  const sdk = getZohoSdk();
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function title(job: Pick<BulkJobSummary, "name" | "created_at">): string {
  return job.name?.trim() || `Bulk SMS · ${shortDate(job.created_at)}`;
}

function statusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (["completed"].includes(normalized)) return styles.good;
  if (["partial", "processing", "queued"].includes(normalized)) return styles.warn;
  if (["failed", "canceled"].includes(normalized)) return styles.bad;
  return styles.neutral;
}

export default function BulkHistoryWidget() {
  const [ready, setReady] = useState(false);
  const [jobs, setJobs] = useState<BulkJobSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<BulkStatus | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return jobs;
    return jobs.filter((job) =>
      [job.name, job.message_template, job.created_by_name, job.status]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [jobs, search]);

  const loadJobs = useCallback(async (showLoading = false) => {
    if (!ready) return;
    if (showLoading) setLoading(true);
    try {
      const payload = await executeProxy<BulkListPayload>({ action: "bulkList" });
      if (!payload.ok) throw new Error(payload.detail || payload.error || "Unable to load bulk sends");
      const next = payload.jobs ?? [];
      setJobs(next);
      setError(null);
      setSelectedId((current) => current ?? next[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load bulk sends");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [ready]);

  const loadStatus = useCallback(async (jobId: string, showLoading = false) => {
    if (!ready) return;
    if (showLoading) setDetailLoading(true);
    try {
      const payload = await executeProxy<BulkStatusPayload>({ action: "bulkStatus", jobId });
      if (!payload.ok || !payload.status) {
        throw new Error(payload.detail || payload.error || "Unable to load bulk send details");
      }
      setStatus(payload.status);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load bulk send details");
    } finally {
      if (showLoading) setDetailLoading(false);
    }
  }, [ready]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        await loadZohoSdk();
        const sdk = getZohoSdk();
        if (!sdk || cancelled) return;
        sdk.embeddedApp.on("PageLoad", () => undefined);
        await Promise.resolve(sdk.embeddedApp.init());
        if (!cancelled) setReady(true);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to initialize MCC Bulk Sends");
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
    if (!ready) return;
    void loadJobs(true);
  }, [loadJobs, ready]);

  useEffect(() => {
    if (!ready || !selectedId) {
      setStatus(null);
      return;
    }
    void loadStatus(selectedId, true);
  }, [loadStatus, ready, selectedId]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadJobs(false);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadJobs, ready]);

  useEffect(() => {
    if (!ready || !selectedId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadStatus(selectedId, false);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [loadStatus, ready, selectedId]);

  return (
    <main className={styles.app}>
      <aside className={styles.sidebar}>
        <div className={styles.brandRow}>
          <div>
            <h1>MCC Bulk Sends</h1>
            <p>SMS delivery history</p>
          </div>
          <button type="button" onClick={() => void loadJobs(false)}>Refresh</button>
        </div>

        <div className={styles.searchBox}>
          <span>⌕</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search bulk sends" />
        </div>

        <div className={styles.jobList}>
          {loading ? <div className={styles.state}>Loading bulk sends…</div> : null}
          {!loading && filteredJobs.length === 0 ? <div className={styles.state}>No bulk sends yet.</div> : null}
          {filteredJobs.map((job) => (
            <button
              className={`${styles.jobItem} ${selectedId === job.id ? styles.selected : ""}`}
              key={job.id}
              type="button"
              onClick={() => setSelectedId(job.id)}
            >
              <div className={styles.jobTopline}>
                <strong>{title(job)}</strong>
                <span className={`${styles.statusPill} ${statusClass(job.status)}`}>{job.status}</span>
              </div>
              <p>{job.message_template}</p>
              <div className={styles.jobMeta}>
                <span>{job.deliveredCount} delivered</span>
                <span>{job.failedCount} failed</span>
                <span>{shortDate(job.created_at)}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.detail}>
        {error ? <div className={styles.error}>{error}</div> : null}
        {!selectedId ? (
          <div className={styles.empty}>
            <div>✉</div>
            <h2>Bulk SMS history</h2>
            <p>Select a bulk send to review delivery results.</p>
          </div>
        ) : detailLoading && !status ? (
          <div className={styles.empty}>Loading report…</div>
        ) : status ? (
          <>
            <header className={styles.detailHeader}>
              <div>
                <h2>{status.job.name?.trim() || "Bulk SMS"}</h2>
                <p>{formatDate(status.job.created_at)}</p>
              </div>
              <span className={`${styles.statusPill} ${statusClass(status.job.status)}`}>{status.job.status}</span>
            </header>

            <div className={styles.scrollArea}>
              <div className={styles.metrics}>
                <div><span>Delivered</span><strong>{status.deliveredCount}</strong></div>
                <div><span>Sent / awaiting delivery</span><strong>{status.acceptedCount}</strong></div>
                <div><span>Pending</span><strong>{status.pendingCount}</strong></div>
                <div><span>Failed</span><strong>{status.failedCount}</strong></div>
                <div><span>Skipped</span><strong>{status.skippedCount}</strong></div>
                <div><span>Total selected</span><strong>{status.job.total_selected}</strong></div>
              </div>

              <section className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>Message</h3>
                    <p>Template used for this bulk send</p>
                  </div>
                </div>
                <div className={styles.messageTemplate}>{status.job.message_template}</div>
              </section>

              <section className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h3>Exceptions</h3>
                    <p>Failed, undelivered, and skipped recipients</p>
                  </div>
                  <strong>{status.recipients.length}</strong>
                </div>

                {status.recipients.length === 0 ? (
                  <div className={styles.successState}>No failed or skipped recipients.</div>
                ) : (
                  <div className={styles.tableWrap}>
                    <table>
                      <thead>
                        <tr>
                          <th>Contact</th>
                          <th>Phone</th>
                          <th>Status</th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {status.recipients.map((recipient) => (
                          <tr key={recipient.id}>
                            <td>{recipient.contact_name || recipient.zoho_contact_id}</td>
                            <td>{recipient.customer_phone || "—"}</td>
                            <td><span className={`${styles.statusPill} ${recipient.status === "skipped" ? styles.neutral : styles.bad}`}>{recipient.status}</span></td>
                            <td>{recipient.skip_reason || recipient.error_message || (recipient.error_code ? `Twilio ${recipient.error_code}` : "—")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          </>
        ) : null}
      </section>

      <aside className={styles.context}>
        {status ? (
          <>
            <div className={styles.contextIcon}>SMS</div>
            <h3>{status.job.name?.trim() || "Bulk SMS"}</h3>
            <p>{status.job.created_by_name || "MCC team"}</p>
            <div className={styles.contextDetails}>
              <div><span>Status</span><strong>{status.job.status}</strong></div>
              <div><span>Selected</span><strong>{status.job.total_selected}</strong></div>
              <div><span>Eligible</span><strong>{status.job.eligible_count}</strong></div>
              <div><span>Started</span><strong>{formatDate(status.job.started_at)}</strong></div>
              <div><span>Completed</span><strong>{formatDate(status.job.completed_at)}</strong></div>
            </div>
          </>
        ) : <div className={styles.state}>Bulk send details will appear here.</div>}
      </aside>
    </main>
  );
}
