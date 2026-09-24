# Locality names as keys in SQL — inventory

> Snapshot: `b4c36455f` (`main`) · Facts: `docs/architecture/facts.json` generated 2026-09-22
> Verified against code on 2026-09-22 by the T3-J1 writer (opus subagent) · Status: draft
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.

L4·3 of the locality plan ("Dos mapas que no coinciden", decided 2026-09-08).
This file exists **before** any promise that "one fold cannot contradict
itself", because that promise is false while the objects below exist.

## The rule these objects break

PO decision 2026-09-08: **a display name is never a join key or an
authorization key.** The TypeScript read gates (`resolveJurisdictionScope`,
`jurisdictionPairClause` in `lib/metrics/scope.ts`) can be moved to an id one
day. Postgres does its own matching, below all of them, and nothing in
TypeScript reaches it: RLS policies and a `SECURITY DEFINER` function decide who
sees a row by comparing `govt_assignments.jurisdiction_locality` with the row's
`jurisdiction_locality` **as strings**.

## Live inventory (local catalog, 2026-09-22)

Queried from `pg_policies`, `pg_proc` and `pg_views` in `public` — the
database, not the migrations ("aplicada no es cerrada"). Eight objects mention
the column; six of them compare it with another row's name. The two
`SECURITY DEFINER` functions are `can_read_case` and `erase_subject_data`.

| # | Object | Kind | What the name decides | Last defined in |
|---|---|---|---|---|
| 1 | `approval_requests` · "approval requests visible to applicant or authority" | policy, SELECT | a govt operator reads approval requests in their `(province, locality)` | `db/migrations/0241_govt_whole_province_rls.sql` |
| 2 | `custody_disputes` · "custody_disputes select by parties and authorities" | policy, SELECT | a govt operator reads disputes in their jurisdiction | same |
| 3 | `custody_dispute_parties` · "custody_dispute_parties select by parties and authorities" | policy, SELECT | the parties of those disputes | same |
| 4 | `pet_identifications` · "pet_identifications read by govt in jurisdiction" | policy, SELECT | a govt operator reads a pet's identifications through the pet's locality | same |
| 5 | `pet_service_dog` · "service_dog select by owner or authority" | policy, SELECT | the service-dog credential, same way | same |
| 6 | `can_read_case(uuid, uuid)` | function, **SECURITY DEFINER** | the govt branch of case visibility; called by the `cases` SELECT policy and the case-scoped policies on `pet_events` and `attachments` | same |
| 7 | `erase_subject_data(uuid, text)` | function, **SECURITY DEFINER** | nothing — it WRITES `jurisdiction_locality = NULL` during erasure. Listed because it is privileged and touches the column | `db/migrations/0228_dead_letter_error_message_redaction.sql` |
| 8 | `welfare_report_content` | view | nothing — it projects the column | — |

The ~21 matches the plan counted in the SQL **source** are the history of
these six predicates: each policy was re-created by later migrations
(`0086`, `0137`, `0140`, `0215`, `0216`, `0241`), and the two `db/*.sql` source files
(`db/rls.sql`, `db/cases_rls.sql`) still carry their original text. The frozen
list in `scripts/check-locality-name-join.ts` holds all of them, file by file.

## How each one fails — read before promising anything

- **A name that does not match denies.** A pet stored as "Nunez" is invisible,
  through these policies, to an operator assigned "Núñez". That is the
  fail-closed direction the plan marked *tolerable*: it can withhold access,
  never grant it.
- **Whole province — resolved by 0241 (T3-J1b, PO 7C 2026-09-22).** Until
  0241, none of the six had a whole-province branch: a whole-province
  assignment (`""`, or CABA's "Ciudad Autónoma de Buenos Aires") matched no row
  through RLS, while the TypeScript gate (`isWholeProvinceLocality` in
  `lib/domain/jurisdiction-canonical.ts`) treated it as the whole province.
  All six now mirror that predicate exactly: those two forms match on province
  alone (NULL-locality rows included); every other assignment keeps the exact
  pair; province equality and `revoked_at IS NULL` still hold. Pinned by
  `__tests__/rls/govt-whole-province-rls.test.ts`, which evaluates the live
  predicates. The comparison is still NAME-based — that is what L4·2 retires.
- **Where this bites.** Only the PostgREST surface (publishable key) goes
  through RLS. The application's own reads use the service connection
  (`BYPASSRLS`) and the TypeScript gates (`docs/architecture/rls-coverage.md`,
  "Authz contract"). So these predicates are the backstop, and they are a
  stricter, name-exact backstop than the front door.

## What guards the count while L4·2 is pending

- `scripts/check-locality-name-join.ts` (`pnpm lint:locality-name-join`, in
  `verify` and CI): a new migration, or an edit to a `db/*.sql` source, that
  compares two qualified locality names fails. It enumerates a FORM.
- `__tests__/locality-name-match-live-inventory.test.ts`: pins the SUBJECT
  against the live catalog — the set of objects that mention the column, the
  subset that compares it, and the two `SECURITY DEFINER` functions. An object
  appearing or disappearing fails until this table is updated.

## What would retire them

L4·2 — making the authority an explicit unit in `govt_assignments` — is the
change that lets these predicates key on something other than a display name.
It is gated on a product decision (what an authority unit is, and what happens
to rows whose locality never resolved), recorded in the T3-J1 report. Until it
lands, "one fold" is a claim about the TypeScript folds only.
