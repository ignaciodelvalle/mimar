// Fence: a bite case's place comes from ONE source, never field by field.
//
// R3 of the 2026-09-25 localities audit ("the chimera pair"). Both bite writers
// used to fall back one FIELD at a time:
//
//   caseProvince = event.province ?? pet.province
//   caseLocality = event.locality ?? pet.locality
//
// so a report that knew only the incident PROVINCE (the reverse geocoder
// answered a province and no locality, or the strict API branch returned a
// null locality) was filed under (incident province, the pet's HOME locality):
// a pair nobody entered. When that name also exists in the incident province
// — San Martín is in both Mendoza and San Juan — the case routes to that
// municipality and takes its rabies rule, and on the org path the pair is
// written into the append-only `incident_reported` payload.
//
// The rule both writers now follow, and the one the lost writer already did:
// the incident place is used WHOLE when the reporter gave one (a province-only
// place is a province-level case, locality NULL — visible to the province's
// authority, never glued to somebody else's locality), and the pet's home pair
// is used WHOLE only when the reporter gave no place at all.
//
// Spec: localidades-por-id / bite-and-lost-reporting "Partial bite report
// never mixes sources"; place-capture-contract "Bite — owner (web)" and
// "Bite — org (web)".

import { describe, expect, it, vi } from "vitest";

import {
  type ReportBiteInput,
  reportBite,
} from "@/src/modules/surveillance/application/report-bite";
import {
  type ReportBiteFromOrgInput,
  reportBiteFromOrg,
} from "@/src/modules/surveillance/application/report-bite-from-org";
import type { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";

/** A pet that lives in Mendoza / San Martín and bites somebody in San Juan. */
const PET_HOME = { jurisdictionProvince: "Mendoza", jurisdictionLocality: "San Martín" };

function makeRepo(): SurveillanceRepository {
  return {
    findLatestRabiesVaccineEvent: vi.fn().mockResolvedValue(null),
    insertIncidentEventIdempotent: vi
      .fn()
      .mockResolvedValue({ event: { id: "a0000000-0000-4000-8000-0000000000b1" }, wasNoop: false }),
    insertObservationStarted: vi.fn().mockResolvedValue({ id: "obs-1" }),
    setObservationStatus: vi.fn().mockResolvedValue(undefined),
    findActiveOwnership: vi.fn().mockResolvedValue(null),
    findGovtTargetsForJurisdiction: vi.fn().mockResolvedValue([]),
    insertNotifications: vi.fn().mockResolvedValue(undefined),
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as SurveillanceRepository;
}

function makeDeps() {
  return {
    repo: makeRepo(),
    openCase: vi.fn().mockResolvedValue({ id: "case-1", publicCode: "CAS-AAAA-BBBB" }),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb("tx")) as <T>(
      cb: (tx: unknown) => Promise<T>,
    ) => Promise<T>,
    findAuthoritiesForJurisdiction: vi.fn().mockResolvedValue([]),
    resolveObservationWindow: vi.fn().mockResolvedValue({ days: 10 }),
    resolveSignerProvenance: vi
      .fn()
      .mockResolvedValue({ authorRole: "shelter" as const, authorVerified: false }),
    loadOrgPetAuthority: vi.fn().mockResolvedValue({ hasPetRelation: true, coverageAreas: [] }),
  };
}

const OWNER_INPUT: ReportBiteInput = {
  pet: {
    id: "pet-1",
    publicToken: "tok-1",
    name: "Firulais",
    species: "dog",
    status: "alive",
    rabiesObservationStatus: null,
    ...PET_HOME,
  },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  occurredAt: new Date("2026-09-01T10:00:00Z"),
  victimKind: "human",
  severity: "minor",
  locationDescription: null,
  context: null,
  victimContactName: null,
  victimContactPhone: null,
  victimAgeEstimate: null,
  clientIdempotencyKey: null,
  eventJurisdictionProvince: null,
  eventJurisdictionLocality: null,
  locationLat: null,
  locationLng: null,
  locationSource: null,
};

const ORG_INPUT: ReportBiteFromOrgInput = {
  pet: {
    id: "pet-2",
    publicToken: "tok-2",
    name: "Max",
    species: "dog",
    status: "alive",
    rabiesObservationStatus: null,
    ...PET_HOME,
  },
  user: { id: "user-org-1" },
  organization: {
    id: "org-1",
    displayName: "Clínica",
    orgType: "clinic",
    verified: true,
    jurisdictionProvince: "San Juan",
    email: "contacto@clinica.test",
    phone: null,
  },
  occurredAt: new Date("2026-09-01T10:00:00Z"),
  victimKind: "animal",
  severity: "moderate",
  locationDescription: null,
  context: null,
  victimContactName: null,
  victimContactPhone: null,
  victimAgeEstimate: null,
  injuriesSummary: null,
  vetInvolved: false,
  eventJurisdictionProvince: null,
  eventJurisdictionLocality: null,
  locationLat: null,
  locationLng: null,
  locationSource: null,
  noRedirect: false,
  orgToken: "org-tok-1",
  clientIdempotencyKey: null,
};

type OpenCaseCall = { jurisdictionProvince: string | null; jurisdictionLocality: string | null };

function casePair(deps: ReturnType<typeof makeDeps>): OpenCaseCall {
  const [input] = deps.openCase.mock.calls[0] as [OpenCaseCall];
  return {
    jurisdictionProvince: input.jurisdictionProvince,
    jurisdictionLocality: input.jurisdictionLocality,
  };
}

describe("owner bite writer: the case place is one source", () => {
  // Known failure until work unit A2 (localidades-por-id): flip to `it` there.
  it.fails(
    "a province-only incident place is a province-level case, never the pet's home locality",
    async () => {
      const deps = makeDeps();
      await reportBite({ ...OWNER_INPUT, eventJurisdictionProvince: "San Juan" }, deps);
      expect(casePair(deps)).toEqual({
        jurisdictionProvince: "San Juan",
        jurisdictionLocality: null,
      });
    },
  );

  it("no incident place at all falls back to the pet's home pair, whole", async () => {
    const deps = makeDeps();
    await reportBite(OWNER_INPUT, deps);
    expect(casePair(deps)).toEqual({
      jurisdictionProvince: "Mendoza",
      jurisdictionLocality: "San Martín",
    });
  });
});

describe("org bite writer: the case place is one source", () => {
  // Known failure until work unit A2 (localidades-por-id): flip to `it` there.
  it.fails(
    "a province-only incident place is a province-level case, never the pet's home locality",
    async () => {
      const deps = makeDeps();
      await reportBiteFromOrg({ ...ORG_INPUT, eventJurisdictionProvince: "San Juan" }, deps);
      expect(casePair(deps)).toEqual({
        jurisdictionProvince: "San Juan",
        jurisdictionLocality: null,
      });
    },
  );

  it("no incident place at all falls back to the pet's home pair, whole", async () => {
    const deps = makeDeps();
    await reportBiteFromOrg(ORG_INPUT, deps);
    expect(casePair(deps)).toEqual({
      jurisdictionProvince: "Mendoza",
      jurisdictionLocality: "San Martín",
    });
  });
});
