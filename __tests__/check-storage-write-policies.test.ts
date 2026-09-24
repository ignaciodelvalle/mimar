// Offline guard for the storage WRITE-policy tripwire (B24).
//
// Two halves, and the second is the one that matters:
//
//   1. Against the REAL repo — the inventory is non-empty, finds exactly the two
//      known blanket grants, and passes. A tripwire that has stopped seeing its
//      own subject reports the same "clean" as one with nothing to report.
//   2. RED CONTROLS, on synthetic SQL — a new bucket-name-only write grant, a
//      widened frozen grant, an `all` policy, a `to public` policy with no roles
//      clause. Each of these is a way the pattern could spread, and each must be
//      demonstrated to fail rather than assumed to.
//
// The parser gets its own tests too, because it is the whole fence: these
// policies are written across many lines, one carries a nested `EXISTS (SELECT
// …)`, and a naive line regex would silently under-report — which is the exact
// false pass the tripwire exists to prevent.

import { globSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FROZEN_WRITE_GRANTS,
  MIN_ALTER_STATEMENTS,
  MIN_WRITE_POLICIES,
  SQL_GLOBS,
  callerFacingWrites,
  describeConnectionError,
  evaluate,
  inventory,
  isPermissive,
  liveWriteVerdict,
  normalize,
  normalizeCatalogPredicate,
  parsePolicy,
  policyStatements,
  stripOuterParens,
  stripSqlComments,
} from "@/scripts/check-storage-write-policies";

// ---------------------------------------------------------------------------
// Against the real repo
// ---------------------------------------------------------------------------

const REAL_FILES = [...new Set(SQL_GLOBS.flatMap((g) => globSync(g)))]
  .map((f) => f.replaceAll("\\", "/"))
  .sort();
const {
  policies: REAL,
  unparseable: REAL_UNPARSEABLE,
  statementCounts: REAL_COUNTS,
} = inventory(REAL_FILES);

describe("the real repo", () => {
  it("scans SQL files at all", () => {
    expect(REAL_FILES.length).toBeGreaterThan(50);
  });

  it("finds enough caller-facing write policies to clear the non-vacuity floor", () => {
    expect(callerFacingWrites(REAL).length).toBeGreaterThanOrEqual(MIN_WRITE_POLICIES);
  });

  // THE FLOOR THAT MATTERS. If the parser stops seeing these two, the fence
  // reports "clean" while measuring nothing — and the two grants it is supposed
  // to be freezing are precisely the ones it would stop watching.
  it("finds the two known blanket grants, and only those two", () => {
    const permissive = callerFacingWrites(REAL)
      .filter(isPermissive)
      .map((p) => p.name);
    expect(permissive.sort()).toEqual(
      ["event_attachments_authenticated_upload", "pet_photos_authenticated_upload"].sort(),
    );
  });

  it("reads every storage.objects policy it finds — none is unparseable", () => {
    // Not decoration. Until 2026-08-25 an unreadable statement was DROPPED, so
    // this count could only ever have been zero and would have told you nothing.
    // Now it is the fence's own coverage: anything here is a policy nobody is
    // checking.
    expect(REAL_UNPARSEABLE).toEqual([]);
  });

  it("passes today", () => {
    const verdict = evaluate(REAL, REAL_UNPARSEABLE);
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.changed).toEqual([]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.unparseable).toEqual([]);
  });

  it("does not confuse a scoped write for a blanket one", () => {
    const scoped = callerFacingWrites(REAL).filter((p) => !isPermissive(p));
    // pet-photos + event-attachments update/delete, the avatars three, and the
    // revocations upload (declared twice — file and migration).
    expect(scoped.length).toBeGreaterThanOrEqual(7);
    expect(scoped.map((p) => p.name)).toContain("revocations_admin_govt_upload");
  });

  // THE ALTER PATH'S ONLY LIFE SIGN. No `alter policy` targets storage.objects
  // today, so the ALTER branch contributes zero to every other number here — an
  // `alter policy` regex that stopped matching would move nothing and the fence
  // would keep printing the same green line with the third evasion reopened.
  it("still reads `alter policy` statements at all", () => {
    expect(REAL_COUNTS.alter).toBeGreaterThanOrEqual(MIN_ALTER_STATEMENTS);
    expect(REAL_COUNTS.create).toBeGreaterThan(0);
  });

  it("finds no storage.objects policy declared by an ALTER — today", () => {
    // Stated as a MEASUREMENT, not a rule. The day one exists it belongs in the
    // scan, which is now what happens; this test would simply move.
    expect(REAL.filter((p) => p.kind === "alter")).toEqual([]);
  });

  it("keeps every frozen grant carrying a reason and a way out", () => {
    for (const [name, grant] of Object.entries(FROZEN_WRITE_GRANTS)) {
      expect(grant.predicate, name).not.toBe("");
      expect(grant.reason, name).toContain("B24");
      // An allowlist entry with no stated exit is a permanent exemption wearing
      // a temporary label.
      expect(grant.reason, name).toContain("signed upload");
      // AND THE STRUCTURAL MARKER, added 2026-08-28 after the phrase above
      // caught a rewrite that had strengthened the entry rather than weakened
      // it (it said "signed-upload primitive", with a hyphen). A phrase is a
      // spelling and spellings get rewritten; `CLOSED BY:` is the shape every
      // entry already uses to introduce its exit, and it is what a reader scans
      // for. Both are asserted because each catches what the other cannot: the
      // phrase catches an exit that drifted to some other plan, the marker
      // catches an entry that stopped naming an exit at all.
      expect(grant.reason, name).toContain("CLOSED BY:");
    }
  });
});

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

