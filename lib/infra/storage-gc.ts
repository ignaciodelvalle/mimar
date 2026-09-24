// Storage garbage collection — the first thing in this repo that deletes an
// object nobody can reach.
//
// WHAT THIS IS FOR, IN THE WORDS OF THE MIGRATION THAT ASKED FOR IT
// ---------------------------------------------------------------------------
// `db/migrations/0206_uploads_staging_bucket.sql` closes with the one hole it
// could not close itself:
//
//     "WHAT IS LEFT: an upload that was ticketed, PUT, and never confirmed by a
//      client that crashed or lost signal. Nothing deletes it. This repo has NO
//      storage garbage collection for ANY bucket — RN-4 A9 measured it: 'no
//      storage GC cron (24 crons, none touches storage)'."
//
// This file is that collector, and it collects EXACTLY ONE BUCKET. See
// "WHY ONLY uploads-staging" below — the rest are not an oversight.
//
// THE RULE, AND IT IS THE WHOLE FILE
// ---------------------------------------------------------------------------
// Delete only what can be PROVEN unreachable, and only after a window long
// enough that no live flow could still be holding it. A staged object is
// unreferenced BY DESIGN for the entire span between the ticket being minted
// and the confirm landing — that is what staging MEANS — so "no row points at
// it" is not on its own a reason to delete anything here. The age is.
//
// WHY ONLY uploads-staging
// ---------------------------------------------------------------------------
// A collector that guesses is worse than no collector, and for every other
// bucket reachability is either UNDECIDABLE from the database or decidable and
// still not this change's to decide. Measured by enumerating every writer and
// every reference column, 2026-09-10:
//
//   pet-photos, event-attachments — `attachments.storage_path` holds paths for
//     BOTH of these AND for `revocations` AND for decomiso evidence, in ONE
//     column with NO bucket discriminator. "Is this path referenced" therefore
//     cannot be asked per-bucket at all. Worse, four seed scripts write objects
//     into pet-photos, and `pets.primary_photo_id` is deliberately NOT a foreign
//     key ("circular reference with attachments.pet_id", db/schema.ts:484) — so
//     any query built over that column is one schema surprise away from
//     reporting the flagship pet's photo as garbage. Out of scope until the
//     column carries its bucket.
//   avatars — `defaultStorageUpload` writes `{userId}/{Date.now()}.{ext}` with
//     `upsert: true` under a CHANGING key, so every avatar change genuinely
//     orphans the previous object, and erasure nulls `profiles.avatar_url`
//     without ever deleting the object. Real garbage, and the bucket most worth
//     doing next. Not here, because the only reference was a full URL string in
//     `profiles.avatar_url` — and that URL was MALFORMED (`/object/sign/...`
//     with no token, RN-4 finding A3), so the column's contents could not be
//     trusted to say what an object's path even is. Fix the writer first.
//     UPDATE 2026-09-11: THE WRITER IS FIXED. `upload-avatar.ts` now stores the
//     bucket-relative path and migration 0219 backfilled the rows it could
//     parse with certainty, so the anti-join this paragraph said was impossible
//     is now writable. Two caveats before someone writes it: 0219 deliberately
//     LEFT UNPARSEABLE ROWS ALONE, so a handful of values are still full URLs
//     and an anti-join would call their objects unreferenced — those objects
//     are live avatars; and every avatar the subject ever REPLACED is already
//     an orphan by construction (a changing key under `upsert: true`), which is
//     the actual garbage worth collecting. The art. 16 erasure path no longer
//     depends on any of this: `purgeSubjectAvatars` sweeps the uid prefix.
//   decomiso-evidence (0234, 2026-09-18) — the first bucket whose rows DO say
//     where they live: its paths are prefixed `decomiso-evidence/`
//     (lib/infra/attachment-location.ts). Legal-hold shaped like the two below,
//     so reachability is not the question; out of scope for the same reason.
//   revocations, welfare-evidence — evidence hanging off an audit entry and off
//     a cruelty complaint. Both are legal-hold shaped and neither has a stated
//     retention policy, which is exactly why `data-lifecycle.ts` leaves the four
//     `retention_until` tables inert. Out of scope pending sign-off, not pending
//     a query.
//   welfare-exports — the path lives ONLY inside an append-only
//     `welfare_mpf_export_generated` audit payload, and the upload and that
//     insert are explicitly not one transaction, so an export whose audit row
//     failed has no payload at all. Reachability would be a JSONB string scan
//     that answers "unreferenced" for the exact objects a failure produced.
//   ppp-exports, travel-exports — WORSE, and the sweep is what showed it: their
//     audit payloads carry `petId`/`petPublicToken` and NO path field. Nothing
//     in the database records where those PDFs went. Every object in both
//     buckets is unreachable-from-the-database by construction, which makes an
//     age-plus-anti-join collector indistinguishable from `remove everything`.
//     Out of scope, emphatically.
//   analytics-exports, seed-photos, org-logos — a gov dashboard export bucket, a
//     demo bucket `scripts/seed-demo.ts` creates at runtime, and a bucket that
//     migration 0227 creates (bounded, no writer yet). None is production
//     credential data and none is referenced by a column with a writer.
//
// ALREADY-EXISTING PARTIAL COVERAGE, so this is not confused for the first
// deletion path: `erase-subject-data.ts` sweeps the whole `{petId}/` prefix of
// uploads-staging on an art. 16 erasure, "because a staged upload that was never
// confirmed has no row at all". That answers ONE person's request. This answers
// the ones nobody makes.
//
// uploads-staging is the one bucket where the answer is structural rather than
// queried: `mintPetPhotoTicket` is the only writer, `stagedKeyFor` is the only
// key shape, and nothing in `public` ever stores a staged path — which is what
// 0206 means by "pointed at by no row in `public`". So an old staged object is
// not "probably" unreferenced; it is unreferenced by construction.
//
// THE CONSUMERS DO NOT DELETE ON EVERY PATH, AND THIS FILE USED TO CLAIM THEY
// DID. That claim was load-bearing and it was false. Three paths deliberately
// KEEP the staged object:
//
//   · `confirmPetPhoto` (pet-photo-upload.ts:376-381) — `if (image.code !==
//     "photo_failed") await discardStaged()`. A read failure means we do not
//     know what is there, and deleting on "we could not read it" would turn a
//     transient Storage outage into data loss the client could have recovered
//     from by confirming again.
//   · `confirmPetPhoto` (pet-photo-upload.ts:402-415) — the normalised-oversize
//     refusal returns WITHOUT discarding, so the retry the person is invited to
//     make has something left to retry from.
//   · `claimStagedEventAttachment` (staged-event-attachment.ts:163-189) — every
//     non-404 error keeps the object. `isMissingObjectError` exists to draw
//     exactly that line, after a degraded storage-api once deleted an owner's
//     tattoo photo and told them it was not an image.
//
// Those survivors are still UNREFERENCED — no row points at them either — so
// the collector's behaviour is unaffected. What changes is what this file is
// honest about: THE MINIMUM AGE IS THE RETRY WINDOW THOSE PATHS ARE GRANTED.
// They keep the bytes so somebody can try again; this file decides how long
// "again" lasts. A header that denied the paths existed would have capped that
// window silently, and nobody reading it would have known.
//
// One of the three is different and worth naming: the normalised-oversize
// refusal is PERMANENT garbage. Re-encoding the same bytes produces the same
// oversized result forever — the function's own docblock says so, which is why
// it answers `photo_not_an_image` rather than a code promising a safe retry.
// The bytes are kept for a retry that cannot succeed. For that path the
// collector is not a cap on recovery, it is the only thing that ever cleans up.
//
// The `NOT EXISTS` guard below is therefore DEFENCE IN DEPTH rather than the
// proof — the proof is the paragraph above. It is here because "no writer
// persists this path" is a property of today's code, and the day somebody adds
// a resumable-upload table this file must fail safe rather than delete the row's
// object out from under it.
//
// BOUNDED THE SAME WAY THE SIBLINGS ARE
// ---------------------------------------------------------------------------
// One call = one bounded LIST and one bounded REMOVE, never more. The caller
// (`runDataLifecyclePurge`) drains under its fair share of the cron budget,
// exactly like the five SQL targets. `lib/infra/rate-limit.ts` states the
// reason for the cap on a DELETE — locks held past the function budget — and
// this target adds a second one: every batch here is an HTTP round trip to the
// Storage API, which is slower and less predictable than a DELETE, which is
// also why it runs LAST in the composite.

