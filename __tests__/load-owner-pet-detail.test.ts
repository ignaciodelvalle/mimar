/**
 * Unit tests for the owner-face reader
 * (src/modules/pets/application/read/load-owner-pet-detail.ts).
 *
 * Every collaborator is injected, so none of this touches a database. What is
 * pinned here is the part that used to be UNTESTABLE: the alert strip's ORDER
 * and its firing conditions lived inside a 1466-line page, where the only way to
 * demonstrate them was to render the page. An ordering nobody can check is an
 * ordering that drifts.
 */

import type { CaretakerState } from "@/src/modules/caretakers/application/get-caretaker-state-for-pet";
import {
  type OwnerPetDetailDeps,
  type OwnerPetDetailPorts,
  type OwnerPetRow,
  deriveOwnerPetAlerts,
  derivePregnancyCard,
  loadOwnerPetDetail,
} from "@/src/modules/pets/application/read/load-owner-pet-detail";
import type { OwnerPetOpenCaseRead } from "@/src/modules/pets/application/read/owner-pet-detail-queries";
import type { RehomeState } from "@/src/modules/rehome/application/get-rehome-state-for-pet";
import { describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function petRow(overrides: Partial<OwnerPetRow> = {}): OwnerPetRow {
  return {
    id: "pet-1",
    publicToken: "DIM-TEST-0001",
    name: "Pampa",
    species: "dog",
    sex: "female",
    breed: "Caniche",
    status: "active",
    dateOfBirth: "2020-01-01",
    deceasedAt: null,
    primaryPhotoId: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    pregnancyStatus: null,
    rabiesObservationStatus: null,
    potentiallyDangerousBreed: false,
    estimatedWeightKg: "12",
    adoptionListedAt: null,
    adoptionListingPausedAt: null,
    ...overrides,
  };
}

/**
 * A resolved business rule with nothing configured for this jurisdiction.
 *
 * `payload` is an OBJECT, not null: the resolver always returns the default
 * payload when no tier matches, and the obligation helpers read into it
 * unguarded. A `payload: null` stub passes the type check (the field is loosely
 * typed) and then throws inside `microchipObligationApplies` — which is exactly
 * the shape of stub that makes a test lie about production.
 */
const EMPTY_RULE = {
  payload: {},
  requirementLevel: null,
  legalBasis: null,
  authority: null,
  sourceUrl: null,
  source: "default",
} as unknown as Awaited<ReturnType<OwnerPetDetailDeps["resolveRule"]>>;

function depsStub(overrides: Partial<OwnerPetDetailDeps> = {}): OwnerPetDetailDeps {
  return {
    readPhoto: vi.fn(async () => ({ photoUrl: null })),
    readServiceDog: vi.fn(async () => null),
    readCases: vi.fn(async () => ({
      openCount: 0,
      openCases: [],
      truncated: false,
      underOfficialCustody: false,
      observationOpenedByOrgName: null,
    })),
    readLostData: vi.fn(async () => ({
      lostEpisode: null,
      lostScans: [],
      alertsOriginShelter: false,
    })),
    readReservedRabiesTurno: vi.fn(async () => null),
    readViewerContacts: vi.fn(async () => null),
    readCarousel: vi.fn(async () => ({ items: [], total: 0, truncated: false })),
    resolveRule: vi.fn(async () => EMPTY_RULE),
    loadEvents: vi.fn(async () => ({ typedEvents: [], recentFive: [] })),
    loadReminders: vi.fn(async () => []),
    loadIdentifications: vi.fn(async () => ({ microchip: null, tattoo: null })),
    // No caretaker/rehome/observation here on purpose — those are PORTS, not
    // deps, because `pets` may not import their modules. See portsStub below.
    now: () => NOW,
    ...overrides,
  } as unknown as OwnerPetDetailDeps;
}

const caretaker = (over: Partial<CaretakerState> = {}): CaretakerState => ({
  active: null,
  pending: null,
  recentlyEnded: null,
  ...over,
});

/**
 * The cross-module ports, stubbed.
 *
 * They are a SEPARATE argument from `deps` because `pets` may not import
 * `caretakers`, `rehome` or `surveillance` — see the reader's header. In
 * production they come from `app/_composition/owner-pet-detail-ports.ts`.
 */
function portsStub(
  over: Partial<OwnerPetDetailPorts<CaretakerState | null, RehomeState | null>> = {},
): OwnerPetDetailPorts<CaretakerState | null, RehomeState | null> {
  return {
    loadCaretakerState: vi.fn(async () => null),
    loadRehomeState: vi.fn(async () => null),
    // The real predicate has two open states; the stub mirrors that rather than
    // testing against a simpler rule than production runs.
    isObservationOpen: (status) => status === "in_progress" || status === "window_expired_unclosed",
    ...over,
  };
}

/** `loadOwnerPetDetail` with both stubs defaulted — the ports are never varied. */
/**
 * `holderRole` defaults to `"owner"` so the tests that do not care about the
 * role read as they did before it became an INPUT rather than a dep.
 *
 * It moved because the reader used to re-query it with no `ORDER BY` while the
 * access guard had already ranked it — a titular who is also caretaker of the
 * same animal resolved at random. The tests that DO care now say the role in
 * the input, which is where production says it too.
 */
function loadFace(
  input: Omit<Parameters<typeof loadOwnerPetDetail>[0], "holderRole"> & {
    holderRole?: string | null;
  },
  deps: OwnerPetDetailDeps = depsStub(),
  ports = portsStub(),
) {
  return loadOwnerPetDetail({ holderRole: "owner", ...input }, ports, deps);
}

// ---------------------------------------------------------------------------
// The alert strip
// ---------------------------------------------------------------------------

describe("deriveOwnerPetAlerts — the strip's ORDER is the product decision", () => {
  const base = {
    petStatus: "active",
    observationOpen: false,
    rabiesObservationStatus: null,
    isTransit: false,
    caretakerState: null,
    rehomeState: null,
    openCaseCount: 0,
    pregnancy: null,
  };

  it("is empty when nothing is going on", () => {
    expect(deriveOwnerPetAlerts(base)).toEqual([]);
  });

  it("ranks lost → rabies → transit → caretaker → rehome → cases → pregnancy", () => {
    // Everything at once, so the ORDER is what the assertion is about — not
    // which ones fired.
    const alerts = deriveOwnerPetAlerts({
      petStatus: "lost",
      observationOpen: true,
      rabiesObservationStatus: "in_progress",
      isTransit: true,
      caretakerState: caretaker({ active: { caretakerName: "Ana" } as never }),
      rehomeState: { kind: "active" } as RehomeState,
      openCaseCount: 2,
      pregnancy: {
        startedAt: NOW,
        weeksAtDiagnosis: 3,
        expectedBirthAt: NOW,
        lastClinicalAt: null,
      },
    });
    expect(alerts.map((a) => a.id)).toEqual([
      "lost",
      "rabies",
      "transit",
      "caretaker",
      "rehome",
      "open-cases",
      "pregnancy",
    ]);
  });

  it("an in-progress observation is urgent; an expired window is not", () => {
    // window_expired_unclosed: nothing is known to be wrong with the animal —
    // what is pending is a professional signature.
    expect(
      deriveOwnerPetAlerts({
        ...base,
        observationOpen: true,
        rabiesObservationStatus: "in_progress",
      })[0],
    ).toEqual({ id: "rabies", tone: "urgent" });
    expect(
      deriveOwnerPetAlerts({
        ...base,
        observationOpen: true,
        rabiesObservationStatus: "window_expired_unclosed",
      })[0],
    ).toEqual({ id: "rabies", tone: "warning" });
  });

  it("a lapsed caretaker arrangement warns; a live one only informs", () => {
    expect(
      deriveOwnerPetAlerts({
        ...base,
        caretakerState: caretaker({ recentlyEnded: { caretakerName: "Ana" } as never }),
      })[0],
    ).toEqual({ id: "caretaker", tone: "warning" });
    expect(
      deriveOwnerPetAlerts({
        ...base,
        caretakerState: caretaker({ pending: { caretakerName: "Ana" } as never }),
      })[0],
    ).toEqual({ id: "caretaker", tone: "info" });
  });

  it("does NOT raise a caretaker or rehome alert on an empty state", () => {
    // The banners return null for an empty state, so an alert pushed here would
    // add a divider to the strip with nothing under it.
    expect(deriveOwnerPetAlerts({ ...base, caretakerState: caretaker() })).toEqual([]);
    expect(deriveOwnerPetAlerts({ ...base, rehomeState: { kind: "none" } })).toEqual([]);
  });

  it("raises open-cases only when at least one is open", () => {
    expect(deriveOwnerPetAlerts({ ...base, openCaseCount: 0 })).toEqual([]);
    expect(deriveOwnerPetAlerts({ ...base, openCaseCount: 1 })).toEqual([
      { id: "open-cases", tone: "warning" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pregnancy
// ---------------------------------------------------------------------------

describe("derivePregnancyCard — arithmetic over the spine, never a stored column", () => {
  const started = new Date("2026-06-01T00:00:00.000Z");
  const startedEvent = {
    eventType: "clinical_info_logged",
    occurredAt: started,
    payload: { sub_kind: "pregnancy", pregnancy_phase: "started", weeks_at_diagnosis: 4 },
  };

  it("is null unless the pet is actually in progress", () => {
    expect(
      derivePregnancyCard({ pregnancyStatus: null, species: "dog" }, [startedEvent]),
    ).toBeNull();
  });

  it("is null when the status says in_progress but no started event exists", () => {
    // An honest null: the card cannot be drawn from a status alone.
    expect(derivePregnancyCard({ pregnancyStatus: "in_progress", species: "dog" }, [])).toBeNull();
  });

  it("projects the due date from the diagnosis week", () => {
    const card = derivePregnancyCard({ pregnancyStatus: "in_progress", species: "dog" }, [
      startedEvent,
    ]);
    // 9 weeks total, 4 already elapsed at diagnosis → 5 weeks from the event.
    expect(card?.expectedBirthAt.toISOString()).toBe("2026-07-06T00:00:00.000Z");
    expect(card?.weeksAtDiagnosis).toBe(4);
    expect(card?.lastClinicalAt).toBeNull();
  });

  it("never projects a date in the past when the diagnosis is already late", () => {
    // weeks_at_diagnosis beyond the species term clamps to 0 remaining, not to a
    // negative offset that would put the birth before the diagnosis.
    const card = derivePregnancyCard({ pregnancyStatus: "in_progress", species: "dog" }, [
      { ...startedEvent, payload: { ...startedEvent.payload, weeks_at_diagnosis: 20 } },
    ]);
    expect(card?.expectedBirthAt.getTime()).toBe(started.getTime());
  });

  it("picks up a later clinical note as the last check-in", () => {
    const later = new Date("2026-06-20T00:00:00.000Z");
    const card = derivePregnancyCard({ pregnancyStatus: "in_progress", species: "dog" }, [
      startedEvent,
      { eventType: "clinical_info_logged", occurredAt: later, payload: {} },
    ]);
    expect(card?.lastClinicalAt?.toISOString()).toBe(later.toISOString());
  });
});

// ---------------------------------------------------------------------------
// The reader itself
// ---------------------------------------------------------------------------

describe("loadOwnerPetDetail — what each access path reads", () => {
  it("composes the hero subtitle from breed, sex, age and species", async () => {
    const detail = await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner" },
      depsStub(),
    );
    expect(detail.identity.breedLine).toContain("Caniche");
    expect(detail.identity.breedLine).toContain("Hembra");
  });

  it("carries the locality chip, and no chip tag without a verified microchip", async () => {
    const detail = await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner" },
      depsStub(),
    );
    expect(detail.identity.tags.map((t) => t.key)).toEqual(["loc"]);
  });

  it("skips the reminders, the contacts and the carousel on the ORG path", async () => {
    // An organization member reading a pet it holds gets the face, not the
    // household: the web gives them no carousel either.
    const deps = depsStub();
    const detail = await loadFace(
      // A holder role is handed in even here, and the reader must DROP it: an
      // org member has no ownership row of their own, and reporting one would
      // tell a client a volunteer is the titular.
      { user: { id: "u1" }, pet: petRow(), accessPath: "org", holderRole: "owner" },
      deps,
    );
    expect(deps.loadReminders).not.toHaveBeenCalled();
    expect(deps.readViewerContacts).not.toHaveBeenCalled();
    expect(deps.readCarousel).not.toHaveBeenCalled();
    expect(detail.carousel).toEqual({ items: [], total: 0, truncated: false });
    expect(detail.ownershipRole).toBeNull();
  });

  it("reads the arrangements for a TITULAR only", async () => {
    // A foster holds the animal; a caretaker is trusted with it. Neither gets to
    // learn who else the owner trusts with it.
    for (const role of ["foster", "caretaker", "co_owner"]) {
      const ports = portsStub();
      await loadFace(
        { user: { id: "u1" }, pet: petRow(), accessPath: "owner", holderRole: role },
        depsStub(),
        ports,
      );
      expect(ports.loadCaretakerState, `role=${role}`).not.toHaveBeenCalled();
      expect(ports.loadRehomeState, `role=${role}`).not.toHaveBeenCalled();
    }
    const titularPorts = portsStub();
    await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner" },
      depsStub(),
      titularPorts,
    );
    expect(titularPorts.loadCaretakerState).toHaveBeenCalled();
    expect(titularPorts.loadRehomeState).toHaveBeenCalled();
  });

  it("does NOT read the arrangements for a deceased animal", async () => {
    // A closed life record has no caretaker story left to tell.
    const ports = portsStub();
    await loadFace(
      {
        user: { id: "u1" },
        pet: petRow({ status: "deceased", deceasedAt: NOW }),
        accessPath: "owner",
      },
      depsStub(),
      ports,
    );
    expect(ports.loadCaretakerState).not.toHaveBeenCalled();
    expect(ports.loadRehomeState).not.toHaveBeenCalled();
  });

  it("marks a foster holder as in transit, and a plain owner as not", async () => {
    const foster = await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner", holderRole: "foster" },
      depsStub(),
    );
    expect(foster.isTransit).toBe(true);
    expect(foster.alerts.map((a) => a.id)).toContain("transit");

    const owner = await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner" },
      depsStub(),
    );
    expect(owner.isTransit).toBe(false);
  });

  it("gives a deceased animal a memorial skin and a tinted band, but no body skin", async () => {
    // The one documented asymmetry: the band tints, the face body does not,
    // because the memorial skin owns the body and the two never stack.
    const detail = await loadFace(
      {
        user: { id: "u1" },
        pet: petRow({ status: "deceased", deceasedAt: new Date("2026-03-04T00:00:00Z") }),
        accessPath: "owner",
      },
      depsStub(),
    );
    expect(detail.isDeceased).toBe(true);
    expect(detail.memorial).toEqual({ birthYear: 2020, deathYear: 2026 });
    expect(detail.situation).toBeNull();
    expect(detail.chromeSituation?.key).toBe("fallecida");
  });

  it("carves the memorial years in the ARGENTINE calendar, not the machine's", async () => {
    // REGRESSION. The page read `new Date(pet.dateOfBirth).getFullYear()`.
    // `dateOfBirth` is a date-only column, so it parses as UTC midnight, and
    // `getFullYear` runs in the MACHINE's zone — every zone west of Greenwich
    // reads the previous day. A pet born on the 1st of January had the wrong
    // year on its memorial ribbon for every Argentine reader.
    const detail = await loadFace(
      {
        user: { id: "u1" },
        pet: petRow({
          status: "deceased",
          dateOfBirth: "2020-01-01",
          deceasedAt: new Date("2026-01-01T00:00:00Z"),
        }),
        accessPath: "owner",
      },
      depsStub(),
    );
    expect(detail.memorial?.birthYear).toBe(2020);
    // 2026-01-01T00:00Z is still 2025 in Buenos Aires (UTC-3) — the AR calendar
    // is what the ribbon must show, and the two genuinely differ here.
    expect(detail.memorial?.deathYear).toBe(2025);
  });

  it("falls back to a neutral third person when the viewer has no display name", async () => {
    const detail = await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner" },
      depsStub(),
    );
    expect(detail.ownerFirstName).toBe("el dueño");
  });

  it("takes only the FIRST word of a display name", async () => {
    const detail = await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner" },
      depsStub({
        readViewerContacts: vi.fn(async () => ({
          preferredVetName: null,
          preferredVetPhone: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
          displayName: "Ignacio Del Valle",
        })),
      }),
    );
    expect(detail.ownerFirstName).toBe("Ignacio");
  });

  it("passes the case read's honesty flags straight through", async () => {
    const detail = await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner" },
      depsStub({
        readCases: vi.fn(async () => ({
          openCount: 3,
          // `satisfies` and not a bare literal: `OwnerPetOpenCaseRead.status`
          // is the two OPEN words, so a stub that said "closed" would be a stub
          // for a value production cannot produce. `satisfies` pins that
          // without freezing the array readonly, which `as const` would.
          openCases: [
            { publicCode: "CAS-1111-2222", caseKind: "bite_incident", status: "open" },
            { publicCode: "CAS-3333-4444", caseKind: "custody_episode", status: "open" },
            { publicCode: "CAS-5555-6666", caseKind: "rehome_request", status: "escalated" },
          ] satisfies OwnerPetOpenCaseRead[],
          truncated: true,
          underOfficialCustody: true,
          observationOpenedByOrgName: "Zoonosis La Plata",
        })),
      }),
    );
    expect(detail.cases.openCount).toBe(3);
    // The reader carries the cases THEMSELVES through, not only their count:
    // the mordedura's CAS- code is the fact a reporter has to quote later, and
    // it reaches a client through this read and not through a write response.
    expect(detail.cases.openCases.map((c) => c.publicCode)).toEqual([
      "CAS-1111-2222",
      "CAS-3333-4444",
      "CAS-5555-6666",
    ]);
    // `truncated` is what keeps the count honest when the 50-case cap bites.
    expect(detail.cases.truncated).toBe(true);
    expect(detail.observationOpenedByOrgName).toBe("Zoonosis La Plata");
    // An open custody episode is a SITUATION, not merely a case.
    expect(detail.chromeSituation?.key).toBe("custodia-oficial");
  });
});

