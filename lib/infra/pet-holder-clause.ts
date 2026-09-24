// pet-holder-clause.ts — the pet-holder rule as an IN-QUERY predicate.
//
// WHY THIS EXISTS (A01-5, 2026-09-18). The lib/ readers that return a pet's
// event history took a bare `petId` and trusted the caller to have run
// requirePetAccess first. Every caller did, but "the caller is the only fence"
// means the first route that resolves an id from the URL and calls a reader
// before (or without) the access check leaks the history — and nothing in the
// query would object. With this clause in the WHERE, a reader asked for a pet
// the viewer does not hold returns nothing, whoever called it.
//
// THE RULE IS resolvePetHolderAccess's (lib/infra/pet-access.ts), stated as SQL:
//   - the pet is not soft-deleted (erased pets resolve nothing, art. 16), and
//   - it has a live ownership row that is EITHER the viewer's own (any role —
//     owner, co_owner, foster, caretaker) OR an organization's in which the
//     viewer holds a live membership.
// It is a SECOND statement of that rule, not a replacement: the resolver still
// decides access and returns the row. If the resolver's two paths ever change,
// this clause must change with them — `__tests__/pet-weight-history.test.ts`
// (T6) is a differential test against the real database: for owner, caretaker,
// live and departed org members, ended rows, a soft-deleted pet and a stranger,
// the resolver and both readers must give the same answer.
//
// It deliberately does NOT encode the capability checks requireAlivePetAccess
// adds for writes: this is a READ predicate, and holding the pet is what a read
// requires.

import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * `EXISTS (…)` true when `viewerId` holds the pet whose id is `petIdColumn`.
 * Compose it into the WHERE of any reader keyed on a pet id.
 *
 * `petIdColumn` takes a correlated column (`petEvents.petId`) OR a constant
 * SQL fragment (`sql\`${pet.id}\``). Pass the constant form when the query is
 * ALREADY pinned to one pet (e.g. `eq(petEvents.petId, pet.id)` sits in the
 * same WHERE): the correlated-column form re-evaluates the EXISTS once per
 * matched row even though the pet id is identical on every one of them, while
 * the constant form is the same literal parameter every time and the planner
 * only has to prove it once (get-libreta-face-data.ts, fresh performance
 * review 2026-09-22).
 */
export function viewerHoldsPetClause(viewerId: string, petIdColumn: AnyPgColumn | SQL): SQL {
  return sql`exists (
    select 1
    from pets hp
    join ownerships ho on ho.pet_id = hp.id and ho.ended_at is null
    where hp.id = ${petIdColumn}
      and hp.deleted_at is null
      and (
        ho.owner_user_id = ${viewerId}
        or exists (
          select 1
          from organization_memberships hm
          where hm.organization_id = ho.owner_organization_id
            and hm.user_id = ${viewerId}
            and hm.left_at is null
        )
      )
  )`;
}