import { sql } from "drizzle-orm";

import { db } from "@/db";
import {
  STAGING_BUCKET,
  SUPABASE_SIGNED_UPLOAD_VALIDITY_SECONDS,
} from "@/lib/infra/pet-photo-upload";
import { createAdminClient } from "@/lib/supabase/admin";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How much older than the longest live upload flow a staged object must be
 * before this file will touch it. SEVENTY-TWO TIMES the signed-upload window,
 * which is six days.
 *
 * THE FLOW THAT SETS THE FLOOR IS `RecordEventScreen`, and it is not the one
 * this constant was first written for.
 *
 * The obvious flow is `requestPetPhotoTicket` → `uploadPetPhotoBytes` →
 * `confirmPetPhoto`, three calls in a row, and it is bounded twice over:
 * `SUPABASE_SIGNED_UPLOAD_VALIDITY_SECONDS` records that `@supabase/storage-js`
 * fixes a signed upload URL's validity at TWO HOURS with no expiry parameter to
 * change it, and `apps/mobile/src/api/endpoints.ts` states "DO NOT PERSIST THE
 * TICKET. Not to AsyncStorage, not to a log, not into a crash report" — it is a
 * bearer credential. So that sequence lives in one process lifetime and is over
 * in seconds. Twenty-four hours would have been ample for it.
 *
 * IT IS NOT THE ONLY FLOW. `apps/mobile/src/pets/RecordEventScreen.tsx:490-522`
 * uploads the tattoo photo AT PICK TIME, deliberately — "ELEGIR Y SUBIR SON UN
 * SOLO GESTO, y suben AHORA y no al enviar", so a failed upload is reported
 * while the person is still looking at the photo. The `stagedPath` then sits in
 * React component state until they finish the asiento and tap Enviar. That
 * DECOUPLES the PUT from the confirm, and nothing bounds the gap.
 *
 * The screen's own comment reasons from the two-hour window — "El objeto en
 * staging dura dos horas, mas de lo que tarda cualquiera en terminar este
 * formulario". True of the TICKET, and the ticket is already spent by then. The
 * step it leaves unstated is the one that matters here: A PROCESS LIFETIME IS
 * NOT BOUNDED BY A DAY. An RN app that is backgrounded and never killed keeps
 * that component state indefinitely. Somebody picks a photo, is interrupted,
 * comes back twenty-six hours later and taps Enviar — and at twenty-four hours
 * this collector would already have taken the object, the claim would 404, and
 * `claimStagedEventAttachment` would tell them their photo "is not an image"
 * when it was fine and we deleted it. On a legal identification record.
 *
 * SIX DAYS, therefore. Six days of abandoned 5 MiB objects in a private bucket
 * is a rounding error against telling one person their good photo was bad, and
 * the volume is bounded upstream anyway (see STORAGE_GC_MAX_BATCHES).
 *
 * Kept as a multiple of the SDK window rather than a literal `6 * 24 * 60 *
 * 60 * 1000` so it MOVES if that window ever does: if the SDK exposes an expiry
 * and that constant changes, this margin scales with it instead of silently
 * becoming a smaller multiple of a longer flow.
 */
