// The SET of reads that must subtract a reported item — derived from source.
//
// WHY THIS FILE EXISTS, AND WHY A COMMENT WOULD NOT HAVE DONE
// ---------------------------------------------------------------------------
// The first delivery of content reporting applied `notReportedClause()` to FOUR
// reads and its own comment claimed "every read of a lost-mode note_added". A
// fresh-context review found eight; re-enumerating against the tree found ten.
// Nobody was lying — the set was simply never counted by anything.
//
// That is the exact failure mode this repo already has a name for: a claim about
// a SET, written in prose, that nothing checks. `public-token-throttle.ts` said
// "the four HTML surfaces" when there were five. `api-v1-rate-limit-families`
// exists because a bucket list in a comment drifts. This is the same defect on
// the same day, so it gets the same instrument.
//
// WHAT IS ASSERTED, and both directions:
//   source → list: every file that reads `pet_events` in a way that can return a
//     lost-feed `note_added` either CARRIES the clause or is a DECLARED
//     exemption. A new read that carries neither fails here.
//   list → source: every declared exemption still exists and still reads
//     pet_events. An exemption that outlives its call site is how an inventory
//     quietly becomes fiction while still reading as complete.
//
// NON-VACUITY is asserted first: if the scan finds no files, every assertion
// below passes over an empty set, which is how a fence stops fencing.
//
// WHAT THIS DOES *NOT* CATCH, measured rather than assumed. Three mutations were
// run against it:
//   · clause deleted from a file still in MUST_SUBTRACT   → FAILS (good)
//   · a brand-new read of a lost-feed note added with no clause and no entry
//     → FAILS (good — this is the direction that found the last two leaks)
//   · a file REMOVED from MUST_SUBTRACT while it still carries the clause
//     → PASSES. That is a deliberate gap and a benign one: the file keeps
//       subtracting, and if the clause is dropped later the file becomes
//       unaccounted-for and the second assertion catches it then. Said out loud
//       so nobody reads this fence as stronger than it is.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/**
 * The ten reads that MUST subtract. Each is a file that queries `pet_events`
 * and can return a `note_added` carrying a lost-feed message.
 */
const MUST_SUBTRACT: readonly string[] = [
  "app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/page.tsx",
  "app/api/mis-mascotas/[publicToken]/libreta-export/route.ts",
  "app/libreta/compartir/[shareToken]/page.tsx",
  "lib/analytics/owner-dashboard.ts",
  "lib/infra/case-queries.ts",
  "lib/infra/lost-mode.ts",
  "src/modules/events/application/read/load-pet-event-detail.ts",
  "src/modules/lost/infrastructure/lost-listing-read.ts",
  "src/modules/pets/application/read/load-public-credential.ts",
  "src/modules/pets/application/tab-data/get-libreta-face-data.ts",
];

/**
 * Reads that deliberately do NOT subtract, with the reason in one line each.
 *
 * SIX of the seven are STATE-FACING AGGREGATES: a dot on a map and a number on a
 * dashboard, neither of which renders anybody's sentence — none of them selects
 * `payload`. Letting an owner erase points from an official map by reporting them
 * would be a moderation control with a jurisdictional reach nobody asked for. The
 * cost — the owner's counter and a gob counter can disagree — is declared in
 * `content-reports.ts` and in AGENTS.md § Privacidad 6c.
 *
 * The SEVENTH is the WRITER itself: it has to find the target row in order to
 * validate it, and it has to find an existing report in order to answer
 * `alreadyReported`. A writer that could not see what it is reporting could not
 * report anything.
 *
 * COUNT THE ARRAY, NOT THIS SENTENCE. This docblock said "the first two" and
 * "the third" for one revision after the array below had grown to seven. Prose
 * that counts a list it sits next to is the exact defect this fence exists for,
 * and it reappeared here, inside the fence. The array is the truth; if these
 * words disagree with it, the words are wrong.
 */
const DECLARED_EXEMPTIONS: readonly string[] = [
  // Government dashboards + the panorama map. These COUNT a reported row, and
  // two of them plot it as a dot with the pet's name and coordinates — but NONE
  // of them selects `payload` text, so no sentence of anybody's is rendered.
  // Letting an owner erase points from an official map by reporting them would
  // be a moderation control with a jurisdictional reach nobody asked for.
  "lib/analytics/dashboards/exports.ts",
  "lib/analytics/dashboards/perdidas.ts",
  "lib/metrics/event-ledger.ts",
  "src/modules/panorama/infrastructure/repository-by-unit.ts",
  "src/modules/panorama/infrastructure/repository-histogram.ts",
  "src/modules/panorama/infrastructure/repository-history.ts",
  // The WRITER. It must see the target row to validate it, and must see an
  // existing report to answer `alreadyReported`.
  "src/modules/events/application/lifecycle/report-lost-feed-item-use-case.ts",
];

