// `turnos-view-model` — the words, the formatting, and the one string that must
// not change.
//
// WHAT THESE HAVE TO PROVE, beyond "it returns a string"
// ---------------------------------------------------------------------------
//   1. THE CHECK-IN QR PAYLOAD IS BYTE-FOR-BYTE THE WEB'S. Two surfaces printing
//      two different codes for one turno is worse than the declared debt that the
//      code currently points at no screen; a front desk that eventually reads one
//      would silently refuse the other.
//   2. DATES ARE ARGENTINE, on a device set to any zone, and the clock is
//      24-hour whatever the ICU build thinks es-AR means.
//   3. `null` PRICE IS "GRATUITO" AND NEVER "$0". A free campaign and a service
//      somebody priced at zero are different facts.
//   4. THE PROVIDER COLLAPSE HAPPENS ONCE, here, and covers all three arms
//      including the one the LEFT join leaves empty.

import { describe, expect, it } from "@jest/globals";

import type { MyAppointmentV1, MyAppointmentsV1 } from "@dim/contract/api";

import {
  allAppointments,
  appointmentCalendarUrl,
  appointmentInputCodeMessage,
  appointmentPriceLabel,
  appointmentProviderLabel,
  appointmentProviderPhone,
  appointmentShortWhenLabel,
  appointmentStatusLabel,
  appointmentWhenLabel,
  appointmentsTotalLabel,
  buildCancelAppointment,
  checkInQrValue,
  findAppointment,
} from "./turnos-view-model";

function anAppointment(over: Partial<MyAppointmentV1> = {}): MyAppointmentV1 {
  return {
    appointmentToken: "APT-7K2M-9QX4",
    status: "confirmed",
    section: "upcoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa" },
    offeringName: "Campaña antirrábica — Plaza San Martín",
    serviceKind: "vaccination_rabies",
    serviceKindLabel: "Vacunación antirrábica",
    provider: {
      kind: "organization",
      displayName: "Zoonosis Bariloche",
      phone: "+54 294 442-0000",
      locality: "San Carlos de Bariloche",
    },
    durationMinutes: 15,
    priceArs: null,
    startsAt: "2026-09-03T13:30:00.000Z",
    endsAt: "2026-09-03T13:45:00.000Z",
    capabilities: { canCancel: true, canCheckIn: true },
    ...over,
  };
}

function payload(over: Partial<MyAppointmentsV1> = {}): MyAppointmentsV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-29T00:00:00.000Z",
    staleAfter: "2026-08-29T00:01:00.000Z",
    upcoming: [],
    past: [],
    cancelled: [],
    ...over,
  };
}

describe("checkInQrValue — the payload the web already prints", () => {
  it("is the custom-scheme form, verbatim", () => {
    // The web builds this with `deepLinkAppUrl("appointment", …)` in
    // `/mis-turnos/[appointmentToken]/page.tsx`. Pinning the literal here is what
    // makes a change to it a deliberate edit in two places rather than a phone
    // and a browser quietly disagreeing.
    expect(checkInQrValue("APT-7K2M-9QX4")).toBe("mimar://appointment/APT-7K2M-9QX4");
  });

  it("encodes a segment that would otherwise break the url", () => {
    expect(checkInQrValue("APT 1/2")).toBe("mimar://appointment/APT%201%2F2");
  });
});

describe("appointmentStatusLabel — the web's five words, and only five", () => {
  it("names every state the CHECK constraint admits", () => {
    expect(appointmentStatusLabel("confirmed")).toBe("Confirmado");
    expect(appointmentStatusLabel("attended")).toBe("Asistido");
    expect(appointmentStatusLabel("cancelled_by_owner")).toBe("Cancelado por vos");
    expect(appointmentStatusLabel("cancelled_by_org")).toBe("Cancelado por el prestador");
    expect(appointmentStatusLabel("no_show")).toBe("No asistió");
  });

  it("distinguishes who cancelled, which is the fact the person needs", () => {
    // The web's list collapsed both into one "Cancelado" bucket for a while and
    // the detail page's map had no entry for `cancelled_by_org` at all, so it
    // fell through to the green "Confirmado" badge (state-honesty audit).
    expect(appointmentStatusLabel("cancelled_by_owner")).not.toBe(
      appointmentStatusLabel("cancelled_by_org"),
    );
  });
});

