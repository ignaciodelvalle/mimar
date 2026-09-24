// avatar-path-backfill.test.ts — migration 0219's backfill, run against the
// real database, over the shapes it will actually meet.
//
// WHY A TEST AND NOT A READING. `profiles.avatar_url` used to hold a fabricated
// `{SUPABASE_URL}/storage/v1/object/sign/avatars/{key}` string with no
// `?token=` — not a working URL and not a path. 0219 rewrites the rows it can
// parse WITH CERTAINTY into the bucket-relative path, and the product owner's
// instruction for everything else is explicit: a row that cannot be parsed with
// certainty is left EXACTLY as it is. Not nulled, not trimmed, not
// best-effort-ed.
//
// "Left alone" is the half of a WHERE clause that no reading of the SQL proves
// and no green migration reveals — it succeeds either way. So this file asserts
// both directions, and it does it against THE MIGRATION'S OWN TEXT: the
// statement is extracted from `db/migrations/0219_*.sql` and executed verbatim.
// A test that restated the regex would pass against a migration that shipped a
// different one.
//
// EVERY FIXTURE PATH IS BUILT FROM THE ROW'S OWN `id`, and that is not a
// cosmetic choice — it is the property under test. The backfill anchors the
// uuid segment to `profiles.id`, so a value can only be rewritten onto a key
// that already belongs to the row holding it. A fixture table with one shared
// constant uuid could not tell the anchored statement from an unanchored one;
// `CROSS_OWNED` below is the case that can.
//
// THE EXTENSION IS NOT AN ALLOWLIST, and an earlier draft of both this file and
// the migration got that wrong together — which is exactly how a test that
// restates its subject's assumptions fails to catch them. That draft asserted
// `.gif` was left alone "because rasterExtension cannot produce it". True of
// the writer TODAY; false for the entire prior life of the column, when the
// extension came from the client filename (`fileName.split(".").pop()`). The
// real legacy key space therefore contains `.JPG`, `.jpeg` and `.img`, and
// those are the rows the backfill exists to fix. They are fixtures now.
//
// RE-RUNNING THE STATEMENT IS SAFE — it is idempotent by construction: the
// rewritten value no longer matches the anchored `^…://…` pattern, so a second
// pass matches nothing.

import { readFileSync } from "node:fs";
import path from "node:path";

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, profiles } from "@/db";

const MIGRATION = path.join(
  process.cwd(),
  "db/migrations/0219_profiles_avatar_url_holds_a_path.sql",
);

/** The backfill statement, verbatim, straight out of the migration file. */
function backfillStatement(): string {
  const file = readFileSync(MIGRATION, "utf8");
  const match = file.match(/^update profiles[\s\S]*?;\s*$/m);
  if (!match) throw new Error("0219 no longer contains an `update profiles …;` statement");
  return match[0];
}

const HOST = "http://127.0.0.1:54321";

