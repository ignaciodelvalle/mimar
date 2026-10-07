// Unit tests for application/report-bite.ts (owner path)
// Spec scenarios: A (report-bite owner path)
// Strict TDD — tests written BEFORE implementation.
//
// Dependencies are mocked via vitest.fn(). No DB needed.

import { describe, expect, it, vi } from "vitest";

import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import {
  KEY_TAKEN_ERROR,
  OBSERVATION_OPEN_ERROR,
  type ReportBiteInput,
  reportBite,
} from "./report-bite";

// ---------------------------------------------------------------------------
// Minimal fake types
// ---------------------------------------------------------------------------

type FakeRepo = {
  [K in keyof SurveillanceRepository]?: ReturnType<typeof vi.fn>;
};

const FAKE_BITE_ID = "a0000000-0000-4000-8000-000000000001";
const FAKE_OBS_ID = "a0000000-0000-4000-8000-000000000002";

function makeRepo(overrides: FakeRepo = {}): SurveillanceRepository {
  return {
    findLatestRabiesVaccineEvent: vi.fn().mockResolvedValue(null),
    findIncidentReplay: vi.fn().mockResolvedValue(null),
    insertIncidentEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: FAKE_BITE_ID },
      wasNoop: false,
    }),
    insertObservationStarted: vi.fn().mockResolvedValue({ id: FAKE_OBS_ID }),
    setObservationStatus: vi.fn().mockResolvedValue(undefined),
    findGovtTargetsForJurisdiction: vi.fn().mockResolvedValue([]),
    insertNotifications: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SurveillanceRepository;
}

function makeDeps(repoOverrides: FakeRepo = {}) {
  const repo = makeRepo(repoOverrides);
  const openCase = vi.fn().mockResolvedValue({ id: "case-1", publicCode: "CAS-AAAA-BBBB" });
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb("fake-tx");
  });
  const findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue([]);
  const resolveObservationWindow = vi.fn().mockResolvedValue({ days: 10 });
  return { repo, openCase, transaction, findAuthoritiesForJurisdiction, resolveObservationWindow };
}