/**
 * `repository-scope.ts` is NOT in the list above, and its absence is the
 * finding that produced this comment.
 *
 * It was listed for two revisions as "the map layer" — and it contains no query
 * at all. It is a PREDICATE BUILDER: `perdidasEventPredicate()` and
 * `sightingEventPredicate()` are spelled there and called from the three
 * repositories that do the reading. Naming it exempted a file that never reads,
 * while the five files that actually read were in no list whatsoever. An
 * inventory that names the wrong file reads as complete and is not.
 */
const PREDICATE_BUILDERS: readonly string[] = [
  "src/modules/panorama/infrastructure/repository-scope.ts",
];

/**
 * Files the coarse scan flags that are NOT reads of a lost-feed note at all,
 * each with the reason it is a false positive.
 *
 * This list is the price of a regex that errs WIDE on purpose. The alternative —
 * narrowing the pattern until the noise disappears — is exactly how the first
 * delivery ended up fencing four reads and believing it had fenced all of them:
 * every file removed from the corpus is a file nobody will ever be forced to
 * think about again.
 */
const NOT_A_LOST_NOTE_READ: readonly string[] = [
  // `note_added` here is kind='adoption_info_requested' — the shelter asking an
  // applicant for more information. Never a lost-feed message.
  "app/(app)/mis-mascotas/postulaciones/page.tsx",
  "app/org/[orgToken]/adopciones/page.tsx",
  "src/modules/adoption/infrastructure/adoption-repository.ts",
  // Same kind, and it is the SAME QUERY as the first entry above: the native
  // adopción door (WU-U) lifted that page's inlined SQL into a module so the
  // cookie door and the bearer door could not derive an application's status
  // two different ways. The read did not change and neither did its triage —
  // but lifting it moved the text across this fence's `src/` boundary, so the
  // sweep saw it as a new reader. That is the fence working: an extraction is
  // exactly when a read's classification should be re-stated rather than
  // inherited.
  //
  // RE-STATED, then: its `note_added` join lives in the `info_requests` CTE,
  // is filtered `payload->>'kind' = 'adoption_info_requested'` AND
  // `payload->>'application_event_id' = s.id`, and selects `MAX(n.recorded_at)`
  // and nothing else. No `payload` text is selected, so no sentence of
  // anybody's is read here, let alone rendered — `RawRow` has no field that
  // could hold one. The timestamp derives one of seven status values
  // (`info_requested`) and is then discarded. This is a STRICTER case than the
  // three above it, which is why it sits with them: two of those select payload
  // for other kinds and rely on the kind filter alone.
  //
  // `my-applications-read-sql.test.ts` pins both halves of that claim against
  // the COMPILED SQL, so this entry cannot quietly become false.
  "src/modules/adoption/infrastructure/my-applications-read.ts",
  // The WRITE path for a finder report: it probes for an identical
  // finder_in_possession row to stay idempotent. It surfaces nothing.
  "app/(public)/p/[publicToken]/encontre/action.ts",
  // Defines `libretaSanitariaClause`; its `from(petEvents)` lives in a docblock
  // example, not in a query.
  "lib/infra/libreta-sanitaria.ts",
  // Names `note_added` only in a comment, to say it is EXCLUDED from the
  // veterinary-access signal.
  "lib/metrics/vet-access.ts",
  // Decomiso / return-to-owner / generic repository notes — different kinds,
  // and none of them a lost-feed message.
  "src/modules/decomiso/application/accept-decomiso-handoff.ts",
  "src/modules/events/infrastructure/events-repository.ts",
  "src/modules/return-to-owner/application/proposal-queries.ts",
  // WRITES a system note ("auto-expirada: el destinatario no respondió") when a
  // transfer proposal lapses. An insert, not a read.
  "src/modules/transfers/infrastructure/transfers-repository.ts",
];

/** Every non-test source file under the app's own roots. */
function sourceFiles(): string[] {
  const found: string[] = [];
  for (const root of ["app", "lib", "src"]) {
    for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (name.includes(".test.")) continue;
      found.push(
        join(entry.parentPath, name)
          .slice(ROOT.length + 1)
          .replaceAll("\\", "/"),
      );
    }
  }
  return found.sort();
}