export const ABANDONED_STAGED_UPLOAD_MIN_AGE_MS =
  72 * SUPABASE_SIGNED_UPLOAD_VALIDITY_SECONDS * 1000;

/**
 * Objects listed — and removed — per call.
 *
 * Smaller than the SQL targets' 500 because a batch here is an HTTP request to
 * the Storage API carrying every path in its body, not a DELETE the pooler
 * plans. The composite drains, so the batch size bounds one round trip rather
 * than one run.
 */
export const STORAGE_GC_BATCH_SIZE = 100;

/**
 * Hard cap on batches per run — 20 × 100 = 2,000 objects.
 *
 * The STATED worst case, following `RATE_LIMIT_CLEANUP_MAX_BATCHES`. The volume
 * this target can face is bounded upstream and the bound is known: the
 * `media-upload` rate-limit family caps one account at 120 requests a day, and
 * roughly half of those are confirms (0206's own arithmetic), so an account can
 * abandon at most ~60 objects a day. 2,000 a run is therefore about thirty-three
 * accounts abandoning EVERY upload they are allowed, every day — far above any
 * steady state, and small enough that twenty Storage round trips cannot eat a
 * budget shared with five other targets.
 */
export const STORAGE_GC_MAX_BATCHES = 20;

/** One abandoned staged object: the bucket-relative key, nothing else. */
type OrphanRow = { name: string };