// ---------------------------------------------------------------------------
// T1-G1 — the loader threads the resolved rules' PAYLOAD into the projection
// ---------------------------------------------------------------------------

describe("loadOwnerPetDetail — the jurisdiction's rule fields reach the compliance card (T1-G1)", () => {
  /** resolveRule stub: `payloads` per rule type, the empty default for the rest. */
  function rulesStub(payloads: Record<string, Record<string, unknown>>) {
    return vi.fn(async (ruleType: string) => ({
      ...EMPTY_RULE,
      payload: payloads[ruleType] ?? {},
    })) as unknown as OwnerPetDetailDeps["resolveRule"];
  }
  // A vet-signed rabies dose applied 01/06/2025 with no next_due_at.
  const signedDose = {
    eventType: "vaccination_administered",
    occurredAt: new Date("2025-06-01T15:00:00Z"),
    payload: { vaccine_name: "Antirrábica", next_due_at: null },
    authorRole: "vet",
    authorVerified: true,
    authorOrganizationId: null,
  };
  const events = vi.fn(async () => ({ typedEvents: [signedDose], recentFive: [] }));
  const rabiesState = async (frequency: number) => {
    const detail = await loadFace(
      { user: { id: "u1" }, pet: petRow(), accessPath: "owner" },
      depsStub({
        loadEvents: events as unknown as OwnerPetDetailDeps["loadEvents"],
        resolveRule: rulesStub({ rabies_vaccination: { frequency_months: frequency } }),
      }),
    );
    return detail.compliance.cards.find((c) => c.key === "rabies")?.state;
  };

  it("frequency_months from the pet's jurisdiction dates the dose as a SUGGESTION: 24 → upcoming, 12 → lapsed", async () => {
    // The date is computed from the configured cadence, not signed, so it reads
    // "Refuerzo sugerido", never "Vigente"/"Vencida" (pet-compliance dueSource).
    expect(await rabiesState(24)).toBe("Refuerzo sugerido");
    expect(await rabiesState(12)).toBe("Refuerzo sugerido vencido");
  });

  it("mandatory_from_months and the pet's date of birth reach the sterilization card", async () => {
    const detail = await loadFace(
      { user: { id: "u1" }, pet: petRow({ dateOfBirth: "2026-05-01" }), accessPath: "owner" },
      depsStub({ resolveRule: rulesStub({ sterilization: { mandatory_from_months: 12 } }) }),
    );
    expect(detail.compliance.cards.find((c) => c.key === "sterilization")?.state).toBe(
      "Aún no corresponde",
    );
  });
});
