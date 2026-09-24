// One command to clear test residue that blocks `pnpm verify`.
//
// THE PAIN THIS REMOVES
// ---------------------------------------------------------------------------
// `lint:spine` enforces invariant #3 — every pet has its pet_registered event in
// the append-only spine. It works, and it caught three leaks in a single day
// (TRNS-TEST-0001, DDXTEST-RABIES-…, and the E2EPet-… pile). But every time, the
// fence stated the problem and left the operator to work out the fix, which is
// NOT obvious: `pet_events` has a BEFORE DELETE trigger, so a plain
// `DELETE FROM pets` fails with "pet_events is append-only", and the sanctioned
// escape hatch is a GUC pair that has to be set LOCAL inside a transaction.
//
// Writing that by hand under a blocked commit is where the time goes. It is also
// where mistakes go: on 2026-07-29 I edited a cache column directly to unblock a
// test and manufactured exactly the cache-vs-spine drift the fence exists to
// detect. A blunt tool used in a hurry is worse than no tool.
//
// TENTH instance of the class, 2026-09-02, and the first from an OPERATOR KILL
// rather than a dying worker: a gate was stopped by hand mid-file and
// __tests__/tag-lifecycle.test.ts never reached its afterAll. It left a pet the
// cleaner could see in NEITHER way — the name was not listed, and its token is
// `DIM-TAGT-XXXX`, a legal real-token shape no prefix here may match. It also
// left `pet_tags` rows, whose `pet_id` FK carries no ON DELETE (migration 0169),
// so even a matched pet would have failed to delete. Both are fixed below.
//
// WHAT IT DOES NOT DO
// ---------------------------------------------------------------------------
// It does not touch real data. It removes pets matching KNOWN TEST PREFIXES
// only, refuses to run against a non-local database, and prints what it will
// delete before deleting it. It is not a general "clean the database" script —
// that would be a way to lose work.
//
// Run:  pnpm tsx scripts/clean-test-orphans.ts            (dry run — lists only)
//       pnpm tsx scripts/clean-test-orphans.ts --apply    (deletes)

import postgres from "postgres";

const DEFAULT_LOCAL_URL = "postgresql://postgres:postgres@localhost:54322/postgres";

/**
 * Name / token prefixes that only ever come from a test or a manual probe.
 * Deliberately explicit — a pattern like "%TEST%" would eventually match a real
 * pet called "Testa" and delete somebody's animal.
 */