const idFor = (i: number) => `0f000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** A uuid that is never a fixture row's id — the "somebody else's key" probe. */
const FOREIGN_ID = "0f000000-0000-4000-8000-ffffffffffff";

type Case = [label: string, seeded: string | null, expected: string | null];

/**
 * The fixture table, as a function of the row's own id.
 *
 * `expected === seeded` is the untouched-on-doubt assertion, and most of this
 * table is that case on purpose.
 */
function casesFor(id: string): Case[] {
  const key = `${id}/1757000000000.jpg`;
  return [
    // ---- REWRITTEN: the shapes the writer really produced -----------------
    ["the canonical malformed URL", `${HOST}/storage/v1/object/sign/avatars/${key}`, key],
    [
      "the same URL from a production host",
      `https://abcdefgh.supabase.co/storage/v1/object/sign/avatars/${id}/1700000000001.png`,
      `${id}/1700000000001.png`,
    ],
    [
      "a webp",
      `${HOST}/storage/v1/object/sign/avatars/${id}/1700000000002.webp`,
      `${id}/1700000000002.webp`,
    ],
    [
      // What Windows and older Android hand over. The pre-2e034bf92 writer put
      // the client filename's extension straight into the key, so these rows
      // exist and an `(jpg|png|webp)` alternation would have skipped them.
      "an UPPERCASE extension from the client filename",
      `${HOST}/storage/v1/object/sign/avatars/${id}/1700000000006.JPG`,
      `${id}/1700000000006.JPG`,
    ],
    [
      "a four-letter .jpeg, which rasterExtension never emits",
      `${HOST}/storage/v1/object/sign/avatars/${id}/1700000000007.jpeg`,
      `${id}/1700000000007.jpeg`,
    ],
    [
      // `"img".split(".").pop()` is `"img"` — a file with no dot at all still
      // produced `{ts}.img`, because the template literal added the dot.
      "a file uploaded with no extension at all",
      `${HOST}/storage/v1/object/sign/avatars/${id}/1700000000008.img`,
      `${id}/1700000000008.img`,
    ],
    [
      // NEXT_PUBLIC_SUPABASE_URL went into a template literal, so an unset env
      // var produced the literal text `undefined`. Same writer, missing
      // variable, fully determined path — not ambiguity.
      "the unset-env-var variant",
      `undefined/storage/v1/object/sign/avatars/${key}`,
      key,
    ],

    // ---- UNTOUCHED: anything we cannot parse with certainty ---------------
    ["a value that is already a bare path", key, key],
    [
      // THE CASE THE UUID ANCHOR EXISTS FOR. A well-formed value naming a
      // DIFFERENT person's key must not be rewritten onto it — otherwise
      // `avatarSignedUrl` would mint a lease on a stranger's object. An
      // unanchored generic-uuid pattern rewrites this row; the anchored one
      // cannot.
      "a well-formed key belonging to SOMEBODY ELSE",
      `${HOST}/storage/v1/object/sign/avatars/${FOREIGN_ID}/1700000000009.jpg`,
      `${HOST}/storage/v1/object/sign/avatars/${FOREIGN_ID}/1700000000009.jpg`,
    ],
    [
      // A signed URL WITH a token came from somewhere that is not our writer,
      // and we do not know what else it encodes. Stripping the prefix would
      // leave a key with a query string glued to it.
      "a real signed URL carrying a token",
      `${HOST}/storage/v1/object/sign/avatars/${key}?token=abc.def.ghi`,
      `${HOST}/storage/v1/object/sign/avatars/${key}?token=abc.def.ghi`,
    ],
    [
      "a URL naming a DIFFERENT bucket",
      `${HOST}/storage/v1/object/sign/pet-photos/${key}`,
      `${HOST}/storage/v1/object/sign/pet-photos/${key}`,
    ],
    [
      "a public-endpoint URL",
      `${HOST}/storage/v1/object/public/avatars/${key}`,
      `${HOST}/storage/v1/object/public/avatars/${key}`,
    ],
    [
      "a first segment that is not a uuid",
      `${HOST}/storage/v1/object/sign/avatars/not-a-uuid/1700000000003.jpg`,
      `${HOST}/storage/v1/object/sign/avatars/not-a-uuid/1700000000003.jpg`,
    ],
    [
      // {ts} is Date.now() — digits only.
      "a non-numeric leaf",
      `${HOST}/storage/v1/object/sign/avatars/${id}/foto.jpg`,
      `${HOST}/storage/v1/object/sign/avatars/${id}/foto.jpg`,
    ],
    [
      // The set-but-EMPTY env var (`NEXT_PUBLIC_SUPABASE_URL=""`) yields a
      // value starting at `/storage/...`. Indistinguishable from a
      // bucket-relative path that happens to start with a slash, so it is left
      // alone and the signer fails closed on it.
      "the set-but-empty env-var variant",
      `/storage/v1/object/sign/avatars/${key}`,
      `/storage/v1/object/sign/avatars/${key}`,
    ],
    [
      "trailing junk after the extension ($ is load-bearing)",
      `${HOST}/storage/v1/object/sign/avatars/${key}/extra`,
      `${HOST}/storage/v1/object/sign/avatars/${key}/extra`,
    ],
    [
      "a nested key one level deeper than the writer's",
      `${HOST}/storage/v1/object/sign/avatars/${id}/sub/1700000000005.jpg`,
      `${HOST}/storage/v1/object/sign/avatars/${id}/sub/1700000000005.jpg`,
    ],
    ["something that is not a URL at all", "¯\\_(ツ)_/¯", "¯\\_(ツ)_/¯"],
    ["a null", null, null],
  ];
}

