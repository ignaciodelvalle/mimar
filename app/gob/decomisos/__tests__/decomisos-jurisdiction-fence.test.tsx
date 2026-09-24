// @vitest-environment jsdom
//
// /gob/decomisos — the LIST is fenced by the operator's JURISDICTION, not only
// by their org membership. (RA-8 finding R3.)
//
// THE BUG THIS PINS
// -----------------
// The list scoped on `cases.openedByOrganizationId = govtOrg.id` alone. That
// answers "did my authority open this episode" — a question a STALE membership
// answers just as well as a current one. An operator whose jurisdiction
// assignments were narrowed to Mendoza, but whose membership in a CABA
// sanitary_authority was never revoked, kept seeing every CABA custody_episode
// that org had opened. Those rows are not passive: each one renders a
// "Reasignar" and a "Devolver al dueño" button, both of which mutate custody of
// a live animal irreversibly.
//
// Meanwhile CREATE (validateExecuteDecomiso) and DETAIL (canReadCase) both
// fenced on `session.jurisdictions`. This test is the one that makes the four
// surfaces agree.
//
// Real database, real query. A mocked `db` cannot prove anything about a WHERE
// clause — the only thing that can is a row that exists and does not come back.

import "@testing-library/jest-dom/vitest";

import { randomUUID } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const guardState: {
  role: string;
  jurisdictions: Array<{ province: string; locality: string }>;
} = { role: "govt", jurisdictions: [] };

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/gob/decomisos",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireDecomisoPrincipal: vi.fn(async () => ({
    user: { id: "fence-operator", email: "fence@dim.test" },
    profile: { id: "fence-operator", role: guardState.role },
    jurisdictions: guardState.jurisdictions,
  })),
}));

// The operator "belongs to" the CABA authority in every case below — that
// membership is exactly the credential the old scoping trusted. `missing`
// simulates a govt principal with jurisdiction assignments but no
// sanitary_authority membership (the read-only mode).
const orgState = { id: "", missing: false };
vi.mock("@/src/modules/decomiso/application/resolve-govt-org", () => ({
  resolveGovtOrgForUser: vi.fn(async () =>
    orgState.missing
      ? null
      : {
          id: orgState.id,
          displayName: "Autoridad Fence CABA",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Ciudad Autónoma de Buenos Aires",
        },
  ),
}));

vi.mock("@/lib/analytics/compliance-metrics", () => ({
  fetchSeizures: vi.fn(async () => ({ total: 0, byMotive: [] })),
}));

vi.mock("@/components/ui/dashboard/DashboardFreshnessFooter", () => ({
  DashboardFreshnessFooter: () => null,
}));

import { sql } from "drizzle-orm";

import { db } from "@/db";
import DecomisosDashboardPage from "../page";

const CABA_PET = "Perro CABA Fence";
const MENDOZA_PET = "Perro Mendoza Fence";
const CABA_TOKEN = "DIM-FENCE-CABA1";
const MENDOZA_TOKEN = "DIM-FENCE-MZA1";
const ORG_TOKEN = "DIM-FENCE-GOVT1";
const CASE_CABA = "CAS-FENC-CABA";
const CASE_MZA = "CAS-FENC-MZA1";

async function renderPage(): Promise<string> {
  const element = await DecomisosDashboardPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element);
}

beforeAll(async () => {
  const orgId = randomUUID();
  orgState.id = orgId;

  await db.execute(sql`
    insert into public.organizations (id, public_token, display_name, legal_name, org_type, email,
                                      verified, status, jurisdiction_province, jurisdiction_locality)
    values (${orgId}, ${ORG_TOKEN}, 'Autoridad Fence CABA', 'Autoridad Fence CABA',
            'sanitary_authority', 'fence-govt@dim-test.local', true, 'active',
            'CABA', 'Ciudad Autónoma de Buenos Aires')
  `);

  const cabaPetId = randomUUID();
  const mzaPetId = randomUUID();
  await db.execute(sql`
    insert into public.pets (id, public_token, name, species, sex, jurisdiction_province, jurisdiction_locality)
    values (${cabaPetId}, ${CABA_TOKEN}, ${CABA_PET}, 'dog', 'male', 'CABA', 'Palermo'),
           (${mzaPetId}, ${MENDOZA_TOKEN}, ${MENDOZA_PET}, 'dog', 'female', 'Mendoza', 'Godoy Cruz')
  `);

  // BOTH episodes are opened by the SAME authority the operator belongs to.
  // Only their jurisdiction differs — which is the whole experiment.
  await db.execute(sql`
    insert into public.cases (public_code, case_kind, status, primary_subject_kind, primary_pet_id,
                              jurisdiction_province, jurisdiction_locality, opened_by_organization_id)
    values (${CASE_CABA}, 'custody_episode', 'open', 'registered_pet', ${cabaPetId},
            'CABA', 'Palermo', ${orgId}),
           (${CASE_MZA}, 'custody_episode', 'open', 'registered_pet', ${mzaPetId},
            'Mendoza', 'Godoy Cruz', ${orgId})
  `);
});