export const TEST_PET_PREFIXES = {
  // "UC CD " added 2026-08-21, NINTH instance of the killed-worker leak class and
  // the first that this list could not see at all: every entry before it was a
  // TOKEN prefix, and `src/modules/custody-disputes/application/__tests__/use-cases.test.ts`
  // mints ordinary `DIM-XXXX-XXXX` tokens and names its pets "UC CD <case>". It
  // HAS a correct afterAll (`:275`); a vitest worker died at teardown, so the 11
  // rows it created reddened `lint:spine` for a reason unrelated to the gate, and
  // the cleaner answered "No test-fixture pets found".
  //
  // WHY A NAME PREFIX IS SAFE HERE, when the token comments below are so careful
  // about LIKE collisions: the danger there is that a real token is
  // `DIM-XXXX-XXXX`, so a prefix like `DIM-PANO-` matches somebody's animal. A
  // NAME has no such format — and `UC CD ` carries a TRAILING SPACE after two
  // uppercase initialisms, so `name LIKE 'UC CD %'` requires a third word after
  // them. No Spanish pet name begins "UC CD ". Widening to `UC ` would NOT be
  // safe by the same reasoning (one initialism, and it prefixes real words).
  // "Tag Lifecycle Pet" added 2026-09-02, TENTH instance (see the header).
  // A NAME entry for the same reason "UC CD " is one, and with no alternative:
  // __tests__/tag-lifecycle.test.ts mints `DIM-TAGT-${4 chars}`, which is a
  // legal real token, so no byToken prefix could ever be safe here.
  // "Dispute Lock Pet" added 2026-09-22, ELEVENTH instance — and the first one
  // where the teardown did not merely fail to RUN, it failed to be POSSIBLE.
  // __tests__/custody-dispute-escalated-keeps-lock.test.ts had a correct
  // afterAll that additionally tried to DELETE its audit_log rows; audit_log is
  // append-only and `enforce_audit_log_append_only()` refused, which aborted the
  // whole cleanup transaction and left all 13 pets behind. Every test in the
  // file had passed. The fixtures were called "Esc <case>" and this list could
  // not see them, so the cleaner answered "No test-fixture pets found" and the
  // rows had to be removed by hand.
  //
  // A NAME entry for the same reason as the two above: the file mints ordinary
  // `DIM-XXXX-XXXX` tokens, so no byToken prefix could ever be safe. Three words
  // ending in a common noun is well past the collision bar "UC CD " argues for —
  // no real animal is named "Dispute Lock Pet <something>".
  byName: [
    "E2EPet-",
    "ProbeAlta-",
    "DdxPet",
    "Transit Compliance Test",
    "UC CD ",
    "Tag Lifecycle Pet",
    "Dispute Lock Pet",
  ],
  // MC-DUP- added 2026-07-30: `__tests__/microchip-replaced.test.ts` HAS a
  // correct afterAll, but a worker killed mid-file never runs it, and the row
  // then fails check-spine-integrity on the next verify. Leaked exactly that
  // way when the suite was run with the QA server up (CPU contention → dead
  // worker). Tokens are `MC-DUP-${Date.now()}`, so they cannot collide with a
  // real `DIM-XXXX-XXXX`.
  // SURVTEST- added 2026-08-01: same failure mode as MC-DUP- above, this time
  // from `__tests__/symptom-surveillance.test.ts` (tokens `SURVTEST-*-${Date.now()}`).
  // DIM-PANO-US1 added 2026-08-01: unit-history-govt-subsumption.test.ts fixture
  // (fixed token `DIM-PANO-US1SUB`) — same killed-worker leak class.
  // MC-PRI- added 2026-08-02: microchip-replaced.test.ts's primary-chip fixture
  // (`MC-PRI-${Date.now()}`) — same killed-worker leak class as MC-DUP-.
  // MI-INV1- added 2026-08-20: `__tests__/macro-invariants/macro-invariants.test.ts`
  // (tokens `MI-INV1-${Date.now()}`, pets named `MacroPet_*`). Fifth instance of
  // the same class and the cause was visible this time: vitest workers died in
  // five separate runs that night with no failing assertion, and a worker that
  // dies mid-file never reaches its afterAll — which this test HAS and which is
  // correct. The leaked row then reds check-spine-integrity on the next verify,
  // for a reason unrelated to whatever is being gated.
  // DIM-PANO-COB- and DIM-PANO-DEPT- added 2026-08-20, sixth and seventh
  // instances. COB leaked the same way as the rest (six orphans from
  // `src/modules/panorama/infrastructure/__tests__/cobertura-guard-verified.test.ts`
  // after two vitest workers died mid-run with zero failing assertions). DEPT
  // has never leaked yet — `department-drill.test.ts` mints DIM-PANO-DEPT-A/B/
  // DECOY and was simply missing, which is the point below.
  //
  // THIS LIST IS STRUCTURALLY BEHIND. It is an enumeration of forms, and it only
  // ever grows one entry at a time, always AFTER a leak has already reddened a
  // verify for a reason unrelated to what was being gated. Widening it to the
  // family (`DIM-PANO-`) is not available: a real token is `DIM-XXXX-XXXX` and
  // PANO is a legal four-character segment, so `DIM-PANO-1234` could belong to
  // somebody's animal. The trailing hyphen is what makes each entry below safe —
  // it forces a third segment, which a real token never has.
  //
  // The root cause is upstream of this file and worth fixing there: every one of
  // these tests HAS a correct afterAll, and every leak came from a vitest worker
  // dying mid-file. Eight such crashes on 2026-08-20 alone, all with zero failing
  // assertions.
  byToken: [
    "TRNS-TEST-",
    "DDXTEST-",
    "MORT-TEST-",
    "SQLQ-TEST-",
    "MC-DUP-",
    "MC-PRI-",
    "SURVTEST-",
    // Full token, not the `DIM-PANO-US1` prefix it used to be: that shorter
    // form would also LIKE-match a real `DIM-PANO-US1Z`, and this script
    // deletes what it matches.
    "DIM-PANO-US1SUB",
    "DIM-PANO-COB-",
    "DIM-PANO-DEPT-",
    // SC-TEST- added 2026-08-20, EIGHTH instance, and it arrived HOURS after the
    // note above was written — from `__tests__/surveillance-compliance.test.ts`,
    // which even declares its own `TEST_PET_TOKEN_PREFIX = "SC-TEST-"` constant
    // that this file cannot see. That is the shape of the real fix whenever
    // someone has the appetite: derive this list from the tests that mint the
    // tokens, instead of transcribing it by hand one leak at a time.
    "SC-TEST-",
    // DIM-RHOM-PET1 added 2026-08-20 for __tests__/rehome-finalize-ownership.test.ts.
    // FULL TOKEN, not the `DIM-RHOM-` prefix it is tempting to write: that shape
    // is a legal real token (DIM + four + four), so the prefix would LIKE-match
    // somebody's `DIM-RHOM-9K2P` and this script deletes what it matches. Same
    // trap as the old `DIM-PANO-US1` entry two lines up.
    //
    // Registered BEFORE it leaked, which is a first for this list. The test has
    // a correct afterAll; a dying worker skips it, and the pre-push reviewer
    // caught the omission rather than the next red gate.
    //
    // Not covered, and worth knowing: that test also creates the organisation
    // DIM-REHOME-001, and this script sweeps pets only. An org row left behind
    // trips no fence today, so it is noise rather than breakage.
    "DIM-RHOM-PET1",
    // DIM-CTKZ-PET1 added 2026-08-21 for __tests__/finalize-ends-caretaker-grant.test.ts.
    // FULL TOKEN again, for the reason above: `DIM-CTKZ-` is a legal real token
    // shape. Also registered before it leaked. The org it creates
    // (DIM-CTKZ-ORG1) is outside this script's reach, same as DIM-REHOME-001.
    "DIM-CTKZ-PET1",
    "MI-INV1-",
  ],
} as const;