describe("stripSqlComments", () => {
  it("removes a line comment", () => {
    expect(stripSqlComments("select 1; -- and then some")).toBe("select 1; ");
  });

  it("does NOT cut inside a string literal", () => {
    expect(stripSqlComments("where name = 'a--b'")).toBe("where name = 'a--b'");
  });
});

/** The first statement of `sql`, or a throw naming what the scan actually saw. */
function firstStatement(sql: string) {
  const statements = policyStatements(sql);
  if (statements.length === 0) throw new Error("the scan found no policy statement at all");
  return statements[0];
}

describe("policyStatements", () => {
  it("captures a statement written across many lines", () => {
    const sql = [
      'create policy "p"',
      "  on storage.objects for insert",
      "  to authenticated",
      "  with check (bucket_id = 'x');",
      "select 1;",
    ].join("\n");
    const statements = policyStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0].kind).toBe("create");
    expect(statements[0].text).toContain("bucket_id = 'x'");
    expect(statements[0].text).not.toContain("select 1");
  });

  // THE THIRD EVASION. The scan's only entry point was /create\s+policy/, so an
  // ALTER — the repo's own normal idiom for changing a predicate, 80 of them in
  // db/ — was a statement the fence never entered.
  it("captures an `alter policy` statement, and labels it", () => {
    const sql = [
      'ALTER POLICY "pet_photos_authenticated_upload" ON storage.objects',
      "  WITH CHECK (bucket_id = 'pet-photos' OR bucket_id = 'anything-else');",
    ].join("\n");
    const statements = policyStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0].kind).toBe("alter");
  });

  it("reads both kinds out of one file, in order", () => {
    const sql = [
      `create policy a on storage.objects for insert to authenticated with check (bucket_id = 'x');`,
      `alter policy a on storage.objects with check (bucket_id = 'y');`,
    ].join("\n");
    expect(policyStatements(sql).map((s) => s.kind)).toEqual(["create", "alter"]);
  });

  // The shape that breaks a naive parser: migration 0188's revocations upload.
  it("does not stop at a nested subquery's parentheses", () => {
    const sql = [
      'CREATE POLICY "revocations_admin_govt_upload"',
      "  ON storage.objects FOR INSERT TO authenticated",
      "  WITH CHECK (",
      "    bucket_id = 'revocations'",
      "    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()))",
      "  );",
    ].join("\n");
    const result = parsePolicy("x.sql", firstStatement(sql));
    expect(result.kind).toBe("policy");
    if (result.kind !== "policy") throw new Error("unreachable");
    expect(result.policy.predicate).toContain("auth.uid()");
    expect(isPermissive(result.policy)).toBe(false);
  });
});

