// `transferCommandInputSchema` — what a client may send to `POST /me/transfers`.
//
// THE POINT OF TESTING A SCHEMA THE SERVER ALSO ENFORCES: this is the copy the
// CLIENT runs, before the network, to put a message under the right field. A
// rule only the server knows is a rule the app can only discover from a 400 with
// no field detail.
//
// The case a reviewer should read first is `carries the pet token in the BODY`.
// Every other write on this surface names its animal in the URL, and the reason
// this one does not is the whole security shape of transfers: three of the four
// commands are sent by somebody who does not hold the pet. A test that let the
// pet token drift into a path segment would be the first step back towards
// authorising these commands with a custody check.

import { describe, expect, it } from "vitest";

import {
  OWNER_TRANSFER_REASONS,
  TRANSFER_EXPIRY_DAYS,
  TRANSFER_NOTE_MAX,
  firstTransferCommandInputCode,
  transferCommandInputSchema,
} from "../transfer.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = transferCommandInputSchema.safeParse(body);
  return parsed.success ? null : firstTransferCommandInputCode(parsed.error);
}

const INITIATE = {
  command: "initiate",
  petPublicToken: "DIM-PAMP-0001",
  toEmail: "vecina@example.com",
  reason: "gift",
} as const;

describe("transferCommandInputSchema — the command discriminator", () => {
  it("accepts the four commands and nothing else", () => {
    expect(codeFor(INITIATE)).toBe(null);
    expect(codeFor({ command: "accept", transferToken: "PTR-ABCD-2345" })).toBe(null);
    expect(codeFor({ command: "reject", transferToken: "PTR-ABCD-2345" })).toBe(null);
    expect(codeFor({ command: "cancel", transferToken: "PTR-ABCD-2345" })).toBe(null);

    // `expire` is a CRON action, never a client command. A client that could
    // send it would be able to kill somebody else's open proposal.
    expect(codeFor({ command: "expire", transferToken: "PTR-ABCD-2345" })).toBe("COMMAND_REQUIRED");
    expect(codeFor({})).toBe("COMMAND_REQUIRED");
  });

  it("carries the pet token in the BODY, and only for initiate", () => {
    // The three token-addressed commands do not name an animal at all — the row
    // does. Accepting a `petPublicToken` on them would suggest the server reads
    // it, and the day somebody made it do so, the addressee check would have a
    // second, wrong input.
    const accept = transferCommandInputSchema.safeParse({
      command: "accept",
      transferToken: "PTR-ABCD-2345",
      petPublicToken: "DIM-PAMP-0001",
    });
    expect(accept.success).toBe(true);
    expect(accept.success && "petPublicToken" in accept.data).toBe(false);

    expect(codeFor({ ...INITIATE, petPublicToken: "" })).toBe("PET_TOKEN_REQUIRED");
    expect(codeFor({ ...INITIATE, petPublicToken: undefined })).toBe("PET_TOKEN_REQUIRED");
  });
});

describe("initiate", () => {
  it("requires a recipient address that is at least shaped like one", () => {
    expect(codeFor({ ...INITIATE, toEmail: "vecina" })).toBe("EMAIL_INVALID");
    expect(codeFor({ ...INITIATE, toEmail: "vecina@example" })).toBe("EMAIL_INVALID");
    expect(codeFor({ ...INITIATE, toEmail: "" })).toBe("EMAIL_INVALID");
    expect(codeFor({ ...INITIATE, toEmail: 42 })).toBe("EMAIL_INVALID");
  });

  it("lowercases and trims the address, because the accept side matches on it", () => {
    // `validateRecipientMatch` compares `toOwnerEmail.toLowerCase()` against the
    // caller's session e-mail. A stored address with a capital letter would
    // still match there — but the row is also what the SENDER reads back, and
    // two spellings of one address in one list is a person wondering whether
    // they sent it twice.
    const parsed = transferCommandInputSchema.safeParse({
      ...INITIATE,
      toEmail: "  Vecina@Example.COM  ",
    });
    expect(parsed.success && parsed.data.command === "initiate" && parsed.data.toEmail).toBe(
      "vecina@example.com",
    );
  });

  it("requires a reason from the four, though the column is nullable", () => {
    for (const reason of OWNER_TRANSFER_REASONS) {
      expect(codeFor({ ...INITIATE, reason })).toBe(null);
    }
    expect(codeFor({ ...INITIATE, reason: "adoption" })).toBe("REASON_INVALID");
    expect(codeFor({ ...INITIATE, reason: undefined })).toBe("REASON_INVALID");
    expect(codeFor({ ...INITIATE, reason: null })).toBe("REASON_INVALID");
  });

  it("treats an absent, blank and null note as the same thing", () => {
    for (const note of [undefined, null, "", "   "]) {
      const parsed = transferCommandInputSchema.safeParse({ ...INITIATE, note });
      expect(parsed.success && parsed.data.command === "initiate" && parsed.data.note).toBe(null);
    }
  });

  it("bounds the note where the web only styles it", () => {
    expect(codeFor({ ...INITIATE, note: "x".repeat(TRANSFER_NOTE_MAX) })).toBe(null);
    expect(codeFor({ ...INITIATE, note: "x".repeat(TRANSFER_NOTE_MAX + 1) })).toBe("NOTE_TOO_LONG");
  });
});

describe("the token-addressed three", () => {
  it("refuses a missing or empty handle rather than looking one up", () => {
    for (const command of ["accept", "reject", "cancel"] as const) {
      expect(codeFor({ command })).toBe("TRANSFER_TOKEN_REQUIRED");
      expect(codeFor({ command, transferToken: "" })).toBe("TRANSFER_TOKEN_REQUIRED");
      expect(codeFor({ command, transferToken: "   " })).toBe("TRANSFER_TOKEN_REQUIRED");
      expect(codeFor({ command, transferToken: "x".repeat(65) })).toBe("TRANSFER_TOKEN_REQUIRED");
    }
  });

  it("does NOT enumerate the PTR shape — that is the server's lookup, not ours", () => {
    // A format check here would be a second copy of `generatePrefixedToken`,
    // in a package that cannot import it, drifting silently the day the token
    // gains a segment. What a bad string gets is `not_found` / 404 — the shared
    // code the refusal table maps "Transferencia no encontrada." onto.
    expect(codeFor({ command: "accept", transferToken: "not-a-real-token" })).toBe(null);
  });

  it("carries an optional reason on reject and on nothing else", () => {
    expect(codeFor({ command: "reject", transferToken: "PTR-ABCD-2345", reason: null })).toBe(null);
    expect(
      codeFor({
        command: "reject",
        transferToken: "PTR-ABCD-2345",
        reason: "x".repeat(TRANSFER_NOTE_MAX + 1),
      }),
    ).toBe("NOTE_TOO_LONG");

    const accept = transferCommandInputSchema.safeParse({
      command: "accept",
      transferToken: "PTR-ABCD-2345",
      reason: "porque sí",
    });
    expect(accept.success && "reason" in accept.data).toBe(false);
  });
});

describe("the mirrored constants", () => {
  // Both exist so a client can write its own copy without inventing a number.
  // Neither is the rule; both are checked here so a change is deliberate.
  it("keeps the seven-day window and the 500-character bound", () => {
    expect(TRANSFER_EXPIRY_DAYS).toBe(7);
    expect(TRANSFER_NOTE_MAX).toBe(500);
  });

  it("keeps the four reasons the column's CHECK constraint allows", () => {
    expect([...OWNER_TRANSFER_REASONS]).toEqual(["sale", "gift", "inheritance", "other"]);
  });
});