// ---------------------------------------------------------------------------
// The candidate query
// ---------------------------------------------------------------------------

/**
 * The paths this run is allowed to delete, at most `limit` of them.
 *
 * THE CUTOFF IS COMPUTED BY POSTGRES, not by Node, and that is deliberate. Every
 * sibling in `data-lifecycle.ts` builds its cutoff with `Date.now()` and compares
 * it against a column the database wrote — which is fine at a 30- or 90-day TTL
 * and is exactly the mistake this repo has already paid for once, when
 * assertions compared a host clock against a `defaultNow()` column and a Docker
 * VM whose clock had drifted made a correct tree fail. `storage.objects.created_at`
 * is written by the storage service against the database's clock; the only
 * honest thing to compare it to is `now()` in the same database.
 *
 * `ORDER BY created_at` makes the drain CONVERGE and makes it FAIR: oldest
 * first, so a backlog is worked from the far end and a batch that is cut short
 * resumes where it stopped instead of re-listing the same page.
 *
 * The `NOT EXISTS` clauses are the defence-in-depth guard described in the file
 * header, not the reachability proof. They name every column in the schema that
 * stores a BUCKET-RELATIVE OBJECT PATH:
 *
 *   · `attachments.storage_path`               — pet photos, event attachments,
 *                                                 decomiso, revocation and
 *                                                 approval evidence
 *   · `welfare_report_attachments.storage_path` — cruelty-complaint evidence
 *
 * Neither can hold a staged key today — a staged key is only ever consumed and
 * deleted, never recorded — so both are expected to be no-ops, and a test proves
 * the guard bites anyway by planting a row that points at one. They are cheap:
 * each is one hash anti-join against a small table per batch, not one lookup per
 * candidate.
 *
 * TWO COLUMNS THAT LOOK LIKE THEY BELONG HERE AND DO NOT, measured rather than
 * assumed (reachability sweep, 2026-09-10):
 *
 *   · `organizations.logo_storage_path` has NO WRITER ANYWHERE. Its three
 *     readers all hand it to `orgLogoUrl()`, which builds a URL against a bucket
 *     called `org-logos` that only 0227 creates, empty. Joining a dead column
 *     against a different bucket's key space would be noise dressed as a guard.
 *   · `profiles.avatar_url` held a full URL rather than a path, so the join
 *     would have been an unindexable substring match — and it cannot collide
 *     anyway: an avatar key's leaf is `{Date.now()}.{ext}`, a staged key's is a
 *     UUID. The URL half is no longer true as of migration 0219 (the column
 *     holds a path now); the no-collision half still is, which is why this
 *     staged-upload query still does not need to join it.
 */
