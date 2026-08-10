import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ZohoApiError, zohoFetch } from "@/lib/zoho/client";

type IntegrationJob = {
  id: string;
  entity_id: string;
  payload: {
    module?: unknown;
    fields?: Record<string, unknown>;
  };
  attempt_count: number;
  max_attempts: number;
};

type ZohoUpsertItem = {
  code?: string;
  status?: string;
  action?: string;
  message?: string;
  details?: {
    id?: string;
    api_name?: string;
  };
};

type ZohoUpsertResponse = {
  data?: ZohoUpsertItem[];
};

export type AssignmentWorkerSummary = {
  workerId: string;
  claimed: number;
  succeeded: number;
  retryScheduled: number;
  deadLettered: number;
};

const ASSIGNMENT_MODULE = "Volunteer_Shift_Assignmen";
const LOOKUP_FIELDS = new Set([
  "Shifts",
  "Contact",
  "Volunteer_Application",
  "Event_Participation",
  "Event",
]);

function requiredText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing required assignment field: ${field}`);
  return text;
}

function normalizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (LOOKUP_FIELDS.has(key)) {
      normalized[key] = value == null || value === "" ? null : { id: String(value) };
      continue;
    }
    normalized[key] = value;
  }

  normalized.Sync_Status = "Synced";
  normalized.Sync_Error = null;
  normalized.Last_Supabase_Sync = new Date().toISOString();
  return normalized;
}

function validateJob(job: IntegrationJob): Record<string, unknown> {
  if (job.payload?.module !== ASSIGNMENT_MODULE) {
    throw new Error(`Unexpected assignment module: ${String(job.payload?.module ?? "")}`);
  }

  const fields = job.payload?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("Assignment payload fields are missing");
  }

  requiredText(fields.Shifts, "Shifts");
  requiredText(fields.Volunteer_Application, "Volunteer_Application");
  requiredText(fields.Supabase_Assignment_ID, "Supabase_Assignment_ID");
  requiredText(fields.Assignment_Unique_Key, "Assignment_Unique_Key");
  requiredText(fields.Assignment_Status, "Assignment_Status");

  return normalizeFields(fields);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2000);
  try {
    return JSON.stringify(error).slice(0, 2000);
  } catch {
    return String(error).slice(0, 2000);
  }
}

function extractZohoCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const direct = (payload as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const data = (payload as { data?: unknown }).data;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
    const code = (data[0] as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function classifyFailure(error: unknown): { code: string; retryable: boolean; message: string } {
  if (error instanceof ZohoApiError) {
    const zohoCode = extractZohoCode(error.payload) ?? `HTTP_${error.status}`;
    const retryable = error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
    return { code: zohoCode, retryable, message: safeErrorMessage(error) };
  }

  const message = safeErrorMessage(error);
  const isPayloadProblem =
    message.includes("Missing required assignment field") ||
    message.includes("Unexpected assignment module") ||
    message.includes("Assignment payload fields are missing");

  return {
    code: isPayloadProblem ? "INVALID_OUTBOX_PAYLOAD" : "TRANSIENT_WORKER_ERROR",
    retryable: !isPayloadProblem,
    message,
  };
}

async function markFailed(job: IntegrationJob, workerId: string, error: unknown): Promise<"failed" | "dead_letter"> {
  const supabase = getSupabaseAdmin();
  const failure = classifyFailure(error);
  const { data, error: rpcError } = await supabase.rpc("fail_zoho_assignment_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_error_code: failure.code,
    p_error_message: failure.message,
    p_retryable: failure.retryable,
  });

  if (rpcError) throw rpcError;
  return data === "dead_letter" ? "dead_letter" : "failed";
}

async function processJob(job: IntegrationJob, workerId: string): Promise<"succeeded" | "failed" | "dead_letter"> {
  const fields = validateJob(job);
  const payload = await zohoFetch<ZohoUpsertResponse>(`/crm/v8/${ASSIGNMENT_MODULE}/upsert`, {
    method: "POST",
    body: JSON.stringify({
      data: [fields],
      duplicate_check_fields: ["Supabase_Assignment_ID"],
    }),
  });

  const item = payload.data?.[0];
  const zohoRecordId = item?.details?.id;
  if (!zohoRecordId || item?.status === "error") {
    const error = new Error(
      `Zoho assignment upsert did not return a successful record id: ${JSON.stringify(item ?? payload)}`,
    );
    return markFailed(job, workerId, error);
  }

  const supabase = getSupabaseAdmin();
  const { error: completeError } = await supabase.rpc("complete_zoho_assignment_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_zoho_record_id: zohoRecordId,
  });
  if (completeError) throw completeError;

  return "succeeded";
}

export async function processZohoAssignmentJobs(limit = 10): Promise<AssignmentWorkerSummary> {
  const workerId = `mcc-messaging:${randomUUID()}`;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("claim_zoho_assignment_jobs", {
    p_worker_id: workerId,
    p_limit: Math.max(1, Math.min(50, limit)),
    p_lease_seconds: 180,
  });
  if (error) throw error;

  const jobs = (data ?? []) as IntegrationJob[];
  const summary: AssignmentWorkerSummary = {
    workerId,
    claimed: jobs.length,
    succeeded: 0,
    retryScheduled: 0,
    deadLettered: 0,
  };

  for (const job of jobs) {
    try {
      const result = await processJob(job, workerId);
      if (result === "succeeded") summary.succeeded += 1;
      else if (result === "dead_letter") summary.deadLettered += 1;
      else summary.retryScheduled += 1;
    } catch (error) {
      try {
        const result = await markFailed(job, workerId, error);
        if (result === "dead_letter") summary.deadLettered += 1;
        else summary.retryScheduled += 1;
      } catch (markError) {
        console.error("Unable to record Zoho assignment worker failure", {
          jobId: job.id,
          error: safeErrorMessage(error),
          markError: safeErrorMessage(markError),
        });
      }
    }
  }

  return summary;
}
