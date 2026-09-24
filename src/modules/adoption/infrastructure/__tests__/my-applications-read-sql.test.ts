// What Postgres is actually ASKED by "mis postulaciones".
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND WHY IT DOES NOT READ THE SOURCE
// ===========================================================================
// `readMyAdoptionApplications` carries two authorization predicates and one
// art. 16 guard INSIDE a raw `sql` template:
//
//   · `e.payload->>'applicant_user_id' = ${userId}` — the only thing separating
//     one person's applications from everybody's. There is no `WHERE user_id`
//     on a table here; the applicant is a JSON field on an append-only event.
//   · `f.payload->>'adopter_user_id' = ${userId}` — the same fact for the
//     finalization LATERAL, which is what turns a row into "finalized_to_me".
//     Widened, this reports somebody else's adoption as the reader's own.
//   · `p.deleted_at IS NULL` — art. 16 (Ley 25.326). The applicant's submission
//     row and the shelter's custody row BOTH survive a rehome-R4 titular's
//     erasure, so nothing upstream filters an erased animal out for a
//     third-party applicant.
//
// The instrument this repo reached for before was a source-text sweep counting
// `pets` reads against `deleted_at` guards
// (`__tests__/public-soft-delete-resolution.test.ts`). That sweep still has a
// job — it finds files nobody remembered to check — but it cannot fence a
// predicate, and the board says why in the turnos post-mortem:
// `toContain("isNull(pets.deletedAt)")` passes for
// `or(isNull(pets.deletedAt), sql`true`)`, which keeps the substring and stops
// filtering. For a RAW template the same hole is one word wide: append
// ` OR TRUE` to any of the three clauses above and every substring assertion in
// the repo stays green.
//
// So this file compiles the fragment the function hands `db.execute` with
// `PgDialect().sqlToQuery()` and asserts what the DATABASE receives: the exact
// text of each clause, and the exact bound parameters. It proves what Postgres
// is ASKED rather than what Postgres answers — and "what is it asked" is the
// half a tautology breaks.
//
// Every test below names the mutation that reddens it. All eight were applied.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn<(fragment: SQL) => Promise<unknown[]>>(async () => []);

vi.mock("@/db", () => ({
  db: { execute: (fragment: SQL) => execute(fragment) },
}));

import { MY_APPLICATIONS_LIMIT, readMyAdoptionApplications } from "../my-applications-read";

const ME = "11111111-2222-3333-4444-555555555555";

const dialect = new PgDialect();

/** The compiled text + params of the one query the function ran. */
async function compiledQuery(userId = ME): Promise<{ text: string; params: unknown[] }> {
  await readMyAdoptionApplications(userId);
  const fragment = execute.mock.calls.at(-1)?.[0];
  if (!fragment) throw new Error("readMyAdoptionApplications ran no query at all");
  const { sql: text, params } = dialect.sqlToQuery(fragment);
  return { text, params };
}

/**
 * Drop `--` comments, then collapse every run of whitespace, so an assertion
 * survives a re-indent or a reworded comment.
 *
 * BOTH STEPS ARE SEMANTICS-PRESERVING AND NOTHING ELSE IS. A `--` comment runs
 * to end of line and Postgres ignores it, so stripping it here cannot accept a
 * mutation Postgres would execute — ` OR TRUE -- note` keeps its `OR TRUE`, and
 * ` -- OR TRUE` is inert on both sides. Stripping happens BEFORE the collapse
 * because after it there are no line ends left to strip to. No case folding and
 * no punctuation normalisation: a normaliser that removed more would start
 * accepting the very mutations this file exists to catch.
 */
const flat = (text: string) =>
  text
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The compiled text BETWEEN two anchors, for an equality assertion.
 *
 * EQUALITY, NEVER `toContain`, is the whole design of this file:
 * `toContain("= $1")` passes for `= $1 OR TRUE` and equality does not. Both
 * anchors throw when they are missing, so a rewrite that moves a clause fails
 * loudly instead of silently asserting over an empty string.
 */
