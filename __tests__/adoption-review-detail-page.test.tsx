// Regression — QA round 2 finding #1 (adoptions review detail crash).
//
// Storyline-seeded adoption_application_submitted payloads carry non-uuid
// applicant ids (e.g. "external_user_404"). The detail page compared
// profiles.id (uuid) against that value via drizzle eq() — a parameterized
// uuid comparison Postgres aborts with 22P02, crashing the WHOLE page (RSC
// error digest 3025710647): an org could list applications but never open
// one to approve/reject. Fixed in f0e1f900 with the isUuid() guard; this
// test pins the fix with a real fixture so the class of bug can't return.
//
// Covers both payload shapes:
//   - non-uuid applicant (the crasher) → page renders "(perfil no encontrado)"
//   - uuid applicant with no matching profile → same fallback, no crash
//
// Integration style mirrors adoption-review.test.ts (real local Postgres via
// drizzle); the page's auth guards are mocked, rendering goes through
// react-dom/server like public-token-landing-structure.test.tsx.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  useRouter: vi.fn(() => ({ refresh: vi.fn(), push: vi.fn() })),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

// Auth guards — the crash under test lives in the data path, not authz.
// requireOrgAccessByToken / requireCapability resolve to the fixture org.
vi.mock("@/lib/infra/auth-guards", () => ({
  requireOrgAccessByToken: vi.fn(async () => ({
    organization: { id: orgId, displayName: "Detail Refugio" },
  })),
}));

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapability: vi.fn(async () => ({
    error: null,
    user: { id: REVIEWER_FAKE_ID },
    organization: { id: orgId, displayName: "Detail Refugio" },
    membership: null,
    granted: null,
  })),
}));

import { and, eq } from "drizzle-orm";

import { db, organizations, ownerships, petEvents, pets } from "@/db";

import AdoptionReviewDetailPage from "@/app/org/[orgToken]/adopciones/[appEventId]/page";
import { withMutationOverride } from "./_helpers/db-overrides";

const ORG_TOKEN = "DIM-REVDET-01";
const PET_TOKEN = "DIM-RDT-PET1";
// No auth user is created: the adopter_pii_viewed audit insert is best-effort
// by contract (its FK failure must never block the render), so a random
// reviewer id also exercises that posture.
const REVIEWER_FAKE_ID = "9c1f2a34-0000-4000-8000-00000000dead";

let orgId: string;
let petId: string;
let nonUuidAppEventId: string;
let uuidNoProfileAppEventId: string;

beforeAll(async () => {
  // Clean leftovers from a previous crashed run (hardcoded tokens).
  await withMutationOverride(async (tx) => {
    const stale = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
    for (const { id } of stale) {
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, ORG_TOKEN));
  for (const { id } of staleOrgs) {
    await db.delete(organizations).where(eq(organizations.id, id));
  }

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Detail Refugio SRL",
      displayName: "Detail Refugio",
      orgType: "shelter",
      email: "detail-review@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  const now = new Date();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Coco Detalle",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      adoptionListedAt: now,
      adoptionEligible: true,
      adoptionEligibilitySetAt: now,
    })
    .returning();
  petId = pet.id;

  await db.insert(ownerships).values({
    petId,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: now,
  });

  // The crasher fixture: v1 payload, applicant id is NOT a uuid — the exact
  // shape of the storyline-seeded rows that took the page down.
  const [nonUuidEvent] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "adoption_application_submitted",
      occurredAt: now,
      recordedAt: now,
      authorRole: "owner",
      payload: {
        payload_version: 1,
        applicant_user_id: "external_user_404",
        housing_type: "departamento",
        related_organization_id: "patitas-del-norte",
      },
    })
    .returning();
  nonUuidAppEventId = nonUuidEvent.id;

  // Valid-uuid applicant with no profiles row — must fall back, not crash.
  const [uuidEvent] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "adoption_application_submitted",
      occurredAt: now,
      recordedAt: now,
      authorRole: "owner",
      payload: {
        payload_version: 2,
        applicant_user_id: "3f7b1e10-1111-4111-8111-000000000404",
        housing_type: "casa_con_patio",
        other_pets: null,
        daily_routine: null,
        notes: null,
        motivation: "Quiero darle un hogar.",
        prior_pets: "no",
      },
    })
    .returning();
  uuidNoProfileAppEventId = uuidEvent.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.delete(ownerships).where(eq(ownerships.petId, petId));
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
  await db.delete(organizations).where(eq(organizations.id, orgId));
});

async function renderDetail(appEventId: string): Promise<string> {
  const element = await AdoptionReviewDetailPage({
    params: Promise.resolve({ orgToken: ORG_TOKEN, appEventId }),
  });
  return renderToStaticMarkup(element as React.ReactElement);
}

describe("adoption review detail page (QA round 2 #1)", () => {
  it("renders a non-uuid applicant application instead of crashing (22P02 regression)", async () => {
    const html = await renderDetail(nonUuidAppEventId);
    expect(html).toContain("Postulación para");
    expect(html).toContain("Coco Detalle");
    // Non-uuid applicant → guarded lookup → explicit fallback, review
    // controls still available.
    expect(html).toContain("(perfil no encontrado)");
    expect(html).toContain("Departamento");
  });

  it("renders a uuid applicant without a profile row via the same fallback", async () => {
    const html = await renderDetail(uuidNoProfileAppEventId);
    expect(html).toContain("Postulación para");
    expect(html).toContain("(perfil no encontrado)");
    expect(html).toContain("Casa con patio");
    expect(html).toContain("Quiero darle un hogar.");
  });

  it("still lists both applications as pending for the org (sanity: list did not regress)", async () => {
    const submitted = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_submitted")),
      );
    expect(submitted.map((r) => r.id).sort()).toEqual(
      [nonUuidAppEventId, uuidNoProfileAppEventId].sort(),
    );
  });
});