const READS_PET_EVENTS = /\.from\(petEvents\)|FROM public\.pet_events|FROM pet_events/;
/**
 * Does this file read `note_added` rows that can be lost-feed messages?
 *
 * FOUR shapes, and the fourth was added after this fence MISSED FIVE READERS —
 * inside the very instrument built to stop that happening:
 *
 *   1. a kind-filtered query (`payload->>'kind' = 'sighting'`)
 *   2. a `note_added`-typed query, or one using `libretaSanitariaClause`
 *   3. a query with NO type filter that pulls a whole case, or one row by id
 *   4. A QUERY THAT IMPORTS ITS PREDICATE. `repository-by-unit.ts`,
 *      `repository-histogram.ts` and `repository-history.ts` call
 *      `perdidasEventPredicate()` / `sightingEventPredicate()`, which spell the
 *      kind inside `repository-scope.ts`. Every one of them scored ZERO on the
 *      first version of this regex, because the fence looked for the FORMS a
 *      query spells rather than the SUBJECT it selects — the exact diagnosis
 *      this whole change was written around, reproduced one level up.
 *
 * WHAT IT STILL CANNOT SEE, declared rather than left to be discovered. Shape 3
 * is not detectable in general: a reader that selects EVERY event type and
 * happens to include a reported row spells nothing this regex can match.
 * `lib/metrics/event-ledger.ts` and `lib/analytics/dashboards/exports.ts` are
 * exactly that and are listed by hand below. A sixth such reader added tomorrow
 * WILL sail through this fence. If you are adding a query over `pet_events` that
 * does not filter by `event_type`, you must triage it into one of the three
 * lists yourself — nothing here will make you.
 */
const CAN_CARRY_LOST_NOTE =
  /'sighting'|finder_in_possession|note_added|libretaSanitariaClause|eq\(petEvents\.caseId|eq\(petEvents\.id, eventId\)|perdidasEventPredicate|sightingEventPredicate/;

function carriesClause(file: string): boolean {
  return readFileSync(join(ROOT, file), "utf8").includes("notReportedClause()");
}

describe("content-report read coverage", () => {
  const files = sourceFiles();

  it("scans a real source tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("every declared read actually carries the clause", () => {
    const missing = MUST_SUBTRACT.filter((f) => !carriesClause(f));
    expect(missing).toEqual([]);
  });

  it("every declared exemption really QUERIES pet_events — not just mentions it", () => {
    // The assertion that would have caught `repository-scope.ts`. An exemption
    // is a statement about a READ; a file with no query cannot be one, and while
    // one sat in the list the five real readers sat in none.
    const notReaders = DECLARED_EXEMPTIONS.filter((f) => {
      if (!files.includes(f)) return true;
      return !READS_PET_EVENTS.test(readFileSync(join(ROOT, f), "utf8"));
    });
    expect(notReaders).toEqual([]);
  });

  it("every MUST_SUBTRACT entry really queries pet_events too", () => {
    const notReaders = MUST_SUBTRACT.filter((f) => {
      if (!files.includes(f)) return true;
      return !READS_PET_EVENTS.test(readFileSync(join(ROOT, f), "utf8"));
    });
    expect(notReaders).toEqual([]);
  });

  it("the predicate builders still build predicates and still do not query", () => {
    // If one of these grows a query it becomes a READER and has to be triaged
    // into one of the three lists — which nothing else here would notice.
    for (const f of PREDICATE_BUILDERS) {
      expect(files).toContain(f);
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(READS_PET_EVENTS.test(src)).toBe(false);
      expect(CAN_CARRY_LOST_NOTE.test(src)).toBe(true);
    }
  });

  it("every triaged false positive still exists", () => {
    // Same ratchet rule as the exemptions: an entry that outlives its file is an
    // inventory quietly becoming fiction.
    const stale = NOT_A_LOST_NOTE_READ.filter((f) => !files.includes(f));
    expect(stale).toEqual([]);
  });

  it("no declared exemption quietly started subtracting", () => {
    // The other direction: if one of these grows the clause, the exemption is
    // over and the list must say so rather than keeping a false entry.
    const nowSubtracting = DECLARED_EXEMPTIONS.filter((f) => carriesClause(f));
    expect(nowSubtracting).toEqual([]);
  });

  it("NO read of a lost-feed note is outside the list — the assertion the first delivery lacked", () => {
    const unaccounted = files.filter((f) => {
      if (MUST_SUBTRACT.includes(f)) return false;
      if (DECLARED_EXEMPTIONS.includes(f)) return false;
      if (NOT_A_LOST_NOTE_READ.includes(f)) return false;
      const src = readFileSync(join(ROOT, f), "utf8");
      if (!READS_PET_EVENTS.test(src)) return false;
      if (!CAN_CARRY_LOST_NOTE.test(src)) return false;
      // A file that already carries the clause is accounted for by definition.
      return !src.includes("notReportedClause()");
    });
    expect(unaccounted).toEqual([]);
  });
});
