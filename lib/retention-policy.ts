export const REDACTED_EMAIL_CONTENT = "[Content removed by the tenant retention policy]";

export function retentionDeadline(receivedAt: Date, retentionDays: number) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new RangeError("Retention days must be between 1 and 365.");
  }
  return new Date(receivedAt.getTime() + retentionDays * 24 * 60 * 60 * 1_000);
}