describe("parsePolicy", () => {
  /** The parsed policy, or a failure naming what came back instead. */
  function parse(sql: string) {
    const result = parsePolicy("test.sql", firstStatement(sql));
    if (result.kind !== "policy") throw new Error(`expected a policy, got "${result.kind}"`);
    return result.policy;
  }

  it("ignores a policy on a table that is not storage.objects", () => {
    const result = parsePolicy(
      "test.sql",
      firstStatement(`create policy "p" on public.pets for insert to authenticated;`),
    );
    // "skip", NOT "unparseable": this really is none of the fence's business.
    expect(result.kind).toBe("skip");
  });

  // `storage . objects` and `storage.objects` are the same identifier to
  // Postgres and were two different answers to this fence until 2026-08-25.
  // Nobody writes it with spaces on purpose, which is exactly why it would work.
  it("reads `storage . objects` with whitespace around the dot", () => {
    const policy = parse(
      `create policy spaced on storage . objects for insert to authenticated with check (bucket_id = 'x');`,
    );
    expect(policy.name).toBe("spaced");
    expect(isPermissive(policy)).toBe(true);
  });

  it("reads a newline between the schema and the table", () => {
    const policy = parse(
      `create policy wrapped on storage\n  .objects for insert to authenticated with check (bucket_id = 'x');`,
    );
    expect(policy.name).toBe("wrapped");
  });

  it("reads name, command and roles", () => {
    const policy = parse(
      `create policy "p" on storage.objects for update to anon, authenticated using (bucket_id = 'x');`,
    );
    expect(policy.name).toBe("p");
    expect(policy.command).toBe("update");
    expect(policy.roles).toEqual(["anon", "authenticated"]);
  });

  // ==========================================================================
  // THE TWO FORMS THAT USED TO FAIL OPEN (fixed 2026-08-25)
  // ==========================================================================
  // Both are valid Postgres and both appear in this repo's own SQL. Each made
  // parsePolicy return null, after which `inventory` dropped the statement and
  // the fence printed green over a policy it had never read.

  it("reads an UNQUOTED policy name — the style db/cases_rls.sql uses", () => {
    const policy = parse(
      `create policy pet_photos_blanket on storage.objects for insert to authenticated with check (bucket_id = 'pet-photos');`,
    );
    expect(policy.name).toBe("pet_photos_blanket");
    expect(policy.command).toBe("insert");
  });

  it("reads an unquoted name behind `if not exists`", () => {
    const policy = parse(
      `create policy if not exists p_bare on storage.objects for insert to authenticated with check (bucket_id = 'x');`,
    );
    expect(policy.name).toBe("p_bare");
  });

  // The single most dangerous form was the one form guaranteed to pass.
  it("treats an OMITTED `for` clause as `all`, per the SQL default", () => {
    const policy = parse(
      `create policy "p" on storage.objects to authenticated using (bucket_id = 'x');`,
    );
    expect(policy.command).toBe("all");
    // `all` is a WRITE command, so this must reach the offender path.
    expect(callerFacingWrites([policy])).toHaveLength(1);
    expect(isPermissive(policy)).toBe(true);
  });

  it("reports an unreadable storage.objects statement as an OFFENDER, not a skip", () => {
    // A `create policy` on storage.objects whose name this parser cannot read.
    const result = parsePolicy("test.sql", {
      kind: "create",
      text: "create policy 42invalid on storage.objects for insert",
    });
    expect(result.kind).toBe("unparseable");
  });

  // ==========================================================================
  // THE THIRD EVASION — `ALTER POLICY` (fixed 2026-08-25)
  // ==========================================================================

  it("reads an ALTER POLICY as a policy, quoted name and all", () => {
    const policy = parse(
      `alter policy "pet_photos_authenticated_upload" on storage.objects with check (bucket_id = 'pet-photos');`,
    );
    expect(policy.name).toBe("pet_photos_authenticated_upload");
    expect(policy.kind).toBe("alter");
  });

  it("reads an ALTER POLICY with an unquoted name", () => {
    expect(parse(`alter policy some_grant on storage.objects using (bucket_id = 'x');`).name).toBe(
      "some_grant",
    );
  });

  // An ALTER never carries a FOR clause (Postgres does not allow changing the
  // command) and often carries no TO clause either. Both absences are read as
  // the WIDEST option, which over-reports rather than under-reports — the only
  // acceptable direction for a tripwire.
  it("reads an ALTER as `for all` to `public`, the widest reading", () => {
    const policy = parse(`alter policy p on storage.objects using (bucket_id = 'x');`);
    expect(policy.command).toBe("all");
    expect(policy.roles).toEqual(["public"]);
    expect(callerFacingWrites([policy])).toHaveLength(1);
  });

  it("does not treat a NARROWING alter as permissive", () => {
    const policy = parse(
      `alter policy p on storage.objects with check (bucket_id = 'x' and auth.uid() = owner);`,
    );
    expect(isPermissive(policy)).toBe(false);
  });

  // SQL's default when `to` is omitted is PUBLIC. Failing closed is the only
  // safe direction: a policy with no roles clause is the MOST exposed, not the
  // least, and skipping it would be the fence's worst possible mistake.
  it("treats a missing `to` clause as PUBLIC", () => {
    const policy = parse(`create policy "p" on storage.objects for insert with check (true);`);
    expect(policy.roles).toEqual(["public"]);
    expect(callerFacingWrites([policy])).toHaveLength(1);
  });

  // The worst legal statement available: bare name, no FOR (so ALL), no TO (so
  // PUBLIC), predicate that names nobody. Before the fix, all three of those
  // gaps pointed the same way and the statement was invisible.
  it("catches the maximally-exposed form: bare name, no FOR, no TO", () => {
    const policy = parse(`create policy wide_open on storage.objects using (bucket_id = 'x');`);
    expect(policy.name).toBe("wide_open");
    expect(policy.command).toBe("all");
    expect(policy.roles).toEqual(["public"]);
    expect(isPermissive(policy)).toBe(true);
    expect(evaluate([policy]).unfrozen.map((p) => p.name)).toEqual(["wide_open"]);
  });

  it("joins a using and a with-check predicate", () => {
    const policy = parse(
      `create policy "p" on storage.objects for update to authenticated using (bucket_id = 'x') with check (auth.uid() = owner);`,
    );
    expect(policy.predicate).toBe("bucket_id = 'x' and auth.uid() = owner");
    expect(isPermissive(policy)).toBe(false);
  });
});

