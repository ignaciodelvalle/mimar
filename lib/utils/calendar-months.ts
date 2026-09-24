/**
 * "YYYY-MM-DD" plus N calendar months, the day clamped to the target month's
 * last day (31/01 + 1 month = 28/02 or 29/02; 29/02 + 12 months = 28/02).
 * Pure calendar arithmetic on the date string — no instant, so no timezone can
 * shift it. Returns null for anything that is not a "YYYY-MM-DD" string.
 *
 * THE one booster-date calculation. The compliance card (pet-compliance) and
 * the libreta (libreta-health-status) used to compute the same derived due
 * date two ways — this one on the AR calendar day, the libreta with `setMonth`
 * on the UTC instant in server-local time and no month-end clamp — so a dose
 * given after 21:00 AR, or on a 29/02, read "Vencida" on the card while the
 * libreta badge on the same profile still said "Por vencer". Both now call
 * this, fed with `isoDateInAr(occurredAt)`, and anchor the result with
 * `parseDateInput` (noon UTC).
 *
 * Lives outside `lib/utils/format.ts` because that file sits at the file-size
 * fence's 1500-line limit.
 */
export function addCalendarMonths(ymd: string, months: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const monthIndex = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Number(m[3]), lastDay);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
