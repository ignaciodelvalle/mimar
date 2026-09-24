// `caretakerCommandInputSchema` — what a client may send to
// `POST /me/caretaker-grants`.
//
// THE POINT OF TESTING A SCHEMA THE SERVER ALSO ENFORCES: this is the copy the
// CLIENT runs, before the network, to put a message under the right field. A rule
// only the server knows is a rule the app can only discover from a 400 with no
// field detail.
//
// The two cases a reviewer should read first are `refuses withdraw and return`
// and `dates are Argentine calendar DAYS`. The first is the scope of this whole
// slice expressed as an assertion: the state machine has eight actions, the web
// offers five, and shipping the other three on a phone would be a native-only
// power over somebody else's arrangement. The second is where a timezone bug
// would live if the contract took instants instead of days.

import { describe, expect, it } from "vitest";

import {
  CARETAKER_INVITATION_EXPIRY_DAYS,
  CARETAKER_MAX_DURATION_DAYS,
  CARETAKER_NOTE_MAX,
  caretakerCommandInputSchema,
  firstCaretakerCommandInputCode,
} from "../caretaker.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = caretakerCommandInputSchema.safeParse(body);
  return parsed.success ? null : firstCaretakerCommandInputCode(parsed.error);
}

const DESIGNATE = {
  command: "designate",
  petPublicToken: "DIM-PAMP-0001",
  inviteeEmail: "vecina@example.com",
  startsAt: "2026-09-01",
  endsAt: "2026-09-15",
} as const;

const GRANT = "CG-0123456789abcdef0123456789abcdef";

describe("caretakerCommandInputSchema — the command discriminator", () => {
  it("accepts the five commands the web offers", () => {
    expect(codeFor(DESIGNATE)).toBe(null);
    expect(codeFor({ command: "accept", grantToken: GRANT })).toBe(null);
    expect(codeFor({ command: "reject", grantToken: GRANT })).toBe(null);
    expect(codeFor({ command: "cancel", petPublicToken: "DIM-PAMP-0001", grantToken: GRANT })).toBe(
      null,
    );
    expect(codeFor({ command: "revoke", petPublicToken: "DIM-PAMP-0001", grantToken: GRANT })).toBe(
      null,
    );
    expect(codeFor({})).toBe("COMMAND_REQUIRED");
  });

  it("refuses withdraw and return — neither is reachable from the web", () => {
    // `withdrawCaretakerGrantAction` exists and NOTHING calls it; `return` has no
    // action wrapper at all. Accepting either here would give a phone a way to
    // end an arrangement that a browser cannot, which is not parity — it is a new
    // feature wearing a mirror's clothes, and the screen that should ask "¿y el
    // animal, dónde está?" was never designed because the flow was never built.
    expect(codeFor({ command: "withdraw", grantToken: GRANT })).toBe("COMMAND_REQUIRED");
    expect(codeFor({ command: "return", grantToken: GRANT })).toBe("COMMAND_REQUIRED");
  });

  it("refuses the three CRON actions, which are never a client's to send", () => {
    // A client that could send one would be able to kill somebody else's open
    // invitation, or close a live arrangement, on a clock it does not own.
    expect(codeFor({ command: "expire_invitation", grantToken: GRANT })).toBe("COMMAND_REQUIRED");
    expect(codeFor({ command: "expire_grant", grantToken: GRANT })).toBe("COMMAND_REQUIRED");
    expect(codeFor({ command: "expire", grantToken: GRANT })).toBe("COMMAND_REQUIRED");
  });
});

describe("the pet token", () => {
  it("is required by the three titular commands and refused on the two invitee ones", () => {
    // The asymmetry IS the security shape. `designate`, `cancel` and `revoke` are
    // guarded against the PET (`requireTitularAccess`), so the pet has to be in
    // the body. `accept` and `reject` are sent by somebody who holds no ownership
    // row at all, and accepting a pet token on them would suggest the server
    // reads it — the day it did, the addressee check would have a second, wrong
    // input.
    expect(codeFor({ ...DESIGNATE, petPublicToken: "" })).toBe("PET_TOKEN_REQUIRED");
    expect(codeFor({ command: "cancel", grantToken: GRANT })).toBe("PET_TOKEN_REQUIRED");
    expect(codeFor({ command: "revoke", grantToken: GRANT })).toBe("PET_TOKEN_REQUIRED");

    const accept = caretakerCommandInputSchema.safeParse({
      command: "accept",
      grantToken: GRANT,
      petPublicToken: "DIM-PAMP-0001",
    });
    expect(accept.success).toBe(true);
    expect(accept.success && "petPublicToken" in accept.data).toBe(false);
  });
});

describe("the grant token", () => {
  it("is a bound, not a format", () => {
    // `CG-` + 32 hex today. A format check here would be a second copy of
    // `newGrantToken` in a package that cannot import it, drifting silently the
    // day the token changes. What a bad string gets is `not_found` / 404.
    expect(codeFor({ command: "accept", grantToken: "not-a-real-token" })).toBe(null);
    expect(codeFor({ command: "accept", grantToken: "" })).toBe("GRANT_TOKEN_REQUIRED");
    expect(codeFor({ command: "accept", grantToken: "x".repeat(65) })).toBe("GRANT_TOKEN_REQUIRED");
  });
});

