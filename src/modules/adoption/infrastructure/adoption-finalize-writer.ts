// The composite atomic write that finalizes an adoption.
//
// WHY IT IS NOT IN adoption-repository.ts ANY MORE
// ---------------------------------------------------------------------------
// It is the single largest method in the module (~190 lines) inside a file that
// sits at the 1500-line ratchet, and that ceiling is a real blocker: the
// rehome-by-titular slices need room in the repository and were being forced to
// scrape comments to get it. Splitting on the seam the file already uses —
// rehome-sponsorship-writer.ts is the precedent right next to this one — is the
// answer the ratchet is actually asking for.
//
// It stays under `src/modules/**/infrastructure/**` for the same reason that
// writer does: scripts/check-titular-gate.ts scans those globs, and an event
// writer parked outside them is invisible to the guard that exists to catch the
// writer nobody remembered to gate.
//
// Pure move. `AdoptionRepository.insertAdoptionFinalized` delegates here so
// every existing caller and every test double keeps the same entry point.

import { and, eq } from "drizzle-orm";

import { attachments, cases, type db, ownerships, petEvents, pets, reminders } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, findOpenAdoptionApplicationCase } from "@/lib/infra/case-helpers";
import { type EndedCaretakerGrant, endAllLiveOwnerships } from "@/lib/infra/end-pet-ownerships";

import { applicationCloseNote, closeApplicationCase } from "./application-case-close";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type InsertAdoptionFinalizedArgs = {
  petId: string;
  userId: string;
  orgId: string;
  orgVerified: boolean;
  custodyOwnershipId: string;
  /**
   * The adopter's REAL account id. Always a registered account: stub-profile
   * creation was removed from finalize-adoption (org-pilot-pack), so this
   * writer never invents a profile row — hence no displayName/phone/dni here.
   */
  adopterUserId: string;
  fosterRow: { id: string; ownerUserId: string | null } | null;
  fosterUserId: string | null;
  /** Pre-found custody case id, or null if not intaked. */
  custodyCaseId: string | null;
  contractAttachmentId: string | null;
  /** Supabase Storage path of the uploaded contract file (null when no file). */
  contractStoragePath: string | null;
  /** MIME type of the uploaded contract file (null when no file). */
  contractMimeType: string | null;
  /** Byte size of the stored (possibly re-encoded) contract file (null when no file). */
  contractFileSize: number | null;
  followupMonths: number | null;
  notes: string | null;
  /**
   * When finalizing from an approved online application, the id of that
   * `adoption_application_submitted` event. Null for offline / foster / DNI paths.
   */
  adoptedFromApplicationId?: string | null;
  /** Organization display name — used in reminder description copy. */
  orgDisplayName: string;
  /** Pet name — used in reminder description copy. */
  petName: string;
  now: Date;
};

/**
 * Composite atomic write for finalizing an adoption. Must be called inside a
 * db.transaction(). Handles:
 *   - close shelter_custody ownership
 *   - close foster ownership + foster_placement case (if active foster)
 *   - insert new owner row
 *   - insert adoption_finalized event
 *   - close custody_episode case (if open)
 *   - auto-reject pending applications cascade (done by caller after getting pendingApps)
 *   - optional contract attachment insert
 *   - optional reminder rows insert
 */