export async function listAbandonedStagedObjects(limit: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT o.name
      FROM storage.objects o
     WHERE o.bucket_id = ${STAGING_BUCKET}
       AND o.created_at < now() - make_interval(secs => ${ABANDONED_STAGED_UPLOAD_MIN_AGE_MS} / 1000.0)
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.storage_path = o.name)
       AND NOT EXISTS (
             SELECT 1 FROM welfare_report_attachments w WHERE w.storage_path = o.name
           )
     ORDER BY o.created_at
     LIMIT ${limit}
  `)) as OrphanRow[];
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// The purge step
// ---------------------------------------------------------------------------

/**
 * Deletes at most STORAGE_GC_BATCH_SIZE abandoned staged objects.
 * Returns how many the Storage API confirmed it removed.
 *
 * ONE BATCH, NOT ONE RUN — `runDataLifecyclePurge` drains this the same way it
 * drains the five SQL targets.
 *
 * THE COUNT IS WHAT STORAGE SAID, NOT WHAT WE ASKED FOR. `remove()` answers
 * `{ data, error }` with `data` listing the objects it actually took, and it
 * does not throw. Returning the request size instead would let a partial removal
 * read as a full batch, and `drainPurge` reads a full batch as "there is more" —
 * so an API that silently kept half the paths would drive the loop to its cap
 * every night on a backlog that never shrinks. Reporting the real number makes
 * that show up as the short batch it is.
 *
 * AN ERROR IS A THROW, NOT A ZERO — REVERSED ON 2026-09-10, AND THE REVERSAL IS
 * THE POINT. This function used to swallow both of its failure modes and return
 * 0, with a docblock arguing "a collector that cannot list is a collector that
 * collected nothing". That was a local patch for a general hole: at the time
 * `runDataLifecyclePurge` had NO per-target catch, so a throw here escaped the
 * whole composite and the run recorded ZERO for all six targets — over rows the
 * five preceding purges had really deleted.
 *
 * The hole is closed where it belongs. `drainPurge` now isolates every target,
 * keeps the batches that completed, flags the failed one as backlogged and hands
 * the message up as `failures: [{ target, reason }]`; the route turns that into a
 * failed run that NAMES this collector. So swallowing here is no longer a guard,
 * it is a second layer telling the opposite story: `drainPurge` reads a 0 as a
 * SHORT BATCH, i.e. "the bucket is drained, nothing left", and the run would
 * close green over a collector that never listed a single object. Two layers,
 * one of them lying.
 *
 * Both failure modes therefore throw, and they are different kinds of likely:
 *   · `listAbandonedStagedObjects` is a raw `db.execute` against the **`storage`
 *     schema**, a cross-schema read nothing else in this repo performs at
 *     runtime. A production role without SELECT on `storage.objects` throws here
 *     on the very first night, and must not read as "no orphans".
 *   · `remove()` does not throw — it answers `{ data, error }` — so its error
 *     branch is turned into one, on purpose: an object store that refused the
 *     batch is not an empty bucket either.
 *
 * WHAT THIS GUARD DOES NOT COVER, said plainly so nobody reads more into it.
 * The argument above — a 0 is read as a short batch, so the run closes green —
 * applies verbatim to EVERY `n < batchSize`, not only to zero. `remove()` can
 * answer `error === null` with a SHORTER `data` array when some keys did not
 * come off (a missing key, a race with a concurrent delete), and 60 confirmed
 * against a batch of 100 is a short batch: the drain stops, `backlogged` reads
 * false, and 40 objects stay. So this covers the TOTAL failure, not the PARTIAL
 * one. Pre-existing, unchanged here, and not a thing this function can fix
 * alone — telling a partial removal from a genuinely drained bucket needs the
 * caller to compare `requested` against `confirmed`, which is a change to the
 * drain contract every target shares.
 *
 * A FAILURE HERE NOW FAILS THE WHOLE NIGHTLY FAN-OUT, and that escalation is
 * worth meeting on paper rather than at 3am. The route marks the run failed and
 * answers 500; `app/api/cron/daily/route.ts` sets `failed: r.failed > 0`, so the
 * dispatcher returns 500 and fires its own critical alert too. Before this, a
 * Storage refusal was a `console.error` and nothing else. Correct — a collector
 * that cannot collect must be visible — but it is two pages, not one.
 */
export async function purgeAbandonedStagedUploads(): Promise<number> {
  const paths = await listAbandonedStagedObjects(STORAGE_GC_BATCH_SIZE);
  if (paths.length === 0) return 0;

  const { data, error } = await createAdminClient().storage.from(STAGING_BUCKET).remove(paths);
  if (error) {
    throw new Error(
      `[storage-gc] could not remove ${paths.length} abandoned staged object(s) from ${STAGING_BUCKET}: ${error.message}`,
    );
  }
  return data?.length ?? 0;
}
