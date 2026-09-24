// Unit tests for application/report-bite-from-org.ts (org path)
// Spec scenarios: B (report-bite org path)
// Strict TDD — tests written BEFORE implementation.
//
// KEY PARITY NOTE: org path was aligned to use insertIncidentEventIdempotent
// in fix/idempotency-guards (v1.0 data-integrity fix).

import { describe, expect, it, vi } from "vitest";

import { computeObservationUntil } from "../domain/rabies-observation";
import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import { type ReportBiteFromOrgInput, reportBiteFromOrg } from "./report-bite-from-org";

const FAKE_BITE_ORG_ID = "a0000000-0000-4000-8000-000000000003";
const FAKE_OBS_ORG_ID = "a0000000-0000-4000-8000-000000000004";

function makeRepo(overrides: Partial<Record<keyof SurveillanceRepository, unknown>> = {}) {
  return {
    findLatestRabiesVaccineEvent: vi.fn().mockResolvedValue(null),
    insertIncidentEventIdempotent: vi
      .fn()
      .mockResolvedValue({ event: { id: FAKE_BITE_ORG_ID }, wasNoop: false }),
    insertObservationStarted: vi.fn().mockResolvedValue({ id: FAKE_OBS_ORG_ID }),
    setObservationStatus: vi.fn().mockResolvedValue(undefined),
    findActiveOwnership: vi.fn().mockResolvedValue(null),
    findGovtTargetsForJurisdiction: vi.fn().mockResolvedValue([]),
    insertNotifications: vi.fn().mockResolvedValue(undefined),
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SurveillanceRepository;
}

function makeDeps(repoOverrides: Partial<Record<keyof SurveillanceRepository, unknown>> = {}) {
  const repo = makeRepo(repoOverrides);
  const openCase = vi.fn().mockResolvedValue({ id: "case-org-1", publicCode: "CAS-ORG1-2222" });
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb("fake-tx");
  });
  const findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue([]);
  const resolveObservationWindow = vi.fn().mockResolvedValue({ days: 10 });
  // Default signer: an org member WITHOUT a validated matrícula — the common
  // case, and the one whose authorship used to be inflated by the org's flag.
  // Tests that need a matriculated vet override this explicitly, so no test can
  // get the professional seal by accident.
  const resolveSignerProvenance = vi
    .fn()
    .mockResolvedValue({ authorRole: "shelter" as const, authorVerified: false });
  // H1 gate default: an org that DID attend/hold this animal. Every pre-existing
  // test in this file describes a legitimate reporter, so the permissive default
  // keeps them describing exactly that; the refusal tests override it.
  const loadOrgPetAuthority = vi
    .fn()
    .mockResolvedValue({ hasPetRelation: true, coverageAreas: [] });
  return {
    repo,
    openCase,
    transaction,
    findAuthoritiesForJurisdiction,
    resolveObservationWindow,
    resolveSignerProvenance,
    loadOrgPetAuthority,
  };
}