export function isLocalDatabase(url: string): boolean {
  return /@(localhost|127\.0\.0\.1)[:/]/.test(url);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL?.trim() || DEFAULT_LOCAL_URL;

  if (!isLocalDatabase(url)) {
    const masked = url.replace(/:[^:@]*@/, ":***@");
    console.error(
      `✗ Refusing to run: ${masked} is not a local database.\n  This script deletes rows. It only ever runs against localhost.`,
    );
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const nameLikes = TEST_PET_PREFIXES.byName.map((p) => `${p}%`);
    const tokenLikes = TEST_PET_PREFIXES.byToken.map((p) => `${p}%`);

    const doomed = await sql<Array<{ id: string; name: string; token: string; status: string }>>`
      SELECT id::text AS id, name, public_token AS token, status
      FROM pets
      WHERE name LIKE ANY(${nameLikes}) OR public_token LIKE ANY(${tokenLikes})
      ORDER BY created_at DESC`;

    if (doomed.length === 0) {
      console.log("✓ No test-fixture pets found. Nothing to clean.");
      return;
    }

    console.log(`${doomed.length} test-fixture pet(s):`);
    for (const p of doomed) console.log(`  ${p.token}  ${p.name}  [${p.status}]`);

    if (!apply) {
      console.log("\nDry run — nothing deleted. Re-run with --apply to remove them.");
      return;
    }

    const actor = await sql<Array<{ id: string }>>`
      SELECT p.id::text AS id FROM profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE u.email = 'admin@dim.test' LIMIT 1`;
    const actorId = actor[0]?.id;
    if (!actorId) {
      console.error("✗ No admin@dim.test profile to attribute the append-only override to.");
      process.exit(1);
    }

    const ids = doomed.map((p) => p.id);
    await sql.begin(async (tx) => {
      // The sanctioned escape hatch, set LOCAL so it dies with the transaction.
      await tx`SELECT set_config('app.allow_event_mutation', 'true', true)`;
      await tx`SELECT set_config('app.allow_event_mutation_actor', ${actorId}, true)`;
      await tx`DELETE FROM pet_events WHERE pet_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM ownerships WHERE pet_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM pet_identifications WHERE pet_id = ANY(${ids}::uuid[])`;
      // pet_tags.pet_id is the ONE foreign key to pets.id with no ON DELETE
      // action (migration 0169; every other child table cascades or sets null),
      // so a tagged pet cannot be deleted while its chapa row survives. The
      // fixture that leaks them says the same thing at its own cleanup:
      // __tests__/tag-lifecycle.test.ts, "clear tag rows before the pets".
      //
      // Not covered, and worth knowing: an UNACTIVATED tag (pet_id NULL, lote
      // TEST-LOTE-TAGLC) hangs off no pet, so this sweep cannot see it. Its
      // serial is random per run, it trips no fence, and it is noise rather
      // than breakage — the same standing as the DIM-REHOME-001 org above.
      await tx`DELETE FROM pet_tags WHERE pet_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM pets WHERE id = ANY(${ids}::uuid[])`;
    });
    console.log(`\n✓ Removed ${ids.length} test-fixture pet(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("clean-test-orphans.ts") ||
    process.argv[1].endsWith("clean-test-orphans.js"));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