const BASE_INPUT: ReportBiteInput = {
  pet: {
    id: "pet-1",
    publicToken: "tok-1",
    name: "Firulais",
    species: "dog",
    status: "alive",
    rabiesObservationStatus: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Lomas de Zamora",
    localityId: null,
  },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  occurredAt: new Date("2024-06-01T10:00:00Z"),
  victimKind: "human",
  severity: "minor",
  locationDescription: null,
  context: null,
  victimContactName: null,
  victimContactPhone: null,
  victimAgeEstimate: null,
  clientIdempotencyKey: "key-abc",
  eventJurisdictionProvince: null,
  eventJurisdictionLocality: null,
  locationLat: null,
  locationLng: null,
  locationSource: null,
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("reportBite (owner path)", () => {
  it("returns ok=true on successful bite report", async () => {
    const deps = makeDeps();
    const result = await reportBite(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
  });

  it("returns the opened case public code for the receipt", async () => {
    const deps = makeDeps();
    const result = await reportBite(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.casePublicCode).toBe("CAS-AAAA-BBBB");
  });

  it("calls openCase with bite_incident kind", async () => {
    const deps = makeDeps();
    await reportBite(BASE_INPUT, deps);
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "bite_incident" }),
      "fake-tx",
    );
  });

  it("calls insertIncidentEventIdempotent (owner path uses idempotent insert)", async () => {
    const deps = makeDeps();
    await reportBite(BASE_INPUT, deps);
    expect(deps.repo.insertIncidentEventIdempotent).toHaveBeenCalled();
  });

  it("calls setObservationStatus with in_progress", async () => {
    const deps = makeDeps();
    await reportBite(BASE_INPUT, deps);
    expect(deps.repo.setObservationStatus).toHaveBeenCalledWith(
      "pet-1",
      "in_progress",
      expect.any(Date),
      "fake-tx",
    );
  });

  it("returns notification for owner with rabies_observation_started_owner type", async () => {
    const deps = makeDeps();
    const result = await reportBite(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ownerNotif = result.notifications.find(
      (n) => n.notificationType === "rabies_observation_started_owner",
    );
    expect(ownerNotif).toBeDefined();
    expect(ownerNotif?.userId).toBe("user-1");
  });

  it("computes rabies vaccine validity via repo.findLatestRabiesVaccineEvent", async () => {
    const deps = makeDeps({
      findLatestRabiesVaccineEvent: vi.fn().mockResolvedValue({
        occurredAt: new Date("2023-01-01"),
        payload: { vaccine_name: "antirrábica", next_due_at: "2025-01-01" },
      }),
    });
    await reportBite(BASE_INPUT, deps);
    // Should call the repo to get vaccine event
    expect(deps.repo.findLatestRabiesVaccineEvent).toHaveBeenCalledWith("pet-1");
  });

  it("sets rabiesVaccineValidAtIncident=true when vaccine still valid", async () => {
    const deps = makeDeps({
      findLatestRabiesVaccineEvent: vi.fn().mockResolvedValue({
        occurredAt: new Date("2023-01-01"),
        payload: {
          vaccine_name: "antirrábica",
          next_due_at: new Date("2030-01-01").toISOString(),
        },
      }),
    });
    await reportBite(BASE_INPUT, deps);
    // insertIncidentEventIdempotent should be called with the payload including the flag
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(call.payload.rabies_vaccine_valid_at_incident).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// panorama-event-points Slice 2 — incident coordinate capture
// ---------------------------------------------------------------------------

describe("reportBite — incident coordinate (Slice 2)", () => {
  it("persists the map-pin coordinate COLUMNAR (as numeric strings) + location_source in payload", async () => {
    const deps = makeDeps();
    await reportBite(
      {
        ...BASE_INPUT,
        locationLat: -34.6037,
        locationLng: -58.3816,
        locationSource: "pin_manual",
      },
      deps,
    );
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      locationLat: unknown;
      locationLng: unknown;
      payload: Record<string, unknown>;
    };
    // Columnar coordinate (numeric-string), NOT in the payload.
    expect(call.locationLat).toBe("-34.6037");
    expect(call.locationLng).toBe("-58.3816");
    // Precision hint travels in the payload.
    expect(call.payload.location_source).toBe("pin_manual");
  });

  it("writes NULL columnar coords when no pin was dropped (falls into the residual, never faked)", async () => {
    const deps = makeDeps();
    await reportBite(BASE_INPUT, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      locationLat: unknown;
      locationLng: unknown;
      payload: Record<string, unknown>;
    };
    expect(call.locationLat).toBeNull();
    expect(call.locationLng).toBeNull();
    expect(call.payload.location_source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency noop path (spec §A: biteNoop early return)
// ---------------------------------------------------------------------------

// A same-key retry by the SAME actor is answered by the ledger before any
// write (see "replay check before state guard" below). An incident that still
// dedupes inside the write is ANOTHER actor's key: the transaction is rolled
// back — no orphan open case — and the person is told to resend.
describe("reportBite — an incident that dedupes inside the write (another actor's key)", () => {
  it("refuses with KEY_TAKEN_ERROR and writes no observation", async () => {
    const deps = makeDeps({
      insertIncidentEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: "evt-bite-1" },
        wasNoop: true,
      }),
    });
    const result = await reportBite(BASE_INPUT, deps);
    expect(result).toEqual({ ok: false, error: KEY_TAKEN_ERROR });
    expect(deps.repo.insertObservationStarted).not.toHaveBeenCalled();
    expect(deps.repo.setObservationStatus).not.toHaveBeenCalled();
  });

  it("throws inside the transaction, so the case it opened is rolled back with it", async () => {
    let bodyError: unknown = null;
    const deps = makeDeps({
      insertIncidentEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: "evt-bite-1" },
        wasNoop: true,
      }),
    });
    deps.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      try {
        return await cb("fake-tx");
      } catch (err) {
        bodyError = err;
        throw err;
      }
    });
    await reportBite(BASE_INPUT, deps);
    expect(deps.openCase).toHaveBeenCalledTimes(1);
    expect(bodyError).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Authority notification fan-out (spec §A fan-out)
// ---------------------------------------------------------------------------

describe("reportBite — authority fan-out", () => {
  it("calls findAuthoritiesForJurisdiction with pet jurisdiction", async () => {
    const deps = makeDeps();
    await reportBite(BASE_INPUT, deps);
    expect(deps.findAuthoritiesForJurisdiction).toHaveBeenCalledWith({
      province: "Buenos Aires",
      locality: "Lomas de Zamora",
    });
  });

  it("a homonym home (San Pedro, Córdoba) pages by the home's row, not the shared name", async () => {
    // No incident place: the case falls back to the home pair WITH its row,
    // and the page must follow the case. On the name path both San Pedros'
    // authorities would be paged for one town's bite.
    const deps = makeDeps();
    await reportBite(
      {
        ...BASE_INPUT,
        pet: {
          ...BASE_INPUT.pet,
          jurisdictionProvince: "Córdoba",
          jurisdictionLocality: "San Pedro",
          localityId: "loc-san-pedro-a",
        },
      },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ localityId: "loc-san-pedro-a" }),
      "fake-tx",
    );
    expect(deps.findAuthoritiesForJurisdiction).toHaveBeenCalledWith({
      province: "Córdoba",
      locality: "San Pedro",
      localityId: "loc-san-pedro-a",
    });
  });

  it("includes authority notifications when authorities found (severity=warning for minor)", async () => {
    const deps = makeDeps();
    deps.findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["auth-user-1"]);
    const result = await reportBite(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authNotif = result.notifications.find(
      (n) => n.notificationType === "bite_reported_authority",
    );
    expect(authNotif).toBeDefined();
    expect(authNotif?.userId).toBe("auth-user-1");
    expect(authNotif?.severity).toBe("warning");
  });

  // THE ANCHOR THE DEDUPE KEY IS DERIVED FROM (2026-08-21).
  //
  // flushNotifications in ../actions.ts builds `${type}:${relatedCaseId}:${userId}`
  // and REFUSES any row without a case anchor rather than falling back to the
  // pet — because two separate bites on the same animal must reach the
  // authority as two alerts, not dedupe into one. This notification is built
  // POST-transaction, where `caseRow` is out of scope, so the case id has to be
  // hoisted out deliberately. Drop that hoist and the row silently stops being
  // deliverable: the flush reports it and skips it.
  it("anchors the authority notification on the incident case, not only the pet", async () => {
    const deps = makeDeps();
    deps.findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["auth-user-1"]);
    const result = await reportBite(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authNotif = result.notifications.find(
      (n) => n.notificationType === "bite_reported_authority",
    );
    expect(authNotif?.relatedCaseId, "sin ancla de caso el flush la descarta").toBeTruthy();
    // Same case the owner's notification is anchored on — one incident, one key
    // family, so a retry of the same report cannot produce a second alert.
    const ownerNotif = result.notifications.find(
      (n) => n.notificationType === "rabies_observation_started_owner",
    );
    expect(authNotif?.relatedCaseId).toBe(ownerNotif?.relatedCaseId);
  });

  it("every notification it emits can be keyed", async () => {
    // The precondition flushNotifications enforces, asserted at the source.
    // A new notification added to this use-case without a case anchor fails
    // here instead of vanishing at runtime.
    const deps = makeDeps();
    deps.findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["auth-user-1"]);
    const result = await reportBite(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notifications.length).toBeGreaterThanOrEqual(2);
    const unkeyable = result.notifications.filter((n) => !n.relatedCaseId);
    expect(
      unkeyable.map((n) => n.notificationType),
      "estas no se pueden deduplicar y el flush las descarta",
    ).toEqual([]);
  });

  it("uses severity=urgent for severe bites", async () => {
    const deps = makeDeps();
    deps.findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["auth-user-1"]);
    const result = await reportBite({ ...BASE_INPUT, severity: "severe" }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authNotif = result.notifications.find(
      (n) => n.notificationType === "bite_reported_authority",
    );
    expect(authNotif?.severity).toBe("urgent");
  });

  it("STILL routes when there is no jurisdiction — the admin fallback must get its chance", async () => {
    // This used to assert `not.toHaveBeenCalled()`, i.e. it pinned the bug: with
    // a null jurisdiction the resolver was never invoked, so the one real
    // fallback in the system (govt-first, active institutional admins second)
    // never ran, and a bite opened a rabies observation with NO authority aware
    // of it while the action returned ok. Coercing null to "" makes the resolver
    // find no govt and page the admins — the shape
    // route-outbreak-signal-notifications already used.
    const deps = makeDeps();
    deps.findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["admin-fallback-1"]);
    const petNoJurisdiction = {
      ...BASE_INPUT,
      pet: {
        ...BASE_INPUT.pet,
        jurisdictionProvince: null,
        jurisdictionLocality: null,
      },
      eventJurisdictionProvince: null,
      eventJurisdictionLocality: null,
    };
    const result = await reportBite(petNoJurisdiction, deps);
    expect(deps.findAuthoritiesForJurisdiction).toHaveBeenCalledWith({
      province: "",
      locality: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.notifications.find((n) => n.notificationType === "bite_reported_authority")?.userId,
    ).toBe("admin-fallback-1");
  });
});

// ---------------------------------------------------------------------------
// LEGAL-ROUTING fix — incident jurisdiction overrides pet home jurisdiction
// (PO decision: a bite routes to where it HAPPENED, not the pet's registered
// home). A prior audit found both the opened case and the authority
// notification always used pet.jurisdictionProvince/Locality — pinned here so
// a regression can't silently bring back the home-jurisdiction routing.
// ---------------------------------------------------------------------------

describe("reportBite — incident jurisdiction overrides pet home jurisdiction", () => {
  const INCIDENT_ELSEWHERE_INPUT: ReportBiteInput = {
    ...BASE_INPUT,
    // pet's home is jurisdiction A (Buenos Aires / Lomas de Zamora, per
    // BASE_INPUT.pet). The bite happened in jurisdiction B.
    eventJurisdictionProvince: "Córdoba",
    eventJurisdictionLocality: "Río Cuarto",
  };

  it("opens the bite_incident case in the incident jurisdiction (B), not the pet's home (A)", async () => {
    const deps = makeDeps();
    await reportBite(INCIDENT_ELSEWHERE_INPUT, deps);
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({
        jurisdictionProvince: "Córdoba",
        jurisdictionLocality: "Río Cuarto",
      }),
      "fake-tx",
    );
  });

  it("notifies the incident jurisdiction's (B) authority, not the pet's home (A) authority", async () => {
    const deps = makeDeps();
    await reportBite(INCIDENT_ELSEWHERE_INPUT, deps);
    // localityId null: the incident place carried no catalogue id, so on the
    // id path it is a province-level place (localidades-por-id D3).
    expect(deps.findAuthoritiesForJurisdiction).toHaveBeenCalledWith({
      province: "Córdoba",
      locality: "Río Cuarto",
      localityId: null,
    });
    expect(deps.findAuthoritiesForJurisdiction).not.toHaveBeenCalledWith({
      province: "Buenos Aires",
      locality: "Lomas de Zamora",
    });
  });

  // A1 (Lote A): the statutory window resolves against the SAME incident
  // jurisdiction the case routes to — the same convention as the two pins above.
  it("resolves the observation window against the incident jurisdiction (A1)", async () => {
    const deps = makeDeps();
    await reportBite(INCIDENT_ELSEWHERE_INPUT, deps);
    expect(deps.resolveObservationWindow).toHaveBeenCalledWith({
      province: "Córdoba",
      locality: "Río Cuarto",
    });
  });
});