const BASE_INPUT: ReportBiteFromOrgInput = {
  pet: {
    id: "pet-2",
    publicToken: "tok-pet-2",
    name: "Max",
    species: "dog",
    status: "alive",
    rabiesObservationStatus: null,
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Palermo",
  },
  user: { id: "user-org-1" },
  organization: {
    id: "org-1",
    displayName: "Clinica Vet SA",
    orgType: "clinic",
    verified: true,
    // The province this org was VERIFIED in — the coverage arm's anchor (U3).
    jurisdictionProvince: "CABA",
    // D1: the owner's only route back to whoever opened the observation.
    email: "contacto@clinicavet.test",
    phone: "11-5555-0000",
  },
  occurredAt: new Date("2024-07-01T09:00:00Z"),
  victimKind: "animal",
  severity: "moderate",
  locationDescription: "Parque",
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

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("reportBiteFromOrg (org path)", () => {
  it("returns ok=true on successful report", async () => {
    const deps = makeDeps();
    const result = await reportBiteFromOrg(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
  });

  it("uses insertIncidentEventIdempotent (aligned with owner path)", async () => {
    const deps = makeDeps();
    await reportBiteFromOrg(BASE_INPUT, deps);
    expect(deps.repo.insertIncidentEventIdempotent).toHaveBeenCalled();
  });

  it("maps clinic orgType to reporter_role=vet", async () => {
    const deps = makeDeps();
    await reportBiteFromOrg(BASE_INPUT, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(call.payload.reporter_role).toBe("vet");
  });

  // #43/#45 provenance, applied to this path on 2026-08-17.
  //
  // The distinction these three tests hold apart: `reporter_role` describes the
  // INSTITUTION that reported (derived from org_type — a fact about the org),
  // while `authorRole`/`authorVerified` describe the PERSON's authority to sign
  // (derived from their validated matrícula). This file's BASE_INPUT is a
  // clinic, so before the fix both came out "vet"+verified from the org alone,
  // and computeConfidence read that as `professional_verified` — the tier its
  // own table defines as "licensed veterinarian with verified matriculation".
  describe("authorship comes from the signer, not from the organization", () => {
    function authorshipOf(deps: ReturnType<typeof makeDeps>) {
      return (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { authorRole: string; authorVerified: boolean };
    }

    it("does NOT stamp a professional signature for an unmatriculated reporter at a clinic", async () => {
      // The receptionist case. The organization is a verified clinic — so
      // `reporter_role` is still "vet" (asserted above) — but the person
      // holds no matrícula.
      const deps = makeDeps();
      await reportBiteFromOrg(BASE_INPUT, deps);

      const authorship = authorshipOf(deps);
      expect(authorship.authorRole).toBe("shelter");
      expect(authorship.authorVerified).toBe(false);
    });

    it("stamps the professional signature when the SIGNER holds a validated matrícula", async () => {
      // The positive control. Without it the assertions above could be
      // satisfied by a build that never grants the seal to anyone.
      const deps = makeDeps();
      deps.resolveSignerProvenance.mockResolvedValue({
        authorRole: "vet" as const,
        authorVerified: true,
      });
      await reportBiteFromOrg(BASE_INPUT, deps);

      const authorship = authorshipOf(deps);
      expect(authorship.authorRole).toBe("vet");
      expect(authorship.authorVerified).toBe(true);
    });

    it("asks about the person who is signing, not about the organization's flag", async () => {
      // Pins the QUESTION being asked. A future refactor could restore the old
      // behaviour while leaving the dep wired but unused, and the two tests
      // above would still pass on a default fixture that happens to agree.
      const deps = makeDeps();
      await reportBiteFromOrg(BASE_INPUT, deps);

      expect(deps.resolveSignerProvenance).toHaveBeenCalledWith(
        BASE_INPUT.user.id,
        BASE_INPUT.organization.id,
      );
    });
  });

  // panorama-event-points Slice 2: the org map pin persists COLUMNAR coords.
  it("persists the incident map-pin coordinate columnar + location_source in payload", async () => {
    const deps = makeDeps();
    await reportBiteFromOrg(
      { ...BASE_INPUT, locationLat: -31.42, locationLng: -64.18, locationSource: "gps" },
      deps,
    );
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      locationLat: unknown;
      locationLng: unknown;
      payload: Record<string, unknown>;
    };
    expect(call.locationLat).toBe("-31.42");
    expect(call.locationLng).toBe("-64.18");
    expect(call.payload.location_source).toBe("gps");
  });

  it("maps shelter orgType to reporter_role=shelter", async () => {
    const deps = makeDeps();
    const shelterInput = {
      ...BASE_INPUT,
      organization: { ...BASE_INPUT.organization, orgType: "shelter" },
    };
    await reportBiteFromOrg(shelterInput, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(call.payload.reporter_role).toBe("shelter");
  });

  it("maps rescue_network orgType to reporter_role=shelter", async () => {
    const deps = makeDeps();
    const input = {
      ...BASE_INPUT,
      organization: { ...BASE_INPUT.organization, orgType: "rescue_network" },
    };
    await reportBiteFromOrg(input, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(call.payload.reporter_role).toBe("shelter");
  });

  it("maps sanitary_authority to reporter_role=govt", async () => {
    const deps = makeDeps();
    const input = {
      ...BASE_INPUT,
      organization: { ...BASE_INPUT.organization, orgType: "sanitary_authority" },
    };
    await reportBiteFromOrg(input, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(call.payload.reporter_role).toBe("govt");
  });

  it("maps unknown orgType to reporter_role=witness", async () => {
    const deps = makeDeps();
    const input = {
      ...BASE_INPUT,
      organization: { ...BASE_INPUT.organization, orgType: "random_type" },
    };
    await reportBiteFromOrg(input, deps);
    const call = (deps.repo.insertIncidentEventIdempotent as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(call.payload.reporter_role).toBe("witness");
  });

  it("calls openCase with openedByOrganizationId", async () => {
    const deps = makeDeps();
    await reportBiteFromOrg(BASE_INPUT, deps);
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ openedByOrganizationId: "org-1" }),
      "fake-tx",
    );
  });

  it("notifies active owner when ownership exists", async () => {
    const deps = makeDeps({
      findActiveOwnership: vi.fn().mockResolvedValue({ ownerUserId: "owner-user-99" }),
    });
    const result = await reportBiteFromOrg(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ownerNotif = result.notifications.find(
      (n) => n.notificationType === "bite_reported_by_org_owner",
    );
    expect(ownerNotif).toBeDefined();
    expect(ownerNotif?.userId).toBe("owner-user-99");
  });

  // D1 (PO 2026-08-23): the owner gets NO in-product dispute channel for an
  // observation opened in error — the complaint goes outside the system, to the
  // organization or the municipality. That decision only holds if this notice is
  // USABLE: a notice that names neither who opened it nor how to reach them does
  // not implement the decision, it simulates it.
  it("names the reporting organization AND a concrete contact route (D1)", async () => {
    const deps = makeDeps({
      findActiveOwnership: vi.fn().mockResolvedValue({ ownerUserId: "owner-user-99" }),
    });
    const result = await reportBiteFromOrg(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ownerNotif = result.notifications.find(
      (n) => n.notificationType === "bite_reported_by_org_owner",
    );
    expect(ownerNotif).toBeDefined();
    // (a) who opened it
    expect(ownerNotif?.body).toContain("Clinica Vet SA");
    // (b) how to reach them — the org's own contact data, not a category noun
    expect(ownerNotif?.body).toContain("contacto@clinicavet.test");
    expect(ownerNotif?.body).toContain("11-5555-0000");
    // (c) where the owner stands: they cannot close it themselves
    expect(ownerNotif?.body).toMatch(/no pod[eé]s cerrarla vos/i);
  });

  it("falls back to the email alone when the org declares no phone (D1)", async () => {
    const deps = makeDeps({
      findActiveOwnership: vi.fn().mockResolvedValue({ ownerUserId: "owner-user-99" }),
    });
    const result = await reportBiteFromOrg(
      { ...BASE_INPUT, organization: { ...BASE_INPUT.organization, phone: null } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ownerNotif = result.notifications.find(
      (n) => n.notificationType === "bite_reported_by_org_owner",
    );
    expect(ownerNotif?.body).toContain("contacto@clinicavet.test");
    expect(ownerNotif?.body).not.toContain("11-5555-0000");
    // No dangling separator when the phone is absent.
    expect(ownerNotif?.body).not.toMatch(/contacto@clinicavet\.test\s*\/\s*\./);
  });

  it("does NOT notify owner when no active ownership", async () => {
    const deps = makeDeps({
      findActiveOwnership: vi.fn().mockResolvedValue(null),
    });
    const result = await reportBiteFromOrg(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ownerNotif = result.notifications.find(
      (n) => n.notificationType === "bite_reported_by_org_owner",
    );
    expect(ownerNotif).toBeUndefined();
  });

  it("returns petToken and ok=true when noRedirect=true", async () => {
    const deps = makeDeps();
    const result = await reportBiteFromOrg({ ...BASE_INPUT, noRedirect: true }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.petToken).toBe("tok-pet-2");
    expect(result.value.casePublicCode).toBe("CAS-ORG1-2222");
  });

  it("uses eventJurisdiction for case if provided (overrides pet jurisdiction)", async () => {
    const deps = makeDeps();
    const input = {
      ...BASE_INPUT,
      eventJurisdictionProvince: "Córdoba",
      eventJurisdictionLocality: "Río Cuarto",
    };
    await reportBiteFromOrg(input, deps);
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({
        jurisdictionProvince: "Córdoba",
        jurisdictionLocality: "Río Cuarto",
      }),
      "fake-tx",
    );
  });
});

// ---------------------------------------------------------------------------
// LEGAL-ROUTING fix — authority fan-out uses the INCIDENT jurisdiction, not
// the pet's home. PO decision: a bite routes to where it HAPPENED. The case
// override was already correct (test above); this pins the authority
// notification, which a prior audit found still used pet.jurisdictionProvince
// /Locality (the pet's home — Palermo, CABA per BASE_INPUT.pet) regardless.
// ---------------------------------------------------------------------------

describe("reportBiteFromOrg — incident jurisdiction overrides pet home jurisdiction", () => {
  const INCIDENT_ELSEWHERE_INPUT: ReportBiteFromOrgInput = {
    ...BASE_INPUT,
    // pet's home is jurisdiction A (CABA / Palermo, per BASE_INPUT.pet). The
    // bite happened in jurisdiction B.
    eventJurisdictionProvince: "Córdoba",
    eventJurisdictionLocality: "Río Cuarto",
  };

  it("notifies the incident jurisdiction's (B) authority, not the pet's home (A) authority", async () => {
    const deps = makeDeps();
    await reportBiteFromOrg(INCIDENT_ELSEWHERE_INPUT, deps);
    expect(deps.findAuthoritiesForJurisdiction).toHaveBeenCalledWith({
      province: "Córdoba",
      locality: "Río Cuarto",
    });
    expect(deps.findAuthoritiesForJurisdiction).not.toHaveBeenCalledWith({
      province: "CABA",
      locality: "Palermo",
    });
  });

  // A1 (Lote A): same convention as the pin above — the statutory window
  // resolves against the incident jurisdiction, and the stored deadline honors
  // the RESOLVED days, not the hardcoded 10.
  it("resolves the observation window against the incident jurisdiction and honors its days (A1)", async () => {
    const deps = makeDeps();
    deps.resolveObservationWindow.mockResolvedValue({ days: 14 });
    await reportBiteFromOrg(INCIDENT_ELSEWHERE_INPUT, deps);
    expect(deps.resolveObservationWindow).toHaveBeenCalledWith({
      province: "Córdoba",
      locality: "Río Cuarto",
    });
    expect(deps.repo.insertObservationStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          observation_until: computeObservationUntil(BASE_INPUT.occurredAt, 14).toISOString(),
        }),
      }),
      "fake-tx",
    );
  });

  // T1-G2 (localidad plan L2·1): the resolved incident locality id rides onto
  // the case — only when the case routes to the incident locality.
  it("stamps the resolved incident locality id on the case, and none on a home fallback", async () => {
    const LOCALITY_ID = "b0000000-0000-4000-8000-0000000000c2";
    const deps = makeDeps();
    await reportBiteFromOrg({ ...INCIDENT_ELSEWHERE_INPUT, eventLocalityId: LOCALITY_ID }, deps);
    expect(deps.openCase).toHaveBeenLastCalledWith(
      expect.objectContaining({ jurisdictionLocality: "Río Cuarto", localityId: LOCALITY_ID }),
      "fake-tx",
    );
    const fallback = makeDeps();
    await reportBiteFromOrg(
      { ...BASE_INPUT, eventJurisdictionProvince: "CABA", eventLocalityId: LOCALITY_ID },
      fallback,
    );
    expect(fallback.openCase).toHaveBeenLastCalledWith(
      expect.objectContaining({ jurisdictionLocality: "Palermo", localityId: null }),
      "fake-tx",
    );
  });
});

// ---------------------------------------------------------------------------
// H1 (top-10 review 2026-08-22) — WHO may open a rabies observation on an
// animal. The finding, reproduced by two independent skeptics: the org path was
// gated ONLY by `bite.report` on an organization the caller had just created
// (creating one asks for a DNI nobody verifies, and the creator becomes its
// admin). No `organization.verified`, no relationship to the target animal.
// The consequence is not a bad row: it is a red banner on the public
// credential, an alert to the pet's authorities, a blocked rehome — and the
// owner cannot lift it (only a professional or the State can close it since
// 2026-08-17).
//
// The gate is TWO facts, not one. `verified` alone would still let a verified
// shelter in Ushuaia open an observation on a pet in Salta it has never seen;
// a relationship alone would still let an unverified "organization" report the
// animal it is holding. Both are required.
//
// The relationship half is deliberately a DISJUNCTION, because the legitimate
// case that would otherwise break is real: a verified shelter reporting a bite
// by an animal it does NOT hold (someone else's dog bit a volunteer on its
// doorstep) has no attendance/custody row for that pet — its claim comes from
// the INCIDENT being inside the zone it works in. Coverage is read through
// lib/domain/org-coverage.ts, the one predicate rehome and foster already use.
// ---------------------------------------------------------------------------

describe("reportBiteFromOrg — the reporting org must be verified AND connected to the animal", () => {
  /** No attendance, no custody, no coverage anywhere: a total stranger. */
  const STRANGER = { hasPetRelation: false, coverageAreas: [] };

  it("refuses an organization that is not verified, even one holding the animal", async () => {
    const deps = makeDeps();
    const result = await reportBiteFromOrg(
      { ...BASE_INPUT, organization: { ...BASE_INPUT.organization, verified: false } },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("verificada");
    // Refused BEFORE anything is written — no case, no event, no status flip.
    expect(deps.transaction).not.toHaveBeenCalled();
  });

  it("refuses a verified org with no relation to the pet and no coverage of the incident zone", async () => {
    const deps = makeDeps();
    deps.loadOrgPetAuthority.mockResolvedValue(STRANGER);
    const result = await reportBiteFromOrg(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(deps.transaction).not.toHaveBeenCalled();
    expect(deps.repo.insertIncidentEventIdempotent).not.toHaveBeenCalled();
    expect(deps.repo.setObservationStatus).not.toHaveBeenCalled();
  });

  it("LETS a verified shelter report a bite by an animal it does not hold, inside its coverage", async () => {
    // The legitimate flow the gate must not break. No attendance row, no
    // custody row — the shelter's standing comes from where the bite happened.
    const deps = makeDeps();
    deps.loadOrgPetAuthority.mockResolvedValue({
      hasPetRelation: false,
      coverageAreas: [{ jurisdictionProvince: "CABA", jurisdictionLocality: "Palermo" }],
    });
    const result = await reportBiteFromOrg(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
  });

  it("reads coverage against the INCIDENT zone, not the pet's home zone", async () => {
    // Same shelter, same coverage (CABA/Palermo — the pet's home): the bite
    // happened in Córdoba, where this org does not work. Without this the
    // predicate would authorize a national stranger for any pet registered in
    // the one locality it covers.
    const deps = makeDeps();
    deps.loadOrgPetAuthority.mockResolvedValue({
      hasPetRelation: false,
      coverageAreas: [{ jurisdictionProvince: "CABA", jurisdictionLocality: "Palermo" }],
    });
    const result = await reportBiteFromOrg(
      {
        ...BASE_INPUT,
        eventJurisdictionProvince: "Córdoba",
        eventJurisdictionLocality: "Río Cuarto",
      },
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("REFUSES coverage the org minted outside the province it was verified in", async () => {
    // U3 (2026-08-22): addCoverageZoneAction lets any admin/coordinator add ANY
    // province, so this row is self-asserted. Anchoring the arm to
    // organizations.jurisdiction_province — which the org cannot edit — is what
    // stops a CABA-verified org acquiring standing in Córdoba by typing it in.
    const deps = makeDeps();
    deps.loadOrgPetAuthority.mockResolvedValue({
      hasPetRelation: false,
      coverageAreas: [{ jurisdictionProvince: "Córdoba", jurisdictionLocality: null }],
    });
    const result = await reportBiteFromOrg(
      {
        ...BASE_INPUT,
        eventJurisdictionProvince: "Córdoba",
        eventJurisdictionLocality: "Río Cuarto",
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(deps.transaction).not.toHaveBeenCalled();
  });

  it("LETS a verified clinic that attended the animal report a bite outside its coverage", async () => {
    // The other arm of the disjunction: the vet who treats this dog reports a
    // bite that happened while the family was travelling.
    const deps = makeDeps();
    deps.loadOrgPetAuthority.mockResolvedValue({ hasPetRelation: true, coverageAreas: [] });
    const result = await reportBiteFromOrg(
      {
        ...BASE_INPUT,
        eventJurisdictionProvince: "Córdoba",
        eventJurisdictionLocality: "Río Cuarto",
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("asks about THIS org and THIS pet", async () => {
    const deps = makeDeps();
    await reportBiteFromOrg(BASE_INPUT, deps);
    expect(deps.loadOrgPetAuthority).toHaveBeenCalledWith(
      BASE_INPUT.organization.id,
      BASE_INPUT.pet.id,
    );
  });

  it("writes the audit row inside the report transaction", async () => {
    // `SELECT DISTINCT action FROM audit_log` returned 43 actions and not one
    // of them was a bite: the single most consequential org write in the system
    // left nothing in the accountability spine. Inside the tx, so a rollback
    // takes the row with it.
    const deps = makeDeps();
    await reportBiteFromOrg(BASE_INPUT, deps);
    const audit = deps.repo.insertAuditLog as ReturnType<typeof vi.fn>;
    expect(audit).toHaveBeenCalledTimes(1);
    const [entry, executor] = audit.mock.calls[0];
    expect(executor).toBe("fake-tx");
    expect(entry).toMatchObject({
      action: "bite_reported_by_org",
      actorUserId: BASE_INPUT.user.id,
      targetOrganizationId: BASE_INPUT.organization.id,
    });
  });

  it("does NOT write an audit row when the bite event deduplicates (no-op retry)", async () => {
    const deps = makeDeps({
      insertIncidentEventIdempotent: vi
        .fn()
        .mockResolvedValue({ event: { id: FAKE_BITE_ORG_ID }, wasNoop: true }),
    });
    await reportBiteFromOrg(BASE_INPUT, deps);
    expect(deps.repo.insertAuditLog).not.toHaveBeenCalled();
  });
});
