// Unit tests for owner-transfer-rules.ts — pure, no DB.
// Written FIRST (RED phase, task 1.2) before creating owner-transfer-rules.ts.

import { describe, expect, it } from "vitest";

import {
  computeTransferExpiresAt,
  isValidTransferEmail,
  resolveRecipientMatch,
  validateOwnerTransferReason,
  validatePetStatusForTransfer,
  validateRecipientMatch,
  validateSelfTransfer,
} from "../owner-transfer-rules";

// ---------------------------------------------------------------------------
// isValidTransferEmail
// ---------------------------------------------------------------------------

describe("isValidTransferEmail", () => {
  it("returns true for a valid email", () => {
    expect(isValidTransferEmail("user@example.com")).toBe(true);
  });

  it("returns true for emails with subdomains", () => {
    expect(isValidTransferEmail("a@b.co.ar")).toBe(true);
  });

  it("returns false for missing @", () => {
    expect(isValidTransferEmail("notanemail")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidTransferEmail("")).toBe(false);
  });

  it("returns false for only spaces", () => {
    expect(isValidTransferEmail("   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateOwnerTransferReason
// ---------------------------------------------------------------------------

describe("validateOwnerTransferReason", () => {
  it("accepts 'sale'", () => {
    expect(validateOwnerTransferReason("sale")).toMatchObject({ ok: true, value: "sale" });
  });

  it("accepts 'gift'", () => {
    expect(validateOwnerTransferReason("gift")).toMatchObject({ ok: true, value: "gift" });
  });

  it("accepts 'inheritance'", () => {
    expect(validateOwnerTransferReason("inheritance")).toMatchObject({
      ok: true,
      value: "inheritance",
    });
  });

  it("accepts 'other'", () => {
    expect(validateOwnerTransferReason("other")).toMatchObject({ ok: true, value: "other" });
  });

  it("rejects an invalid reason", () => {
    expect(validateOwnerTransferReason("random")).toMatchObject({
      ok: false,
      error: "Motivo inválido.",
    });
  });

  it("rejects empty string", () => {
    expect(validateOwnerTransferReason("")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validatePetStatusForTransfer
// ---------------------------------------------------------------------------

describe("validatePetStatusForTransfer", () => {
  it("passes for an active pet with no dispute", () => {
    expect(
      validatePetStatusForTransfer({ status: "active", inCustodyDispute: false }),
    ).toMatchObject({ ok: true });
  });

  it("fails for a deceased pet", () => {
    expect(
      validatePetStatusForTransfer({ status: "deceased", inCustodyDispute: false }),
    ).toMatchObject({ ok: false, error: "No podés transferir una mascota fallecida." });
  });

  it("fails for a lost pet", () => {
    expect(validatePetStatusForTransfer({ status: "lost", inCustodyDispute: false })).toMatchObject(
      { ok: false, error: expect.stringContaining("perdida") },
    );
  });

  it("fails when custody dispute is open", () => {
    expect(
      validatePetStatusForTransfer({ status: "active", inCustodyDispute: true }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("disputa") });
  });
});

// ---------------------------------------------------------------------------
// validateSelfTransfer
// ---------------------------------------------------------------------------

describe("validateSelfTransfer", () => {
  it("passes when caller and recipient are different users", () => {
    expect(validateSelfTransfer("user-a", "user-b")).toMatchObject({ ok: true });
  });

  it("fails when caller and recipient are the same user", () => {
    expect(validateSelfTransfer("user-a", "user-a")).toMatchObject({
      ok: false,
      error: expect.stringContaining("vos mismo"),
    });
  });
});

// ---------------------------------------------------------------------------
// validateRecipientMatch
// ---------------------------------------------------------------------------

describe("validateRecipientMatch", () => {
  it("matches when toOwnerId equals callerId", () => {
    expect(
      validateRecipientMatch({
        toOwnerId: "abc",
        toOwnerEmail: "other@example.com",
        callerId: "abc",
        callerEmail: "caller@example.com",
        callerEmailConfirmed: true,
      }),
    ).toBe(true);
  });

  it("matches when toOwnerId is null and emails match (case-insensitive)", () => {
    expect(
      validateRecipientMatch({
        toOwnerId: null,
        toOwnerEmail: "Recipient@Example.com",
        callerId: "xyz",
        callerEmail: "recipient@example.com",
        callerEmailConfirmed: true,
      }),
    ).toBe(true);
  });

  it("does NOT match on email when toOwnerId is set (even if email matches)", () => {
    expect(
      validateRecipientMatch({
        toOwnerId: "different-id",
        toOwnerEmail: "recipient@example.com",
        callerId: "caller-id",
        callerEmail: "recipient@example.com",
        callerEmailConfirmed: true,
      }),
    ).toBe(false);
  });

  it("returns false when neither id nor email match", () => {
    expect(
      validateRecipientMatch({
        toOwnerId: null,
        toOwnerEmail: "other@example.com",
        callerId: "xyz",
        callerEmail: "caller@example.com",
        callerEmailConfirmed: true,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveRecipientMatch — the confirmed-address term (audit A09-1)
// ---------------------------------------------------------------------------
//
// The exploit this closes, in one sentence: Alice offers her dog to an address
// with no account; Mallory, who knows the address, registers it and accepts.
// The e-mail arm was a bare string compare, so "I typed this address" counted as
// "I read this mailbox". These cases pin the three answers that separate them.

describe("resolveRecipientMatch — the e-mail arm needs a proved address", () => {
  const OPEN_INVITATION = {
    toOwnerId: null,
    toOwnerEmail: "recipient@example.com",
    callerId: "mallory",
  };

  it("answers 'email' for an addressee whose address is confirmed", () => {
    expect(
      resolveRecipientMatch({
        ...OPEN_INVITATION,
        callerEmail: "recipient@example.com",
        callerEmailConfirmed: true,
      }),
    ).toBe("email");
  });

  it("answers 'email_unconfirmed' — NOT a match — when the address was never proved", () => {
    expect(
      resolveRecipientMatch({
        ...OPEN_INVITATION,
        callerEmail: "recipient@example.com",
        callerEmailConfirmed: false,
      }),
    ).toBe("email_unconfirmed");
  });

  it("keeps case-insensitivity on the confirmed arm", () => {
    expect(
      resolveRecipientMatch({
        toOwnerId: null,
        toOwnerEmail: "Recipient@Example.COM",
        callerId: "xyz",
        callerEmail: "  RECIPIENT@example.com  ",
        callerEmailConfirmed: true,
      }),
    ).toBe("email");
  });

  it("leaves the ID arm untouched: an unconfirmed address still matches by id", () => {
    // The id was resolved by the SENDER at initiate time against an existing
    // account. It is not a claim about a mailbox, so the new term must not
    // narrow it — doing so would lock out every ordinary recipient.
    expect(
      resolveRecipientMatch({
        toOwnerId: "abc",
        toOwnerEmail: "other@example.com",
        callerId: "abc",
        callerEmail: "caller@example.com",
        callerEmailConfirmed: false,
      }),
    ).toBe("id");
  });

  it("answers 'no_match' for a confirmed address that is simply not the addressee", () => {
    expect(
      resolveRecipientMatch({
        ...OPEN_INVITATION,
        callerEmail: "somebody-else@example.com",
        callerEmailConfirmed: true,
      }),
    ).toBe("no_match");
  });

  it("never matches an EMPTY caller address, confirmed or not", () => {
    // Removes the reliance on `to_owner_email` being non-empty by side effect of
    // a NOT NULL column (A11 nit).
    for (const callerEmailConfirmed of [true, false]) {
      expect(
        resolveRecipientMatch({
          toOwnerId: null,
          toOwnerEmail: "",
          callerId: "xyz",
          callerEmail: "",
          callerEmailConfirmed,
        }),
      ).toBe("no_match");
    }
  });

  it("validateRecipientMatch is false for the unconfirmed arm and true for the confirmed one", () => {
    const base = { ...OPEN_INVITATION, callerEmail: "recipient@example.com" };
    expect(validateRecipientMatch({ ...base, callerEmailConfirmed: false })).toBe(false);
    expect(validateRecipientMatch({ ...base, callerEmailConfirmed: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeTransferExpiresAt
// ---------------------------------------------------------------------------

describe("computeTransferExpiresAt", () => {
  it("returns a date exactly 7 days after the given now", () => {
    const now = new Date("2024-01-01T00:00:00.000Z");
    const expires = computeTransferExpiresAt(now);
    const diffDays = (expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(7);
  });

  it("works for a different base date (triangulation)", () => {
    const now = new Date("2025-06-15T12:00:00.000Z");
    const expires = computeTransferExpiresAt(now);
    expect(expires.getTime()).toBe(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  });
});