// ---------------------------------------------------------------------------
// T1-G2 (localidad plan L2·1) — the INDEC id of the incident locality rides onto
// the case. The web writer resolves it with locality "soft" (a map pin carries a
// name, never an id); the use-case stamps it only when the case routes to the
// INCIDENT locality, never on the pet-home fallback.
// ---------------------------------------------------------------------------

describe("reportBite — incident locality id (T1-G2)", () => {
  const LOCALITY_ID = "b0000000-0000-4000-8000-0000000000c1";

  it("stamps the resolved incident locality id on the case", async () => {
    const deps = makeDeps();
    await reportBite(
      {
        ...BASE_INPUT,
        eventJurisdictionProvince: "Córdoba",
        eventJurisdictionLocality: "Río Cuarto",
        eventLocalityId: LOCALITY_ID,
      },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ jurisdictionLocality: "Río Cuarto", localityId: LOCALITY_ID }),
      "fake-tx",
    );
  });

  // localidades-por-id D3: the routing gets the same id the case gets; a
  // case on the pet's home pair passes none (the name path decides it).
  it("routes with the incident locality id, null when unresolved", async () => {
    const deps = makeDeps();
    await reportBite(
      {
        ...BASE_INPUT,
        eventJurisdictionProvince: "Córdoba",
        eventJurisdictionLocality: "Río Cuarto",
        eventLocalityId: LOCALITY_ID,
      },
      deps,
    );
    expect(deps.findAuthoritiesForJurisdiction).toHaveBeenLastCalledWith({
      province: "Córdoba",
      locality: "Río Cuarto",
      localityId: LOCALITY_ID,
    });
    const unresolved = makeDeps();
    await reportBite(
      {
        ...BASE_INPUT,
        eventJurisdictionProvince: "Córdoba",
        eventJurisdictionLocality: "Paraje Sin Catalogo",
        eventLocalityId: null,
      },
      unresolved,
    );
    expect(unresolved.findAuthoritiesForJurisdiction).toHaveBeenLastCalledWith({
      province: "Córdoba",
      locality: "Paraje Sin Catalogo",
      localityId: null,
    });
  });

  it("an incident locality the catalog did not resolve still opens the case, with no id", async () => {
    const deps = makeDeps();
    const result = await reportBite(
      {
        ...BASE_INPUT,
        eventJurisdictionProvince: "Córdoba",
        eventJurisdictionLocality: "Paraje Sin Catalogo",
        eventLocalityId: null,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ jurisdictionLocality: "Paraje Sin Catalogo", localityId: null }),
      "fake-tx",
    );
  });

  it("never stamps an incident id on a case that carries no incident locality", async () => {
    // A province-only incident place is a PROVINCE-LEVEL case since
    // localidades-por-id A2 — never (Córdoba, the pet's home locality), the
    // chimera the field-by-field fallback used to write. With no locality on
    // the case there is no row for an id to name.
    const deps = makeDeps();
    await reportBite(
      { ...BASE_INPUT, eventJurisdictionProvince: "Córdoba", eventLocalityId: LOCALITY_ID },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({
        jurisdictionProvince: "Córdoba",
        jurisdictionLocality: null,
        localityId: null,
      }),
      "fake-tx",
    );
  });
});

