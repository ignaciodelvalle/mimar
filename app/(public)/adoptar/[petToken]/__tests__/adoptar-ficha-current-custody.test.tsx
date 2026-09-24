// @vitest-environment jsdom
//
// /adoptar/[petToken] — the "REFUGIO RESPONSABLE" card names the CURRENT
// custodian, and the D7.2 soft branches survive the custody split.
//
// THE BUG THIS PINS
// -----------------
// The page inner-joined ownerships on petId alone, no role/ended predicate,
// `.limit(1)`. For a pet transferred between orgs that returned one ARBITRARY
// ownership row — in the wild, the ORIGINAL shelter's ended row: the public
// detail credited "Refugio Patitas del Norte · en custodia desde 7/7" while
// the catalog card, the receiving org's profile, and the transfer hub all
// said the receiver had accepted custody on 8/7 (9-role external run,
// 2026-08-18). The card that exists to say who answers for this animal named
// an org that no longer does.
//
// The fix filters to role='shelter_custody' AND ended_at IS NULL — the same
// predicate pair queryAdoptionListing uses — via a SEPARATE lookup, so a pet
// whose custody row ENDED (adopted out) still reaches the RecentlyAdopted
// soft page instead of hard-404ing on the join.
//
// Real database, real query — a mocked db cannot prove anything about a
// WHERE clause.
//
// FIXTURE CONSTRAINT: no pet_events rows. The append-only trigger blocks
// DELETE on pet_events, so a fixture pet with ANY event is undeletable and
// permanently poisons the unique public_token (learned the hard way — a
// crashed run left exactly that debris). The RecentlyAdopted branch
// (adoption_finalized within 7 days) therefore cannot be exercised here; what
// keeps it reachable is the SPLIT lookup structure itself (pet resolved
// before custody, custody optional), which the adopted-out case below pins.

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

import { db } from "@/db";
import AdoptarFichaPage from "../page";

const PET_TOKEN = "DIM-CUST-FICHA";
const ADOPTED_TOKEN = "DIM-CUST-ADOPT";
const OLD_ORG_TOKEN = "DIM-CUST-OLD1";
const NEW_ORG_TOKEN = "DIM-CUST-NEW1";
const OLD_ORG_NAME = "Refugio Custodia Original QA";
const NEW_ORG_NAME = "Red Custodia Vigente QA";

const ids = {
  oldOrg: randomUUID(),
  newOrg: randomUUID(),
  pet: randomUUID(),
  adoptedPet: randomUUID(),
};

async function renderPage(token: string): Promise<string> {
  const element = await AdoptarFichaPage({ params: Promise.resolve({ petToken: token }) });
  return renderToStaticMarkup(element);
}

// Token-keyed cleanup — id-keyed deletes miss residue from a crashed prior
// run (fresh random UUIDs each run), and these tokens are unique constraints.
async function cleanup(): Promise<void> {
  await db
    .execute(
      sql`delete from public.pet_events where pet_id in (select id from public.pets where public_token in (${PET_TOKEN}, ${ADOPTED_TOKEN}))`,
    )
    .catch(() => {});
  await db
    .execute(
      sql`delete from public.ownerships where pet_id in (select id from public.pets where public_token in (${PET_TOKEN}, ${ADOPTED_TOKEN}))`,
    )
    .catch(() => {});
  await db
    .execute(sql`delete from public.pets where public_token in (${PET_TOKEN}, ${ADOPTED_TOKEN})`)
    .catch(() => {});
  await db
    .execute(
      sql`delete from public.organizations where public_token in (${OLD_ORG_TOKEN}, ${NEW_ORG_TOKEN})`,
    )
    .catch(() => {});
}

beforeAll(async () => {
  await cleanup();
  await db.execute(sql`
    insert into public.organizations (id, public_token, display_name, legal_name, org_type, email,
                                      verified, status, jurisdiction_province, jurisdiction_locality)
    values (${ids.oldOrg}, ${OLD_ORG_TOKEN}, ${OLD_ORG_NAME}, ${OLD_ORG_NAME},
            'shelter', 'cust-old@dim-test.local', true, 'active', 'CABA', 'Palermo'),
           (${ids.newOrg}, ${NEW_ORG_TOKEN}, ${NEW_ORG_NAME}, ${NEW_ORG_NAME},
            'rescue_network', 'cust-new@dim-test.local', true, 'active', 'CABA', 'Recoleta')
  `);

  // Listed pet, transferred: ENDED custody at old org, ACTIVE at new org.
  await db.execute(sql`
    insert into public.pets (id, public_token, name, species, sex, status,
                             adoption_eligible, adoption_eligibility_set_at, adoption_listed_at)
    values (${ids.pet}, ${PET_TOKEN}, 'CustodiaQA-Negro', 'dog', 'male', 'active', true, now(), now()),
           (${ids.adoptedPet}, ${ADOPTED_TOKEN}, 'CustodiaQA-Adoptado', 'dog', 'female', 'active', true, now(), now())
  `);

  await db.execute(sql`
    insert into public.ownerships (pet_id, owner_organization_id, role, started_at, ended_at)
    values (${ids.pet}, ${ids.oldOrg}, 'shelter_custody', now() - interval '40 days', now() - interval '30 days'),
           (${ids.pet}, ${ids.newOrg}, 'shelter_custody', now() - interval '30 days', null),
           -- adopted-out pet: custody ENDED, nothing active
           (${ids.adoptedPet}, ${ids.oldOrg}, 'shelter_custody', now() - interval '40 days', now() - interval '2 days')
  `);
});

afterAll(cleanup);

describe("/adoptar/[petToken] — current-custody resolution", () => {
  it("names the CURRENT custodian, never the transferred-away org", async () => {
    const html = await renderPage(PET_TOKEN);

    // Positive control first: the page rendered the responsible-org card.
    expect(html, "the current custodian is missing — the query is broken").toContain(NEW_ORG_NAME);
    expect(html, "the ended custody row leaked into the public responsible-org card").not.toContain(
      OLD_ORG_NAME,
    );
  });

  it("an adopted-out pet (custody ENDED, nothing active) stops resolving as a listed ficha", async () => {
    // Under the old join, the ended custody row still satisfied every guard:
    // the page rendered the FULL ficha crediting the org that had already
    // given the animal up. Now the absence of a current custodian is decisive
    // (and with no recent adoption_finalized event, that means 404).
    await expect(renderPage(ADOPTED_TOKEN)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