describe("dates are Argentine calendar DAYS, never instants", () => {
  it("takes YYYY-MM-DD and refuses an ISO instant", () => {
    // An instant on the wire would move the boundary decision onto the phone,
    // where a device in another zone computes a different one for the same picked
    // day. The server owns what "hasta el 15/09" means: the LAST instant of the
    // 15th, Argentine time.
    expect(codeFor({ ...DESIGNATE, endsAt: "2026-09-15T23:59:59.999Z" })).toBe("DATE_INVALID");
    expect(codeFor({ ...DESIGNATE, endsAt: "15/09/2026" })).toBe("DATE_INVALID");
    expect(codeFor({ ...DESIGNATE, startsAt: "" })).toBe("DATE_INVALID");
  });

  it("refuses a day that does not exist, on either end", () => {
    // THE REGEX IS NOT THE WHOLE CHECK. `2026-02-31` matches it, and
    // `parseArDateEndOfDay` — what the writers use — ROLLS IT OVER to the 3rd of
    // March (measured 2026-08-26), so a period meant to close on the 28th would
    // have closed three days later. `isRealArDay` is imported from the same place
    // `record-event.ts` gets it, so there is one calendar in this package.
    expect(codeFor({ ...DESIGNATE, endsAt: "2026-02-31" })).toBe("DATE_INVALID");
    expect(codeFor({ ...DESIGNATE, startsAt: "2027-02-29" })).toBe("DATE_INVALID");
    expect(codeFor({ ...DESIGNATE, endsAt: "2026-13-01" })).toBe("DATE_INVALID");
  });

  it("still accepts a REAL leap day", () => {
    // The other half: 2028 is a leap year, so the 29th exists and must go
    // through. A check that refused it would be a wrong calendar, not a strict one.
    expect(codeFor({ ...DESIGNATE, startsAt: "2028-02-29", endsAt: "2028-03-10" })).toBe(null);
  });

  it("does not enforce the 180-day cap either — that rule needs a clock", () => {
    // `validateDesignation` compares against `now`, which a wire schema does not
    // have. The constant is exported so a picker can be bounded BEFORE the round
    // trip; the rule stays where it is enforced.
    expect(codeFor({ ...DESIGNATE, startsAt: "2026-01-01", endsAt: "2030-01-01" })).toBe(null);
  });
});

describe("the invitee address", () => {
  it("is checked for shape and lowercased, never for existence", () => {
    // Answering "that account does not exist" would turn this endpoint into an
    // oracle over the user table.
    const parsed = caretakerCommandInputSchema.safeParse({
      ...DESIGNATE,
      inviteeEmail: "  Vecina@Example.COM ",
    });
    expect(parsed.success && parsed.data.command === "designate" && parsed.data.inviteeEmail).toBe(
      "vecina@example.com",
    );
    expect(codeFor({ ...DESIGNATE, inviteeEmail: "vecina" })).toBe("EMAIL_INVALID");
    expect(codeFor({ ...DESIGNATE, inviteeEmail: "" })).toBe("EMAIL_INVALID");
  });
});

describe("the note", () => {
  it("is optional, bounded, and normalises blank to null", () => {
    expect(codeFor({ ...DESIGNATE, note: "x".repeat(CARETAKER_NOTE_MAX) })).toBe(null);
    expect(codeFor({ ...DESIGNATE, note: "x".repeat(CARETAKER_NOTE_MAX + 1) })).toBe(
      "NOTE_TOO_LONG",
    );
    for (const blank of [undefined, null, "   "]) {
      const parsed = caretakerCommandInputSchema.safeParse({ ...DESIGNATE, note: blank });
      expect(parsed.success && parsed.data.command === "designate" && parsed.data.note).toBe(null);
    }
  });

  it("rides designate alone — the other four carry no free text", () => {
    const accept = caretakerCommandInputSchema.safeParse({
      command: "accept",
      grantToken: GRANT,
      note: "no",
    });
    expect(accept.success && "note" in accept.data).toBe(false);
  });
});

describe("the consent flag", () => {
  it("is optional and absent means NOT consented", () => {
    // An unticked checkbox sends no field, and silence is never consent. What it
    // gates is a third party's name and phone on an unauthenticated page.
    const silent = caretakerCommandInputSchema.safeParse({ command: "accept", grantToken: GRANT });
    expect(
      silent.success && silent.data.command === "accept" && silent.data.publicContactConsent,
    ).toBe(undefined);

    const given = caretakerCommandInputSchema.safeParse({
      command: "accept",
      grantToken: GRANT,
      publicContactConsent: true,
    });
    expect(
      given.success && given.data.command === "accept" && given.data.publicContactConsent,
    ).toBe(true);
  });

  it("rides accept alone — no later request can collect it", () => {
    // The repository writes it in the same UPDATE as the status flip, because a
    // CHECK constraint forbids a consent timestamp on a `pending` row.
    const reject = caretakerCommandInputSchema.safeParse({
      command: "reject",
      grantToken: GRANT,
      publicContactConsent: true,
    });
    expect(reject.success && "publicContactConsent" in reject.data).toBe(false);
  });
});

describe("the mirrored constants", () => {
  it("carry the numbers the domain enforces", () => {
    // Pinned so a change in `src/modules/caretakers/domain/types.ts` that forgets
    // this file is a red test rather than a picker that offers a date the server
    // refuses.
    expect(CARETAKER_MAX_DURATION_DAYS).toBe(180);
    expect(CARETAKER_INVITATION_EXPIRY_DAYS).toBe(7);
    expect(CARETAKER_NOTE_MAX).toBe(500);
  });
});