describe("isPermissive", () => {
  function policy(predicate: string) {
    return {
      file: "t.sql",
      name: "p",
      kind: "create" as const,
      command: "insert",
      roles: ["authenticated"],
      predicate: normalize(predicate),
    };
  }

  it("calls a bucket-name-only predicate permissive", () => {
    expect(isPermissive(policy("bucket_id = 'x'"))).toBe(true);
  });

  it("accepts auth.uid() nested in a subquery — the 0137 convention", () => {
    expect(
      isPermissive(
        policy("bucket_id = 'x' and exists (select 1 from p where p.id = (select auth.uid()))"),
      ),
    ).toBe(false);
  });

  it("calls an empty predicate permissive", () => {
    expect(isPermissive(policy(""))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RED CONTROLS — every way the pattern could spread
// ---------------------------------------------------------------------------

describe("red controls", () => {
  function verdictFor(sql: string) {
    const statements = policyStatements(stripSqlComments(sql));
    const policies = [];
    const unparseable = [];
    for (const statement of statements) {
      const result = parsePolicy("planted.sql", statement);
      if (result.kind === "policy") policies.push(result.policy);
      // Carried, not dropped — otherwise a red control could "pass" by being
      // unreadable, which is the exact failure this file now guards.
      else if (result.kind === "unparseable") {
        unparseable.push({ file: "planted.sql", statement: normalize(statement.text) });
      }
    }
    return evaluate(policies, unparseable);
  }

  /** The two frozen grants, spelled exactly as db/storage.sql spells them. */
  const FROZEN_SQL = [
    `create policy "pet_photos_authenticated_upload"`,
    "  on storage.objects for insert",
    "  to authenticated",
    "  with check (bucket_id = 'pet-photos');",
    `create policy "event_attachments_authenticated_upload"`,
    "  on storage.objects for insert",
    "  to authenticated",
    "  with check (bucket_id = 'event-attachments');",
  ].join("\n");

  it("is GREEN on the two frozen grants alone — the non-vacuity of the reds below", () => {
    const verdict = verdictFor(FROZEN_SQL);
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.changed).toEqual([]);
    expect(verdict.missing).toEqual([]);
  });

  it("RED: a NEW bucket-name-only INSERT grant", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\ncreate policy "new_blanket" on storage.objects for insert to authenticated with check (bucket_id = 'new-bucket');`,
    );
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["new_blanket"]);
  });

  it("RED: a NEW bucket-name-only DELETE grant", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\ncreate policy "blanket_delete" on storage.objects for delete to authenticated using (bucket_id = 'pet-photos');`,
    );
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["blanket_delete"]);
  });

  // `for all` is the widest of the four and the easiest to write by accident.
  it("RED: a `for all` policy with no caller in its predicate", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\ncreate policy "blanket_all" on storage.objects for all to authenticated using (bucket_id = 'pet-photos');`,
    );
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["blanket_all"]);
  });

  it("RED: a grant to anon", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\ncreate policy "anon_upload" on storage.objects for insert to anon with check (bucket_id = 'pet-photos');`,
    );
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["anon_upload"]);
  });

  // THE PLANTED WIDENING. This is the case the tripwire is named for: not a new
  // policy, an existing one quietly given more.
  it("RED: an existing frozen grant WIDENED to a second bucket", () => {
    const widened = FROZEN_SQL.replace(
      "with check (bucket_id = 'pet-photos');",
      "with check (bucket_id in ('pet-photos', 'event-attachments'));",
    );
    const verdict = verdictFor(widened);
    expect(verdict.changed).toHaveLength(1);
    expect(verdict.changed[0]?.policy.name).toBe("pet_photos_authenticated_upload");
    expect(verdict.changed[0]?.expected).toBe("bucket_id = 'pet-photos'");
  });

  it("RED: a frozen grant widened to `true`", () => {
    const widened = FROZEN_SQL.replace("bucket_id = 'pet-photos'", "true");
    expect(verdictFor(widened).changed).toHaveLength(1);
  });

  // An allowlist that names something the scan cannot see is either stale (good
  // news, uncelebrated) or broken (bad news, unnoticed). Both are loud.
  it("RED: a frozen grant that has disappeared from the SQL", () => {
    const onlyOne = FROZEN_SQL.split("create policy")
      .filter((chunk) => !chunk.includes("pet_photos_authenticated_upload"))
      .join("create policy");
    expect(verdictFor(onlyOne).missing).toEqual(["pet_photos_authenticated_upload"]);
  });

  // ==========================================================================
  // THE PLANTED WIDENING, WRITTEN AS AN ALTER — the third evasion's red proof
  // ==========================================================================
  //
  // This is the statement that walked through the tripwire until 2026-08-25. It
  // is not exotic: `ALTER POLICY` is how this repo changes a predicate (80 of
  // them in db/), because it is the smallest safe edit — it replaces the USING /
  // WITH CHECK expression and touches nothing else. The scan's only entry point
  // was /create\s+policy/, so a widening spelled this way was not "missed", it
  // was never looked at.

  it("RED: a frozen grant widened by an ALTER POLICY", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\nalter policy "pet_photos_authenticated_upload" on storage.objects with check (bucket_id in ('pet-photos', 'anything-else'));`,
    );
    expect(verdict.changed).toHaveLength(1);
    expect(verdict.changed[0]?.policy.name).toBe("pet_photos_authenticated_upload");
    expect(verdict.changed[0]?.policy.kind).toBe("alter");
    expect(verdict.changed[0]?.expected).toBe("bucket_id = 'pet-photos'");
  });

  it("RED: a frozen grant widened to `true` by an ALTER POLICY", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\nalter policy "event_attachments_authenticated_upload" on storage.objects with check (true);`,
    );
    expect(verdict.changed).toHaveLength(1);
    expect(verdict.changed[0]?.policy.predicate).toBe("true");
  });

  it("RED: an ALTER POLICY introducing a bucket-name-only grant under a NEW name", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\nalter policy some_other_grant on storage.objects with check (bucket_id = 'welfare-evidence');`,
    );
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["some_other_grant"]);
  });

  it("RED: a NEW blanket grant written with `storage . objects`", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\ncreate policy spaced_blanket on storage . objects for insert to authenticated with check (bucket_id = 'x');`,
    );
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["spaced_blanket"]);
  });

  it("GREEN: an ALTER POLICY that NARROWS a frozen grant is not a widening", () => {
    // It is still a `changed` finding — the grants are frozen exactly, not
    // approximately, and narrowing them is the B24 fix, which belongs in a
    // commit that also empties the allowlist entry. What it must NOT be is
    // `unfrozen`, i.e. mistaken for a new blanket grant.
    const verdict = verdictFor(
      `${FROZEN_SQL}\nalter policy "pet_photos_authenticated_upload" on storage.objects with check (bucket_id = 'pet-photos' and auth.uid() = owner);`,
    );
    expect(verdict.unfrozen).toEqual([]);
  });

  it("GREEN: an ALTER POLICY on a public table is none of this fence's business", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\nalter policy "pet events readable by active owner" on public."pet_events" using (true);`,
    );
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.changed).toEqual([]);
    expect(verdict.unparseable).toEqual([]);
  });

  it("GREEN: a new write grant that DOES name the caller", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\ncreate policy "scoped_upload" on storage.objects for insert to authenticated with check (bucket_id = 'new-bucket' and auth.uid() = owner);`,
    );
    expect(verdict.unfrozen).toEqual([]);
  });

  // SELECT stays check-rls-coverage's business. A tripwire that also policed
  // reads would be a second, weaker copy of a fence that already runs against a
  // live database.
  it("GREEN: a permissive SELECT policy — not this fence's subject", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\ncreate policy "blanket_read" on storage.objects for select to authenticated using (bucket_id = 'pet-photos');`,
    );
    expect(verdict.unfrozen).toEqual([]);
  });

  it("GREEN: a service-role-only write grant", () => {
    const verdict = verdictFor(
      `${FROZEN_SQL}\ncreate policy "svc" on storage.objects for insert to service_role with check (bucket_id = 'x');`,
    );
    expect(verdict.unfrozen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The live half - the catalog against the tree
// ---------------------------------------------------------------------------
//
// Offline on purpose, and the split is this repo's own pattern: check-rls-
// coverage keeps its pure evaluators in a fixture-only file and its catalog
// assertions in __tests__/rls/, so the evaluator stays testable on a machine
// with Docker stopped. Everything below is a pure function over literal rows.

describe("normalizeCatalogPredicate - the catalog does not hand back what was typed", () => {
  // THIS IS THE LOAD-BEARING BLOCK, for a reason that is not obvious: a bug
  // here does not produce a false green, it produces a fence that reports drift
  // on a healthy tree every night until somebody switches it off - which is the
  // same outcome as a false green, arriving later and with more noise.

  it("reduces the catalog's rendering of the two frozen grants to their pinned predicate", () => {
    // LITERALS, not built from FROZEN_WRITE_GRANTS. A fixture derived from the
    // constant moves with it, so mutating the constant would kill nothing and
    // the test would still read as if it were checking something.
    //
    // These are what `pg_policies` returns for the two policies db/storage.sql
    // creates: wrapping parens and an explicit ::text cast, neither of which is
    // in the source.
    expect(normalizeCatalogPredicate(null, "(bucket_id = 'pet-photos'::text)")).toBe(
      "bucket_id = 'pet-photos'",
    );
    expect(normalizeCatalogPredicate(null, "(bucket_id = 'event-attachments'::text)")).toBe(
      "bucket_id = 'event-attachments'",
    );
  });

  it("and those reductions are exactly what the frozen set pins", () => {
    // The bridge assertion: the literals above are only useful if they land on
    // the pinned text. Widen a frozen predicate and this goes red.
    expect(normalizeCatalogPredicate(null, "(bucket_id = 'pet-photos'::text)")).toBe(
      FROZEN_WRITE_GRANTS.pet_photos_authenticated_upload.predicate,
    );
    expect(normalizeCatalogPredicate(null, "(bucket_id = 'event-attachments'::text)")).toBe(
      FROZEN_WRITE_GRANTS.event_attachments_authenticated_upload.predicate,
    );
  });

  it("joins using and with check in the parser's order", () => {
    // An UPDATE policy carries both. The static parser joins its predicate
    // groups with " and " in source order; if this half joined them the other
    // way round every UPDATE grant would read as drift.
    expect(normalizeCatalogPredicate("(bucket_id = 'b'::text)", "(auth.uid() = owner)")).toBe(
      "bucket_id = 'b' and auth.uid() = owner",
    );
  });

  it("an INSERT grant's predicate lives in with_check, and reading only qual would miss it", () => {
    // Both known holes are INSERT. A scan that read `qual` alone would see them
    // as having NO predicate - i.e. would report the two measured holes as
    // something far worse, and be wrong about it.
    expect(normalizeCatalogPredicate(null, "(bucket_id = 'pet-photos'::text)")).not.toBe("");
  });

  it("does NOT strip parentheses that belong to the predicate", () => {
    expect(normalizeCatalogPredicate(null, "((a = 1) or (b = 2))")).toBe("(a = 1) or (b = 2)");
  });

  it("leaves an unknown cast alone rather than guessing", () => {
    // Deliberately not a SQL parser. A normaliser that tries to prove two
    // arbitrary predicates equivalent eventually says yes to two that are not,
    // and this is the fence that must never do that. A false alarm is the
    // acceptable direction.
    expect(normalizeCatalogPredicate(null, "(x = 1::custom_domain)")).toBe("x = 1::custom_domain");
  });

  it("an absent predicate stays empty - a grant true for everybody", () => {
    expect(normalizeCatalogPredicate(null, null)).toBe("");
  });

  it("stripOuterParens is balanced-aware, not a trim", () => {
    expect(stripOuterParens("((a))")).toBe("a");
    expect(stripOuterParens("(a) and (b)")).toBe("(a) and (b)");
    expect(stripOuterParens("(a")).toBe("(a");
  });
});

describe("liveWriteVerdict - the catalog judged by the fence's own rule", () => {
  const declaredPetPhotos = {
    file: "db/storage.sql",
    name: "pet_photos_authenticated_upload",
    kind: "create" as const,
    command: "insert",
    roles: ["authenticated"],
    predicate: "bucket_id = 'pet-photos'",
  };

  const livePetPhotos = {
    name: "pet_photos_authenticated_upload",
    command: "insert",
    roles: ["authenticated"],
    qual: null,
    withCheck: "(bucket_id = 'pet-photos'::text)",
  };

  it("GREEN: a catalog that agrees with the tree reports nothing", () => {
    const verdict = liveWriteVerdict([livePetPhotos], [declaredPetPhotos]);
    expect(verdict.undeclared).toEqual([]);
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.changed).toEqual([]);
    expect(verdict.liveWrites).toHaveLength(1);
    expect(verdict.seen).toBe(1);
  });

  it("THE REGRESSION THAT MATTERS: the deparse shapes that broke the first design", () => {
    // Measured against the local catalog on 2026-09-17. The first version of
    // this half compared live text against source text and reported EIGHT
    // drifted grants on a tree that was correct. These are the two real shapes
    // it choked on - parentheses around each conjunct, and IN rewritten as
    // = ANY(ARRAY[...]) with casts, a schema qualification dropped and a
    // subselect given an alias.
    //
    // Both name the caller, so this design counts them and never compares their
    // text. If somebody later "improves" this into a text comparison again,
    // this test is what says no.
    const verdict = liveWriteVerdict(
      [
        {
          name: "Users can upload own avatar",
          command: "insert",
          roles: ["authenticated"],
          qual: null,
          withCheck: "(bucket_id = 'avatars') and (auth.uid() = owner)",
        },
        {
          name: "revocations_admin_govt_upload",
          command: "insert",
          roles: ["authenticated"],
          qual: null,
          withCheck:
            "(bucket_id = 'revocations') and (exists ( select 1 from profiles p where ((p.id = ( select auth.uid() as uid)) and (p.role = any (array['admin'::user_role, 'govt'::user_role])))))",
        },
      ],
      [
        {
          file: "db/migrations/0171_avatars_bucket.sql",
          name: "Users can upload own avatar",
          kind: "create" as const,
          command: "insert",
          roles: ["authenticated"],
          predicate: "bucket_id = 'avatars' and auth.uid() = owner",
        },
        {
          file: "db/revocations_storage.sql",
          name: "revocations_admin_govt_upload",
          kind: "create" as const,
          command: "insert",
          roles: ["authenticated"],
          predicate:
            "bucket_id = 'revocations' and exists ( select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('admin', 'govt') )",
        },
      ],
    );
    expect(verdict.undeclared).toEqual([]);
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.changed).toEqual([]);
    expect(verdict.scoped).toHaveLength(2);
  });

  it("RED: a caller-facing write grant in the catalog that no file declares", () => {
    // The defect this whole half exists for. `create policy` typed into a SQL
    // console leaves no file behind, survives every rebuild of this tree, and
    // is invisible to every review of it. Fired for real against the local
    // catalog on 2026-09-17: planted, caught by name, dropped.
    const verdict = liveWriteVerdict(
      [
        livePetPhotos,
        {
          name: "hand_applied_upload",
          command: "insert",
          roles: ["authenticated"],
          qual: null,
          withCheck: "(bucket_id = 'anything'::text)",
        },
      ],
      [declaredPetPhotos],
    );
    expect(verdict.undeclared.map((p) => p.name)).toEqual(["hand_applied_upload"]);
    // And it is caught TWICE, by two independent rules: it is undeclared, and
    // it cannot name the caller. Either one alone would be enough.
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["hand_applied_upload"]);
  });

  it("RED: a blanket write grant that IS declared but is not one of the frozen two", () => {
    // The name being in a file is not a defence. A grant that cannot name who
    // is asking is true for every caller, wherever it was written down.
    const declaredBlanket = {
      file: "db/migrations/9999_oops.sql",
      name: "new_blanket_upload",
      kind: "create" as const,
      command: "insert",
      roles: ["authenticated"],
      predicate: "bucket_id = 'somewhere'",
    };
    const verdict = liveWriteVerdict(
      [
        {
          name: "new_blanket_upload",
          command: "insert",
          roles: ["authenticated"],
          qual: null,
          withCheck: "(bucket_id = 'somewhere'::text)",
        },
      ],
      [declaredBlanket],
    );
    expect(verdict.undeclared).toEqual([]);
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["new_blanket_upload"]);
  });

  it("RED: a frozen hole widened in the database", () => {
    // The two frozen grants are load-bearing debts with a ticket on them.
    // Growing one in place, in a database, without a migration, turns a
    // measured debt into an unmeasured one.
    const verdict = liveWriteVerdict(
      [{ ...livePetPhotos, withCheck: "true" }],
      [declaredPetPhotos],
    );
    expect(verdict.changed).toHaveLength(1);
    expect(verdict.changed[0]?.livePredicate).toBe("true");
    expect(verdict.changed[0]?.expected).toBe("bucket_id = 'pet-photos'");
    expect(verdict.unfrozen).toEqual([]);
  });

  it("GREEN: a live grant that names the caller is counted, not compared", () => {
    const verdict = liveWriteVerdict(
      [
        {
          name: "scoped_upload",
          command: "insert",
          roles: ["authenticated"],
          qual: null,
          withCheck: "(bucket_id = 'x'::text) and (auth.uid() = owner)",
        },
      ],
      [
        {
          file: "db/storage.sql",
          name: "scoped_upload",
          kind: "create" as const,
          command: "insert",
          roles: ["authenticated"],
          // Deliberately NOT the same text. It names the caller, so the text is
          // not the question.
          predicate: "auth.uid() = owner and bucket_id = 'x'",
        },
      ],
    );
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.changed).toEqual([]);
    expect(verdict.scoped).toHaveLength(1);
  });

  it("THE FALSE GREEN THIS FENCE ALMOST SHIPPED: a frozen hole widened with an OR", () => {
    // Caught in adversarial review, before it was pushed. The first version of
    // the loop tested for `auth.uid()` BEFORE looking the name up in the frozen
    // set, which made the pin comparison dead code for any predicate containing
    // that substring - including the two grants the whole file exists to pin.
    //
    // One ALTER in the Supabase SQL editor reopened it, and the widening is not
    // subtle: `or auth.uid() is not null` takes an INSERT grant from ONE bucket
    // to EVERY bucket on the instance - revocations, welfare evidence, the
    // export buckets - while the old order filed it under "names the caller,
    // leave it alone" and printed a checkmark.
    //
    // The asymmetry that made it worse: the STATIC half fails closed on the
    // same edit (the grant drops out of `permissive`, never reaches `seen`, and
    // fires `verdict.missing`). The live half failed OPEN on the harder side of
    // the same rule.
    const verdict = liveWriteVerdict(
      [
        {
          name: "event_attachments_authenticated_upload",
          command: "insert",
          roles: ["authenticated"],
          qual: null,
          withCheck: "((bucket_id = 'event-attachments'::text) OR (auth.uid() IS NOT NULL))",
        },
      ],
      [
        {
          file: "db/storage.sql",
          name: "event_attachments_authenticated_upload",
          kind: "create" as const,
          command: "insert",
          roles: ["authenticated"],
          predicate: "bucket_id = 'event-attachments'",
        },
      ],
    );
    expect(verdict.scoped).toEqual([]);
    expect(verdict.changed).toHaveLength(1);
    expect(verdict.changed[0]?.expected).toBe(
      FROZEN_WRITE_GRANTS.event_attachments_authenticated_upload.predicate,
    );
  });

  it("RED: a grant that names the caller but NO bucket reaches every bucket on the instance", () => {
    // The sibling of the hole above. `using (auth.uid() is not null)` says who
    // is asking and never says where, so it authorises writes into every
    // bucket. All ten caller-facing write grants this tree declares name their
    // bucket, so requiring it costs nothing and closes the shape.
    const verdict = liveWriteVerdict(
      [
        {
          name: "pet_photos_uploader_update",
          command: "update",
          roles: ["authenticated"],
          qual: "(auth.uid() IS NOT NULL)",
          withCheck: null,
        },
      ],
      [
        {
          file: "db/storage.sql",
          name: "pet_photos_uploader_update",
          kind: "create" as const,
          command: "update",
          roles: ["authenticated"],
          predicate: "bucket_id = 'pet-photos' and auth.uid() = owner",
        },
      ],
    );
    expect(verdict.scoped).toEqual([]);
    expect(verdict.crossBucket.map((p) => p.name)).toEqual(["pet_photos_uploader_update"]);
    // Not "undeclared": an ALTER never changes a name, which is exactly why the
    // name check alone could never have caught this.
    expect(verdict.undeclared).toEqual([]);
  });

  it("GREEN: a RESTRICTIVE policy narrows and must never be read as a blanket grant", () => {
    // `as restrictive ... with check (bucket_id <> 'revocations')` is somebody
    // CLOSING a hole. It has no auth.uid() and is in no frozen set, so without
    // the permissive filter the fence would turn the nightly red on a hardening
    // - and a fence that punishes the right move gets reverted.
    const verdict = liveWriteVerdict(
      [
        {
          name: "no_evidence_writes",
          command: "insert",
          roles: ["authenticated"],
          qual: null,
          withCheck: "(bucket_id <> 'revocations'::text)",
          permissive: false,
        },
      ],
      [],
    );
    expect(verdict.liveWrites).toEqual([]);
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.undeclared).toEqual([]);
    // Still counted for non-vacuity: the scan did see a row.
    expect(verdict.seen).toBe(1);
  });

  it("an absent `permissive` reads as PERMISSIVE, so an unknown row is judged, not waved through", () => {
    const verdict = liveWriteVerdict(
      [
        {
          name: "unknown_shape",
          command: "insert",
          roles: ["authenticated"],
          qual: null,
          withCheck: "(bucket_id = 'x'::text)",
        },
      ],
      [],
    );
    expect(verdict.unfrozen.map((p) => p.name)).toEqual(["unknown_shape"]);
  });

  it("GREEN: a live SELECT policy is not this fence's subject, but still counts", () => {
    // SELECT stays check-rls-coverage's business. It is counted in `seen`
    // anyway, because `seen` is the non-vacuity number and a scan that found
    // only reads still found something.
    const verdict = liveWriteVerdict(
      [
        {
          name: "blanket_read",
          command: "select",
          roles: ["authenticated"],
          qual: "(bucket_id = 'x'::text)",
          withCheck: null,
        },
      ],
      [],
    );
    expect(verdict.liveWrites).toEqual([]);
    expect(verdict.undeclared).toEqual([]);
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.seen).toBe(1);
  });

  it("GREEN: a service-role-only write grant is not caller-facing", () => {
    const verdict = liveWriteVerdict(
      [
        {
          name: "svc",
          command: "insert",
          roles: ["service_role"],
          qual: null,
          withCheck: "(true)",
        },
      ],
      [],
    );
    expect(verdict.liveWrites).toEqual([]);
    expect(verdict.unfrozen).toEqual([]);
  });

  it("reports a declared name absent from the catalog WITHOUT calling it a failure", () => {
    // This scan reads `create policy` and `alter policy`, never `drop policy`,
    // so a grant a later migration dropped is "declared" here and correctly
    // missing there. It goes in its own list, not in the ones that fail a run.
    const verdict = liveWriteVerdict([], [declaredPetPhotos]);
    expect(verdict.absent).toEqual(["pet_photos_authenticated_upload"]);
    expect(verdict.undeclared).toEqual([]);
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.changed).toEqual([]);
  });

  it("no vacuity: an empty catalog satisfies every rule here, which is why runCheck fails on seen === 0", () => {
    // Every assertion above passes trivially against an empty list. The guard
    // that catches that lives in runCheck, not here - this test exists so
    // nobody reads the emptiness below as a pass.
    const verdict = liveWriteVerdict([], []);
    expect(verdict.seen).toBe(0);
    expect(verdict.undeclared).toEqual([]);
    expect(verdict.unfrozen).toEqual([]);
    expect(verdict.changed).toEqual([]);
  });
});

describe("describeConnectionError - a skip that says nothing is a skip nobody investigates", () => {
  it("prefers the code, because postgres.js raises a connection failure with an EMPTY message", () => {
    // Measured 2026-09-17 against a closed port: message "", code
    // "ECONNREFUSED". Reading `message` first printed "could not reach the
    // database ()" - true, useless, and indistinguishable from a wrong
    // password or a stopped container.
    const err = Object.assign(new Error(""), { code: "ECONNREFUSED" });
    expect(describeConnectionError(err)).toBe("ECONNREFUSED");
  });

  it("keeps both when both say something", () => {
    const err = Object.assign(new Error("password authentication failed"), { code: "28P01" });
    expect(describeConnectionError(err)).toBe("28P01: password authentication failed");
  });

  it("falls back to the error's name rather than an empty string", () => {
    expect(describeConnectionError(new Error(""))).toBe("Error");
  });

  it("survives a throw that is not an Error at all", () => {
    expect(describeConnectionError("boom")).toBe("boom");
  });
});
