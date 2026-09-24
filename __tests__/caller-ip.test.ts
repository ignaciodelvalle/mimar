// Unit tests for callerIp() — lib/rate-limit.ts
//
// callerIp() must return a TRUSTED IP, not a client-controlled one.
//攻撃 vector: the first segment of x-forwarded-for is set by the client.
// An attacker can rotate it to get a fresh rate-limit bucket per request.
//
// Trust order (Vercel / standard reverse proxy):
//   1. x-real-ip  — edge-set, not forwarded from the client. MEASURED on Vercel
//      2026-08-26; an origin with no rewriting proxy believes whatever arrives.
//   2. last segment of x-forwarded-for — assumed edge-appended. UNMEASURED.
//   3. "unknown"  — no proxy headers (local dev / direct invocation).
//
// WHAT THESE TESTS CAN AND CANNOT PIN. They pin the PARSING — last non-empty
// segment, never the first, x-real-ip outranking both. They cannot pin what a
// CDN writes into either header; that is a live-origin measurement, and both its
// result and the run still owed for source 2 are documented in
// lib/infra/rate-limit.ts above callerIp(). A green file here is not evidence
// that a header is trustworthy.

import { describe, expect, it } from "vitest";

import { callerIp, callerSubject } from "@/lib/infra/rate-limit";

// ---------------------------------------------------------------------------
// Minimal header-getter factory (matches the HeaderGetter interface)
// ---------------------------------------------------------------------------

