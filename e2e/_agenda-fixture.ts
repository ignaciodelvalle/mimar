// _agenda-fixture — an APPROVED service offering for the seed refugio, made
// directly in a LOCAL Postgres, for e2e/org-forms-settle.spec.ts.
//
// WHY DIRECT. The agenda page only opens for an `approved` offering and
// redirects away from anything else. An offering is created `pending_approval`
// (src/modules/service-offerings/application/create-service-offering.ts) and
// only an authority approval moves it on — walking that would make the spec a
// test of the approval flow and the TOTP harness, not of the agenda form. And
// `pnpm db:bootstrap` seeds none: the PERF-COV offering a laptop may carry comes
// from `pnpm seed:coverage`, which CI never runs.
//
// LOCAL ONLY, through the guard every direct-to-Postgres e2e helper shares
// (`resolveCleanupTarget`, demo/_db-cleanup.ts): against any other database
// these return null / do nothing, and the spec skips on that ENVIRONMENT.
//
// The row mirrors scripts/seed-coverage.ts's offering. Deleting it cascades to
// its rules, slots and appointments (all ON DELETE CASCADE), so the spec leaves
// nothing behind.

import postgres from "postgres";

import { resolveCleanupTarget } from "./demo/_db-cleanup";

/** The fixture's public token — the agenda URL segment. */
export const AGENDA_OFFERING_TOKEN = "E2E-SVO-AGENDA-0001";

/**
 * Make sure the seed refugio holds the fixture offering, approved and with no
 * schedule rule, and return its token. Null when the run has no local database.
 */
export async function ensureAgendaOffering(orgToken: string): Promise<string | null> {
  const target = resolveCleanupTarget();
  if (target.kind !== "local") return null;

  const sql = postgres(target.url, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM organizations WHERE public_token = ${orgToken}`;
    if (!org) throw new Error(`[agenda fixture] no organization ${orgToken}`);

    // A leftover from an interrupted run goes first, rules and all, so every
    // run starts from an empty agenda.
    await sql`DELETE FROM service_offerings WHERE public_token = ${AGENDA_OFFERING_TOKEN}`;
    await sql`
      INSERT INTO service_offerings (
        public_token, organization_id, jurisdiction_country, jurisdiction_province,
        jurisdiction_locality, service_kind, display_name, description,
        duration_minutes, slot_capacity, status, is_public
      ) VALUES (
        ${AGENDA_OFFERING_TOKEN}, ${org.id}::uuid, 'AR', 'CABA',
        'Palermo', 'sterilization_dog_male', 'E2E — Agenda', 'Fixture de e2e/org-forms-settle.spec.ts',
        60, 5, 'approved', false
      )`;
    return AGENDA_OFFERING_TOKEN;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Remove the fixture offering and everything that cascades from it. */
export async function removeAgendaOffering(): Promise<void> {
  const target = resolveCleanupTarget();
  if (target.kind !== "local") return;

  const sql = postgres(target.url, { max: 1, onnotice: () => {} });
  try {
    await sql`DELETE FROM service_offerings WHERE public_token = ${AGENDA_OFFERING_TOKEN}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
