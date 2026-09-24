import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isoToArDateDisplay,
  maskArDateInput,
  maskArTimeInput,
  parseArDateEndOfDay,
  parseArDateStartOfDay,
  parseArDateToIso,
  parseArTimeToHm,
} from "./date-input-ar";
import {
  calendarDaysAgoInAr,
  eventTypeLabel,
  formatCount,
  formatDate,
  formatDateArOmitCurrentYear,
  formatDateShort,
  formatDateTime,
  formatDateTimeLegal,
  formatDelta,
  formatDiasAgo,
  formatPercent,
  formatRate,
  isoDateInAr,
  notificationTypeLabel,
  nowLocalDatetimeInAr,
  parseArDatetimeLocal,
  parseDateInput,
  pluralizeEs,
  rabiesObservationOutcomeLabel,
  relativeDayLabel,
  relativeDaysShort,
  relativeTime,
  todayIsoInAr,
} from "./format";

// Regression coverage for the outreach "hace 20624d" bug: never-vaccinated pets
// carry an epoch-sentinel date (new Date(0)), and a 56-year "days ago" value is
// nonsense. relativeDaysShort must keep real overdue counts legible while
// refusing to print an absurd relative figure. (Exec E2E gate.)
describe("relativeDaysShort", () => {
  afterEach(() => vi.useRealTimers());

  const fixedNow = new Date("2026-06-20T12:00:00.000Z");

  function daysAgo(n: number): Date {
    return new Date(fixedNow.getTime() - n * 86_400_000);
  }

  it("returns the empty marker for null/undefined", () => {
    expect(relativeDaysShort(null)).toBe("—");
    expect(relativeDaysShort(undefined)).toBe("—");
  });

  it("treats the epoch sentinel (new Date(0)) as 'no record', not 56 years", () => {
    expect(relativeDaysShort(new Date(0))).toBe("—");
  });

  it("returns the empty marker for an unparseable date", () => {
    expect(relativeDaysShort("not-a-date")).toBe("—");
  });

  it("returns 'hoy' for the current instant", () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    expect(relativeDaysShort(fixedNow)).toBe("hoy");
  });

  it("keeps a legible day count for real overdue values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    expect(relativeDaysShort(daysAgo(400))).toBe("hace 400d");
    expect(relativeDaysShort(daysAgo(900))).toBe("hace 900d");
  });

  it("stays relative right up to the ~10-year threshold, then switches to absolute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    expect(relativeDaysShort(daysAgo(3650))).toBe("hace 3650d");
    expect(relativeDaysShort(daysAgo(3651))).not.toMatch(/hace \d+d/);
  });

  it("never prints an absurd 'hace 20624d' — falls back to an absolute date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const out = relativeDaysShort(daysAgo(20624));
    expect(out).not.toMatch(/hace \d+d/);
    expect(out).not.toContain("20624");
  });
});

// Calendar-day relative labels — "hoy"/"ayer" are CALENDAR words, so they must
// compare Argentine calendar days, not elapsed 24h blocks.
describe("calendarDaysAgoInAr", () => {
  it("counts AR calendar days, not elapsed 24h blocks", () => {
    const now = new Date("2026-07-04T13:00:00Z"); // 10:00 AR on 07-04
    const yesterdayEvening = new Date("2026-07-03T23:00:00Z"); // 20:00 AR 07-03
    // 14 elapsed hours — but ONE calendar day ago.
    expect(calendarDaysAgoInAr(yesterdayEvening, now)).toBe(1);
    // Same AR day, hours apart → 0.
    expect(calendarDaysAgoInAr(new Date("2026-07-04T03:30:00Z"), now)).toBe(0);
    // 25 elapsed hours crossing two AR midnights → 2.
    const lateNow = new Date("2026-07-04T03:30:00Z"); // 00:30 AR
    expect(calendarDaysAgoInAr(new Date("2026-07-03T02:30:00Z"), lateNow)).toBe(2);
    // Future date → negative.
    expect(calendarDaysAgoInAr(new Date("2026-07-05T15:00:00Z"), now)).toBe(-1);
  });
});

