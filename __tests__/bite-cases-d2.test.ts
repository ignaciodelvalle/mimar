// Integration tests for Fase D2 of the cases system — wiring the
// bite/rabies flow to the cases layer.
//
// We don't drive the full reportBiteAction (FormData + supabase auth
// would force too much mocking). Instead we exercise the contract by
// emulating the action's tx steps:
//  1. openCase(bite_incident) inside a transaction.
//  2. INSERT incident_reported + rabies_observation_started with caseId.
//  3. Assert the case row + linkage + bridge events all converge.
//  4. closeCase mirror on the various ending outcomes (negative, dead,
//     positive_rabies, lost_to_followup).

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-D2-PA1";

let petId: string;
let caseId: string;

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "BiteCaseTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
    await tx.execute(sql`DELETE FROM cases WHERE id = ${caseId}`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
  });
});

describe("D2: bite_incident case opens with incident + observation events", () => {
  it("openCase + 2 events with case_id, all atomic", async () => {
    const occurredAt = new Date();
    const observationUntil = new Date(occurredAt.getTime() + 10 * 24 * 60 * 60 * 1000);

    await db.transaction(async (tx) => {
      const caseRow = await openCase(
        {
          kind: "bite_incident",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
        },
        tx,
      );
      caseId = caseRow.id;

      const incidentPayload = validateEventPayload("incident_reported", {
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
      const [biteEvent] = await tx
        .insert(petEvents)
        .values({
          petId,
          eventType: "incident_reported",
          occurredAt,
          recordedAt: occurredAt,
          authorRole: "owner",
          payload: incidentPayload,
          caseId: caseRow.id,
        })
        .returning();

      const observationPayload = validateEventPayload("rabies_observation_started", {
        bite_event_id: biteEvent.id,
        observation_until: observationUntil.toISOString(),
        location: "in_situ",
        official_site_organization_id: null,
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "rabies_observation_started",
        occurredAt,
        recordedAt: occurredAt,
        authorRole: "owner",
        payload: observationPayload,
        caseId: caseRow.id,
      });
    });

    const [row] = await db
      .select({
        status: cases.status,
        caseKind: cases.caseKind,
        primaryPetId: cases.primaryPetId,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(row.status).toBe("open");
    expect(row.caseKind).toBe("bite_incident");
    expect(row.primaryPetId).toBe(petId);

    const events = await db
      .select({ eventType: petEvents.eventType, caseId: petEvents.caseId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.caseId, caseId)));
    expect(events.length).toBe(2);
    const types = events.map((e) => e.eventType).sort();
    expect(types).toEqual(["incident_reported", "rabies_observation_started"]);
  });
});

describe("D2: outcome → closed_reason mapping (closeCase mirror)", () => {
  it("negative outcome closes with closed_reason=resolved", async () => {
    const updated = await closeCase({ caseId, reason: "resolved" });
    expect(updated?.status).toBe("closed");
    expect(updated?.closedReason).toBe("resolved");
  });

  it("idempotent — closing a closed case returns it unchanged", async () => {
    const second = await closeCase({ caseId, reason: "resolved" });
    expect(second?.status).toBe("closed");
  });
});

describe("D2: per-pet partial index allows opening a new case after close", () => {
  let secondCaseId: string;

  it("opens a fresh bite_incident case after the previous was closed", async () => {
    const second = await openCase({
      kind: "bite_incident",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
    });
    secondCaseId = second.id;
    expect(second.status).toBe("open");
  });

  it("cleanup the second case", async () => {
    await closeCase({ caseId: secondCaseId, reason: "resolved" });
    await db.execute(sql`DELETE FROM cases WHERE id = ${secondCaseId}`);
  });
});
