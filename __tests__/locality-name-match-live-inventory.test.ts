// The LIVE inventory of every database object that touches
// `jurisdiction_locality` (L4·3 of the locality plan, T3-J1).
//
// scripts/check-locality-name-join.ts fences a FORM in the SQL source (two
// qualified locality names compared). A form is narrower than the concept, and a
// migration is not the database: a policy patched by hand, or a name compared
// through `IN (SELECT …)`, would pass it. This file pins the SUBJECT against the
// catalog the application actually runs on — every policy, function and view in
// `public` whose definition mentions the column — and which of them compare it.
//
// The doc that explains each entry, what it guards and how it fails is
// docs/architecture/locality-name-match-inventory.md. An object appearing or
// disappearing here is the prompt to update that doc; it is not a number to
// re-baseline. A promise that "one fold cannot contradict itself" is false for
// as long as NAME_COMPARISONS below is non-empty.

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";

type CatalogObject = { kind: string; name: string; compares: boolean; secdef: boolean };

/** Every object whose definition mentions the column, measured 2026-09-22. */
const TOUCHING = [
  "function public.can_read_case",
  "function public.erase_subject_data",
  "policy public.approval_requests :: approval requests visible to applicant or authority",
  "policy public.custody_dispute_parties :: custody_dispute_parties select by parties and authorities",
  "policy public.custody_disputes :: custody_disputes select by parties and authorities",
  "policy public.pet_identifications :: pet_identifications read by govt in jurisdiction",
  "policy public.pet_service_dog :: service_dog select by owner or authority",
  "view public.welfare_report_content",
];

/** The subset that decides access by comparing the NAME with another row's. */
const NAME_COMPARISONS = [
  "function public.can_read_case",
  "policy public.approval_requests :: approval requests visible to applicant or authority",
  "policy public.custody_dispute_parties :: custody_dispute_parties select by parties and authorities",
  "policy public.custody_disputes :: custody_disputes select by parties and authorities",
  "policy public.pet_identifications :: pet_identifications read by govt in jurisdiction",
  "policy public.pet_service_dog :: service_dog select by owner or authority",
];

// Passed as a bound parameter, not written into the template: a backslash inside
// a tagged template is cooked away before it reaches Postgres.
const NAME_COMPARE_RE = String.raw`[a-z_]+\.jurisdiction_locality\s*(=|is\s+not\s+distinct\s+from)\s*\(?\s*[a-z_]+\.jurisdiction_locality`;

let objects: CatalogObject[] = [];

beforeAll(async () => {
  objects = (await db.execute(sql`
    with src as (
      select 'policy' as kind,
             schemaname || '.' || tablename || ' :: ' || policyname as name,
             coalesce(qual, '') || ' ' || coalesce(with_check, '') as body,
             false as secdef
      from pg_policies
      where schemaname = 'public'
      union all
      select 'function', n.nspname || '.' || p.proname, p.prosrc, p.prosecdef
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
      union all
      select 'view', schemaname || '.' || viewname, definition, false
      from pg_views
      where schemaname = 'public'
    )
    select kind, name, secdef, body ~* ${NAME_COMPARE_RE} as compares
    from src
    where body ~* 'jurisdiction_locality'
    order by kind, name
  `)) as unknown as CatalogObject[];
});

const label = (o: CatalogObject) => `${o.kind} ${o.name}`;

describe("live catalog — objects that touch jurisdiction_locality (L4·3)", () => {
  it("is exactly the inventoried set", () => {
    expect(objects.map(label).sort()).toEqual([...TOUCHING].sort());
  });

  it("the ones that compare the NAME are exactly the inventoried set", () => {
    expect(
      objects
        .filter((o) => o.compares)
        .map(label)
        .sort(),
    ).toEqual([...NAME_COMPARISONS].sort());
  });

  it("the two SECURITY DEFINER functions are the inventoried two", () => {
    expect(
      objects
        .filter((o) => o.secdef)
        .map(label)
        .sort(),
    ).toEqual(["function public.can_read_case", "function public.erase_subject_data"]);
  });
});
