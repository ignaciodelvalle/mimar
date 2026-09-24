// `appointmentCommandInputSchema` — what a client may send to
// `POST /me/appointments`.
//
// THE POINT OF TESTING A SCHEMA THE SERVER ALSO ENFORCES: this is the copy the
// CLIENT runs, before the network, to put a message under the right field. A rule
// only the server knows is a rule the app can only discover from a 400 with no
// field detail.
//
// The case a reviewer should read first is `refuses the three provider commands`.
// It is the scope of this whole slice expressed as an assertion: the booking
// feature has four writes, three of them belong to the clinic's own agenda
// screen, and shipping any of them on a citizen's phone would be a wallet acting
// on somebody else's turno.
//
// THE FOURTH — `book` — USED TO BE REFUSED HERE AND NOW PARSES. That case had a
// name and a paragraph ("scope rather than a rule … so that adding it later is a
// deliberate edit here rather than something that quietly starts parsing"), and
// this is that deliberate edit. It is REPLACED rather than deleted: the block
// below asserts what the command accepts and what it refuses, so the three
// provider commands are still the only members this union will not take.

import { describe, expect, it } from "vitest";

import {
  APPOINTMENT_COMMAND_INPUT_CODES,
  appointmentCommandInputSchema,
  firstAppointmentCommandInputCode,
} from "../appointment.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = appointmentCommandInputSchema.safeParse(body);
  return parsed.success ? null : firstAppointmentCommandInputCode(parsed.error);
}

const TOKEN = "APT-7K2M-9QX4";
const SLOT = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const PET = "DIM-PAMP-0001";

describe("appointmentCommandInputSchema — the command discriminator", () => {
  it("accepts the two commands the owner's browser offers", () => {
    expect(codeFor({ command: "cancel", appointmentToken: TOKEN })).toBe(null);
    expect(codeFor({ command: "book", slotId: SLOT, petPublicToken: PET })).toBe(null);
  });

  it("names a missing command rather than falling through to null", () => {
    // A `null` here would mean the parse failed on something the vocabulary does
    // not cover, and the app's copy for that says "hay un campo que no pudimos
    // interpretar" — useless for a body with no command at all.
    expect(codeFor({})).toBe("COMMAND_REQUIRED");
    expect(codeFor({ appointmentToken: TOKEN })).toBe("COMMAND_REQUIRED");
    expect(codeFor(null)).toBe("COMMAND_REQUIRED");
  });

  it("refuses the three provider commands — none is reachable from an owner's browser", () => {
    // `markAppointmentAttended`, `markAppointmentNoShow` and
    // `cancelAppointmentByOrg` all live behind `/org/{token}/agenda` and are
    // guarded against org membership. Accepting any of them here would give a
    // citizen wallet a power no owner's browser has, over a turno that is only
    // half theirs.
    expect(codeFor({ command: "attend", appointmentToken: TOKEN })).toBe("COMMAND_REQUIRED");
    expect(codeFor({ command: "no_show", appointmentToken: TOKEN })).toBe("COMMAND_REQUIRED");
    expect(codeFor({ command: "cancel_by_org", appointmentToken: TOKEN })).toBe("COMMAND_REQUIRED");
  });

  it("still refuses a `book` whose slot is not uuid-shaped", () => {
    // The predecessor of this case asserted that `book` did not parse AT ALL, with
    // `slotId: "…"`. That body must still be refused now that the command exists,
    // and for a reason one level down: the union takes the command and the FIELD
    // refuses the value. Without this, "the schema stopped rejecting nonsense"
    // would look identical to "the command landed".
    expect(codeFor({ command: "book", slotId: "…", petPublicToken: "…" })).toBe("SLOT_REQUIRED");
  });
});

