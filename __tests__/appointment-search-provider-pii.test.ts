// The national turno search and WHOSE phone it may carry.
//
// THE ASYMMETRY IS THE CONTRACT (PO decision 2026-09-01). The search payload
// reaches any authenticated caller with no prior relationship to the offering,
// so:
//
//   · organization  → phone CROSSES. It is the clinic's public number, the one
//     a person needs to call the place they are about to book at, with
//     precedent on the org public profile (`lib/infra/org-public-profile.ts`).
//   · professional  → phone DOES NOT CROSS. `profiles.phone` is a personal
//     number; the two web pages the module mirrors never selected it — one
//     omits it with a written comment, after the 2026-08-13 incident — and it
//     reached the wire only by a type being reused for rendering convenience.
//     A turno the caller already HOLDS still carries it (`MyAppointmentsV1`),
//     which is the relationship that earns it.
//
// Both directions are pinned ON PURPOSE: a fence that only banned the
// professional's phone would invite "fixing" the org side by symmetry, and a
// fence that only blessed the org's would not notice the personal number
// creeping back. The sweeping fences (`lint:subject-rights`,
// `no-personal-contact-in-ui`, `welfare-org-pii-fitness`) were all green while
// the leak was live — this file is the one that would have gone red.

import { describe, expect, it } from "vitest";

import { resolveProvider } from "@/src/modules/events/application/booking/search-bookable-slots";

import type { AppointmentProviderV1Search } from "@dim/contract/api";

// Compile-time half of the fence: the CONTRACT's professional variant must not
// re-grow a `phone` key. If it does, this alias stops typechecking before any
// runtime assertion gets a chance to run.
type ProfessionalOnWire = Extract<AppointmentProviderV1Search, { kind: "professional" }>;
type _ProfessionalCarriesNoPhone = "phone" extends keyof ProfessionalOnWire ? never : true;
const _pinned: _ProfessionalCarriesNoPhone = true;
void _pinned;

const ROW_BASE = {
  organizationId: null as string | null,
  orgDisplayName: null as string | null,
  orgPhone: null as string | null,
  jurisdictionLocality: null as string | null,
  providerDisplayName: null as string | null,
  providerMatricula: null as string | null,
};

describe("resolveProvider — whose phone the search payload may carry", () => {
  it("a professional's provider object carries NO phone key at all", () => {
    const provider = resolveProvider({
      ...ROW_BASE,
      providerDisplayName: "Ana Pérez",
      providerMatricula: "MP 1234",
    });

    // The exact object, so a re-added field fails on shape and not only on the
    // key probe below.
    expect(provider).toEqual({
      kind: "professional",
      displayName: "Ana Pérez",
      matriculaNumber: "MP 1234",
    });
    // ABSENT, not null: `phone: null` would still be a key on the wire, and a
    // later "harmless" population of it would not change the shape again.
    expect("phone" in provider).toBe(false);
  });

  it("an organization's provider object KEEPS its public phone — the precedent stays", () => {
    const provider = resolveProvider({
      ...ROW_BASE,
      organizationId: "org-1",
      orgDisplayName: "Zoonosis Central",
      orgPhone: "+54 11 4000-0000",
      jurisdictionLocality: "Palermo",
    });

    expect(provider).toEqual({
      kind: "organization",
      displayName: "Zoonosis Central",
      phone: "+54 11 4000-0000",
      locality: "Palermo",
    });
  });
});