// ---------------------------------------------------------------------------
// A1 (Lote A) — the observation deadline honors the per-jurisdiction
// `rabies_observation_window` rule at report time. The cron later reads the
// stored `observation_until` verbatim, so this write is the whole enforcement.
// The dashboard already measured against the rule; the writers hardcoded 10 —
// this pins the split-brain closed.
// ---------------------------------------------------------------------------

describe("reportBite — per-jurisdiction observation window (A1)", () => {
  it("writes observation_until at occurredAt + the RESOLVED days, not the hardcoded 10", async () => {
    const deps = makeDeps();
    deps.resolveObservationWindow.mockResolvedValue({ days: 14 });
    await reportBite(BASE_INPUT, deps);
    expect(deps.repo.insertObservationStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          // occurredAt 2024-06-01 + 14 days (calendar arithmetic).
          observation_until: new Date("2024-06-15T10:00:00Z").toISOString(),
        }),
      }),
      "fake-tx",
    );
  });
});

// ---------------------------------------------------------------------------
// Vaccine validity at bite date (parity quirk #1)
// ---------------------------------------------------------------------------

describe("reportBite — vaccine validity snapshot", () => {
  it("sets rabiesVaccineValidAtIncident=false when no vaccine on record", async () => {
    const deps = makeDeps({
      findLatestRabiesVaccineEvent: vi.fn().mockResolvedValue(null),
    });
    await reportBite(BASE_INPUT, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(call.payload.rabies_vaccine_valid_at_incident).toBe(false);
  });

  it("sets rabiesVaccineValidAtIncident=false when vaccine expired via next_due_at", async () => {
    const biteDate = new Date("2024-06-01T10:00:00Z");
    const deps = makeDeps({
      findLatestRabiesVaccineEvent: vi.fn().mockResolvedValue({
        occurredAt: new Date("2022-01-01"),
        payload: {
          vaccine_name: "rabies",
          next_due_at: new Date("2023-01-01").toISOString(), // expired
        },
      }),
    });
    await reportBite({ ...BASE_INPUT, occurredAt: biteDate }, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(call.payload.rabies_vaccine_valid_at_incident).toBe(false);
  });
});

// localidades-por-id A8: the append-only incident keeps where the bite
// happened, as entered and as resolved.
describe("reportBite — the incident keeps its place (A8)", () => {
  it("writes the place onto incident_reported", async () => {
    const deps = makeDeps();
    const place = {
      entered: { province: "AR-X", locality: "Villa María", indec_id: "14042170" },
      resolved: {
        locality_id: "00000000-0000-4000-8000-0000000014e2",
        province_code: "AR-X",
        method: "indec_id" as const,
      },
    };
    await reportBite(
      {
        ...BASE_INPUT,
        eventJurisdictionProvince: "Córdoba",
        eventJurisdictionLocality: "Villa María",
        eventPlace: place,
      },
      deps,
    );
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(call.payload.place).toEqual(place);
  });

  it("writes no place when the report carried none", async () => {
    const deps = makeDeps();
    await reportBite(BASE_INPUT, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(call.payload).not.toHaveProperty("place");
  });
});

// Stage A review, BLOCKER 2: a bite whose pin names no province is an
// UNRESOLVED case — no jurisdiction — never the animal's home.
describe("reportBite — an unresolved pin is never filed at the home pair", () => {
  it("opens the case with no jurisdiction and keeps the place on the incident", async () => {
    const deps = makeDeps();
    const place = {
      entered: { province: null, locality: null, indec_id: null },
      resolved: null,
      candidates: ["00000000-0000-4000-8000-0000000000c1"],
    };
    await reportBite({ ...BASE_INPUT, eventPlace: place }, deps);
    const [caseArg] = (deps.openCase as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(caseArg).toMatchObject({
      jurisdictionProvince: null,
      jurisdictionLocality: null,
      localityId: null,
    });
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(call.payload.place).toEqual(place);
  });
});

// ---------------------------------------------------------------------------
// Replay check before state guard (plan A5c)
// ---------------------------------------------------------------------------
//
// A successful report invalidates its own precondition: it opens the case and
// the observation a second report is refused for. The fake below keeps that
// state between calls the way the database does — one ledger keyed on the
// idempotency key, one open bite case per pet (cases_open_per_pet_kind_idx) —
// and each call reads the pet AFTER the previous one, as a real retry does.

function makeStatefulDeps() {
  const ledger = new Map<string, { eventId: string; caseId: string; casePublicCode: string }>();
  const openCases: { id: string; publicCode: string }[] = [];
  let observationStatus: string | null = null;
  const deps = makeDeps({
    findIncidentReplay: vi.fn(
      async ({ clientIdempotencyKey }: { clientIdempotencyKey: string }) =>
        ledger.get(clientIdempotencyKey) ?? null,
    ),
    insertIncidentEventIdempotent: vi.fn(
      async (values: { clientIdempotencyKey: string; caseId: string }) => {
        const eventId = `a0000000-0000-4000-8000-0000000001${String(ledger.size + 1).padStart(2, "0")}`;
        const opened = openCases.find((c) => c.id === values.caseId);
        ledger.set(values.clientIdempotencyKey, {
          eventId,
          caseId: values.caseId,
          casePublicCode: opened?.publicCode ?? "",
        });
        return { event: { id: eventId }, wasNoop: false };
      },
    ),
    setObservationStatus: vi.fn(async (_petId: string, status: string) => {
      observationStatus = status;
    }),
  });
  deps.openCase.mockImplementation(async () => {
    if (openCases.length > 0) {
      throw new Error(
        'duplicate key value violates unique constraint "cases_open_per_pet_kind_idx"',
      );
    }
    const row = { id: `case-${openCases.length + 1}`, publicCode: "CAS-REPL-AY01" };
    openCases.push(row);
    return row;
  });
  const inputWith = (key: string): ReportBiteInput => ({
    ...BASE_INPUT,
    pet: { ...BASE_INPUT.pet, rabiesObservationStatus: observationStatus },
    clientIdempotencyKey: key,
  });
  return { deps, openCases, inputWith };
}

describe("reportBite — replay check before state guard", () => {
  it("the same request twice with the same key returns the original result and opens one case", async () => {
    const { deps, openCases, inputWith } = makeStatefulDeps();

    const first = await reportBite(inputWith("key-retry"), deps);
    const retry = await reportBite(inputWith("key-retry"), deps);

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.value).toEqual({ ...first.value, wasDuplicate: true });
    expect(first.value.wasDuplicate).toBe(false);
    expect(openCases).toHaveLength(1);
    expect(deps.openCase).toHaveBeenCalledTimes(1);
    expect(deps.repo.insertObservationStarted).toHaveBeenCalledTimes(1);
    // The original call already announced it; a replay pages nobody again.
    expect(retry.notifications).toEqual([]);
  });

  it("a different key on the same pet is still refused by the state guard", async () => {
    const { deps, openCases, inputWith } = makeStatefulDeps();

    await reportBite(inputWith("key-first"), deps);
    const other = await reportBite(inputWith("key-second"), deps);

    expect(other).toEqual({ ok: false, error: OBSERVATION_OPEN_ERROR });
    expect(deps.openCase).toHaveBeenCalledTimes(1);
    expect(openCases).toHaveLength(1);
  });

  it("asks the ledger inside the transaction, before opening the case", async () => {
    const deps = makeDeps();
    await reportBite(BASE_INPUT, deps);
    const replayOrder = (deps.repo.findIncidentReplay as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(deps.repo.findIncidentReplay).toHaveBeenCalledWith(
      { petId: "pet-1", clientIdempotencyKey: "key-abc", recordedByUserId: "user-1" },
      "fake-tx",
    );
    expect(replayOrder).toBeLessThan(deps.openCase.mock.invocationCallOrder[0]);
  });

  it("a twin with ANOTHER key that opened the case first is the guard's refusal, not a 500", async () => {
    // What postgres-js throws (wrapped by drizzle) when two different-key
    // reports pass the guard on the same stale snapshot.
    const deps = makeDeps();
    deps.openCase.mockRejectedValue(
      Object.assign(new Error("Failed query: insert into cases ..."), {
        cause: {
          code: "23505",
          constraint_name: "cases_open_per_pet_kind_idx",
          message: 'duplicate key value violates unique constraint "cases_open_per_pet_kind_idx"',
        },
      }),
    );
    const result = await reportBite(BASE_INPUT, deps);
    expect(result).toEqual({ ok: false, error: OBSERVATION_OPEN_ERROR });
  });

  it("any other failure keeps the generic refusal", async () => {
    const deps = makeDeps();
    deps.openCase.mockRejectedValue(new Error("connection reset"));
    const result = await reportBite(BASE_INPUT, deps);
    expect(result).toEqual({
      ok: false,
      error: "No se pudo reportar la mordedura: connection reset",
    });
  });

  it("without a key there is nothing to replay: an open observation refuses", async () => {
    const deps = makeDeps();
    const result = await reportBite(
      {
        ...BASE_INPUT,
        clientIdempotencyKey: null,
        pet: { ...BASE_INPUT.pet, rabiesObservationStatus: "window_expired_unclosed" },
      },
      deps,
    );
    expect(result).toEqual({ ok: false, error: OBSERVATION_OPEN_ERROR });
    expect(deps.repo.findIncidentReplay).not.toHaveBeenCalled();
    expect(deps.openCase).not.toHaveBeenCalled();
  });
});