// medianos-sesión-2 finding #1: "Próxima 18/7" with no year reads as TODAY
// when the real due date is a year out. The year must appear the moment the
// date's AR-calendar year differs from the current one — never a raw UTC
// comparison (a date-only value near AR midnight must not flip years on SSR
// vs. hydration).
describe("formatDateArOmitCurrentYear", () => {
  const thisYearNow = new Date("2026-07-04T13:00:00Z"); // 10:00 AR, 2026

  it("omits the year when the date falls in the current AR calendar year", () => {
    expect(formatDateArOmitCurrentYear(new Date("2026-12-31T13:00:00Z"), thisYearNow)).toBe(
      "31/12",
    );
  });

  it("appends the year when the date falls in a different AR calendar year", () => {
    expect(formatDateArOmitCurrentYear(new Date("2027-01-18T13:00:00Z"), thisYearNow)).toBe(
      "18/01/2027",
    );
  });

  it("compares AR-calendar years, not raw UTC years, near the AR New Year boundary", () => {
    // 2027-01-01T02:00Z is 2026-12-31T23:00 AR (UTC-3) — UTC year is already
    // 2027, but the AR calendar day is still 31/12/2026. Against `thisYearNow`
    // (AR year 2026) the AR years match, so the year must be OMITTED — a
    // UTC-year comparison would wrongly append "/2027".
    const lateArNewYearsEveInstant = new Date("2027-01-01T02:00:00Z");
    expect(formatDateArOmitCurrentYear(lateArNewYearsEveInstant, thisYearNow)).toBe("31/12");

    // Flip it: `now` itself sits at that same late-AR-New-Year's-Eve instant
    // (AR year 2026, UTC year 2027) while the date is genuinely early January
    // AR year 2027. A UTC-year comparison on `now` would read 2027 and wrongly
    // omit the year; the AR-year comparison correctly appends it.
    const dateEarlyNextArYear = new Date("2027-01-02T13:00:00Z"); // 10:00 AR 01-02-2027
    expect(formatDateArOmitCurrentYear(dateEarlyNextArYear, lateArNewYearsEveInstant)).toBe(
      "02/01/2027",
    );
  });

  it("returns the empty marker for null/undefined/unparseable input", () => {
    expect(formatDateArOmitCurrentYear(null, thisYearNow)).toBe("—");
    expect(formatDateArOmitCurrentYear(undefined, thisYearNow)).toBe("—");
    expect(formatDateArOmitCurrentYear("not-a-date", thisYearNow)).toBe("—");
  });
});

describe("relativeDayLabel", () => {
  const now = new Date("2026-07-04T13:00:00Z"); // 10:00 AR on 07-04

  it("labels the same AR day 'hoy' regardless of hour", () => {
    expect(relativeDayLabel(new Date("2026-07-04T03:00:00Z"), now)).toBe("hoy"); // 00:00 AR
    expect(relativeDayLabel("2026-07-04", now)).toBe("hoy"); // pre-computed AR day string
  });

  it("labels 20:00-yesterday viewed at 10:00-today 'ayer' (14h elapsed)", () => {
    expect(relativeDayLabel(new Date("2026-07-03T23:00:00Z"), now)).toBe("ayer");
    expect(relativeDayLabel("2026-07-03", now)).toBe("ayer");
  });

  it("falls back to a compact d/M chip beyond ayer", () => {
    expect(relativeDayLabel("2026-07-01", now)).toBe("1/7");
  });
});

describe("relativeDaysShort — calendar-day semantics", () => {
  afterEach(() => vi.useRealTimers());

  it("says 'hace 1d', not 'hoy', for yesterday evening viewed this morning", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T13:00:00Z")); // 10:00 AR
    expect(relativeDaysShort(new Date("2026-07-03T23:00:00Z"))).toBe("hace 1d"); // 20:00 AR ayer
  });
});

describe("relativeTime — calendar-day semantics", () => {
  afterEach(() => vi.useRealTimers());

  it("says 'ayer' for yesterday evening viewed this morning (14h elapsed)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T13:00:00Z")); // 10:00 AR
    expect(relativeTime(new Date("2026-07-03T23:00:00Z"))).toBe("ayer");
  });

  it("keeps hour granularity within the same AR day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T13:00:00Z")); // 10:00 AR
    expect(relativeTime(new Date("2026-07-04T05:00:00Z"))).toBe("hace 8 h"); // 02:00 AR hoy
  });

  it("never says 'ayer' for something two AR days back at 24-48h elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T03:30:00Z")); // 00:30 AR
    // 25h ago = 23:30 AR two days back — old elapsed math said "ayer".
    expect(relativeTime(new Date("2026-07-03T02:30:00Z"))).toBe("hace 2 días");
  });
});

// ---------------------------------------------------------------------------
// Numeric KPI / metric formatters (es-AR) — KPI precision audit 2026-07-07
// ---------------------------------------------------------------------------
//
// Pins the es-AR locale contract: COMMA decimal separator, DOT thousands
// separator. A regression here means dashboards render "41.3%" (wrong locale)
// or drop the decimal a fetcher worked to preserve.