function makeHeaders(map: Record<string, string | undefined>) {
  return {
    get(name: string): string | null {
      return map[name.toLowerCase()] ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callerIp()", () => {
  it("returns x-real-ip when present — preferred trusted source", () => {
    const hdrs = makeHeaders({ "x-real-ip": "203.0.113.1" });
    expect(callerIp(hdrs)).toBe("203.0.113.1");
  });

  it("trims whitespace from x-real-ip", () => {
    const hdrs = makeHeaders({ "x-real-ip": "  203.0.113.1  " });
    expect(callerIp(hdrs)).toBe("203.0.113.1");
  });

  it("falls back to the LAST segment of x-forwarded-for when x-real-ip is absent", () => {
    // The last hop is edge-appended — trusted.
    const hdrs = makeHeaders({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" });
    expect(callerIp(hdrs)).toBe("9.10.11.12");
  });

  it("trims whitespace from the last XFF segment", () => {
    const hdrs = makeHeaders({ "x-forwarded-for": "1.2.3.4,  9.10.11.12  " });
    expect(callerIp(hdrs)).toBe("9.10.11.12");
  });

  it("does NOT return the first XFF segment (the spoofable client-controlled value)", () => {
    // Attacker sends X-Forwarded-For: FAKE, <real-edge-ip>
    // We must return the LAST segment, not the attacker-supplied first one.
    const hdrs = makeHeaders({ "x-forwarded-for": "FAKE-ATTACKER-IP, 192.0.2.99" });
    const result = callerIp(hdrs);
    expect(result).not.toBe("FAKE-ATTACKER-IP");
    expect(result).toBe("192.0.2.99");
  });

  it("handles a single-segment x-forwarded-for (no proxy chain)", () => {
    const hdrs = makeHeaders({ "x-forwarded-for": "198.51.100.7" });
    expect(callerIp(hdrs)).toBe("198.51.100.7");
  });

  it("returns 'unknown' when neither x-real-ip nor x-forwarded-for is present", () => {
    const hdrs = makeHeaders({});
    expect(callerIp(hdrs)).toBe("unknown");
  });

  it("returns 'unknown' when x-forwarded-for is an empty string", () => {
    const hdrs = makeHeaders({ "x-forwarded-for": "" });
    expect(callerIp(hdrs)).toBe("unknown");
  });

  it("returns 'unknown' when x-forwarded-for contains only whitespace/commas", () => {
    const hdrs = makeHeaders({ "x-forwarded-for": " , , " });
    expect(callerIp(hdrs)).toBe("unknown");
  });

  // ---------------------------------------------------------------------------
  // Spoof scenario: attacker sends X-Forwarded-For but x-real-ip is present
  // ---------------------------------------------------------------------------

  it("SPOOF SCENARIO: x-real-ip wins over spoofed XFF first segment", () => {
    // Attacker sends: X-Forwarded-For: 1.2.3.4, <real-edge-ip>
    // Edge also sets: X-Real-IP: <real-edge-ip>
    // callerIp() must return x-real-ip, NOT 1.2.3.4.
    const hdrs = makeHeaders({
      "x-forwarded-for": "1.2.3.4, 203.0.113.99",
      "x-real-ip": "203.0.113.99",
    });
    const result = callerIp(hdrs);
    expect(result).toBe("203.0.113.99");
    expect(result).not.toBe("1.2.3.4");
  });
});

// ---------------------------------------------------------------------------
// WHO a bucket is about: an IPv6 caller is its /64, not one address
// ---------------------------------------------------------------------------
//
// One IPv6 host owns a whole /64 and picks (and rotates) its own interface
// identifier inside it, so a limiter keyed on the full address handed one
// machine 2^64 fresh buckets. The expected subjects below are written out by
// hand, not computed, so a normaliser that drifts cannot agree with itself.

describe("callerSubject() / callerIp() — IPv6 grouped by /64", () => {
  const SAME_64 = [
    "2001:db8:abcd:12::1",
    "2001:0db8:abcd:0012:0000:0000:0000:0001",
    "2001:DB8:ABCD:12:ffff:ffff:ffff:ffff",
    "2001:db8:abcd:12:a1b2:c3d4:e5f6:789",
    "[2001:db8:abcd:12::7]",
    "2001:db8:abcd:12::7%eth0",
  ];

  it("keys every spelling of one /64 on the same subject", () => {
    for (const spelling of SAME_64) {
      expect(callerSubject(spelling), spelling).toBe("2001:db8:abcd:12::/64");
    }
  });

  it("keeps two different /64s apart, even inside the same /48", () => {
    expect(callerSubject("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(callerSubject("2001:db8:abcd:13::1")).toBe("2001:db8:abcd:13::/64");
  });

  it("expands a compressed prefix before cutting it", () => {
    // `::` inside the first four groups: the /64 is 2001:db8:0:0.
    expect(callerSubject("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(callerSubject("2001:db8:0:0:1::2")).toBe("2001:db8:0:0::/64");
    expect(callerSubject("::1")).toBe("0:0:0:0::/64");
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 caller it is", () => {
    expect(callerSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(callerSubject("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(callerSubject("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(callerSubject("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("leaves IPv4 per address", () => {
    expect(callerSubject("203.0.113.7")).toBe("203.0.113.7");
    expect(callerSubject("203.0.113.8")).toBe("203.0.113.8");
  });

  it("returns anything unparseable exactly as it arrived (today's behaviour)", () => {
    for (const garbage of [
      "unknown",
      "not-an-ip",
      "2001:db8:::1",
      "2001:db8::1::2",
      "1:2:3:4:5:6:7:8:9",
      "2001:db8:zzzz::1",
      "::ffff:999.0.0.1",
      "999.1.1.1",
      "1.2.3",
    ]) {
      expect(callerSubject(garbage), garbage).toBe(garbage);
    }
  });

  it("applies to both trusted sources", () => {
    expect(callerIp(makeHeaders({ "x-real-ip": " 2001:db8:abcd:12::99 " }))).toBe(
      "2001:db8:abcd:12::/64",
    );
    expect(callerIp(makeHeaders({ "x-forwarded-for": "1.2.3.4, 2001:0db8:abcd:0012::5" }))).toBe(
      "2001:db8:abcd:12::/64",
    );
    expect(callerIp(makeHeaders({ "x-real-ip": "::ffff:198.51.100.4" }))).toBe("198.51.100.4");
    expect(callerIp(makeHeaders({}))).toBe("unknown");
  });
});
