// The reporter capability, pinned.
//
// This token is what replaced "anyone holding the DEN-XXXX-XXXX string can read
// the denuncia". If any property below regresses, the change
// `legal/denuncias-despublicadas` is undone without the page looking any
// different — which is exactly the failure mode a test has to catch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REPORTER_ACCESS_LINK_TTL_MS,
  REPORTER_ACCESS_POST_CLOSE_GRACE_MS,
  REPORTER_SESSION_TTL_MS,
  encodeReporterSessionCookie,
  generateReporterToken,
  readReporterSessionCookie,
  reporterAccessRevoked,
  reporterSessionCookie,
  validateReporterToken,
} from "./denuncia-reporter-token";

const REPORT_A = "11111111-1111-1111-1111-111111111111";
const REPORT_B = "22222222-2222-2222-2222-222222222222";

describe("generateReporterToken / validateReporterToken", () => {
  it("accepts a fresh token for the same purpose + reportId", () => {
    const token = generateReporterToken("access_link", REPORT_A);
    expect(validateReporterToken("access_link", REPORT_A, token)).toBe(true);
  });

  it("BINDS TO THE REPORT: a token for one denuncia cannot open another", () => {
    // Without this, one leaked link would be a master key to every denuncia.
    const token = generateReporterToken("session", REPORT_A);
    expect(validateReporterToken("session", REPORT_B, token)).toBe(false);
  });

  it("SEPARATES PURPOSES: an emailed link cannot be replayed as a session, nor a session as a link", () => {
    // An access_link travels through an inbox, a mail relay and a URL bar; a
    // session lives in an httpOnly cookie. Collapsing the two would let a
    // 30-minute mail artefact be presented as a redeemed session (and would let
    // a stolen cookie be turned back into a shareable link).
    const link = generateReporterToken("access_link", REPORT_A);
    const session = generateReporterToken("session", REPORT_A);
    expect(validateReporterToken("session", REPORT_A, link)).toBe(false);
    expect(validateReporterToken("access_link", REPORT_A, session)).toBe(false);
  });

  it("fails closed on garbage, empty and MAC-tampered input instead of throwing", () => {
    // timingSafeEqual throws on unequal lengths; a throw here would be a 500 on
    // a public route rather than a denial.
    for (const bad of ["", ".", "nope", "a.b.c", "....", "AAAA.notanumber"]) {
      expect(validateReporterToken("session", REPORT_A, bad)).toBe(false);
    }
    expect(validateReporterToken("session", "", generateReporterToken("session", ""))).toBe(false);

    const token = generateReporterToken("session", REPORT_A);
    const dot = token.lastIndexOf(".");
    // Tamper the FIRST character AFTER the dot — inside the MAC segment.
    // Two prior versions of this line were dice, not tests:
    //   1. Hardcoding "X" at dot-1 produced an identical token whenever the
    //      original char WAS "X" (~1/64 per run).
    //   2. Flipping X↔Y at dot-1 still validated when the pre-dot segment's
    //      length ≡ 3 (mod 4): base64url's final char there contributes only
    //      its top 2 bits, and X (010111) and Y (011000) share them — the
    //      "tampered" string DECODED to the same bytes (caught by CI while
    //      the local run rolled green, 2026-08-19).
    // A segment's first character always contributes all 6 of its bits, and
    // A↔B differ in the low bit, so the decoded MAC is guaranteed different.
    const macFirst = token[dot + 1];
    const flipped = macFirst === "A" ? "B" : "A";
    const tampered = `${token.slice(0, dot + 1)}${flipped}${token.slice(dot + 2)}`;
    expect(tampered).not.toBe(token); // non-vacuity: the corruption must be real
    expect(validateReporterToken("session", REPORT_A, tampered)).toBe(false);
  });

  it("rejects a token whose timestamp was moved into the FUTURE", () => {
    // A hand-crafted or clock-skewed `ts` must not buy a window longer than the
    // TTL. The MAC covers the timestamp, so this is only reachable by someone
    // who can sign — but the dev-fallback signing key makes that reachable in
    // any non-production environment, which is where staging lives.
    const future = generateReporterToken("session", REPORT_A, Date.now() + 60_000);
    expect(validateReporterToken("session", REPORT_A, future)).toBe(false);
  });
});