describe("formatCount", () => {
  it("uses the es-AR thousands separator (dot)", () => {
    expect(formatCount(1982)).toBe("1.982");
    expect(formatCount(12345)).toBe("12.345");
    expect(formatCount(0)).toBe("0");
  });

  it("never fabricates a decimal — rounds to an integer", () => {
    expect(formatCount(41.9)).toBe("42");
    expect(formatCount(41.4)).toBe("41");
  });

  it("returns the empty marker for null/undefined/non-finite", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("shows one decimal with an es-AR comma", () => {
    expect(formatPercent(41.3)).toBe("41,3%");
    expect(formatPercent(72)).toBe("72,0%");
    expect(formatPercent(66.666)).toBe("66,7%"); // rounds to 1 decimal
    expect(formatPercent(0.4)).toBe("0,4%"); // a tiny non-zero survives
  });

  it("renders exactly 0 and 100 clean (no trailing decimal)", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(100)).toBe("100%");
  });

  it("honours a custom decimals option", () => {
    expect(formatPercent(41.34, { decimals: 2 })).toBe("41,34%");
  });

  it("returns the empty marker for null/undefined/non-finite", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});

describe("eventTypeLabel", () => {
  // Regression: the shared libreta (/libreta/compartir) rendered raw snake_case
  // English event types (rabies_observation_ended, incident_reported) to
  // funcionarios/vets. Every event type must resolve to es-AR prose.
  it("maps bite + rabies-observation event types to es-AR prose", () => {
    expect(eventTypeLabel("incident_reported")).toBe("Incidente reportado");
    expect(eventTypeLabel("rabies_observation_started")).toBe("Observación antirrábica iniciada");
    expect(eventTypeLabel("rabies_observation_ended")).toBe("Observación antirrábica finalizada");
  });

  it("never returns raw snake_case for a libreta event type", () => {
    for (const t of [
      "incident_reported",
      "rabies_observation_started",
      "rabies_observation_ended",
    ] as const) {
      expect(eventTypeLabel(t)).not.toMatch(/_/);
    }
  });
});

describe("notificationTypeLabel", () => {
  it("maps the onboarding welcome type to es-AR prose (not the raw code)", () => {
    expect(notificationTypeLabel("welcome")).toBe("Bienvenida");
  });

  it("falls back to the raw code for unknown types", () => {
    expect(notificationTypeLabel("some_unknown_type")).toBe("some_unknown_type");
    expect(notificationTypeLabel(null)).toBe("—");
  });
});

describe("rabiesObservationOutcomeLabel", () => {
  it("maps close outcomes to es-AR prose so bodies never show 'outcome: negative'", () => {
    expect(rabiesObservationOutcomeLabel("negative")).toBe("resultado negativo (animal sano)");
    expect(rabiesObservationOutcomeLabel("positive_rabies")).toBe(
      "resultado positivo (rabia confirmada o sospechada)",
    );
    expect(rabiesObservationOutcomeLabel("dead")).toBe("fallecimiento durante la observación");
    expect(rabiesObservationOutcomeLabel("lost_to_followup")).toBe(
      "sin seguimiento (animal perdido o sin contacto)",
    );
  });

  it("handles null/unknown safely", () => {
    expect(rabiesObservationOutcomeLabel(null)).toBe("resultado no especificado");
    expect(rabiesObservationOutcomeLabel("mystery")).toBe("mystery");
  });
});

describe("formatRate", () => {
  it("shows one decimal with an es-AR comma and no unit", () => {
    expect(formatRate(3.5)).toBe("3,5");
    expect(formatRate(3)).toBe("3,0");
    expect(formatRate(12.34)).toBe("12,3");
  });

  it("uses the es-AR thousands separator for large rates", () => {
    expect(formatRate(1234.5)).toBe("1.234,5");
  });

  it("returns the empty marker for null/undefined/non-finite", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });
});

describe("formatDelta", () => {
  it("prefixes an explicit sign and uses an es-AR comma", () => {
    expect(formatDelta(2.4)).toBe("+2,4");
    expect(formatDelta(-1)).toBe("-1,0");
    expect(formatDelta(0)).toBe("0,0"); // zero carries no sign
  });

  it("appends a unit suffix when given", () => {
    expect(formatDelta(2.4, { unit: "pp" })).toBe("+2,4pp");
    expect(formatDelta(-3, { unit: "%", decimals: 0 })).toBe("-3%");
  });

  it("returns the empty marker for null/undefined/non-finite", () => {
    expect(formatDelta(null)).toBe("—");
    expect(formatDelta(Number.NaN)).toBe("—");
  });
});

// Legal-document timestamps (MPF/PPP/travel PDF exports — staging validation
// 2026-07-04, bug 4): the exported PDF printed the server's UTC clock
// ("generado 06:27:41" for a ~17:47 ART generation) with no timezone label.
describe("formatDateTimeLegal", () => {
  it("pins to Argentina time regardless of the ambient/server zone", () => {
    // 2026-07-04T20:47:41Z is 17:47:41 in America/Argentina/Buenos_Aires (UTC-3).
    const out = formatDateTimeLegal(new Date("2026-07-04T20:47:41Z"));
    expect(out).toContain("17:47:41");
    expect(out).not.toContain("20:47:41");
  });

  it("carries an explicit '(hora de Argentina)' label and seconds precision", () => {
    const out = formatDateTimeLegal("2026-07-04T20:47:41Z");
    expect(out).toMatch(/\(hora de Argentina\)$/);
    expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(out).toContain("04/07/2026");
  });

  it("returns the empty marker for null/invalid input", () => {
    expect(formatDateTimeLegal(null)).toBe("—");
    expect(formatDateTimeLegal("not-a-date")).toBe("—");
  });
});