function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  if (start === -1) throw new Error(`opening anchor not in the compiled SQL: ${open}`);
  const rest = text.slice(start + open.length);
  const end = rest.indexOf(close);
  if (end === -1) throw new Error(`closing anchor not in the compiled SQL: ${close}`);
  return rest.slice(0, end).trim();
}

describe("readMyAdoptionApplications — the SQL Postgres receives", () => {
  beforeEach(() => {
    execute.mockClear();
  });

  it("binds the caller's id EXACTLY TWICE, and binds nothing else but the cap", async () => {
    // THE STRONGEST SINGLE ASSERTION IN THE FILE, and the cheapest.
    //
    // MUTATIONS APPLIED, each one red here:
    //   · delete `AND e.payload->>'applicant_user_id' = ${userId}` from
    //     `my_submissions` — params become [ME, 100] and every applicant's
    //     submissions are returned to every caller.
    //   · delete `AND f.payload->>'adopter_user_id' = ${userId}` from
    //     `finalizations` — params become [ME, 100] and a row finalized to
    //     SOMEBODY ELSE is reported to this reader as "finalized_to_me".
    //   · replace `${userId}` with a literal — params lose an entry.
    //
    // The cap is asserted in the same breath because `LIMIT ${…}` is the third
    // and last bound value; anything else appearing in this array is a new
    // parameter nobody declared.
    const { params } = await compiledQuery();
    expect(params).toEqual([ME, ME, MY_APPLICATIONS_LIMIT]);
  });

  it("keeps the applicant predicate an EQUALITY on the bound id, with nothing appended", async () => {
    // MUTATION APPLIED: `AND e.payload->>'applicant_user_id' = ${userId} OR TRUE`.
    // Params are untouched — the id is still bound, so the test above stays
    // green — and every application in the database is returned to every
    // caller. Only this equality catches it. Red.
    const { text } = await compiledQuery();
    expect(
      between(
        flat(text),
        "WHERE e.event_type = 'adoption_application_submitted'",
        "), decisions AS",
      ),
    ).toBe("AND e.payload->>'applicant_user_id' = $1");
  });

  it("keeps the ADOPTER predicate an equality too, so nobody else's adoption reads as mine", async () => {
    // THE SECOND AUTHORIZATION PREDICATE, and the one easiest to overlook
    // because it does not decide WHICH ROWS come back — it decides whether a row
    // is labelled `finalized_to_me`. Widened, the screen tells an applicant they
    // adopted an animal somebody else adopted.
    //
    // MUTATION APPLIED: `AND f.payload->>'adopter_user_id' = ${userId} OR TRUE`.
    // Red here and green everywhere else in the repo.
    const { text } = await compiledQuery();
    expect(
      between(flat(text), "AND f.event_type = 'adoption_finalized'", "), info_requests AS"),
    ).toBe("AND f.payload->>'adopter_user_id' = $2");
  });

  it("joins `pets` on the art. 16 guard and NOTHING that weakens it", async () => {
    // THE SUPPRESSION GUARD, ON ITS OWN LINE, so a failure names it instead of
    // pointing at the whole query. The animal in question belongs to somebody
    // who exercised art. 16 (Ley 25.326) — and the reader here is a THIRD PARTY
    // who once applied to adopt it, so no upstream filter covers them.
    //
    // MUTATIONS APPLIED, both red:
    //   · `AND (p.deleted_at IS NULL OR TRUE)` — the substring `p.deleted_at IS
    //     NULL` survives, so the repo's source-text sweep stays green while an
    //     erased animal's name renders to a third-party applicant.
    //   · delete the `AND p.deleted_at IS NULL` line outright.
    const { text } = await compiledQuery();
    expect(between(flat(text), "FROM my_submissions s JOIN pets p", "LEFT JOIN LATERAL")).toBe(
      "ON p.id = s.pet_id AND p.deleted_at IS NULL",
    );
    // …and the query carries no disjunction ANYWHERE. `OR` appears nowhere in it
    // today, so this one line closes the tautology door on every predicate at
    // once rather than on the three that happen to be named above.
    expect(flat(text)).not.toMatch(/\bOR\b/);
  });

  it("caps the read, and the cap is the module's own constant", async () => {
    // MUTATION APPLIED: delete `LIMIT ${MY_APPLICATIONS_LIMIT}`. Params drop to
    // two entries and an account with a scripted history returns unbounded.
    const { text, params } = await compiledQuery();
    expect(flat(text).endsWith("LIMIT $3")).toBe(true);
    expect(params.at(-1)).toBe(MY_APPLICATIONS_LIMIT);
  });

  it("reads the note_added join ONLY for kind=adoption_info_requested", async () => {
    // THIS ASSERTION IS A CONTENT-MODERATION FENCE WEARING A SQL TEST'S CLOTHES,
    // and it is here because a claim was made about this query in a census that
    // nothing else could check.
    //
    // `__tests__/content-report-read-coverage.test.ts` sweeps every file that
    // reads `pet_events` in a way that can return a lost-feed `note_added` and
    // demands each one either subtract reported items (`notReportedClause()`) or
    // be triaged. This module is triaged as NOT_A_LOST_NOTE_READ on exactly one
    // ground: its `note_added` join is narrowed to the shelter's
    // `adoption_info_requested` marker, which is never a lost-feed message.
    //
    // That census is a list of file paths and free prose. It cannot see a
    // predicate, so the day somebody widens this join the triage silently
    // becomes a false statement and the sweep keeps passing — the file is still
    // in the list, and the list is what it reads.
    //
    // MUTATION APPLIED: delete `AND n.payload->>'kind' = 'adoption_info_requested'`.
    // The join then matches EVERY `note_added` on the pet — including a lost-feed
    // sighting note somebody reported — `readMyAdoptionApplications` becomes a
    // genuine lost-note reader, and `content-report-read-coverage` stays 8/8
    // green because the path is still triaged. Red here, and only here.
    const { text } = await compiledQuery();
    expect(between(flat(text), "AND n.event_type = 'note_added'", "GROUP BY s.id")).toBe(
      "AND n.payload->>'kind' = 'adoption_info_requested' " +
        "AND n.payload->>'application_event_id' = s.id::text " +
        "AND n.recorded_at >= s.submitted_at",
    );
  });

  it("selects a TIMESTAMP off that note and never its text", async () => {
    // The second half of the same triage claim, and the half that would actually
    // put somebody's words on a screen. The CTE derives one of seven status
    // values from WHETHER a marker exists and WHEN the latest one landed; the
    // note's payload is never selected, so `RawRow` has no field that could
    // carry a sentence and the mapping has nothing to render.
    //
    // MUTATION APPLIED: add `, n.payload->>'text' AS note_text` to this CTE's
    // select list. The read now pulls moderatable prose out of `pet_events`
    // while its triage still says it reads no note text — the precise thing the
    // content-report census exists to prevent, arriving through a file the
    // census has already been told to ignore. Red here.
    const { text } = await compiledQuery();
    expect(
      between(flat(text), "info_requests AS (", "FROM my_submissions s JOIN pet_events n"),
    ).toBe("SELECT s.id AS application_id, MAX(n.recorded_at) AS requested_at");
  });

  it("binds the id it was CALLED with, not one it captured", async () => {
    // MUTATION APPLIED: hard-code the applicant predicate to a constant. Green
    // on every assertion above that only counts parameters, red here.
    const other = "99999999-8888-7777-6666-555555555555";
    const { params } = await compiledQuery(other);
    expect(params).toEqual([other, other, MY_APPLICATIONS_LIMIT]);
  });
});
