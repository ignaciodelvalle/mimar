import type { SupabaseClient } from "@supabase/supabase-js";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { attachments, db, ownerships, petCaretakerGrants, petIdentifications, pets } from "@/db";
import { isDecomisoEvidencePath } from "@/lib/infra/attachment-location";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import {
  endCaretakerArrangementsForPet,
  endCaretakerGrantAtomically,
} from "@/lib/infra/end-pet-ownerships";
import { createNotification } from "@/lib/infra/notification-service";
import { type RateLimitConfig, RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { replaceMicrochipForUser } from "@/src/modules/pets/application/microchip/replace-microchip";

import type { EraseSubjectDataResult } from "./types";

// ---------------------------------------------------------------------------
// ERRATA — the retention rationale written into the migrations is FALSE
// ---------------------------------------------------------------------------
// Migrations are immutable, so the wrong premise cannot be corrected where it
// was written. It is corrected HERE, at the live code site, so nobody inherits
// it by reading the migration headers:
//
//   * 0059_subject_rights_rpcs.sql:102-104 — "sus eventos sanitarios (libreta)
//     se preservan para la conservación obligatoria por norma (Res. SENASA,
//     Ley 14.072 ejercicio profesional, etc)".
//   * 0159_erase_subject_data_free_text_payload_keys.sql:6-7 — "retains
//     sanitary events by design (SENASA/Ord. CABA 41.831/Ley 14.072 retention
//     — see app/(app)/cuenta/privacidad/page.tsx)".
//
// Both cite the privacy page, and the privacy page cited them back. The claim
// was verified against docs/legal-framework-full.md and does not hold:
//   1. Ord. CABA 41.831 imposes registration and reporting duties on the OWNER
//      (art. 23 inscription at four months; art. 25 report of transfer, baja or
//      death). It fixes no event-log retention period at all.
//   2. Ley 14.072/1951 regulates the professional practice of veterinary
//      medicine (matriculación); it is not a data-retention rule, and its reach
//      is national/CABA — not a duty binding this system for a user in Salta.
//   3. No SENASA resolution in docs/legal-framework-full.md establishes a
//      retention period for these records either.
//
// Consequence: retention here is a PRODUCT decision (the health history
// outlives a single owner), not a legal obligation — and it may NOT be used to
// refuse a supresión request under Ley 25.326 art. 16 inc. 5, which permits
// refusal only "cuando existiera una obligación legal de conservar los datos".
// The user-facing copy was corrected accordingly (2026-08-17).
//
// This errata records what we SAY. It deliberately changes nothing about what
// we DO: the retention period itself is still an open PO + legal decision —
// docs/architecture/retention-policy-pending-decision.md. Do not add purge
// logic here on the strength of this note.
// ---------------------------------------------------------------------------
// ERRATA #2 — 0208's claim that organization_memberships was already covered
// ---------------------------------------------------------------------------
// `db/migrations/0208_subject_rights_watermarks_tag_interest_org_invitations.sql:42`
// says `organization_memberships` is "already in both RPCs since 0059". It is
// not, and the migration is immutable, so the wrong premise is corrected here
// instead: `organization_memberships` has no match in 0059 and first appears
// on the EXPORT side only, in 0087. It has never been read by
// `erase_subject_data` — closing the erase side (`left_at = now()`,
// `title = NULL`, mirroring how 0207 closed pet_caretaker_grants.caretaker_email)
// is a still-open art. 16 item, not a fact 0208 could assume was covered.
// ---------------------------------------------------------------------------
// ERRATA #3 — "free-text keys" were redacted by NAME, and that destroyed facts
// ---------------------------------------------------------------------------
// 0159 → 0228 describe the pet_events redaction as sentinel-replacing "known
// free-text keys" (`reason`, `notes`, `description`, `context`,
// `closure_notes`, `clinical_notes`, …) across every event type of the
// subject's current pets. Two premises in those headers were false, and the
// migrations are immutable, so they are corrected here:
//   1. `reason` is NOT always free text. It is an ENUM on microchip_replaced,
//      foster_ended, custody_transferred and custody_transfer_proposed; the
//      sweep overwrote it with '[dato removido]' and the row stopped matching
//      its own schema. Those values are unrecoverable (no pre-image before
//      0235; 0235's images never copy `reason`).
//   2. A key name does not say who wrote it. The sweep erased a vet's
//      diagnosis, a rabies closure note and a disease report's clinical notes
//      because the OWNER asked to be forgotten.
// Migration 0240 (T3-A2b, PO decision 5A) replaced the sweep with a
// classification per (event type, key) in lib/events/payload-privacy.ts:
// personal data is erased, professional acts survive, compliance facts are
// never touched. The docblocks in lib/events/*-schemas.ts that chose `outcome`
// or `revoke_reason` "so the sweep would not destroy it" are historical notes
// now — the reason for the name is gone, the name stays.
// ---------------------------------------------------------------------------

/**
 * Page size for the `uploads-staging` sweep below.
 *
 * 1000 is the Storage API ceiling for one `list`; storage-js DEFAULTS TO 100
 * when you pass nothing, which is how the first version of that sweep came to
 * truncate silently. Named here rather than inlined so the number and the reason
 * travel together.
 */
const STAGING_SWEEP_PAGE_SIZE = 1000;

/**
 * How many pages the sweep will ask for before giving up on one pet.
 *
 * 20 × 1000 = 20.000 staged objects per pet, which is roughly 166 days of one
 * account minting at its full 120/day ceiling and never confirming. Past that,
 * something is wrong that deleting harder will not fix, and a supresión must
 * still finish.
 */
const STAGING_SWEEP_MAX_PAGES = 20;

// Storage objects the RPC cannot reach (SQL has no object-store access), in
// THREE buckets, and the third one is reached differently from the other two:
//
//   · pet-photos and event-attachments — found through `attachments` rows on
//     the subject's owned pets. Each row's bucket is inferred from its shape: a
//     row carrying an event_id is an event attachment (private bucket); one
//     with only a pet_id is a pet photo (public bucket), mirroring
//     lib/infra/storage.ts.
//   · uploads-staging — found by PREFIX, because a staged upload that was never
//     confirmed has no row at all. See the sweep below.
async function purgeOwnedPetAttachments(userId: string): Promise<void> {
  // Owned pets (active custody). ownerships rows survive the RPC (only pets are
  // soft-deleted), so this resolves correctly whether run before or after it.
  //
  // role = 'owner' is load-bearing: ownerships also holds foster / caretaker /
  // shelter_custody rows under the SAME owner_user_id (foster-repository.ts
  // inserts role:'foster'). Without this filter the irreversible Storage delete
  // would purge the photos + event attachments of pets the subject merely
  // fosters/caretakes — third-party data. A true owner erasing their account is
  // correct; a foster is not.
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    );
  const petIds = owned.map((o) => o.petId);
  if (petIds.length === 0) return;

  const admin = createAdminClient();

  // STAGED UPLOADS FIRST, and they are the one thing here that is NOT reachable
  // from a row.
  //
  // The pet-photo door (0206) mints a signed upload URL into the private
  // `uploads-staging` bucket and only writes an `attachments` row once the
  // bytes have been validated. An upload that was ticketed and PUT but never
  // confirmed therefore has NO row pointing at it — it is a photo of the
  // subject's animal, in our object store, invisible to the `attachments` scan
  // below. Erasure has to reach it by PREFIX, which is exactly why the staged
  // key is `{petId}/…` rather than a flat UUID.
  //
  // Best-effort, like the removes further down: a supresión must not stall on a
  // Storage hiccup. And it is the ONLY thing that removes an abandoned staged
  // object — there is no storage GC cron in this repo for any bucket (RN-4 A9),
  // so for a subject exercising art. 16 this loop is not a belt-and-braces
  // sweep, it is the sweep.
  // PAGINATED, AND THE PAGE SIZE IS WHY. `list()` defaults to 100 entries in
  // storage-js and takes no "give me all of them" option, so the first version of
  // this loop removed an arbitrary 100 objects per pet and left the rest FOREVER
  // — nothing else deletes them. That is reachable, not theoretical: the
  // media-upload family admits 120 tickets a day for one account, so a single pet
  // can hold more than 100 abandoned staged objects inside one day. A sweep that
  // calls itself "the sweep" and silently stops at 100 is worse than one that
  // admits it is partial.
  //
  // WHAT BOUNDS THE LOOP: STAGING_SWEEP_MAX_PAGES, and it is a real stop rather
  // than a formality. A page that comes back full means there may be more, so we
  // ask again; a short page means we are done. The cap exists so a Storage bug
  // that keeps returning full pages cannot spin a supresión forever — and when
  // it is hit we say so in the log, because a truncated sweep the subject is
  // never told about is the exact defect this paragraph replaces.
  for (const petId of petIds) {
    try {
      let removed = 0;
      let page = 0;
      for (; page < STAGING_SWEEP_MAX_PAGES; page += 1) {
        const listed = await admin.storage
          .from("uploads-staging")
          .list(petId, { limit: STAGING_SWEEP_PAGE_SIZE, offset: 0 });
        const paths = (listed.data ?? []).map((entry) => `${petId}/${entry.name}`);
        if (paths.length === 0) break;
        await admin.storage.from("uploads-staging").remove(paths);
        removed += paths.length;
        // OFFSET STAYS AT ZERO on purpose: the previous page was just deleted,
        // so the next unremoved object is again at the start. Advancing the
        // offset would step PAST the objects that slid down into the gap and
        // leave every other page behind.
        if (paths.length < STAGING_SWEEP_PAGE_SIZE) break;
      }
      if (page === STAGING_SWEEP_MAX_PAGES) {
        console.warn("[erase-subject-data] staged-upload sweep hit its page cap", {
          petId,
          removed,
          cap: STAGING_SWEEP_MAX_PAGES * STAGING_SWEEP_PAGE_SIZE,
        });
      }
    } catch (err) {
      console.warn("[erase-subject-data] staged-upload sweep failed", {
        petId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Event attachments carry pet_id too (schema.ts), so `pet_id IN (owned)`
  // captures both pet photos and event attachments on the subject's pets.
  const petRows = await db
    .select({
      id: attachments.id,
      storagePath: attachments.storagePath,
      eventId: attachments.eventId,
    })
    .from(attachments)
    .where(inArray(attachments.petId, petIds));
  // DECOMISO EVIDENCE IS LEFT ALONE — row and object. It is the authority's
  // record of a seizure, not the titular's upload (a subject can hold the pet
  // again after a return to owner, which is how it reaches this set), and it
  // is legal-hold shaped like welfare-evidence. No retention decision is
  // documented for it either, so scripts/check-subject-rights-coverage.ts
  // declares the `decomiso-evidence` bucket a KNOWN GAP instead of claiming
  // retention; the legacy `decomiso/` objects in event-attachments ride the
  // same rule. Deleting only the row would orphan the object in a bucket
  // nothing here names.
  const rows = petRows.filter((r) => !isDecomisoEvidencePath(r.storagePath));
  if (rows.length === 0) return;

  const eventPaths = rows.filter((r) => r.eventId !== null).map((r) => r.storagePath);
  const photoPaths = rows.filter((r) => r.eventId === null).map((r) => r.storagePath);

  if (eventPaths.length > 0) {
    await admin.storage.from("event-attachments").remove(eventPaths);
  }
  if (photoPaths.length > 0) {
    await admin.storage.from("pet-photos").remove(photoPaths);
  }

  // Drop the DB rows too — storage_path + caption are the subject's data.
  await db.delete(attachments).where(
    inArray(
      attachments.id,
      rows.map((r) => r.id),
    ),
  );
}

/**
 * DELETE THE SUBJECT'S OWN AVATAR OBJECTS — the face of the person exercising
 * art. 16, which until now survived their erasure forever.
 *
 * The RPC nulls `profiles.avatar_url` and the object stays in the private
 * `avatars` bucket. There is no storage GC for that bucket (lib/infra/storage-gc.ts
 * names it "the bucket most worth doing next" and declines, because the column
 * used to hold a fabricated tokenless URL rather than a path), so nothing else
 * has ever removed one.
 *
 * BY PREFIX, NOT BY COLUMN, and the reasons are cumulative:
 *   1. `avatarObjectKey` is `{userId}/{Date.now()}.{ext}` — a CHANGING key
 *      under `upsert: true`, so every avatar the subject ever replaced is still
 *      there as its own object. The column names at most the last one; the
 *      prefix names all of them.
 *   2. The column is nulled by the RPC, which runs BEFORE this step. A
 *      column-driven delete would have to be re-ordered ahead of Step 1; a
 *      prefix does not care when it runs.
 *   3. Migration 0219 deliberately leaves an unparseable legacy value UNTOUCHED
 *      rather than guessing at it. Those rows name no path at all — the prefix
 *      still reaches their objects.
 *
 * The prefix is the subject's own uid, so this cannot reach another person's
 * avatar. It CAN reach an object somebody else planted under that prefix — 0171
 * grants any authenticated caller an INSERT at any key in this bucket (see
 * 0218's header) — and deleting that is right, not collateral: it is an object
 * sitting in the erased subject's namespace.
 *
 * PAGINATED for the reason the staged sweep is: `list()` answers 100 by default
 * and takes no "all of them" option, so an unpaginated version silently keeps
 * everything past the hundredth. Same two constants, same stop rule, and
 * BEST-EFFORT with the same shape as the removes around it — a supresión must
 * not stall on a Storage hiccup, and `remove()`'s returned error is not checked
 * here any more than it is for `pet-photos` or `event-attachments`.
 */
async function purgeSubjectAvatars(userId: string): Promise<void> {
  const admin = createAdminClient();
  try {
    let removed = 0;
    let page = 0;
    for (; page < STAGING_SWEEP_MAX_PAGES; page += 1) {
      const listed = await admin.storage
        .from("avatars")
        .list(userId, { limit: STAGING_SWEEP_PAGE_SIZE, offset: 0 });
      const paths = (listed.data ?? []).map((entry) => `${userId}/${entry.name}`);
      if (paths.length === 0) break;
      await admin.storage.from("avatars").remove(paths);
      removed += paths.length;
      // Offset stays at zero: the page just removed is gone, so the next
      // unremoved object is again at the start. See the staged sweep.
      if (paths.length < STAGING_SWEEP_PAGE_SIZE) break;
    }
    if (page === STAGING_SWEEP_MAX_PAGES) {
      console.warn("[erase-subject-data] avatar sweep hit its page cap", {
        userId,
        removed,
        cap: STAGING_SWEEP_MAX_PAGES * STAGING_SWEEP_PAGE_SIZE,
      });
    }
  } catch (err) {
    console.warn("[erase-subject-data] avatar sweep failed", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * END EVERY LIVE CARETAKER ARRANGEMENT THE SUBJECT IS PART OF — and why this is
 * here rather than inside `erase_subject_data`.
 *
 * Migration 0205 brought `pet_caretaker_grants` into both RPCs, but it scrubs
 * PII and flips PENDING invitations only. It deliberately does not flip an
 * ACCEPTED grant, because ending one is THREE writes that must land together —
 * close the `ownerships` row, emit `caretaker_ended`, flip the grant — and
 * there is exactly ONE definition of them, `endCaretakerGrantAtomically` in
 * lib/infra/end-pet-ownerships.ts. (Named without parentheses on purpose: the
 * lock fence in src/modules/rehome/__tests__/owner-row-lock.test.ts finds the
 * first `name(` in the file and requires the pet advisory lock above it, and it
 * cannot tell a call from a sentence about one.)
 * A status flip in SQL with no event would leave a grant the spine cannot
 * explain: `detect-pet-cache-drift` reports `pet_caretaker_ownership_drift`,
 * `rederive-pet-ownerships` reports the ownership row's `ended_at` as
 * unmatched, and `lib/projections/pet-caretaker.ts` leaves the interval open
 * forever. Invariant #3 is not negotiable for a compliance path either.
 *
 * The split follows the domain's own line, stated in lib/infra/end-pet-ownerships.ts:
 * "ACCEPTED → ended, through the atomic three-step. The arrangement happened,
 * so the spine owes an ending fact. PENDING → cancelled, a plain status flip
 * with no event." The RPC does the pending side; this does the accepted side.
 *
 * WHY IT RUNS FIRST. The RPC soft-deletes the subject's pets and cancels the
 * pending invitations on them. Leaving a live grant behind either way is the
 * zombie `caretakers-repository.ts` documents — an ownership row that still
 * grants write access on an animal, and a caretaker contact that
 * `caretaker-public-contact.ts` may still publish on a public credential,
 * because it decides that from the GRANT alone and never joins `ownerships`.
 *
 * BEST-EFFORT, like the Storage purge. A failure here is logged and does not
 * abort the erasure: the subject's right does not depend on our bookkeeping.
 */
async function endCaretakerArrangementsForErasure(userId: string): Promise<void> {
  const now = new Date();

  // A — the subject IS the caretaker of somebody else's animal. `withdraw` is
  // the domain's own name for this case: grant-state.ts defines it as "the
  // caretaker stepped down, or their account was deactivated/erased".
  const asCaretaker = await db
    .select({
      grantId: petCaretakerGrants.id,
      ownershipId: petCaretakerGrants.ownershipId,
      petId: petCaretakerGrants.petId,
      endsAt: petCaretakerGrants.endsAt,
      grantedByUserId: petCaretakerGrants.grantedByUserId,
      petName: pets.name,
      petPublicToken: pets.publicToken,
    })
    .from(petCaretakerGrants)
    .innerJoin(pets, eq(pets.id, petCaretakerGrants.petId))
    .where(
      and(
        eq(petCaretakerGrants.caretakerUserId, userId),
        eq(petCaretakerGrants.status, "accepted"),
      ),
    );

  for (const grant of asCaretaker) {
    // `ownership_id` is NOT NULL on an accepted row by the biconditional accept
    // CHECK (0192), but the column is nullable, so the type is honest and so is
    // this guard.
    const { ownershipId } = grant;
    if (ownershipId === null) continue;
    try {
      await db.transaction(async (tx) => {
        // THE PET LOCK COMES FIRST — every pet-scoped custody writer in this repo
        // takes this one key before any row lock, because two transactions taking
        // the same `ownerships` rows in opposite orders is a 40P01 deadlock and
        // Postgres resolves it by killing one side. A finalize or a withdraw
        // racing this erasure is exactly that cycle. Pinned by
        // src/modules/rehome/__tests__/owner-row-lock.test.ts, whose derived arm
        // discovered this writer the day it was written.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${grant.petId}))`);
        await endCaretakerGrantAtomically(
          {
            grantId: grant.grantId,
            ownershipId,
            petId: grant.petId,
            outcome: "withdrawn_by_caretaker",
            endsAt: grant.endsAt,
            now,
            actorUserId: userId,
          },
          tx,
        );
      });
    } catch (err) {
      // PER GRANT, not per run. `endCaretakerGrantAtomically` THROWS when its
      // `UPDATE … WHERE status='accepted'` matches zero rows — the narrow race
      // where a concurrent revoke or the expiry cron resolved this grant between
      // the read above and the write. One outer catch around the whole function
      // would let that single throw abandon every REMAINING arrangement, and the
      // RPC would then run over a subject who still holds live accepted grants:
      // exactly the state the migration header says has no path in the app.
      // Skip the one grant, keep going, and say which one.
      console.error("[erase-subject-data] could not end caretaker grant", {
        userId,
        grantId: grant.grantId,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // The TITULAR has to be told: their animal may still be physically with the
    // person whose access just closed. The copy does NOT say why — that an
    // account was erased is the counterparty's own exercise of a legal right,
    // not news this product owes a third party.
    await createNotification({
      userId: grant.grantedByUserId,
      notificationType: "caretaker_grant_ended",
      severity: "warning",
      category: "custody",
      title: `El cuidado temporal de ${grant.petName} terminó`,
      body: `Volvés a tener el acceso completo a ${grant.petName}. Si el animal sigue con la persona que lo cuidaba, coordiná la devolución con ella.`,
      ctaLabel: "Ver mis mascotas",
      ctaUrl: grant.petPublicToken ? `/mis-mascotas/${grant.petPublicToken}` : "/mis-mascotas",
      relatedPetId: grant.petId,
      dedupeKey: `caretaker:grant_ended:${grant.grantId}:${grant.grantedByUserId}`,
    });
  }

  // B — the subject is the TITULAR. Every live arrangement on every animal they
  // own ends with them: `endCaretakerArrangementsForPet` does BOTH halves (the
  // atomic three-step for accepted, a plain flip for pending), so the pending
  // ones the RPC would also cancel are simply already cancelled by the time it
  // runs and it counts zero. Two paths cancelling the same row is idempotent;
  // neither path cancelling it is the invitation an erased owner's pet accepts
  // months later.
  const ownedPets = await db
    .select({ petId: ownerships.petId, name: pets.name, publicToken: pets.publicToken })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    );

  for (const pet of ownedPets) {
    let endedCaretakerGrants: Awaited<
      ReturnType<typeof endCaretakerArrangementsForPet>
    >["endedCaretakerGrants"];
    try {
      // PER PET, for the same reason as the per-grant catch above: one animal
      // whose arrangement lost a race must not cost the subject the closure of
      // all the others.
      ({ endedCaretakerGrants } = await db.transaction(async (tx) => {
        // Same key, same reason, same position: first statement of the transaction.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pet.petId}))`);
        return endCaretakerArrangementsForPet(
          { petId: pet.petId, outcome: "revoked_by_owner", actorUserId: userId, now },
          tx,
        );
      }));
    } catch (err) {
      console.error("[erase-subject-data] could not end arrangements for pet", {
        userId,
        petId: pet.petId,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // MUST be after the transaction commits (ARCH-P): a notification failure may
    // not roll back an erasure step. createNotification dead-letters rather than
    // throwing, so this cannot fail the caller.
    for (const ended of endedCaretakerGrants) {
      if (ended.caretakerUserId === null) continue;
      await createNotification({
        userId: ended.caretakerUserId,
        notificationType: "caretaker_grant_ended",
        severity: "warning",
        category: "custody",
        title: `Tu período de cuidado de ${pet.name} terminó`,
        // Same wording as the ownership-change notice in
        // lib/infra/end-pet-ownerships.ts (T4-D3), minus the cause: that the
        // titular erased their account is their own exercise of a legal right,
        // not news for a third party (see the titular-side notice above). The
        // old copy asked the caretaker to coordinate with "quien lo tiene a
        // cargo ahora" — a holder they cannot see and may not reach.
        body: `Terminó el cuidado de ${pet.name} y ya no podés cargarle eventos. Si el animal sigue con vos, avisale a quien te lo dejó a cargo por el medio que ya usaban. Si no lo podés contactar, escribinos.`,
        ctaLabel: "Escribinos",
        ctaUrl: "/sugerencias",
        relatedPetId: pet.petId,
        dedupeKey: `caretaker:grant_ended:${ended.grantId}:${ended.caretakerUserId}`,
      });
    }
  }
}

/**
 * RELEASE THE MICROCHIP OF EVERY PET THIS ERASURE SUPPRESSED — so a finder can
 * re-register the animal.
 *
 * PO-4 retires the erased pet's public credential and its physical chapa "even
 * for reunification" (tag-lookup.ts). A microchip is the SAME class of durable
 * reunification identifier, and today it stays `status='active'` forever,
 * occupying the partial unique index `pet_identifications_chip_unique` (on
 * `code WHERE kind='microchip_iso' AND status='active'` — it does NOT reference
 * deleted_at, so only a status change frees it). That leaves the animal
 * un-re-registerable by whoever now physically holds it. This releases it.
 *
 * EVENT-BACKED, NOT A BARE STATUS FLIP. `pet_identifications` is CANONICAL (the
 * pets.* chip columns derive FROM it — rederive-pet-cache.ts), and
 * `detect-pet-cache-drift` replays events for ALL pets (no deleted_at filter)
 * and compares to the stored row. Erasure RETAINS the `microchip_implanted`
 * event (append-only spine, invariant #2), so a flip with no retraction event
 * would leave the replay seeing an active chip forever → false-positive drift on
 * every erased pet. The revoke use-case emits a `microchip_replaced` with
 * `new_chip_number=null`, which lib/projections/pet-microchip.ts folds to "active
 * row → 'replaced', no successor" — so stored and derived agree and drift stays
 * clean. `replaceMicrochipForUser` also flips the canonical row itself, in the
 * same transaction as the event.
 *
 * SCOPE — EXACTLY the pets this erasure suppressed: the subject's live `owner`
 * rows (role='owner', ended_at IS NULL — the same scope the RPC soft-deletes)
 * whose pet is now soft-deleted (deleted_at IS NOT NULL). A pet the subject
 * merely fosters, a pet transferred away BEFORE the erasure (its owner row is
 * ended), and any pet whose row is not soft-deleted are all excluded — the chip
 * of a non-erased animal is never touched. The revoke's own owner gate is the
 * second lock: it re-verifies the subject holds a live ownership on the pet.
 *
 * IDEMPOTENT + PARTIAL-FAILURE-SAFE, like the steps around it. The revoke flips
 * the active row to 'replaced', so a re-run of the erasure finds no active chip
 * and does nothing; a pet with no active chip is simply absent from the scan;
 * and one pet's failure is logged and does not abort the rest.
 *
 * WHY IT RUNS BEFORE the auth.users deletion (Step 2): the revoke writes a
 * pet_events row (recorded_by_user_id) and an audit_log row (actor_user_id, ON
 * DELETE RESTRICT) attributed to the subject's uid, so that row must still
 * exist when this runs. The soft-deleted profile row is enough — only Step 2
 * deletes the auth row, and this precedes it.
 */
export async function releaseMicrochipsForErasedPets(userId: string): Promise<void> {
  // Owned + now soft-deleted pets. Same owner scope as purgeOwnedPetAttachments
  // and the RPC's own soft-delete, intersected with deleted_at IS NOT NULL so a
  // non-erased pet can never enter the set. Deduped: a pet with more than one
  // matching ownership row must yield one release, not one per row.
  const erasedOwnedPets = await db
    .selectDistinct({ petId: ownerships.petId })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
        isNotNull(pets.deletedAt),
      ),
    );
  const petIds = erasedOwnedPets.map((p) => p.petId);
  if (petIds.length === 0) return;

  const activeChips = await db
    .select({ petId: petIdentifications.petId, code: petIdentifications.code })
    .from(petIdentifications)
    .where(
      and(
        inArray(petIdentifications.petId, petIds),
        eq(petIdentifications.kind, "microchip_iso"),
        eq(petIdentifications.status, "active"),
      ),
    );

  // One release per pet (the model is one active chip per pet; guard anyway so a
  // stray second active row cannot emit a spurious second revocation event).
  const chipByPet = new Map<string, string>();
  for (const chip of activeChips) {
    if (chip.code && !chipByPet.has(chip.petId)) chipByPet.set(chip.petId, chip.code);
  }

  const now = new Date();
  for (const [petId, code] of chipByPet) {
    try {
      // Reuse the microchip revocation use-case: it emits the microchip_replaced
      // event AND flips the canonical row, atomically. new_chip_number=null with
      // reason 'owner_request' is the pure-revocation shape it already supports.
      const result = await replaceMicrochipForUser(userId, {
        petId,
        previousChipNumber: code,
        newChipNumber: null,
        reason: "owner_request",
        replacedAt: now.toISOString(),
        actorContext: { kind: "owner" },
      });
      if ("error" in result) {
        // PER PET, not per run: one pet whose release fails (a lost race, a
        // vanished ownership) must not cost the subject the release of the rest.
        console.error("[erase-subject-data] microchip release failed", {
          userId,
          petId,
          message: result.error,
        });
      }
    } catch (err) {
      console.error("[erase-subject-data] microchip release threw", {
        userId,
        petId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * ONE bucket for both transports, keyed on the subject.
 *
 * Not `api_v1_…`, for the reason `REVOKE_SESSIONS_USER_BUCKET` gives: a name
 * that says `api_v1` on a call from a web form reads like a different budget,
 * and the whole point is that it is not one.
 */
export const SUBJECT_DATA_ERASURE_USER_BUCKET = "subject_data_erasure_user";

/**
 * Deliberately not tight, for the reason `REVOKE_SESSIONS_USER_LIMIT` is not:
 * the control is bounded by construction, since a successful call destroys the
 * `auth.users` row that the next one would need.
 *
 * What it really bounds is the RETRY LOOP. Every step after the RPC is
 * best-effort — the microchip release, the auth deletion, the Storage purge all
 * log and continue — so a subject whose erasure half-finished may reasonably
 * press the button again, and each attempt re-runs a caretaker sweep and a
 * Storage listing over their pets. Five in a minute covers a person retrying;
 * anything above it is a loop nobody is watching.
 *
 * A DAILY FIGURE for a different reason than the export's: not exfiltration,
 * but the fact that the second erasure of an already-erased subject does real
 * work (the sweeps run again) and buys nothing.
 */
export const SUBJECT_DATA_ERASURE_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 5,
  maxPerHour: 20,
  maxPerDay: 40,
};

/** The two es-AR sentences both surfaces show, so neither invents its own. */
const REASON_REQUIRED_COPY = "Indicá brevemente el motivo (mínimo 5 caracteres).";
const RATE_LIMITED_COPY =
  "Pediste la baja varias veces seguidas. Esperá unos minutos y volvé a intentar.";

export type EraseSubjectDataInput = {
  /** The subject, resolved by the surface's own guard. Never read from a token. */
  userId: string;
  /**
   * A client already authenticated AS the subject — cookie or bearer. The RPC is
   * SECURITY DEFINER and authorizes on `auth.uid()`, so this client IS the
   * authorization; a service-role one would silently bypass it and erase whoever
   * the caller named.
   */
  supabase: SupabaseClient;
  /** The subject's own words. Minimum five characters, recorded by the RPC. */
  reason: string;
};

/**
 * Run the supresión for an already-resolved subject — every step, in the one
 * order that works.
 *
 * WHAT IS IN HERE AND WHAT IS NOT (WU-R, 2026-08-29)
 * ---------------------------------------------------------------------------
 * Everything that touches the subject's DATA is in here, so the native door and
 * the web button run the SAME six steps rather than two implementations of them.
 * That is the whole reason this function was carved out of the action: an
 * erasure has an ordering constraint at every joint — the caretaker sweep must
 * precede the RPC, the microchip release and the Storage purge must precede the
 * `auth.users` deletion because they write rows attributed to that uid — and a
 * second copy of it written against a bearer token would have got one of them
 * wrong within a month.
 *
 * What is NOT in here is the SESSION TEARDOWN, and its absence is deliberate.
 * The two surfaces end a session differently and neither can do the other's:
 * the web calls `supabase.auth.signOut()` on a cookie client and revalidates,
 * while a bearer client's `signOut` is the documented no-op that
 * `revoke-sessions.ts` measured (auth-js reads the session from STORAGE, and a
 * `persistSession: false` client never stored one — it would report success and
 * revoke nothing). The native client drops its own keychain entry instead. So
 * the caller ends the session; this function ends the account.
 */
export async function eraseSubjectDataFor(
  input: EraseSubjectDataInput,
): Promise<EraseSubjectDataResult> {
  const { userId, supabase } = input;
  const reason = input.reason?.trim() ?? "";

  // VALIDATED BEFORE THE LIMITER IS SPENT, which is the opposite of the usual
  // order on this project and is right here. Elsewhere the limiter comes first
  // so a malformed hammer costs nothing downstream; there is no hammer to bound
  // here, because the only account this call can erase is the caller's own. What
  // there IS, is somebody typing "no" into a mandatory reason field three times
  // — and a budget spent on their typos is a budget missing when they finally
  // write a sentence, on the one action they cannot come back to later.
  if (reason.length < 5) {
    return { ok: false, reason: "reason_required", error: REASON_REQUIRED_COPY };
  }

  try {
    await enforceRateLimit(
      SUBJECT_DATA_ERASURE_USER_BUCKET,
      userId,
      SUBJECT_DATA_ERASURE_USER_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { ok: false, reason: "rate_limited", error: RATE_LIMITED_COPY };
    }
    // FAILS OPEN, and this is the opposite direction from the export's limiter
    // one file over — so it is worth saying why they differ rather than letting
    // a reader assume one of them is a mistake. The export's strict direction
    // protects against EXFILTRATION: a limiter outage there would mean an
    // unbounded PII dump. Nothing leaves here. Refusing on a
    // `rate_limit_buckets` hiccup would instead deny somebody the exercise of a
    // legal right over an abuse control, which is the trade `revoke-sessions.ts`
    // also refuses to make.
    reportError("subject-rights/erasure-limiter", err);
  }

  // Step 0 — end every live caretaker arrangement through the spine's one
  // writer, BEFORE the RPC soft-deletes the pets and cancels the pending
  // invitations on them. See the function's own header for why this cannot live
  // inside erase_subject_data.
  //
  // This catch is the LAST RESORT, not the granularity. Each grant and each pet
  // has its own try/catch inside, so one lost race closes one arrangement short
  // rather than abandoning the rest; what reaches here is a failure of the two
  // reads that drive the loops, which leaves nothing half-done.
  try {
    await endCaretakerArrangementsForErasure(userId);
  } catch (err) {
    console.error("[erase-subject-data] caretaker arrangement close failed", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 1 — redact the application-side subject data. The RPC soft-deletes the
  // profile, hashes/nulls every PII column, scrubs filed reports/transfers, and
  // (Wave D2, migration 0129) redacts third-party PII in owned-pet event
  // payloads. Must run BEFORE the auth row is deleted: the RPC authorizes on
  // auth.uid() and the trigger override it emits is attributed to that uid.
  const { error } = await supabase.rpc("erase_subject_data", {
    p_user_id: userId,
    p_reason: reason,
  });

  if (error) {
    return { ok: false, reason: "failed", error: error.message };
  }

  // Step 1.5 — release the microchip of every pet this erasure just suppressed,
  // so a finder can re-register the animal (PO-4 parity for the durable
  // reunification identifier — see the function header). Event-backed, so drift
  // replay and the stored canonical row stay in agreement. Runs BEFORE the
  // auth.users deletion below because the revocation event + audit row are
  // attributed to the subject's uid. Best-effort like the steps around it: a
  // failure here must not leave the subject staring at an error after their
  // profile PII is already gone.
  try {
    await releaseMicrochipsForErasedPets(userId);
  } catch (err) {
    console.error("[erase-subject-data] microchip release step failed", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 2 — delete the auth.users row (Ley 25.326 art. 16). Without this the
  // email + password hash survive forever and the subject can simply log back in
  // to an account whose PII is already gone. Uses the service-role admin client
  // (the anon/cookie client cannot delete auth users). A failure here must NOT
  // block completion: the app-side data is already erased, so we log and still
  // report success — a residual auth row is a follow-up cleanup, not a reason to
  // leave the subject staring at an error after their data is gone.
  try {
    const admin = createAdminClient();
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError) {
      console.error("[erase-subject-data] auth.users deletion failed", {
        userId,
        message: deleteError.message,
      });
    }
  } catch (err) {
    console.error("[erase-subject-data] auth.users deletion threw", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3 — purge Storage objects the RPC cannot reach (pet photos + event
  // attachments on the subject's owned pets, Ley 25.326 art. 16 — audit 27-#5).
  //
  // WHICH BUCKETS THIS FILE DOES NOT TOUCH, and why that is written down rather
  // than forgotten: every bucket is classified in the bucket inventory of
  // scripts/check-subject-rights-coverage.ts, which reads this file's storage
  // calls and fails when the two disagree. `revocations` and `welfare-evidence`
  // are declared there as GAPS — evidence-shaped, but no retention decision is
  // documented, so they are not claimed as retention either (A07-3).
  // Best-effort like the auth deletion: a Storage hiccup must not leave the
  // subject staring at an error after their DB data is already gone.
  try {
    await purgeOwnedPetAttachments(userId);
  } catch (err) {
    console.error("[erase-subject-data] attachment/storage purge failed", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3b — the subject's OWN avatar objects, in the private `avatars`
  // bucket. Separate from the step above because that one is pet-scoped and
  // early-returns for a subject who owns no pets, while an avatar belongs to
  // the person: a subject with no animals at all still had their face left
  // behind. See `purgeSubjectAvatars` for why it goes by prefix.
  try {
    await purgeSubjectAvatars(userId);
  } catch (err) {
    console.error("[erase-subject-data] avatar purge failed", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { ok: true };
}

/**
 * The COOKIE door onto the supresión — the web privacy page's button.
 *
 * Everything below the guard is the shared use-case. What is left here is what
 * only a browser session has: signing the cookie session out, and revalidating
 * the router cache so the next render is unauthenticated. The native door does
 * neither — see `eraseSubjectDataFor`'s header for why a bearer client's
 * `signOut()` would report success and revoke nothing.
 */
export async function eraseMySubjectDataAction(reason: string): Promise<EraseSubjectDataResult> {
  const { user } = await requireUserOrRedirect();
  const supabase = await createClient();

  const result = await eraseSubjectDataFor({ userId: user.id, supabase, reason });
  if (!result.ok) return result;

  // Drop the session — the profile row is now soft-deleted + PII hashed and the
  // auth row is gone. ONLY on success: a refused erasure (a short reason, a
  // spent budget) must leave the person signed in and looking at the form they
  // can still fix, not bounced to a login screen having lost nothing but their
  // session.
  await supabase.auth.signOut();
  revalidatePath("/");
  return result;
}