describe("token expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the emailed link dies at 30 minutes", () => {
    expect(REPORTER_ACCESS_LINK_TTL_MS).toBe(30 * 60 * 1000);
    const token = generateReporterToken("access_link", REPORT_A);
    vi.advanceTimersByTime(REPORTER_ACCESS_LINK_TTL_MS - 1_000);
    expect(validateReporterToken("access_link", REPORT_A, token)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(validateReporterToken("access_link", REPORT_A, token)).toBe(false);
  });

  it("the session dies at 60 minutes", () => {
    expect(REPORTER_SESSION_TTL_MS).toBe(60 * 60 * 1000);
    const token = generateReporterToken("session", REPORT_A);
    vi.advanceTimersByTime(REPORTER_SESSION_TTL_MS - 1_000);
    expect(validateReporterToken("session", REPORT_A, token)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(validateReporterToken("session", REPORT_A, token)).toBe(false);
  });

  it("a link token does NOT inherit the longer session TTL", () => {
    // The two TTLs differ, so a purpose mix-up would silently triple the life of
    // the artefact that travels through email.
    const link = generateReporterToken("access_link", REPORT_A);
    vi.advanceTimersByTime(REPORTER_ACCESS_LINK_TTL_MS + 1_000);
    expect(validateReporterToken("access_link", REPORT_A, link)).toBe(false);
  });
});

describe("readReporterSessionCookie", () => {
  it("returns the reportId only after verifying the MAC over it", () => {
    const reportId = REPORT_A;
    const raw = encodeReporterSessionCookie(reportId, generateReporterToken("session", reportId));
    expect(readReporterSessionCookie(raw)).toEqual({ reportId });
  });

  it("refuses a cookie whose reportId was swapped — no unauthenticated object reference", () => {
    // The reportId is used to fetch a cruelty complaint. If the parser handed it
    // back without checking the MAC, editing one cookie field would be a read of
    // any denuncia in the country.
    const raw = encodeReporterSessionCookie(REPORT_B, generateReporterToken("session", REPORT_A));
    expect(readReporterSessionCookie(raw)).toBeNull();
  });

  it("refuses missing, empty and malformed cookies", () => {
    for (const bad of [undefined, null, "", "no-dot-here", `.${REPORT_A}`]) {
      expect(readReporterSessionCookie(bad)).toBeNull();
    }
  });

  it("refuses a cookie carrying an access_link token instead of a session token", () => {
    const raw = encodeReporterSessionCookie(
      REPORT_A,
      generateReporterToken("access_link", REPORT_A),
    );
    expect(readReporterSessionCookie(raw)).toBeNull();
  });
});

describe("reporterSessionCookie", () => {
  it("mints a cookie the reader accepts, scoped and httpOnly", () => {
    const c = reporterSessionCookie(REPORT_A);
    expect(c.httpOnly).toBe(true);
    expect(c.path).toBe("/denuncias");
    // lax, not strict: the reporter arrives by clicking a link in their mail
    // client — a cross-site top-level navigation. `strict` would drop the cookie
    // on precisely the hop the whole flow depends on.
    expect(c.sameSite).toBe("lax");
    expect(c.maxAge).toBe(REPORTER_SESSION_TTL_MS / 1000);
    expect(readReporterSessionCookie(c.value)).toEqual({ reportId: REPORT_A });
  });

  it("the deletion form matches the write form on name and path", () => {
    // A cookie deleted under a different path than it was written under silently
    // deletes nothing, and the "Salir" button becomes a button that lies. Both
    // forms come from this one function precisely so they cannot drift.
    const set = reporterSessionCookie(REPORT_A);
    const del = reporterSessionCookie(null);
    expect(del.name).toBe(set.name);
    expect(del.path).toBe(set.path);
    expect(del.maxAge).toBe(0);
    expect(del.value).toBe("");
    expect(readReporterSessionCookie(del.value)).toBeNull();
  });
});

describe("reporterAccessRevoked", () => {
  it("an open denuncia is never revoked", () => {
    expect(reporterAccessRevoked(null)).toBe(false);
    expect(reporterAccessRevoked(undefined)).toBe(false);
  });

  it("survives the close by the grace period, then stops", () => {
    // DELIBERATE DEVIATION from a literal "revoked when the case closes": that
    // would deny the reporter the single fact they are most entitled to — that
    // the state finished, and when. 30 days is long enough that someone who
    // checks monthly still learns the outcome.
    const now = Date.UTC(2026, 5, 1);
    const justClosed = new Date(now - 1_000);
    const longClosed = new Date(now - REPORTER_ACCESS_POST_CLOSE_GRACE_MS - 1_000);
    expect(reporterAccessRevoked(justClosed, now)).toBe(false);
    expect(reporterAccessRevoked(longClosed, now)).toBe(true);
  });

  it("treats an unparseable closedAt as not-closed rather than crashing a public route", () => {
    expect(reporterAccessRevoked("not-a-date")).toBe(false);
  });
});
