// Pure rules of the rehome-by-titular request and accept paths.
// Layer: Unit (no DB, no Next.js). Spec REQ-1, REQ-16; design ADR-1 steps 1-4.

import { describe, expect, it } from "vitest";

import {
  PET_LOST_ERROR,
  REHOME_ELIGIBLE_ORG_TYPES,
  coverageAreaCoversZone,
  orgCoversZone,
  validateAcceptPreconditions,
  validateDeclinePreconditions,
  validateRequestOpen,
  validateSponsorCoverage,
  validateSponsorTarget,
  validateWithdrawRequest,
  validateWithdrawSponsorship,
} from "../domain/rehome-rules";

describe("validateSponsorTarget — who may be asked to sponsor", () => {
  it("accepts a verified shelter and a verified rescue network", () => {
    expect(validateSponsorTarget({ orgType: "shelter", verified: true })).toEqual({ ok: true });
    expect(validateSponsorTarget({ orgType: "rescue_network", verified: true })).toEqual({
      ok: true,
    });
    expect([...REHOME_ELIGIBLE_ORG_TYPES].sort()).toEqual(["rescue_network", "shelter"]);
  });

  it("rejects a missing org", () => {
    const r = validateSponsorTarget(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Organización no encontrada.");
  });

  it("rejects a verified org of the wrong type (a vet clinic cannot sponsor)", () => {
    const r = validateSponsorTarget({ orgType: "vet", verified: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/refugio o una red de rescate/);
  });

  it("rejects an unverified shelter", () => {
    const r = validateSponsorTarget({ orgType: "shelter", verified: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("La organización no está verificada.");
  });
});

describe("coverage — the picker's filter, as a rule (W-4)", () => {
  const laPlata = { province: "Buenos Aires", locality: "La Plata" };

  it("matches a coverage row for the exact province + locality", () => {
    expect(
      coverageAreaCoversZone(
        { jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "La Plata" },
        laPlata,
      ),
    ).toBe(true);
  });

  it("matches a province-wide row (locality IS NULL) — the picker's `or(isNull(...))` branch", () => {
    expect(
      coverageAreaCoversZone(
        { jurisdictionProvince: "Buenos Aires", jurisdictionLocality: null },
        laPlata,
      ),
    ).toBe(true);
  });

  it("does not match another locality of the same province, nor another province", () => {
    expect(
      coverageAreaCoversZone(
        { jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "Berisso" },
        laPlata,
      ),
    ).toBe(false);
    expect(
      coverageAreaCoversZone(
        { jurisdictionProvince: "Córdoba", jurisdictionLocality: "La Plata" },
        laPlata,
      ),
    ).toBe(false);
  });

  it("with no locality on the pet, any row in the province counts — the picker drops the locality predicate", () => {
    const zone = { province: "Buenos Aires", locality: null };
    expect(
      coverageAreaCoversZone(
        { jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "Berisso" },
        zone,
      ),
    ).toBe(true);
    expect(
      coverageAreaCoversZone({ jurisdictionProvince: "Córdoba", jurisdictionLocality: null }, zone),
    ).toBe(false);
  });

  it("orgCoversZone is any-of, and an org with no coverage rows covers nothing", () => {
    expect(
      orgCoversZone(
        [
          { jurisdictionProvince: "Córdoba", jurisdictionLocality: null },
          { jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "La Plata" },
        ],
        laPlata,
      ),
    ).toBe(true);
    expect(orgCoversZone([], laPlata)).toBe(false);
  });
});

describe("validateSponsorCoverage — the refusal the titular reads (W-4)", () => {
  const base = {
    orgDisplayName: "Refugio Lejano",
    petName: "Malena",
    zone: { province: "Buenos Aires", locality: "La Plata" },
  };

  it("passes when a coverage row reaches the pet's zone", () => {
    expect(
      validateSponsorCoverage({
        ...base,
        coverage: [{ jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "La Plata" }],
      }),
    ).toEqual({ ok: true });
  });

  it("names the org and the pet when nothing covers the zone", () => {
    const r = validateSponsorCoverage({
      ...base,
      coverage: [{ jurisdictionProvince: "Córdoba", jurisdictionLocality: "Córdoba" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Refugio Lejano no cubre la zona de Malena\./);
  });

  it("says the honest thing when the PET has no province — the picker's other empty state", () => {
    const r = validateSponsorCoverage({
      ...base,
      zone: { province: null, locality: null },
      coverage: [{ jurisdictionProvince: "Buenos Aires", jurisdictionLocality: null }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no tiene provincia registrada/);
  });
});

describe("validateRequestOpen — one request per pet at a time (REQ-16)", () => {
  const clean = { petStatus: "active", hasOpenRequest: false, hasOpenSponsorship: false };

  it("allows a first request on an active pet", () => {
    expect(validateRequestOpen(clean)).toEqual({ ok: true });
  });

  it("rejects while a request is still pending", () => {
    const r = validateRequestOpen({ ...clean, hasOpenRequest: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/solicitud de nuevo hogar pendiente/);
  });

  it("rejects while an accepted sponsorship is still running", () => {
    const r = validateRequestOpen({ ...clean, hasOpenSponsorship: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya tiene una organización acompañando/);
  });

  it("rejects a deceased pet", () => {
    const r = validateRequestOpen({ ...clean, petStatus: "deceased" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fallecida/);
  });

  // The gap this suite mirrored until 2026-08-25: it tested `deceased` only,
  // so the missing `lost` arm was green. The accept refuses lost, so custody
  // was never granted — what the request cost was an org inbox item, a
  // notification saying the animal "sigue viviendo con su familia", and an
  // open `rehome_request` case beside an open `lost_pet` one.
  it("rejects a pet reported lost", () => {
    const r = validateRequestOpen({ ...clean, petStatus: "lost" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reportada como perdida/);
  });

  // ONE sentence per refusal, not one per door: the request and the accept
  // say the same thing about a lost animal. A second wording would read as a
  // different rule to the person hitting it twice.
  //
  // The sentence now has ONE home — `PET_LOST_ERROR` — and this asserts the
  // door uses it. Until 2026-08-25 it was an inline literal in three places
  // pinned only by tests that hardcoded it separately, which is not a pin.
  it("refuses a lost pet with the module's one named sentence", () => {
    const r = validateRequestOpen({ ...clean, petStatus: "lost" });
    expect(r).toEqual({ ok: false, error: PET_LOST_ERROR });
    expect(PET_LOST_ERROR).toBe("Esta mascota está reportada como perdida.");
  });

  it("says exactly what the accept says about a lost pet", () => {
    const request = validateRequestOpen({ ...clean, petStatus: "lost" });
    const accept = validateAcceptPreconditions({
      caseKind: "rehome_request",
      caseStatus: "open",
      caseReceiverOrganizationId: "org-a",
      actingOrganizationId: "org-a",
      actingOrg: { orgType: "shelter", verified: true },
      titularOwnerRowLive: true,
      liveShelterCustodyCount: 0,
      pet: {
        status: "lost",
        inCustodyDispute: false,
        rabiesObservationStatus: null,
        adoptionIneligibleUntil: null,
      },
      now: new Date("2026-08-25T12:00:00Z"),
    });
    expect(request.ok).toBe(false);
    expect(accept.ok).toBe(false);
    if (!request.ok && !accept.ok) expect(request.error).toBe(accept.error);
  });

  // Order pinned: a pet that is lost AND already has a pending request hears
  // "perdida" first, the same way the accept and `validatePublish` order it.
  it("reports lost before the open-request lock", () => {
    const r = validateRequestOpen({ ...clean, petStatus: "lost", hasOpenRequest: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reportada como perdida/);
  });
});

describe("validateAcceptPreconditions — ADR-1 steps 1 to 4, in order", () => {
  const ORG = "org-a";
  const NOW = new Date("2026-08-21T12:00:00Z");
  const good = {
    caseKind: "rehome_request",
    caseStatus: "open",
    caseReceiverOrganizationId: ORG,
    actingOrganizationId: ORG,
    actingOrg: { orgType: "shelter", verified: true },
    titularOwnerRowLive: true,
    liveShelterCustodyCount: 0,
    pet: {
      status: "active",
      inCustodyDispute: false,
      rabiesObservationStatus: null,
      adoptionIneligibleUntil: null,
    },
    now: NOW,
  };

  it("passes the clean case", () => {
    expect(validateAcceptPreconditions(good)).toEqual({ ok: true });
  });

  // WU3 review, L-3. Step 6 of the accept calls setEligibility(true), which
  // nulls adoption_ineligible_until / _reason. A time-boxed ineligibility — a
  // quarantine, a treatment, a legal hold WITH a date — set by whichever org
  // last held the animal is a fact about the animal that outlives that org's
  // custody; the accept must not erase it while it is in force. An open-ended
  // ineligibility (no date) is NOT a blocker: the org that set it no longer
  // holds custody (step 3 asserts zero live custody), so nobody could lift
  // it, and a pet blocked forever with no lifter is the worse failure.
  it("step 4: rejects while a time-boxed ineligibility is still in force — the accept would erase it", () => {
    const r = validateAcceptPreconditions({
      ...good,
      pet: { ...good.pet, adoptionIneligibleUntil: new Date("2026-09-30T00:00:00Z") },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no apta para adopción hasta/);
  });

  it("step 4: an ineligibility whose date already passed no longer blocks", () => {
    const r = validateAcceptPreconditions({
      ...good,
      pet: { ...good.pet, adoptionIneligibleUntil: new Date("2026-08-21T11:59:59Z") },
    });
    expect(r).toEqual({ ok: true });
  });

  it("step 4: the time-box is checked after custody (step 3), not before", () => {
    const r = validateAcceptPreconditions({
      ...good,
      liveShelterCustodyCount: 1,
      pet: { ...good.pet, adoptionIneligibleUntil: new Date("2026-09-30T00:00:00Z") },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bajo custodia de una organización/);
  });

  // The catalog (adoption-listing-read.ts) lists a pet only when the custodian
  // org is verified AND a shelter/rescue network. Accepting without asserting
  // both would grant custody, publish, notify "ya figura en la búsqueda" — and
  // the pet would never appear, with no undo until the titular withdraws.
  it("step 1b: rejects an acting org that is no longer verified — the catalog would never list the pet", () => {
    const r = validateAcceptPreconditions({
      ...good,
      actingOrg: { orgType: "shelter", verified: false },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("La organización no está verificada.");
  });

  it("step 1b: rejects an acting org of a type the catalog does not list", () => {
    const r = validateAcceptPreconditions({
      ...good,
      actingOrg: { orgType: "clinic", verified: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/refugio o una red de rescate/);
  });

  it("step 1b: rejects when the acting org row cannot be re-read at all", () => {
    const r = validateAcceptPreconditions({ ...good, actingOrg: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Organización no encontrada.");
  });

  it("step 1b sits between the case checks and the titular check", () => {
    // Closed case + de-verified org: step 1 wins.
    const closed = validateAcceptPreconditions({
      ...good,
      caseStatus: "closed",
      actingOrg: { orgType: "shelter", verified: false },
    });
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error).toMatch(/ya fue respondida/);
    // De-verified org + ex-owner: the org's own problem is reported first.
    const deverified = validateAcceptPreconditions({
      ...good,
      actingOrg: { orgType: "shelter", verified: false },
      titularOwnerRowLive: false,
    });
    expect(deverified.ok).toBe(false);
    if (!deverified.ok) expect(deverified.error).toMatch(/no está verificada/);
  });

  it("step 1: rejects a case that is not an open rehome_request addressed to this org", () => {
    const wrongKind = validateAcceptPreconditions({ ...good, caseKind: "adoption_listing" });
    const closed = validateAcceptPreconditions({ ...good, caseStatus: "closed" });
    const otherOrg = validateAcceptPreconditions({ ...good, caseReceiverOrganizationId: "org-b" });
    expect(wrongKind.ok).toBe(false);
    expect(closed.ok).toBe(false);
    expect(otherOrg.ok).toBe(false);
    if (!closed.ok) expect(closed.error).toMatch(/ya fue respondida/);
    if (!otherOrg.ok) expect(otherOrg.error).toMatch(/otra organización/);
  });

  it("step 2: rejects when the titular who consented no longer holds a live owner row", () => {
    const r = validateAcceptPreconditions({ ...good, titularOwnerRowLive: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya no es titular/);
  });

  it("step 3: rejects when any org already holds live custody (one org at a time)", () => {
    const r = validateAcceptPreconditions({ ...good, liveShelterCustodyCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bajo custodia de una organización/);
  });

  it("step 4: rejects the catalog preconditions with a reason instead of a silent non-listing", () => {
    const lost = validateAcceptPreconditions({ ...good, pet: { ...good.pet, status: "lost" } });
    const dead = validateAcceptPreconditions({ ...good, pet: { ...good.pet, status: "deceased" } });
    const dispute = validateAcceptPreconditions({
      ...good,
      pet: { ...good.pet, inCustodyDispute: true },
    });
    const rabies = validateAcceptPreconditions({
      ...good,
      pet: { ...good.pet, rabiesObservationStatus: "in_progress" },
    });
    for (const r of [lost, dead, dispute, rabies]) expect(r.ok).toBe(false);
    if (!lost.ok) expect(lost.error).toMatch(/perdida/);
    if (!dispute.ok) expect(dispute.error).toMatch(/disputa de custodia/);
    if (!rabies.ok) expect(rabies.error).toMatch(/observación sanitaria/);
  });

  it("reports the earliest failing step, not the last", () => {
    // A closed case addressed to another org with a dead pet: step 1 wins.
    const r = validateAcceptPreconditions({
      ...good,
      caseStatus: "closed",
      caseReceiverOrganizationId: "org-b",
      pet: { ...good.pet, status: "deceased" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya fue respondida/);
  });
});

describe("validateDeclinePreconditions — only step 1 applies", () => {
  it("declining needs an open rehome_request addressed to this org and nothing about the animal", () => {
    const base = {
      caseKind: "rehome_request",
      caseStatus: "open",
      caseReceiverOrganizationId: "org-a",
      actingOrganizationId: "org-a",
    };
    expect(validateDeclinePreconditions(base)).toEqual({ ok: true });
    expect(validateDeclinePreconditions({ ...base, caseStatus: "closed" }).ok).toBe(false);
    expect(validateDeclinePreconditions({ ...base, actingOrganizationId: "org-b" }).ok).toBe(false);
  });
});

// WU4. The titular's withdraw is unconditional on the ORG's side (REQ-8,
// REQ-10: no waiting period, no org sign-off, no org reachability) — the only
// two things it checks are about the titular and about there being something
// to withdraw.
describe("validateWithdrawSponsorship — the titular ends an active sponsorship (REQ-8, REQ-10)", () => {
  const open = { ownershipId: "cust-1" };

  it("passes for the live titular while a sponsorship is running", () => {
    expect(
      validateWithdrawSponsorship({ titularOwnerRowLive: true, openSponsorship: open }),
    ).toEqual({ ok: true });
  });

  it("rejects anyone who does not hold the live owner row (a foster, a caretaker, an ex-owner)", () => {
    const r = validateWithdrawSponsorship({ titularOwnerRowLive: false, openSponsorship: open });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/titular/);
  });

  it("rejects when nothing is running — there is nothing to withdraw", () => {
    const r = validateWithdrawSponsorship({ titularOwnerRowLive: true, openSponsorship: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no tiene un acompañamiento .*activo/);
  });
});

describe("validateWithdrawRequest — the titular cancels a request before it is answered (REQ-3)", () => {
  const base = {
    caseKind: "rehome_request",
    caseStatus: "open",
    caseOpenedByUserId: "user-titular",
    actingUserId: "user-titular",
  };

  it("passes for the user who opened the still-open request", () => {
    expect(validateWithdrawRequest(base)).toEqual({ ok: true });
  });

  it("rejects a case of another kind", () => {
    const r = validateWithdrawRequest({ ...base, caseKind: "adoption_listing" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no es una solicitud de nuevo hogar/);
  });

  it("rejects once the request is no longer open — answered or already cancelled", () => {
    const r = validateWithdrawRequest({ ...base, caseStatus: "closed" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ya fue respondida o cancelada/);
  });

  it("rejects a different user than the one who opened it", () => {
    const r = validateWithdrawRequest({ ...base, actingUserId: "user-other" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/quien envió la solicitud/);
  });
});
