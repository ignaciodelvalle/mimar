// clinicMayRecordObservationDeath — the second anchor a vet needs before
// recording a TERMINAL death during a rabies observation (security review
// 2026-09-18, MEDIUM D8). Real rows, no mocks: the rule is two queries and
// both are the thing under test.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizations, petEvents, pets, profiles } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { clinicMayRecordObservationDeath } from "@/lib/infra/vet-observation-reach";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = `DIM-VR-${randomUUID().slice(0, 4).toUpperCase()}`;
const creatorId = randomUUID();
let petId: string;
let localOrgId: string;
let farOrgId: string;
let observingFarOrgId: string;
const observationStartedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

async function makeOrg(province: string): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: `VR-${randomUUID()}`,
      displayName: `VR clinic ${province}`,
      legalName: `VR clinic ${province} S.A.`,
      orgType: "shelter",
      email: `vr-${randomUUID().slice(0, 8)}@dim-test.local`,
      jurisdictionProvince: province,
      createdByUserId: creatorId,
    })
    .returning({ id: organizations.id });
  return org.id;
}

async function signedBy(orgId: string, occurredAt: Date): Promise<void> {
  const payload = validateEventPayload("incident_reported", {
    incident_type: "bite_inflicted",
    severity: "moderate",
    injuries_summary: null,
    vet_involved: null,
    location_description: null,
    victim_kind: "human",
    victim_contact_name: null,
    victim_contact_phone: null,
    victim_pet_id: null,
    victim_age_estimate: null,
    context: null,
    rabies_vaccine_valid_at_incident: true,
    reporter_role: "owner",
  });
  await db.insert(petEvents).values({
    petId,
    eventType: "incident_reported",
    occurredAt,
    recordedAt: occurredAt,
    authorRole: "owner",
    authorOrganizationId: orgId,
    payload,
  });
}

beforeAll(async () => {
  await db.insert(profiles).values({
    id: creatorId,
    displayName: "VR creator",
    role: "owner",
    accountType: "personal",
  });
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "ReachTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning({ id: pets.id });
  petId = pet.id;
  localOrgId = await makeOrg("Buenos Aires");
  farOrgId = await makeOrg("Salta");
  observingFarOrgId = await makeOrg("Jujuy");
  // A far clinic that signed BEFORE the observation: does not count.
  await signedBy(farOrgId, new Date(observationStartedAt.getTime() - 60_000));
  // A far clinic that signed DURING the observation: counts.
  await signedBy(observingFarOrgId, new Date(observationStartedAt.getTime() + 60_000));
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    if (petId) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
    }
    for (const orgId of [localOrgId, farOrgId, observingFarOrgId]) {
      if (orgId) await tx.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
    }
    await tx.execute(sql`DELETE FROM profiles WHERE id = ${creatorId}`);
  });
});

describe("clinicMayRecordObservationDeath", () => {
  const ask = (organizationId: string, observationStarted: Date | null = observationStartedAt) =>
    clinicMayRecordObservationDeath({
      organizationId,
      petId,
      petProvince: "Buenos Aires",
      observationStartedAt: observationStarted,
    });

  it("a clinic in the animal's province may", async () => {
    expect(await ask(localOrgId)).toBe(true);
  });

  it("a far clinic that already signed THIS observation may", async () => {
    expect(await ask(observingFarOrgId)).toBe(true);
  });

  it("a far clinic whose only event predates the observation may NOT", async () => {
    expect(await ask(farOrgId)).toBe(false);
  });

  it("with no observation start, a far clinic may NOT; an unknown org may NOT", async () => {
    expect(await ask(observingFarOrgId, null)).toBe(false);
    expect(await ask(randomUUID())).toBe(false);
  });
});
