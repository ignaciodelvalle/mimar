// @vitest-environment jsdom
//
// /adoptar/[petToken] — possession-conditioned copy (rehome-by-titular, spec
// REQ-12; design WU6 "B4").
//
// THE FALSE CLAIMS THIS PINS
// --------------------------
// The "REFUGIO RESPONSABLE" card asserted three things that are only true
// when the org physically holds the animal: the eyebrow itself, the ORG's
// locality shown as the pet's, and "En custodia desde {fecha}" read as an
// intake date. A rehome sponsorship gives the org a `shelter_custody` row
// while the animal keeps living with its family — registry custody, not
// possession — so on a sponsored ficha every one of those was a lie told to
// a prospective adopter, and the locality contradicted the search filter,
// which keys on the PET's locality.
//
// Sponsored is decided on the SPINE (an unmatched `rehome_sponsorship_started`
// naming the live custody row), never on the owner+shelter_custody shape,
// which also describes a decomiso or an intake. The surrender-path ficha
// (org custody, no sponsorship) keeps its copy byte-for-byte.
//
// Real database, real query, same harness as adoptar-ficha-current-custody.
// The sponsored fixture needs a pet_events row, which the append-only trigger
// refuses to DELETE — so cleanup goes through withMutationOverride.

import "@testing-library/jest-dom/vitest";

import { randomUUID } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Map()),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));

import { sql } from "drizzle-orm";

import { db, petEvents } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import AdoptarFichaPage from "../page";

const SPONSORED_TOKEN = "DIM-RHFI-SPON";
const SURRENDER_TOKEN = "DIM-RHFI-SURR";
const ORG_TOKEN = "DIM-RHFI-ORG1";
const ORG_NAME = "Red Acompaña QA";
const ORG_LOCALITY = "Recoleta";
const PET_LOCALITY = "Villa Urquiza";

const ids = {
  org: randomUUID(),
  sponsoredPet: randomUUID(),
  surrenderPet: randomUUID(),
  sponsoredCustody: randomUUID(),
};

async function renderPage(token: string): Promise<string> {
  const element = await AdoptarFichaPage({ params: Promise.resolve({ petToken: token }) });
  return renderToStaticMarkup(element);
}

async function cleanup(): Promise<void> {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`delete from public.pet_events where pet_id in (select id from public.pets where public_token in (${SPONSORED_TOKEN}, ${SURRENDER_TOKEN}))`,
    );
    await tx.execute(
      sql`delete from public.ownerships where pet_id in (select id from public.pets where public_token in (${SPONSORED_TOKEN}, ${SURRENDER_TOKEN}))`,
    );
    await tx.execute(
      sql`delete from public.pets where public_token in (${SPONSORED_TOKEN}, ${SURRENDER_TOKEN})`,
    );
    await tx.execute(sql`delete from public.organizations where public_token = ${ORG_TOKEN}`);
  });
}

beforeAll(async () => {
  await cleanup();
  await db.execute(sql`
    insert into public.organizations (id, public_token, display_name, legal_name, org_type, email,
                                      verified, status, jurisdiction_province, jurisdiction_locality)
    values (${ids.org}, ${ORG_TOKEN}, ${ORG_NAME}, ${ORG_NAME},
            'rescue_network', 'rhfi-org@dim-test.local', true, 'active', 'CABA', ${ORG_LOCALITY})
  `);

  // Two listed pets under the same org, same locality — one sponsored (lives
  // with its family), one surrendered (held by the org).
  await db.execute(sql`
    insert into public.pets (id, public_token, name, species, sex, status,
                             jurisdiction_province, jurisdiction_locality,
                             adoption_eligible, adoption_eligibility_set_at, adoption_listed_at)
    values (${ids.sponsoredPet}, ${SPONSORED_TOKEN}, 'FichaQA-Apadrinado', 'dog', 'male', 'active',
            'CABA', ${PET_LOCALITY}, true, now(), now()),
           (${ids.surrenderPet}, ${SURRENDER_TOKEN}, 'FichaQA-Entregado', 'dog', 'female', 'active',
            'CABA', ${PET_LOCALITY}, true, now(), now())
  `);

  await db.execute(sql`
    insert into public.ownerships (id, pet_id, owner_organization_id, role, started_at, ended_at)
    values (${ids.sponsoredCustody}, ${ids.sponsoredPet}, ${ids.org}, 'shelter_custody', now() - interval '12 days', null),
           (${randomUUID()}, ${ids.surrenderPet}, ${ids.org}, 'shelter_custody', now() - interval '12 days', null)
  `);

  // The sponsorship fact, on the spine, naming the custody row it opened.
  const now = new Date();
  const payload = validateEventPayload("rehome_sponsorship_started", {
    ownership_id: ids.sponsoredCustody,
    sponsoring_organization_id: ids.org,
    consented_by_user_id: randomUUID(),
    request_case_public_code: "CAS-RHFI-0001",
    listing_case_id: null,
    note: null,
  });
  await db.insert(petEvents).values({
    petId: ids.sponsoredPet,
    eventType: "rehome_sponsorship_started",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: null,
    authorRole: "shelter",
    authorOrganizationId: ids.org,
    authorVerified: true,
    payload,
  });
});

afterAll(cleanup);

describe("/adoptar/[petToken] — a SPONSORED pet says where it actually lives (REQ-12)", () => {
  it("the org is the one accompanying, not a 'refugio responsable'; the animal lives with its family", async () => {
    const html = await renderPage(SPONSORED_TOKEN);
    expect(html, "the org must still be named").toContain(ORG_NAME);
    expect(html).toContain("Organización que acompaña");
    expect(html).not.toContain("Refugio responsable");
    expect(html).toContain("FichaQA-Apadrinado vive con su familia actual");
    expect(html).toContain(
      `${ORG_NAME} publica la búsqueda de hogar y evalúa a quienes se postulan`,
    );
  });

  it("the locality shown is the PET's — the one the search filters on — not the org's", async () => {
    const html = await renderPage(SPONSORED_TOKEN);
    expect(html).toContain(PET_LOCALITY);
    expect(html, "the org's locality leaked as the animal's").not.toContain(ORG_LOCALITY);
  });

  it("no 'En custodia desde' — the date is when the accompaniment started", async () => {
    const html = await renderPage(SPONSORED_TOKEN);
    expect(html).not.toContain("En custodia desde");
    expect(html).toContain("Acompaña la adopción desde");
  });
});

describe("/adoptar/[petToken] — a SURRENDERED pet keeps the refugio copy unchanged", () => {
  it("still reads 'Refugio responsable', the org's locality and 'En custodia desde'", async () => {
    const html = await renderPage(SURRENDER_TOKEN);
    expect(html).toContain(ORG_NAME);
    expect(html).toContain("Refugio responsable");
    expect(html).toContain(ORG_LOCALITY);
    expect(html).toContain("En custodia desde");
    expect(html).not.toContain("vive con su familia");
    expect(html).not.toContain("Organización que acompaña");
  });
});