describe("formatDateShort", () => {
  it("renders the compact abbreviated-month shape (es-AR: '7 de jul de 2026')", () => {
    const out = formatDateShort(new Date("2026-07-07T15:00:00Z"));
    expect(out).toMatch(/7 de jul\.? de 2026/);
  });

  it("pins to Argentina — a late-night AR timestamp keeps the AR calendar day", () => {
    // 2026-07-04T02:30:00Z is 2026-07-03 23:30 in ART (UTC-3): the AR day is the
    // 3rd, not the 4th. A bare (unpinned) formatter on a UTC server would show
    // the 4th — the off-by-one this helper exists to prevent.
    const out = formatDateShort(new Date("2026-07-04T02:30:00Z"));
    expect(out).toContain("3 de jul");
    expect(out).not.toContain("4 de jul");
  });

  it("returns the empty marker for null/invalid input", () => {
    expect(formatDateShort(null)).toBe("—");
    expect(formatDateShort(undefined)).toBe("—");
    expect(formatDateShort("not-a-date")).toBe("—");
  });
});

describe("formatDateTime", () => {
  it("pins to Argentina time (UTC-3) — never the ambient zone", () => {
    // 2026-07-04T10:59:41Z → 07:59 ART. The postulación page previously
    // rendered the raw UTC clock via a bare toLocaleString.
    const out = formatDateTime(new Date("2026-07-04T10:59:41Z"));
    expect(out).toContain("07:59");
    expect(out).toContain("4 de julio de 2026");
  });

  // Regression guard for QA histórico 2026-07-08 item 1: the admin audit log
  // (app/admin/auditoria/page.tsx) formatted `entry.performedAt` with a raw
  // `toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })` and
  // no timeZone, so a 05:51 ART action rendered as "8:51" (the UTC clock).
  // The row timestamp now delegates to formatDateTime — this pins the fix.
  it("keeps the admin audit log timestamp pinned to ART (05:51 action, not 08:51 UTC)", () => {
    const out = formatDateTime(new Date("2026-07-08T08:51:00.000Z"));
    expect(out).toContain("05:51");
    expect(out).not.toContain("08:51");
  });

  // Regression guard for QA histórico 2026-07-08 item 1: the transfer
  // detail/list pages (app/(app)/transferencias/**) formatted `expiresAt`
  // with a raw toLocaleString/toLocaleDateString and no timeZone, so a
  // transfer expiring at 03:13 ART rendered "Vence 15/7 06:13 a.m." (the
  // UTC clock). Both surfaces now delegate to formatDate/formatDateTime.
  it("keeps the transfer-expiry timestamp pinned to ART (03:13 expiry, not 06:13 UTC)", () => {
    const out = formatDateTime(new Date("2026-07-15T06:13:00.000Z"));
    expect(out).toContain("03:13");
    expect(out).not.toContain("06:13");
  });
});

