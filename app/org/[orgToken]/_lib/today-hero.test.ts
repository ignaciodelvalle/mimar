// The org home's "Hoy" hero (portal-vet-p0 D13): a clinic leads with its day,
// a refugio's home does not change.

import { describe, expect, it } from "vitest";

import { todayHeroLinks } from "./today-hero";

const both = new Set(["appointment.manage", "event.write"]);

describe("todayHeroLinks", () => {
  it("gives a clinic member the agenda and Atender, in that order", () => {
    expect(todayHeroLinks({ orgToken: "ORG", orgType: "clinic", granted: both })).toEqual([
      {
        href: "/org/ORG/agenda",
        label: "Turnos de hoy",
        description: "Las reservas del día para atender.",
      },
      {
        href: "/org/ORG/atender",
        label: "Atender mascota",
        description: "Buscá al animal por su código y registrá lo que atendiste.",
      },
    ]);
  });

  it("shows only the door the member can use", () => {
    const agendaOnly = todayHeroLinks({
      orgToken: "ORG",
      orgType: "clinic",
      granted: new Set(["appointment.manage"]),
    });
    expect(agendaOnly?.map((l) => l.label)).toEqual(["Turnos de hoy"]);
    const atenderOnly = todayHeroLinks({
      orgToken: "ORG",
      orgType: "sanitary_authority",
      granted: new Set(["event.write"]),
    });
    expect(atenderOnly?.map((l) => l.label)).toEqual(["Atender mascota"]);
  });

  it("is absent when the member can use neither", () => {
    expect(
      todayHeroLinks({ orgToken: "ORG", orgType: "clinic", granted: new Set(["member.invite"]) }),
    ).toBeNull();
  });

  it("never replaces a refugio's home (shelter regression)", () => {
    for (const orgType of ["shelter", "rescue_network"]) {
      expect(todayHeroLinks({ orgToken: "ORG", orgType, granted: both }), orgType).toBeNull();
    }
  });
});