describe("the clock and the calendar are Argentina's", () => {
  it("formats the long form in Buenos Aires time, 24-hour, first letter up", () => {
    // 13:30 UTC is 10:30 in Buenos Aires (UTC-3). A device in any zone must read
    // the same, because the turno is at a place that keeps that hour.
    expect(appointmentWhenLabel("2026-09-03T13:30:00.000Z")).toBe(
      "Jueves 3 de septiembre a las 10:30",
    );
  });

  it("formats the short form as dd/mm/aaaa · HH:MM", () => {
    expect(appointmentShortWhenLabel("2026-09-03T13:30:00.000Z")).toBe("03/09/2026 · 10:30");
  });

  it("crosses midnight the Argentine way, not UTC's", () => {
    // 01:00 UTC on the 4th is 22:00 on the 3rd in Buenos Aires. A formatter that
    // leaked UTC would put this turno on the wrong DAY, which is the failure a
    // person acts on.
    expect(appointmentShortWhenLabel("2026-09-04T01:00:00.000Z")).toBe("03/09/2026 · 22:00");
  });

  it("says so rather than printing Invalid Date", () => {
    expect(appointmentWhenLabel("no")).toBe("Fecha desconocida");
    expect(appointmentShortWhenLabel("")).toBe("Fecha desconocida");
  });
});

describe("appointmentPriceLabel", () => {
  it("calls a free service gratuito and never zero", () => {
    expect(appointmentPriceLabel(null)).toBe("Gratuito");
    expect(appointmentPriceLabel(null)).not.toContain("0");
  });

  it("groups thousands the es-AR way", () => {
    expect(appointmentPriceLabel(1500)).toBe("$1.500");
  });

  it("prints a real zero as a price, because somebody set it", () => {
    expect(appointmentPriceLabel(0)).toBe("$0");
  });
});

describe("appointmentProviderLabel — one collapse, three arms", () => {
  it("names an organization plainly", () => {
    expect(
      appointmentProviderLabel({
        kind: "organization",
        displayName: "Zoonosis Bariloche",
        phone: null,
        locality: null,
      }),
    ).toBe("Zoonosis Bariloche");
  });

  it("gives a vet their first name and their matrícula, as the web does", () => {
    expect(
      appointmentProviderLabel({
        kind: "professional",
        displayName: "Ana Beatriz Rossi",
        matriculaNumber: "MP 4821",
        phone: null,
      }),
    ).toBe("Dr/a. Ana · Mat. MP 4821");
  });

  it("drops the matrícula clause when there is none, instead of printing null", () => {
    expect(
      appointmentProviderLabel({
        kind: "professional",
        displayName: "Ana Beatriz Rossi",
        matriculaNumber: null,
        phone: null,
      }),
    ).toBe("Dr/a. Ana");
  });

  it("falls back to a sentence when the join found nobody", () => {
    expect(appointmentProviderLabel({ kind: "unknown" })).toBe("Profesional independiente");
    expect(appointmentProviderPhone({ kind: "unknown" })).toBe(null);
  });
});

describe("finding one row in the hub", () => {
  it("searches all three lists, because a detail can be opened from any", () => {
    const upcoming = anAppointment({ appointmentToken: "APT-UP" });
    const past = anAppointment({ appointmentToken: "APT-PAST", section: "past" });
    const cancelled = anAppointment({ appointmentToken: "APT-CAN", section: "cancelled" });
    const view = payload({ upcoming: [upcoming], past: [past], cancelled: [cancelled] });

    expect(allAppointments(view)).toHaveLength(3);
    expect(findAppointment(view, "APT-PAST")).toBe(past);
    expect(findAppointment(view, "APT-CAN")).toBe(cancelled);
  });

  it("answers null for a token this caller does not hold", () => {
    // The union of the three lists IS the authorized set, so absence is the
    // answer — not a second round trip that would tell a stranger the token is
    // real.
    expect(findAppointment(payload(), "APT-SOMEBODY-ELSES")).toBe(null);
  });
});