// Regression guard for the night-time future-date block (cursor QA 2026-07-15
// A2): form date DEFAULTS computed as `new Date().toISOString().slice(0, 10)`
// resolve in UTC, so late in the AR evening (UTC-3) "today" becomes TOMORROW and
// the "no future date" rule rejects the untouched default. todayIsoInAr must
// return the Argentine calendar day for that instant.
describe("todayIsoInAr", () => {
  it("returns the AR calendar day when UTC has already rolled to the next day", () => {
    // 2026-07-16T01:30:00Z is the 16th in UTC but still 22:30 on the 15th in AR.
    const arToday = todayIsoInAr(new Date("2026-07-16T01:30:00.000Z"));
    expect(arToday).toBe("2026-07-15");
    // The UTC computation the app previously used would wrongly say "tomorrow".
    expect(new Date("2026-07-16T01:30:00.000Z").toISOString().slice(0, 10)).toBe("2026-07-16");
  });

  it("returns YYYY-MM-DD and agrees with UTC when both zones are on the same day", () => {
    const arToday = todayIsoInAr(new Date("2026-07-15T15:00:00.000Z"));
    expect(arToday).toBe("2026-07-15");
    expect(arToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// Regression guard for the same class of bug as todayIsoInAr, but for
// `<input type="datetime-local">` defaults (PetSightingForm "¿Cuándo la
// viste?"): `new Date().toISOString().slice(0, 16)` is UTC wall-clock, 3h
// ahead of Argentina, and rolls to the next AR calendar day near AR midnight.
describe("nowLocalDatetimeInAr", () => {
  it("subtracts the 3h AR offset from a UTC instant", () => {
    // 2026-07-15T18:00:00Z is 15:00 in Argentina (UTC-3).
    expect(nowLocalDatetimeInAr(new Date("2026-07-15T18:00:00.000Z"))).toBe("2026-07-15T15:00");
  });

  it("rolls back to the PREVIOUS calendar day when UTC has already advanced", () => {
    // 2026-07-16T01:30:00Z is the 16th in UTC but still 22:30 on the 15th in AR.
    const arNow = nowLocalDatetimeInAr(new Date("2026-07-16T01:30:00.000Z"));
    expect(arNow).toBe("2026-07-15T22:30");
    // The UTC computation the app previously used would wrongly say "tomorrow".
    expect(new Date("2026-07-16T01:30:00.000Z").toISOString().slice(0, 16)).toBe(
      "2026-07-16T01:30",
    );
  });

  it("returns YYYY-MM-DDTHH:mm, zero-padded, 24h clock", () => {
    const arNow = nowLocalDatetimeInAr(new Date("2026-07-15T03:05:00.000Z"));
    expect(arNow).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // 03:05Z - 3h = 00:05 AR, not "0:05" or "24:05".
    expect(arNow).toBe("2026-07-15T00:05");
  });
});

// Browser-independent dd/mm/aaaa date entry (DateInputAr backing helpers).
// The whole point of this control is that an es-AR operator's "03/07" is always
// 3-July, never mm/dd 7-March, on every browser — so parsing must be strict and
// leap-aware, and the round-trip ISO<->display must be lossless.
describe("parseDateInput", () => {
  it("anchors a YYYY-MM-DD input at NOON UTC of that calendar day", () => {
    // The noon anchor is a deliberate, load-bearing choice: it keeps the date
    // on the same calendar day when rendered in any zone within ±12h, and 21
    // consumers (incl. the legal rabies-observation window) depend on it.
    expect(parseDateInput("2026-07-08")?.toISOString()).toBe("2026-07-08T12:00:00.000Z");
    expect(parseDateInput("2024-02-29")?.toISOString()).toBe("2024-02-29T12:00:00.000Z");
  });

  it("returns null for empty or garbage input", () => {
    expect(parseDateInput(null)).toBeNull();
    expect(parseDateInput(undefined)).toBeNull();
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput("not-a-date")).toBeNull();
    expect(parseDateInput("2026-13-45")).toBeNull();
  });
});

// `<input type="date">` submits a bare "YYYY-MM-DD". `new Date(that)` is
// midnight UTC = 21:00 ART of the PREVIOUS day, so every date the user picked
// renders one day early in every AR-pinned formatter in this file. Found while
// wiring the caretaker designation form (custodia-temporal C9): a grant ending
// "15/09" displayed as "terminó el 14/09" to both parties.
describe("parseArDateStartOfDay / parseArDateEndOfDay", () => {
  it("start-of-day is 00:00 ARGENTINE, not 00:00 UTC", () => {
    expect(parseArDateStartOfDay("2026-09-15")?.toISOString()).toBe("2026-09-15T03:00:00.000Z");
  });

  it("end-of-day is the last instant of the ARGENTINE calendar day", () => {
    expect(parseArDateEndOfDay("2026-09-15")?.toISOString()).toBe("2026-09-16T02:59:59.999Z");
  });

  it("survives the AR-pinned formatter round trip — the whole point", () => {
    // The bug, stated as a test: the naive parse reads back as the day before.
    expect(formatDateArOmitCurrentYear(new Date("2026-09-15"), new Date("2026-09-20"))).toBe(
      "14/09",
    );
    // Both helpers land inside the intended Argentine day.
    const start = parseArDateStartOfDay("2026-09-15") as Date;
    const end = parseArDateEndOfDay("2026-09-15") as Date;
    expect(formatDateArOmitCurrentYear(start, new Date("2026-09-20"))).toBe("15/09");
    expect(formatDateArOmitCurrentYear(end, new Date("2026-09-20"))).toBe("15/09");
  });

  it("end-of-day is strictly after start-of-day of the same date", () => {
    const start = parseArDateStartOfDay("2026-09-15") as Date;
    const end = parseArDateEndOfDay("2026-09-15") as Date;
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it("returns null for empty or malformed input", () => {
    expect(parseArDateStartOfDay(null)).toBeNull();
    expect(parseArDateEndOfDay(undefined)).toBeNull();
    expect(parseArDateStartOfDay("")).toBeNull();
    expect(parseArDateEndOfDay("15/09/2026")).toBeNull();
    expect(parseArDateStartOfDay("2026-13-45")).toBeNull();
  });
});

// The "Altas registradas hoy" window (`todayStart` in
// lib/analytics/dashboards/surveillance.ts) is built by COMPOSING these two
// helpers — `isoDateInAr` picks the Argentine calendar day, `parseArDateStartOfDay`
// turns it into that day's first instant — and the composition is the part that
// needed pinning: each half was already correct on its own while the call site
// was wrong.
//
// Before the metric-honesty fix (PO 2026-09-16) that call site anchored on
// midnight UTC, and the interesting part is that it was wrong in BOTH
// directions depending on the hour. During the Argentine day it began at 21:00
// ART of YESTERDAY and over-counted by three hours, which is the failure the
// audit named. But between 21:00 and 24:00 ART the UTC date has already rolled
// over, so the window jumped forward to 21:00 ART of TODAY — and a tile
// labelled "hoy" showed only the last few hours, dropping the whole working day
// it claimed to summarise. The second case is the one nobody would have caught
// by reading the code in the morning.
describe("start of the Argentine day containing an instant (the 'hoy' window)", () => {
  /** The pre-fix rule, kept here as the thing the new one must differ from. */
  const utcMidnightStart = (instant: Date) =>
    new Date(`${instant.toISOString().slice(0, 10)}T00:00:00Z`);
  const arDayStart = (instant: Date) => parseArDateStartOfDay(isoDateInAr(instant));

  it("during the Argentine day, starts at 00:00 ART and not at 21:00 ART of yesterday", () => {
    const instant = new Date("2026-09-16T14:00:00.000Z"); // 11:00 ART on the 16th
    expect(isoDateInAr(instant)).toBe("2026-09-16");
    expect(arDayStart(instant)?.toISOString()).toBe("2026-09-16T03:00:00.000Z");
    // The over-count, as a number: the old window opened three hours earlier.
    expect(utcMidnightStart(instant).toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });

  it("after 21:00 ART, still starts at 00:00 ART of the SAME Argentine day", () => {
    const instant = new Date("2026-09-17T01:00:00.000Z"); // 22:00 ART on the 16th
    expect(isoDateInAr(instant)).toBe("2026-09-16");
    expect(arDayStart(instant)?.toISOString()).toBe("2026-09-16T03:00:00.000Z");
    // The collapse, as a number: the old window opened at 21:00 ART on the 16th,
    // one hour before this instant, so "hoy" covered one hour of the 16th.
    expect(utcMidnightStart(instant).toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });

  it("never opens in the future relative to the instant it describes", () => {
    // Includes both sides of the 03:00Z seam, where the Argentine day rolls over.
    for (const iso of [
      "2026-09-16T00:00:00.000Z",
      "2026-09-16T02:59:59.999Z",
      "2026-09-16T03:00:00.000Z",
      "2026-09-17T01:00:00.000Z",
    ]) {
      const instant = new Date(iso);
      const start = arDayStart(instant) as Date;
      expect(start.getTime()).toBeLessThanOrEqual(instant.getTime());
    }
  });
});

describe("parseArDatetimeLocal", () => {
  it("parses a datetime-local string as AR wall clock (UTC-3)", () => {
    // 18:00 AR = 21:00 UTC — NOT 18:00 UTC (what an offset-less parse yields
    // on a UTC server, firing dose reminders 3h early).
    expect(parseArDatetimeLocal("2026-07-08T18:00")?.toISOString()).toBe(
      "2026-07-08T21:00:00.000Z",
    );
  });

  it("round-trips with nowLocalDatetimeInAr", () => {
    const instant = new Date("2026-07-08T14:37:00.000Z");
    const local = nowLocalDatetimeInAr(instant); // "2026-07-08T11:37"
    expect(parseArDatetimeLocal(local)?.toISOString()).toBe(instant.toISOString());
  });

  it("crosses the UTC midnight boundary at 21:00 ART correctly", () => {
    // 21:00 AR on the 8th is already 00:00Z on the 9th — the UTC calendar day
    // advances but the AR wall clock (and the value the user typed) does not.
    const parsed = parseArDatetimeLocal("2026-07-08T21:00");
    expect(parsed?.toISOString()).toBe("2026-07-09T00:00:00.000Z");
    expect(parsed ? nowLocalDatetimeInAr(parsed) : null).toBe("2026-07-08T21:00");
  });

  it("accepts an optional seconds component", () => {
    expect(parseArDatetimeLocal("2026-07-08T18:00:30")?.toISOString()).toBe(
      "2026-07-08T21:00:30.000Z",
    );
  });

  it("returns null for empty or malformed input", () => {
    expect(parseArDatetimeLocal(null)).toBeNull();
    expect(parseArDatetimeLocal(undefined)).toBeNull();
    expect(parseArDatetimeLocal("")).toBeNull();
    expect(parseArDatetimeLocal("2026-07-08")).toBeNull(); // date-only
    expect(parseArDatetimeLocal("garbage")).toBeNull();
    expect(parseArDatetimeLocal("2026-07-08T18:00Z")).toBeNull(); // explicit zone
    expect(parseArDatetimeLocal("2026-13-08T18:00")).toBeNull(); // impossible month
  });
});

describe("isoToArDateDisplay", () => {
  it("renders ISO yyyy-mm-dd as dd/mm/aaaa", () => {
    expect(isoToArDateDisplay("2026-07-03")).toBe("03/07/2026");
    expect(isoToArDateDisplay("2024-02-29")).toBe("29/02/2024");
  });

  it("returns empty string for empty or non-ISO input", () => {
    expect(isoToArDateDisplay(null)).toBe("");
    expect(isoToArDateDisplay(undefined)).toBe("");
    expect(isoToArDateDisplay("")).toBe("");
    expect(isoToArDateDisplay("03/07/2026")).toBe("");
    expect(isoToArDateDisplay("2026-7-3")).toBe("");
  });
});

describe("parseArDateToIso", () => {
  it("parses a valid dd/mm/aaaa to ISO — 03/07 is 3-July, not 7-March", () => {
    expect(parseArDateToIso("03/07/2026")).toBe("2026-07-03");
    expect(parseArDateToIso("31/12/2025")).toBe("2025-12-31");
    expect(parseArDateToIso(" 01/01/2026 ")).toBe("2026-01-01");
  });

  it("accepts a real leap day but rejects a non-leap 29 Feb", () => {
    expect(parseArDateToIso("29/02/2024")).toBe("2024-02-29");
    expect(parseArDateToIso("29/02/2025")).toBeNull();
  });

  it("rejects impossible dates", () => {
    expect(parseArDateToIso("32/01/2026")).toBeNull();
    expect(parseArDateToIso("00/01/2026")).toBeNull();
    expect(parseArDateToIso("15/13/2026")).toBeNull();
    expect(parseArDateToIso("15/00/2026")).toBeNull();
    expect(parseArDateToIso("31/04/2026")).toBeNull(); // April has 30 days
  });

  it("rejects malformed or empty input", () => {
    expect(parseArDateToIso(null)).toBeNull();
    expect(parseArDateToIso("")).toBeNull();
    expect(parseArDateToIso("3/7/2026")).toBeNull(); // not zero-padded
    expect(parseArDateToIso("2026-07-03")).toBeNull(); // ISO, not display
    expect(parseArDateToIso("abc")).toBeNull();
  });

  it("round-trips ISO -> display -> ISO losslessly", () => {
    for (const iso of ["2026-07-03", "2024-02-29", "2025-12-31", "2026-01-01"]) {
      expect(parseArDateToIso(isoToArDateDisplay(iso))).toBe(iso);
    }
  });
});

describe("maskArDateInput", () => {
  it("inserts slashes progressively as digits are typed", () => {
    expect(maskArDateInput("0")).toBe("0");
    expect(maskArDateInput("03")).toBe("03");
    expect(maskArDateInput("037")).toBe("03/7");
    expect(maskArDateInput("0307")).toBe("03/07");
    expect(maskArDateInput("03072")).toBe("03/07/2");
    expect(maskArDateInput("03072026")).toBe("03/07/2026");
  });

  it("strips non-digits and caps at 8 digits", () => {
    expect(maskArDateInput("03/07/2026")).toBe("03/07/2026");
    expect(maskArDateInput("ab03cd07")).toBe("03/07");
    expect(maskArDateInput("030720261234")).toBe("03/07/2026");
  });
});

describe("maskArTimeInput", () => {
  it("inserts the colon progressively as digits are typed", () => {
    expect(maskArTimeInput("1")).toBe("1");
    expect(maskArTimeInput("19")).toBe("19");
    expect(maskArTimeInput("193")).toBe("19:3");
    expect(maskArTimeInput("1930")).toBe("19:30");
  });

  it("strips non-digits and caps at 4 digits", () => {
    expect(maskArTimeInput("19:30")).toBe("19:30");
    expect(maskArTimeInput("ab19cd30")).toBe("19:30");
    expect(maskArTimeInput("193045")).toBe("19:30");
    // An AM/PM paste keeps only its digits — never a 12-hour value.
    expect(maskArTimeInput("07:30 PM")).toBe("07:30");
  });

  it("returns empty for an all-non-digit string", () => {
    expect(maskArTimeInput("")).toBe("");
    expect(maskArTimeInput("PM")).toBe("");
  });
});

describe("parseArTimeToHm", () => {
  it("accepts a complete in-range 24-hour time", () => {
    expect(parseArTimeToHm("00:00")).toBe("00:00");
    expect(parseArTimeToHm("09:05")).toBe("09:05");
    expect(parseArTimeToHm("19:30")).toBe("19:30");
    expect(parseArTimeToHm("23:59")).toBe("23:59");
  });

  it("trims surrounding whitespace", () => {
    expect(parseArTimeToHm("  19:30  ")).toBe("19:30");
  });

  it("rejects an out-of-range hour or minute", () => {
    expect(parseArTimeToHm("24:00")).toBeNull();
    expect(parseArTimeToHm("99:99")).toBeNull();
    expect(parseArTimeToHm("12:60")).toBeNull();
  });

  it("rejects incomplete, unpadded, or malformed input", () => {
    expect(parseArTimeToHm("")).toBeNull();
    expect(parseArTimeToHm(null)).toBeNull();
    expect(parseArTimeToHm(undefined)).toBeNull();
    expect(parseArTimeToHm("19")).toBeNull();
    expect(parseArTimeToHm("19:")).toBeNull();
    expect(parseArTimeToHm("9:5")).toBeNull();
    expect(parseArTimeToHm("19:30:45")).toBeNull();
    // The whole point: a 12-hour string never round-trips.
    expect(parseArTimeToHm("07:30 PM")).toBeNull();
  });

  it("composes with a parsed date into the exact datetime-local wire format", () => {
    // The contract PetSightingForm depends on: date half + "T" + time half is
    // the same "YYYY-MM-DDTHH:mm" parseArDatetimeLocal already accepts.
    const date = parseArDateToIso("03/07/2026");
    const time = parseArTimeToHm("19:30");
    expect(`${date}T${time}`).toBe("2026-07-03T19:30");
    expect(parseArDatetimeLocal(`${date}T${time}`)?.toISOString()).toBe("2026-07-03T22:30:00.000Z");
  });
});

describe("pluralizeEs", () => {
  it("returns the singular for exactly 1", () => {
    expect(pluralizeEs(1, "evento")).toBe("evento");
    expect(pluralizeEs(1, "señal")).toBe("señal");
  });

  it("pluralizes vowel-ending nouns with +s (0 and 2+ are plural)", () => {
    expect(pluralizeEs(0, "evento")).toBe("eventos");
    expect(pluralizeEs(2, "regla")).toBe("reglas");
    expect(pluralizeEs(3, "café")).toBe("cafés");
  });

  it("pluralizes consonant-ending nouns with +es", () => {
    expect(pluralizeEs(2, "señal")).toBe("señales");
    expect(pluralizeEs(2, "animal")).toBe("animales");
    expect(pluralizeEs(2, "mes")).toBe("meses");
    expect(pluralizeEs(2, "solicitud")).toBe("solicitudes");
    expect(pluralizeEs(2, "lugar")).toBe("lugares");
  });

  it("pluralizes z-ending nouns with -ces", () => {
    expect(pluralizeEs(2, "vez")).toBe("veces");
  });

  it("honors an explicit plural for irregulars", () => {
    expect(pluralizeEs(2, "camión", "camiones")).toBe("camiones");
    expect(pluralizeEs(2, "lunes", "lunes")).toBe("lunes");
    expect(pluralizeEs(1, "camión", "camiones")).toBe("camión");
  });
});

describe("formatDiasAgo", () => {
  it("returns 'hace N días' for the plural cases (0 and 2+)", () => {
    expect(formatDiasAgo(0)).toBe("hace 0 días");
    expect(formatDiasAgo(3)).toBe("hace 3 días");
  });

  it("returns the singular 'hace 1 día' — never 'hace 1 días'", () => {
    expect(formatDiasAgo(1)).toBe("hace 1 día");
  });
});

// Regression coverage for Cowork QA v3 M2a (2026-08-06): Drizzle `date()`
// columns arrive in app code as bare "YYYY-MM-DD" strings. Parsed with
// `new Date(...)` they land on UTC MIDNIGHT, and the AR-pinned (UTC-3)
// formatters then rendered the PREVIOUS calendar day — an agenda rule stored
// "2026-08-06" displayed "5 de ago". Every canonical formatter must anchor
// date-only strings at noon UTC (same rule as parseDateInput).
describe("date-only string input (Drizzle date() columns)", () => {
  it("formatDate keeps the stored calendar day", () => {
    expect(formatDate("2026-08-06")).toBe("6 de agosto de 2026");
  });

  it("formatDateShort keeps the stored calendar day", () => {
    expect(formatDateShort("2026-08-06")).toBe("6 de ago de 2026");
  });

  it("keeps the day at year boundaries", () => {
    expect(formatDateShort("2026-01-01")).toBe("1 de ene de 2026");
    expect(formatDateShort("2026-12-31")).toBe("31 de dic de 2026");
  });

  it("still renders full timestamps in the AR zone (not treated as date-only)", () => {
    // 01:30Z on the 7th is 22:30 on the 6th in AR — the timestamp path must
    // keep converting instants, only bare dates get the noon anchor.
    expect(formatDateShort("2026-08-07T01:30:00.000Z")).toBe("6 de ago de 2026");
  });
});