afterAll(async () => {
  await db
    .execute(sql`delete from public.cases where public_code in (${CASE_CABA}, ${CASE_MZA})`)
    .catch(() => {});
  await db
    .execute(
      sql`delete from public.pet_events where pet_id in (select id from public.pets where public_token in (${CABA_TOKEN}, ${MENDOZA_TOKEN}))`,
    )
    .catch(() => {});
  await db
    .execute(sql`delete from public.pets where public_token in (${CABA_TOKEN}, ${MENDOZA_TOKEN})`)
    .catch(() => {});
  await db
    .execute(sql`delete from public.organizations where public_token = ${ORG_TOKEN}`)
    .catch(() => {});
});

describe("/gob/decomisos — jurisdictional fence on the LIST (RA-8 R3)", () => {
  it("shows only the episodes inside the operator's assignments, not everything their org opened", async () => {
    guardState.role = "govt";
    guardState.jurisdictions = [{ province: "Mendoza", locality: "Godoy Cruz" }];

    const html = await renderPage();

    // Positive control FIRST: if this is absent the fence "passed" only because
    // the query returned nothing at all, which proves nothing.
    expect(
      html,
      "the in-scope Mendoza episode is missing — the query is broken, not fenced",
    ).toContain(MENDOZA_PET);
    expect(
      html,
      "a Mendoza-assigned operator can see (and act on) a CABA custody episode because they still hold a membership in the org that opened it",
    ).not.toContain(CABA_PET);
  });

  it("a whole-province CABA assignment sees the CABA episode and not the Mendoza one", async () => {
    guardState.role = "govt";
    // Whole-province form: subsumes every barrio, so a Palermo-tagged case is
    // in scope — the same subsumption the detail page applies.
    guardState.jurisdictions = [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }];

    const html = await renderPage();

    expect(html, "whole-province CABA did not subsume a Palermo-tagged episode").toContain(
      CABA_PET,
    );
    expect(html, "CABA scope leaked a Mendoza episode").not.toContain(MENDOZA_PET);
  });

  it("an operator with ZERO assignments sees nothing (fail-closed, not unfiltered)", async () => {
    guardState.role = "govt";
    guardState.jurisdictions = [];

    const html = await renderPage();

    expect(html).not.toContain(CABA_PET);
    expect(html).not.toContain(MENDOZA_PET);
  });

  it("a govt operator WITHOUT an authority org reads their jurisdiction, with every mutation affordance gone", async () => {
    guardState.role = "govt";
    guardState.jurisdictions = [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }];
    orgState.missing = true;
    try {
      const html = await renderPage();

      // Reads like /gob/casos: jurisdiction decides visibility, not org
      // membership — the old behavior was a hard dead-end instead of a list.
      expect(html, "the read-only mode hid the in-jurisdiction episode").toContain(CABA_PET);
      expect(html, "read-only mode leaked an out-of-jurisdiction episode").not.toContain(
        MENDOZA_PET,
      );

      // No dead-end affordances: the wizard link and both mutation buttons
      // would all be rejected server-side for this principal.
      expect(html).not.toContain("Nuevo decomiso");
      expect(html).not.toContain("Reasignar");
      expect(html).not.toContain("Devolver al dueño");

      // The requirement is stated, and the old blanket rejection is gone.
      expect(html).toContain("pertenecer a una autoridad sanitaria");
      expect(html).not.toContain("Tu usuario no está asociado a ninguna autoridad sanitaria");
    } finally {
      orgState.missing = false;
    }
  });

  it("admin keeps universal visibility", async () => {
    guardState.role = "admin";
    guardState.jurisdictions = [];

    const html = await renderPage();

    expect(html, "the fence blinded admin").toContain(CABA_PET);
    expect(html).toContain(MENDOZA_PET);
  });
});