describe("appointmentsTotalLabel — the count is the buckets rendered", () => {
  it("counts every list, not one of them", () => {
    const view = payload({
      upcoming: [anAppointment({ appointmentToken: "A" })],
      past: [anAppointment({ appointmentToken: "B" })],
      cancelled: [anAppointment({ appointmentToken: "C" })],
    });
    expect(appointmentsTotalLabel(view)).toBe("3 turnos en total.");
  });

  it("agrees with itself in the singular", () => {
    expect(appointmentsTotalLabel(payload({ upcoming: [anAppointment()] }))).toBe(
      "1 turno en total.",
    );
  });

  it("says nothing is booked rather than printing a zero", () => {
    expect(appointmentsTotalLabel(payload())).toBe("No tenés turnos reservados.");
  });
});

describe("buildCancelAppointment — validated against the server's own schema", () => {
  it("builds the command the endpoint accepts", () => {
    const built = buildCancelAppointment("APT-7K2M-9QX4");
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input).toEqual({ command: "cancel", appointmentToken: "APT-7K2M-9QX4" });
    }
  });

  it("refuses an empty token locally, with a sentence and not a blank", () => {
    // The round trip would answer `invalid_request` with no field detail, which
    // is useless copy. The contract's codes exist so a client can say more.
    const built = buildCancelAppointment("   ");
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.code).toBe("APPOINTMENT_TOKEN_REQUIRED");
      expect(built.message.length).toBeGreaterThan(0);
    }
  });
});

describe("appointmentInputCodeMessage", () => {
  it("has a sentence for every code and for the unnamed case", () => {
    expect(appointmentInputCodeMessage("COMMAND_REQUIRED").length).toBeGreaterThan(0);
    expect(appointmentInputCodeMessage("APPOINTMENT_TOKEN_REQUIRED").length).toBeGreaterThan(0);
    // `null` is "the parse failed on something the contract does not name", which
    // is a real state and must not render as an empty line.
    expect(appointmentInputCodeMessage(null).length).toBeGreaterThan(0);
  });
});

describe("appointmentCalendarUrl — the no-permission add-to-calendar", () => {
  it("builds the template with the turno's real window, in UTC basic format", () => {
    const url = appointmentCalendarUrl(anAppointment());
    expect(url).not.toBeNull();
    const params = new URL(url as string).searchParams;
    expect(new URL(url as string).origin + new URL(url as string).pathname).toBe(
      "https://calendar.google.com/calendar/render",
    );
    expect(params.get("action")).toBe("TEMPLATE");
    // 13:30Z + 15 minutes — the END comes from durationMinutes, not from a
    // second parse of endsAt, so the two cannot disagree on the event length.
    expect(params.get("dates")).toBe("20260903T133000Z/20260903T134500Z");
  });

  it("names the service and the animal in the title, the provider in the details", () => {
    const url = appointmentCalendarUrl(anAppointment()) as string;
    const params = new URL(url).searchParams;
    expect(params.get("text")).toContain("Pampa");
    // appointmentServiceLabel prefers the OFFERING's name over the generic
    // service kind — the calendar entry inherits that, correctly.
    expect(params.get("text")).toContain("Campaña antirrábica — Plaza San Martín");
    expect(params.get("details")).toContain("Zoonosis Bariloche");
    expect(params.get("location")).toBe("San Carlos de Bariloche");
  });

  it("omits the location when the provider has none, instead of an empty field", () => {
    const url = appointmentCalendarUrl(
      anAppointment({
        provider: {
          kind: "professional",
          displayName: "Dra. Paz",
          matriculaNumber: null,
          phone: null,
        },
      }),
    ) as string;
    expect(new URL(url).searchParams.get("location")).toBeNull();
  });

  it("returns null on an unparseable start — no event is better than a wrong one", () => {
    expect(appointmentCalendarUrl(anAppointment({ startsAt: "no-es-fecha" }))).toBeNull();
  });
});