export async function insertAdoptionFinalized(
  args: InsertAdoptionFinalizedArgs,
  tx: Tx,
): Promise<{ eventId: string; endedCaretakerGrants: EndedCaretakerGrant[] }> {
  const {
    petId,
    userId,
    orgId,
    orgVerified,
    custodyOwnershipId,
    adopterUserId,
    fosterRow,
    fosterUserId,
    custodyCaseId,
    contractAttachmentId,
    contractStoragePath,
    contractMimeType,
    contractFileSize,
    followupMonths,
    notes,
    adoptedFromApplicationId,
    orgDisplayName,
    petName,
    now,
  } = args;

  // No stub-profile insert: the adopter ALWAYS pre-exists as a registered
  // account (finalize-adoption refuses otherwise), so this writer only ever
  // moves custody onto a profile someone can actually log into.

  // Every live ownership row, whatever its role — and caretakers through
  // their three-step end, which a blanket UPDATE here used to skip. See
  // lib/infra/end-pet-ownerships.ts for what the half-close left behind.
  // The same call ends a rehome sponsorship on the spine if this pet reached
  // the shelf through one (`adopted`) — a no-op otherwise: the trigger is the
  // spine, not the ownership shape.
  const { endedCaretakerGrants } = await endAllLiveOwnerships(
    {
      petId,
      outcome: "ownership_transferred",
      sponsorshipOutcome: "adopted",
      actorUserId: userId,
      now,
      // The author is the org coordinator running the finalize, not the
      // titular. Left at the default the ADOPTER's timeline would show
      // "Cuidado temporal finalizado — Dueno/a, no verificado" for an event a
      // refugio wrote (db/schema.ts: "the test is who the author IS").
      authorRole: "shelter",
      authorVerified: orgVerified,
      authorOrganizationId: orgId,
    },
    tx,
  );

  // Close the foster_placement case alongside the row just ended above.
  if (fosterRow) {
    const [fosterCase] = await tx
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, "foster_placement"),
          eq(cases.status, "open"),
        ),
      )
      .limit(1);
    if (fosterCase?.id) {
      await closeCase({ caseId: fosterCase.id, reason: "resolved", closedByUserId: userId }, tx);
    }
  }

  // Insert new owner row.
  await tx.insert(ownerships).values({
    petId,
    ownerUserId: adopterUserId,
    role: "owner",
    startedAt: now,
    transferredFromId: custodyOwnershipId,
  });

  // Take the pet OFF the adoption shelf. The listing is shelf-curated
  // metadata (see setListingStatus), and finalize never cleared it — so a pet
  // that had just been adopted still carried adoptionListedAt, and the new
  // owner opened her own credential to an "EN ADOPCIÓN" chip (adversarial
  // review 2026-08-08, S2-F04, reproduced end to end as S6-F01).
  //
  // The public /adoptar list looked correct only because its query ALSO
  // requires a live shelter ownership; the chip on /mis-mascotas reads
  // adoptionListedAt directly, so it kept telling the truth of a stale field.
  // The reversal path at the bottom of this file has always done this — only
  // the success path forgot.
  await tx
    .update(pets)
    .set({ adoptionListedAt: null, adoptionListingPausedAt: null, updatedAt: now })
    .where(eq(pets.id, petId));

  // Insert adoption_finalized event.
  const payload = validateEventPayload("adoption_finalized", {
    previous_owner_organization_id: orgId,
    adopter_user_id: adopterUserId,
    foster_user_id: fosterUserId,
    contract_attachment_id: contractAttachmentId,
    post_adoption_followup_months: followupMonths,
    notes,
    adopted_from_application_id: adoptedFromApplicationId ?? null,
  });

  const [adoptionEvent] = await tx
    .insert(petEvents)
    .values({
      petId,
      eventType: "adoption_finalized",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: userId,
      authorRole: "shelter",
      authorOrganizationId: orgId,
      authorVerified: orgVerified,
      payload,
      caseId: custodyCaseId ?? null,
    })
    .returning({ id: petEvents.id });

  // Close custody_episode case.
  if (custodyCaseId) {
    await closeCase({ caseId: custodyCaseId, reason: "resolved", closedByUserId: userId }, tx);
  }

  // Close the ADOPTER's own `adoption_application` case — the process it
  // tracked has just ended in the adoption. By (pet, adopter), not by
  // `adoptedFromApplicationId`: the DNI path finalizes without naming the
  // application, and the adopter's open case is the same row either way.
  // Approval deliberately left it open (application-case-close.ts); this is
  // the resolving close. The caller's auto-rejection cascade closes the
  // OTHER applicants' cases through resolveApplication, right after.
  const adopterCase = await findOpenAdoptionApplicationCase(petId, adopterUserId, tx);
  if (adopterCase) {
    await closeApplicationCase(
      {
        caseId: adopterCase.id,
        reason: "resolved",
        closedByUserId: userId,
        outcome: "finalized",
        note: applicationCloseNote({ outcome: "finalized" }),
        now,
      },
      tx,
    );
  }

  // Contract attachment row.
  // The storage upload happens pre-tx in the action; the action passes the
  // resulting storagePath, mimeType, and fileSize alongside contractAttachmentId.
  // Caller handles orphan cleanup on error (storage delete + throw).
  if (contractAttachmentId && contractStoragePath && contractMimeType) {
    await tx.insert(attachments).values({
      id: contractAttachmentId,
      petId,
      eventId: adoptionEvent.id,
      uploadedByUserId: userId,
      storagePath: contractStoragePath,
      mimeType: contractMimeType,
      fileSize: contractFileSize ?? null,
    });
  }

  // Post-adoption check-in reminders. They land in the adopter's own account,
  // which always exists (see adopterUserId's contract above).
  const CHECKIN_WINDOWS = [1, 3, 6, 12] as const;
  if (followupMonths !== null && followupMonths > 0) {
    const dueWindows = CHECKIN_WINDOWS.filter((m) => m <= followupMonths);
    if (dueWindows.length > 0) {
      await tx.insert(reminders).values(
        dueWindows.map((m) => {
          const dueDate = new Date(now);
          dueDate.setMonth(dueDate.getMonth() + m);
          return {
            petId,
            userId: adopterUserId,
            reminderType: "post_adoption_checkin" as const,
            dueAt: dueDate,
            title: `Seguimiento post-adopción a los ${m} ${m === 1 ? "mes" : "meses"}`,
            description: `${orgDisplayName} pidió un check-in sobre ${petName}. Subí fotos y contanos cómo está.`,
            sourceEventId: adoptionEvent.id,
          };
        }),
      );
    }
  }

  return { eventId: adoptionEvent.id, endedCaretakerGrants };
}