/** Labels only — the shape is identical for every row, so index 0 describes it. */
const LABELS = casesFor(idFor(0)).map(([label]) => label);
const FIXTURE_IDS = LABELS.map((_, i) => idFor(i));

/** Row `i` carries case `i`, built against row `i`'s own id. */
const caseAt = (i: number): Case => casesFor(idFor(i))[i];

async function seed(): Promise<void> {
  await cleanup();
  await db.insert(profiles).values(
    LABELS.map((label, i) => ({
      id: idFor(i),
      displayName: `0219 fixture — ${label}`,
      // The drizzle field is `avatarStoragePath` and the column is still
      // `avatar_url` — see db/schema.ts for why only one of the two was renamed.
      avatarStoragePath: caseAt(i)[1],
    })),
  );
}

async function cleanup(): Promise<void> {
  await db.delete(profiles).where(inArray(profiles.id, FIXTURE_IDS));
}

async function readBack(): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ id: profiles.id, value: profiles.avatarStoragePath })
    .from(profiles)
    .where(inArray(profiles.id, FIXTURE_IDS));
  return new Map(rows.map((r) => [r.id, r.value]));
}

describe("migration 0219 — the avatar_url backfill", () => {
  let after: Map<string, string | null>;

  beforeAll(async () => {
    await seed();
    await db.execute(sql.raw(backfillStatement()));
    after = await readBack();
  });

  afterAll(async () => {
    await cleanup();
  });

  for (const [i, label] of LABELS.entries()) {
    const [, seeded, expected] = caseAt(i);
    const verb = seeded === expected ? "leaves untouched" : "rewrites to a path";
    it(`${verb}: ${label}`, () => {
      expect(after.get(idFor(i))).toBe(expected);
    });
  }

  it("rewrites something — a WHERE clause that matches nothing would pass every case above", () => {
    // The untouched-on-doubt assertions are all `expected === seeded`, so a
    // statement that silently matched zero rows would satisfy every one of
    // them. This is the non-vacuity check: at least one row really moved.
    const moved = LABELS.filter((_, i) => caseAt(i)[1] !== caseAt(i)[2]);
    expect(moved.length).toBeGreaterThan(0);
    for (const [i] of LABELS.entries()) {
      const [, seeded, expected] = caseAt(i);
      if (seeded !== expected) expect(after.get(idFor(i))).not.toBe(seeded);
    }
  });

  it("is idempotent — a second pass matches nothing", async () => {
    await db.execute(sql.raw(backfillStatement()));
    const twice = await readBack();
    for (const [i] of LABELS.entries()) {
      expect(twice.get(idFor(i))).toBe(caseAt(i)[2]);
    }
  });

  it("never produces a value carrying a scheme — the whole point of the column change", () => {
    for (const [i] of LABELS.entries()) {
      const value = after.get(idFor(i));
      // A leftover `://` means the row was DELIBERATELY left alone (we could not
      // parse it) — never that a rewrite half-happened. Assert that: a rewritten
      // row is scheme-free, and a left-alone row is byte-identical to its seed.
      if (value?.includes("://")) expect(value).toBe(caseAt(i)[1]);
    }
  });
});
