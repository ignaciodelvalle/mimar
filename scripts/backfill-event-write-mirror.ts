#!/usr/bin/env tsx
/**
 * One-off backfill: recompute `organization_memberships.can_write_pet_events`
 * for EVERY membership through `syncEventWriteMirror` (W6).
 *
 * WHY. Until W6 the legacy column was written by five paths with five ideas of
 * the value — the org creator's `true`, an invitation's checkbox copied onto a
 * vet_individual, a toggle's intent, hand-typed seed values. Enforcement never
 * read it (the resolver reads the grant table), so rows drifted: finding F-9 is
 * a tránsito membership whose column said "yes" while the resolver said "no".
 * New writes now go through the single writer; this corrects the rows that
 * predate it, with the SAME function, so the backfill cannot disagree with the
 * live path about what "effective" means (role baseline + approved grants +
 * the member's vet credential; an ended membership is false).
 *
 * DRY-RUN BY DEFAULT: reports how many rows would change, in which direction,
 * and writes nothing. `--apply` writes, one short transaction per membership.
 *
 * IDEMPOTENT: a second `--apply` finds nothing to change.
 *
 * Run:
 *   NODE_OPTIONS="--conditions=react-server" pnpm tsx scripts/backfill-event-write-mirror.ts
 *   NODE_OPTIONS="--conditions=react-server" pnpm tsx scripts/backfill-event-write-mirror.ts --apply
 *
 * It targets whatever DATABASE_URL `_load-env` resolves. Running it against a
 * shared environment is a PO/orchestrator decision, not something to do because
 * the local run looked clean.
 */

import "./_load-env";

import { asc } from "drizzle-orm";

import { db, organizationMemberships } from "@/db";
import { syncEventWriteMirror } from "@/src/modules/organizations/application/set-member-event-write";
import { resolveGrantedCaps } from "@/src/modules/organizations/domain/capabilities";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

type EventWriteState = Awaited<ReturnType<OrgRepository["readEventWriteState"]>>;

/** The live path's own rule (syncEventWriteMirror), read-only for the dry run. */
function effectiveEventWrite(state: EventWriteState): boolean {
  if (!state?.active) return false;
  return resolveGrantedCaps(state.role, state.approvedCapabilities, {
    vetCredentialValid: state.vetCredentialValid,
  }).has("event.write");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const repo = new OrgRepository();

  const rows = await db
    .select({ id: organizationMemberships.id, column: organizationMemberships.canWritePetEvents })
    .from(organizationMemberships)
    .orderBy(asc(organizationMemberships.id));

  let unchanged = 0;
  let toTrue = 0;
  let toFalse = 0;

  for (const row of rows) {
    const state = await repo.readEventWriteState(row.id);
    const effective = effectiveEventWrite(state);
    if (effective === row.column) {
      unchanged += 1;
      continue;
    }
    if (effective) toTrue += 1;
    else toFalse += 1;
    if (apply) {
      // The single writer itself, so the value written is exactly the live path's.
      await db.transaction((tx) => syncEventWriteMirror(repo, row.id, tx));
    }
  }

  console.log(
    `[backfill-event-write-mirror] ${apply ? "APPLIED" : "DRY-RUN"}: ${rows.length} memberships · ${unchanged} already correct · ${toTrue} false→true · ${toFalse} true→false`,
  );

  // A sanity read after --apply: the same count must now be zero.
  if (apply) {
    let still = 0;
    for (const row of await db
      .select({ id: organizationMemberships.id, column: organizationMemberships.canWritePetEvents })
      .from(organizationMemberships)) {
      const state = await repo.readEventWriteState(row.id);
      const effective = effectiveEventWrite(state);
      if (effective !== row.column) still += 1;
    }
    console.log(`[backfill-event-write-mirror] rows still out of sync: ${still}`);
    if (still > 0) process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("[backfill-event-write-mirror] failed:", err);
    process.exit(1);
  });
