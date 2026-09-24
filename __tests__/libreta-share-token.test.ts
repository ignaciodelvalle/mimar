// Unit tests for the pure validateShareToken helper. No DB needed — the
// integration tests in __tests__/libreta-share.test.ts cover the full
// create/revoke/view-logging round-trip.

import { describe, expect, it } from "vitest";

import { validateShareToken } from "@/lib/infra/libreta-share-token";

const NOW = new Date("2026-05-27T12:00:00Z");
const PAST = new Date("2026-05-26T00:00:00Z");
const FUTURE = new Date("2026-06-01T00:00:00Z");

describe("validateShareToken", () => {
  it("returns not_found when the token is null or undefined", () => {
    expect(validateShareToken(null, NOW)).toBe("not_found");
    expect(validateShareToken(undefined, NOW)).toBe("not_found");
  });

  it("returns revoked when revokedAt is set", () => {
    expect(validateShareToken({ revokedAt: PAST, expiresAt: FUTURE }, NOW)).toBe("revoked");
  });

  it("revoked takes precedence over expired", () => {
    // A deliberate revoke must always win — owners rely on revocation as the
    // hard stop, regardless of the token's natural expiry.
    expect(validateShareToken({ revokedAt: PAST, expiresAt: PAST }, NOW)).toBe("revoked");
  });

  it("returns expired when expiresAt is in the past and not revoked", () => {
    expect(validateShareToken({ revokedAt: null, expiresAt: PAST }, NOW)).toBe("expired");
  });

  it("returns valid for a token with future expiry and no revoke", () => {
    expect(validateShareToken({ revokedAt: null, expiresAt: FUTURE }, NOW)).toBe("valid");
  });

  it("returns valid when expiresAt is null (open-ended share)", () => {
    expect(validateShareToken({ revokedAt: null, expiresAt: null }, NOW)).toBe("valid");
  });

  it("treats the exact expiry instant as still valid (strict less-than)", () => {
    expect(validateShareToken({ revokedAt: null, expiresAt: NOW }, NOW)).toBe("valid");
  });
});