describe("appointmentCommandInputSchema — booking's two fields", () => {
  it("refuses an absent, empty or non-uuid slot", () => {
    expect(codeFor({ command: "book", petPublicToken: PET })).toBe("SLOT_REQUIRED");
    expect(codeFor({ command: "book", slotId: "", petPublicToken: PET })).toBe("SLOT_REQUIRED");
    expect(codeFor({ command: "book", slotId: 42, petPublicToken: PET })).toBe("SLOT_REQUIRED");
    // Uuid-SHAPED and nothing more. The slot's existence, its capacity, its
    // offering's status and the future window are all re-resolved inside the
    // booking transaction under an advisory lock, so this is a typo check.
    expect(codeFor({ command: "book", slotId: `${SLOT}x`, petPublicToken: PET })).toBe(
      "SLOT_REQUIRED",
    );
  });

  it("refuses an absent or blank pet, and does NOT pin the token's format", () => {
    expect(codeFor({ command: "book", slotId: SLOT })).toBe("PET_REQUIRED");
    expect(codeFor({ command: "book", slotId: SLOT, petPublicToken: "   " })).toBe("PET_REQUIRED");
    // `DIM-XXXX-XXXX` is NOT asserted, for `appointmentToken`'s reason: a client
    // must not validate its own server's output format, or the contract refuses a
    // token the server legitimately minted the day the generator changes.
    expect(codeFor({ command: "book", slotId: SLOT, petPublicToken: "whatever" })).toBe(null);
  });

  it("trims both, so a value pasted with whitespace still reaches the server clean", () => {
    const parsed = appointmentCommandInputSchema.safeParse({
      command: "book",
      slotId: `  ${SLOT}\n`,
      petPublicToken: ` ${PET} `,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.command === "book") {
      expect(parsed.data.slotId).toBe(SLOT);
      expect(parsed.data.petPublicToken).toBe(PET);
    }
  });

  it("drops an `appointmentToken` sent alongside a book, rather than carrying it through", () => {
    // The shape a client would produce by editing a cancel body into a booking
    // one. zod's object parse strips unknown keys, so the writer never sees a
    // field the command has no use for — asserted because "it happens to be
    // ignored today" and "it cannot reach the writer" are different guarantees.
    const parsed = appointmentCommandInputSchema.safeParse({
      command: "book",
      slotId: SLOT,
      petPublicToken: PET,
      appointmentToken: TOKEN,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("appointmentToken" in parsed.data).toBe(false);
  });
});

describe("appointmentCommandInputSchema — the token", () => {
  it("refuses an absent, empty or whitespace-only token", () => {
    expect(codeFor({ command: "cancel" })).toBe("APPOINTMENT_TOKEN_REQUIRED");
    expect(codeFor({ command: "cancel", appointmentToken: "" })).toBe("APPOINTMENT_TOKEN_REQUIRED");
    expect(codeFor({ command: "cancel", appointmentToken: "   " })).toBe(
      "APPOINTMENT_TOKEN_REQUIRED",
    );
    expect(codeFor({ command: "cancel", appointmentToken: 42 })).toBe("APPOINTMENT_TOKEN_REQUIRED");
  });

  it("trims, so a token pasted with a trailing space still reaches the server clean", () => {
    const parsed = appointmentCommandInputSchema.safeParse({
      command: "cancel",
      appointmentToken: `  ${TOKEN}\n`,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.command === "cancel") {
      expect(parsed.data.appointmentToken).toBe(TOKEN);
    }
  });

  it("checks SHAPE and never format — a server-minted token is not the client's to validate", () => {
    // Pinning `APT-XXXX-XXXX` here would make the contract refuse a token the
    // server legitimately minted the day `generateAppointmentToken` changes. The
    // only honest pre-flight check is "non-empty".
    expect(codeFor({ command: "cancel", appointmentToken: "not-a-token-shape" })).toBe(null);
  });
});

describe("firstAppointmentCommandInputCode", () => {
  it("returns null when the body parses", () => {
    const parsed = appointmentCommandInputSchema.safeParse({
      command: "cancel",
      appointmentToken: TOKEN,
    });
    expect(parsed.success).toBe(true);
  });

  it("only ever returns a code the vocabulary declares", () => {
    // The app's copy switch is exhaustive over this array with no `default`, so a
    // code outside it renders as a blank line under a "no se pudo" heading.
    for (const body of [{}, { command: "cancel" }, { command: "attend" }]) {
      const code = codeFor(body);
      expect(code === null || APPOINTMENT_COMMAND_INPUT_CODES.includes(code as never)).toBe(true);
    }
  });
});
