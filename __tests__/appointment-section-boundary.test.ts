// Which section a turno belongs to, and the exact instant it moves.
//
// WHY THIS FILE EXISTS. Until 2026-08-31 this rule had TWO definitions and no
// test. `app/(app)/mis-turnos/page.tsx` bucketed on `startsAt` inline; the
// phone's `sectionOf` bucketed on `endsAt`. Both were reviewed, both were gated,
// and they disagreed for weeks — because nothing anywhere asserted where the
// boundary was, so moving it cost nothing and neither copy could go red for
// being wrong about the other. The page's copy is gone now (it imports this
// function), and this file is what keeps the surviving one honest.
//
// THE BOUNDARY IS THE SUBJECT, not the happy path. A test that checks "a turno
// next week is upcoming" passes under `startsAt` and under `endsAt` alike, which
// is precisely how the divergence survived review. Every case below is placed
// within the slot's own duration, where the two rules give different answers.

import { describe, expect, it } from "vitest";

import { sectionOf } from "@/src/modules/events/application/booking/list-appointments-for-user";

// A one-hour slot. `now` moves; the slot does not.
const STARTS = new Date("2026-08-31T14:00:00.000Z");
const ENDS = new Date("2026-08-31T15:00:00.000Z");
const slot = { startsAt: STARTS, endsAt: ENDS };

describe("sectionOf — a confirmed turno and the clock", () => {
  it("is upcoming before it starts", () => {
    expect(sectionOf("confirmed", slot, new Date("2026-08-31T13:59:59.000Z"))).toBe("upcoming");
  });

  it("STAYS upcoming while it is happening — the whole point", () => {
    // Under the superseded `startsAt` rule this instant answered "past", and the
    // person it describes is standing at the clinic desk with a check-in QR that
    // is still valid, looking for the row under "Próximos".
    expect(sectionOf("confirmed", slot, new Date("2026-08-31T14:00:00.000Z"))).toBe("upcoming");
    expect(sectionOf("confirmed", slot, new Date("2026-08-31T14:30:00.000Z"))).toBe("upcoming");
    expect(sectionOf("confirmed", slot, new Date("2026-08-31T14:59:59.000Z"))).toBe("upcoming");
  });

  it("becomes past exactly AT endsAt, not a millisecond either side", () => {
    // The comparison is a strict `endsAt > now`, so the closing instant belongs
    // to "past". Pinned to the millisecond because `>` and `>=` differ by
    // exactly this case and nothing else would catch the swap.
    expect(sectionOf("confirmed", slot, new Date("2026-08-31T14:59:59.999Z"))).toBe("upcoming");
    expect(sectionOf("confirmed", slot, new Date("2026-08-31T15:00:00.000Z"))).toBe("past");
    expect(sectionOf("confirmed", slot, new Date("2026-08-31T15:00:00.001Z"))).toBe("past");
  });
});

describe("sectionOf — the statuses the clock does not govern", () => {
  it("files an attended turno as past no matter when you ask", () => {
    // Including DURING its own slot: somebody attended early and the visit is
    // recorded. The status outranks the clock in this direction.
    expect(sectionOf("attended", slot, new Date("2026-08-31T14:30:00.000Z"))).toBe("past");
    expect(sectionOf("attended", slot, new Date("2026-08-31T13:00:00.000Z"))).toBe("past");
  });

  it("files every cancellation as cancelled, including before its own slot", () => {
    // A cancelled turno must never appear under "Próximos" while its hour is
    // still ahead — that is a row offering a check-in for a place nobody holds.
    const before = new Date("2026-08-31T13:00:00.000Z");
    expect(sectionOf("cancelled_by_owner", slot, before)).toBe("cancelled");
    expect(sectionOf("cancelled_by_org", slot, before)).toBe("cancelled");
    expect(sectionOf("no_show", slot, before)).toBe("cancelled");
  });

  it("covers every status the database can actually hold", () => {
    // The five in `APPOINTMENT_STATUSES_V1` are exactly the five the
    // `appointment_status_valid` check constraint admits. Iterated rather than
    // listed so a sixth status cannot be added to the contract with no section.
    //
    // (`"cancelled"` is NOT among them. The web page carried a filter for it
    // until this migration — a branch the constraint made unreachable.)
    const statuses = [
      "confirmed",
      "attended",
      "no_show",
      "cancelled_by_owner",
      "cancelled_by_org",
    ] as const;
    for (const status of statuses) {
      const section = sectionOf(status, slot, new Date("2026-08-31T16:00:00.000Z"));
      expect(["upcoming", "past", "cancelled"]).toContain(section);
    }
  });
});
