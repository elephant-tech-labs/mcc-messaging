export type ZohoMessageStatus = "Sent" | "Delivered" | "Failed" | "Received";

const STATUS_RANK: Record<string, number> = {
  accepted: 10,
  scheduled: 15,
  queued: 20,
  sending: 30,
  sent: 40,
  delivered: 50,
  read: 60,
};

const TERMINAL_FAILURES = new Set(["failed", "undelivered", "canceled"]);

export function normalizeTwilioStatus(status: string): string {
  return status.trim().toLowerCase();
}

export function toZohoMessageStatus(status: string): ZohoMessageStatus {
  const normalized = normalizeTwilioStatus(status);

  if (normalized === "received") return "Received";
  if (normalized === "delivered" || normalized === "read") return "Delivered";
  if (TERMINAL_FAILURES.has(normalized)) return "Failed";
  return "Sent";
}

export function shouldApplyTwilioStatus(current: string, next: string): boolean {
  const currentStatus = normalizeTwilioStatus(current);
  const nextStatus = normalizeTwilioStatus(next);

  if (currentStatus === nextStatus) return false;

  if (currentStatus === "delivered" || currentStatus === "read") {
    return false;
  }

  if (TERMINAL_FAILURES.has(currentStatus)) {
    return false;
  }

  if (TERMINAL_FAILURES.has(nextStatus)) {
    return true;
  }

  return (STATUS_RANK[nextStatus] ?? 0) >= (STATUS_RANK[currentStatus] ?? 0);
}
