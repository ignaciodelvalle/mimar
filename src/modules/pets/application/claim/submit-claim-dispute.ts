// Use-case: submitClaimDisputeForUser (variant B)
//
// Raises a custody_dispute against the active HOLDER of a chip/tattoo-matched
// pet — a person or an organisation; see the holder lookup below for why the
// distinction was a blocker and not a nicety. Uploads evidence BEFORE the tx so
// failures don't dangle, then opens a case + raising event + dispute row in one
// atomic transaction.
//
// AUTHORIZATION: the private identifier, never a caller-supplied pet token.
//
// This writer used to take `petToken` straight into `where(eq(pets.publicToken,
// …))` behind nothing but requireUserOrRedirect. That made it a national
// denial-of-rescue button: /perdidas lists every lost animal with a link to
// /p/{token} and no login, so a free account could scrape tokens and raise a
// dispute on each one. Every raise flips `pets.in_custody_dispute` (see
// openDisputeFromEvent), and app/(public)/p/[publicToken]/page.tsx reads that
// flag to null out ownerFirstName, ownerPhoneE164, ownerEmail, the finder form
// AND the sighting form — so mass-disputing lost pets strips the only channel
// by which a finder reaches the owner, on exactly the animals that need it.
// It also notified each owner that a stranger claims their pet, and appended a
// permanent custody_dispute_raised row to their append-only spine.
//
// The fix resolves the pet FROM the identifier and never consults a token, so
// a mismatch is not merely rejected — it is unrepresentable. That is verbatim
// what submitFreeClaimForUser (the sibling step of the SAME wizard) already
// did, calling the identifier "the evidence". The dispute step was an outlier,
// not a design. The wizard already carries kind+value forward for the free
// branch; this branch now uses the value it was already holding.
//
// The identifier is not proof of ownership — a vet or a shelter knows the chip
// too. It is proof the caller reached this flow legitimately, and the dispute
// is adjudicated by a human authority afterwards. What it buys is the end of
// bulk abuse against arbitrary animals: a 15-digit keyspace at 30 attempts a
// minute instead of a token list anyone can download.

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  attachments,
  auditLog,
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { isActiveOrgMember } from "@/lib/infra/case-access";
import { openCase } from "@/lib/infra/case-helpers";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { removeWelfareEvidence, uploadWelfareEvidence } from "@/lib/infra/welfare-uploads";
import { openDisputeFromEvent } from "@/src/modules/custody-disputes/application/open-dispute";

import type { ClaimDisputeInput, ClaimDisputeResult } from "./types";

const MICROCHIP_PATTERN = /^\d{15}$/;

/** Cap on the org members notified when the counter-party is an organization —
 * same number and same reason as `ownerProposeReturnToOrgUseCase`: a shelter's
 * membership list is unbounded and a dispute is one notification, not a mailing.
 */
const ORG_NOTIFICATION_CAP = 10;

/**
 * Rank an organisation's members so the ten that fit under the cap are CHOSEN.
 *
 * A cap without an order is a lottery: `.limit(10)` over a 40-member refugio
 * returns whichever ten Postgres reaches first, so the one person who can act
 * on a dispute — an admin, a coordinator — may be none of them, and the
 * notification then goes only to volunteers with no authority over the case.
 * Same defect the holder rank below exists for, one table over.
 */
const MEMBER_NOTIFICATION_RANK = sql`case ${organizationMemberships.role} when 'admin' then 0 when 'coordinator' then 1 else 2 end`;

/**
 * Rank the pet's ACTIVE custody rows so the counter-party is chosen, not drawn.
 *
 * `ownerships` can carry several live rows for one animal (a shelter's
 * `shelter_custody` alongside a volunteer's `foster`, a titular alongside a
 * `caretaker`), so a bare `.limit(1)` picks whichever row Postgres happens to
 * return — the exact defect `resolvePetHolderAccess` and `resolveReturnTargetOrg`
 * each had to fix once the row became load-bearing. Titularidad outranks
 * custody, and `startedAt desc` breaks a tie inside one role.
 *
 * It orders the WHOLE set rather than picking one row (`limit(1)` is gone, and
 * the reason is below at the party fan-out): the rank decides which holder is
 * the PRIMARY counter-party, not which holders exist.
 */
const HOLDER_ROLE_RANK = sql`case ${ownerships.role} when 'owner' then 0 when 'co_owner' then 1 when 'shelter_custody' then 2 when 'foster' then 3 when 'caretaker' then 4 else 5 end`;

export async function submitClaimDisputeForUser(
  userId: string,
  input: ClaimDisputeInput,
  files: File[],
): Promise<ClaimDisputeResult> {
  if (input.reason.trim().length < 20) {
    return { error: "Contanos por qué creés que es tuya (al menos 20 caracteres)." };
  }
  if (input.reason.length > 2000) {
    return { error: "La explicación no puede superar los 2000 caracteres." };
  }

  // Evidence gate — mirrors submitFreeClaimForUser. An empty value (or a
  // malformed microchip) can never resolve to a pet, so reject before spending
  // a rate-limit token or uploading anything.
  const identifierValue = input.identifierValue.trim();
  if (!identifierValue) {
    return { error: "Ingresá el número de microchip o el código del tatuaje." };
  }
  if (input.identifierKind === "microchip" && !MICROCHIP_PATTERN.test(identifierValue)) {
    return { error: "El microchip debe tener exactamente 15 dígitos." };
  }

  // Evidence gate (PO decision 2026-07-30). Raising a dispute is not a request
  // — it is a permanent, third-party-visible accusation: it notifies the
  // registered owner that a stranger claims their animal, appends an
  // uneditable custody_dispute_raised row to their spine (invariant #2), flips
  // pets.in_custody_dispute (which strips the owner's contact channel from the
  // public credential) and opens a case the local authority must adjudicate.
  // The friction has to be proportional to that, and 20 characters of prose
  // was not: `files: []` opened a dispute with zero proof.
  //
  // Same rule the other two evidence-backed accusation writers already
  // enforce: createOrgWelfareReportAction ("Un reporte profesional requiere al
  // menos un adjunto de evidencia") and validateMotivoAndAttachments
  // (EVIDENCE_REQUIRED) for revocations. Empty/zero-byte entries are filtered
  // first so a submitted-but-empty file input cannot satisfy the gate — that
  // is the same `f.size > 0` filter uploadWelfareEvidence applies downstream,
  // hoisted here so the count the gate checks is the count that gets stored.
  //
  // Server-side on purpose: the wizard also marks the input required, but the
  // action is an independently-addressable server action — the client check is
  // a courtesy, this is the rule.
  const evidenceFiles = files.filter((f) => f && f.size > 0);
  if (evidenceFiles.length === 0) {
    return {
      error:
        "Adjuntá al menos una foto o un video como prueba. Una disputa le avisa a la persona registrada como dueña y queda asentada de forma permanente, así que la autoridad necesita ver algo concreto para poder revisarla.",
    };
  }

  // Rate limit — same key as lookup so a burst of probes counts together.
  try {
    await enforceRateLimit("claim_lookup", userId, { maxPerMinute: 30, maxPerHour: 200 });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { error: "Demasiados intentos. Probá en unos minutos." };
    }
    throw err;
  }

  // Resolve the pet FROM the private identifier — this is the evidence, and it
  // is the whole authorization. No caller-supplied token is consulted anywhere
  // in this function, so there is no token/pet pair that could disagree.
  // The active-status partial unique index guarantees at most one match.
  //
  // ART. 16: `isNull(pets.deletedAt)` on the join is load-bearing, same clause
  // and same reason as `submit-free-claim.ts` and `lookup-for-claim.ts` —
  // `pet_identifications` rows stay `status = 'active'` after an erasure, and
  // `ownerships` rows survive it too (erase-subject-data soft-deletes only
  // `pets`). Without the clause an erased pet's chip answered "figura como
  // fallecida" / "no tiene dueño activo registrado" — both distinguishable
  // from "No encontramos la mascota." — and with a surviving active-owner row
  // the dispute PROCEEDED: case opened, `custody_dispute_raised` appended to
  // the erased spine, `in_custody_dispute` flipped, the erased subject
  // notified. Filtered out, `!pet` below answers exactly what an unregistered
  // chip answers. Found by the 2026-09-01 pre-push review of the free-claim
  // fix, which had named only `lookup-for-claim` as "the sibling".
  const identificationKind = input.identifierKind === "microchip" ? "microchip_iso" : "tattoo";
  const [pet] = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      status: pets.status,
      inCustodyDispute: pets.inCustodyDispute,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
    })
    .from(petIdentifications)
    .innerJoin(pets, and(eq(pets.id, petIdentifications.petId), isNull(pets.deletedAt)))
    .where(
      and(
        eq(petIdentifications.kind, identificationKind),
        eq(petIdentifications.code, identifierValue),
        eq(petIdentifications.status, "active"),
      ),
    )
    .limit(1);
  if (!pet) return { error: "No encontramos la mascota." };
  if (pet.status === "deceased") {
    return { error: "Esta mascota figura como fallecida en miMAR." };
  }
  if (pet.inCustodyDispute) {
    return { error: "Ya hay una disputa abierta para esta mascota." };
  }

  // THE ACTIVE HOLDER, WHATEVER ROLE HOLDS — not `role = 'owner'`.
  //
  // This clause used to read `eq(ownerships.role, "owner")`, which made an
  // animal held only by a refugio UNDISPUTABLE: an org-held row sets
  // `owner_organization_id` and leaves `owner_user_id` null under a
  // `shelter_custody` role, so the query found nothing and the writer answered
  // "Esta mascota no tiene dueño activo registrado." — on an animal that
  // demonstrably has a holder. Measured by the 2026-09-04 QA batch against
  // Toby DIM-3UVE-9QH8, held by Refugio Test: a full submit with evidence left
  // `in_custody_dispute` false and wrote no event.
  //
  // The step BEFORE this one already disagreed. `lookupForClaimForUser` calls
  // `hasAnyActiveCustody` — every role, no filter — so the wizard reached the
  // dispute step (and the mobile lookup says it in words: "ya está bajo la
  // custodia de otra persona u organización", claim-view-model.ts:138) for
  // exactly the population this writer then refused. Two implementations of
  // "who holds this animal" is how a screen ends up offering a control the
  // writer rejects; the return-to-owner module says the same thing in
  // `resolveReturnTargetOrg`'s docblock, having been bitten by it. The set is
  // now the SAME set the lookup uses.
  //
  // EVERY live row, not the top one. The self-dispute guard and the party
  // fan-out below each need the whole set for their own reason; the rank still
  // decides which of them is PRIMARY.
  const holders = await db
    .select({
      ownerUserId: ownerships.ownerUserId,
      ownerOrganizationId: ownerships.ownerOrganizationId,
      role: ownerships.role,
      // Only the token: the notification below addresses the org's own members,
      // who do not need to be told their organisation's name, but do need a
      // destination — and a destination is a public token, never a UUID.
      orgPublicToken: organizations.publicToken,
    })
    .from(ownerships)
    .leftJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
    .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt)))
    .orderBy(HOLDER_ROLE_RANK, desc(ownerships.startedAt));
  // Copy unchanged: this is still the answer for an animal nobody holds, and
  // `__tests__/pet-claim.test.ts` pins it as the ERASED-pet oracle it must not
  // become.
  if (holders.length === 0) return { error: "Esta mascota no tiene dueño activo registrado." };

  // NOBODY DISPUTES THEMSELVES — AND "THEMSELVES" INCLUDES THEIR REFUGIO.
  //
  // This guard used to read `holder.ownerUserId === userId` on the SINGLE
  // top-ranked row, which became two holes the moment the lookup above widened
  // to every role and every subject:
  //
  //   · AN ORG ROW CARRIES `owner_user_id` NULL, so the comparison was
  //     `null === userId` and an active member of the shelter that holds the
  //     animal passed straight through it. They could dispute their own
  //     shelter's pet: `in_custody_dispute` flips (blocking that same shelter's
  //     adoption pipeline), their organisation is filed as the counter-party,
  //     and the fan-out below tells their own colleagues that somebody claims
  //     the animal. An organisation acts through its members, so this is the
  //     same self-dispute wearing an institution's name.
  //   · A LOWER-RANKED USER ROW never reached the comparison at all. A foster
  //     or a caretaker on an animal whose top row belongs to somebody else (the
  //     titular, or the sponsoring refugio) is holding it and was allowed to
  //     dispute it.
  //
  // The guard now reads the whole set the lookup returned, which is the only
  // version that does not have to be re-derived the next time the rank changes.
  const ownRow = holders.find((h) => h.ownerUserId === userId);
  if (ownRow) {
    // Two sentences because there are two facts. "Registrada a tu nombre" is
    // titularidad and would be a lie told to a foster or a caretaker, who hold
    // the animal without owning it — and whose refusal is nonetheless the same
    // refusal: nobody disputes themselves.
    return {
      error:
        ownRow.role === "owner" || ownRow.role === "co_owner"
          ? "Esta mascota ya está registrada a tu nombre."
          : "Ya tenés la custodia activa de esta mascota.",
    };
  }
  // A THIRD sentence, because it states a third fact. Either sentence above
  // would claim a PERSONAL relationship this caller does not have — their name
  // is on no row here; their organisation's is.
  const heldByOrgIds = [
    ...new Set(holders.map((h) => h.ownerOrganizationId).filter((id): id is string => !!id)),
  ];
  for (const orgId of heldByOrgIds) {
    // `isActiveOrgMember` rather than a fourth hand-written membership read:
    // `left_at IS NULL` is what "member" means across every org-party branch of
    // canReadCase, and a private copy here is how the two definitions drift.
    if (await isActiveOrgMember(orgId, userId)) {
      return { error: "Tu organización ya tiene la custodia de esta mascota." };
    }
  }

  // THE COUNTER-PARTIES: the top-ranked USER row and the top-ranked ORG row,
  // and BOTH when both exist.
  //
  // The pair is not hypothetical — `db/schema.ts` names it: "a live owner row
  // and a live shelter_custody row CAN coexist — that pair is the
  // rehome-by-titular sponsorship, where the animal keeps living with its
  // titular while a verified org sponsors the adoption listing". Filing only
  // the rank-winner left the other one out of a proceeding that stops them
  // both: `in_custody_dispute` blocks the org's adoption pipeline exactly as it
  // blocks the titular's transfers, and an organisation that is not a party is
  // neither notified here nor reached when the authority rules (resolve-dispute
  // fans out over the party rows).
  //
  // `custody_dispute_parties` already allowed it. `dispute_party_exactly_one_subject`
  // constrains one subject PER ROW, not per dispute, and there is no
  // one-party-per-dispute index — the exclusivity was this writer's alone.
  const userHolder = holders.find((h) => h.ownerUserId);
  const orgHolder = holders.find((h) => h.ownerOrganizationId);
  // Filtered by identity against those two picks so the list keeps the RANK
  // order the query returned, instead of re-inventing an order of its own.
  const counterparties = holders.filter((h) => h === userHolder || h === orgHolder);

  // Evidence upload — happens BEFORE the tx so failures don't dangle.
  const reportId = crypto.randomUUID();
  const upload = await uploadWelfareEvidence(`claims/${reportId}`, evidenceFiles);
  if (upload.error) return { error: upload.error };

  let disputeToken = "";
  try {
    await db.transaction(async (tx) => {
      const payload = validateEventPayload("custody_dispute_raised", {
        raised_by_role: "owner",
        raised_by_user_id: userId,
        external_proceeding_reference: null,
        reason: input.reason.trim(),
      });

      // ARCH-E sequencing fix: create the case BEFORE inserting the raising
      // event so the event row can carry case_id in the same transaction.
      // pet_events.case_id is append-only (trigger-enforced) — a post-insert
      // UPDATE is blocked without the GUC escape hatch.
      // custodyDisputeId is backfilled by openDisputeFromEvent once the
      // dispute row exists (passed via preCreatedCaseId).
      const disputeCase = await openCase(
        {
          kind: "custody_dispute",
          primarySubjectKind: "registered_pet",
          primaryPetId: pet.id,
          jurisdictionProvince: pet.jurisdictionProvince ?? "",
          jurisdictionLocality: pet.jurisdictionLocality ?? "",
          openedByUserId: userId,
          openedByOrganizationId: null,
          // This writer only ever raises `owner`. The union carries the role
          // so the other three roles the custody_disputes CHECK allows read
          // correctly if a writer ever raises one.
          openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
        },
        tx,
      );

      const [raisingEvent] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_dispute_raised",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: userId,
          // NOT "owner" — see the twin fix in confirm-chip-match-vecino.ts
          // (4b09b445). This writer runs on a pet the actor demonstrably does
          // NOT own: the guard 100 lines up returns an error when the claimant
          // IS the registered owner, so reaching this insert proves they are
          // not. The timeline renders author_role verbatim as "Dueño/a", so
          // signing it "owner" showed the real owner an accusation against
          // themselves apparently written by themselves. The spine is
          // append-only (invariant #2): a false attribution here cannot be
          // edited later, only contradicted by a second event.
          //
          // The payload's `raised_by_role` below stays "owner" on purpose —
          // that is a different axis. Its domain is owner|org|govt|admin (DB
          // CHECK custody_disputes_raised_role_valid, migration 0025) and it
          // classifies WHO INITIATED — a private party asserting ownership, as
          // opposed to an org, a govt agent or an admin. There is no
          // "claimant" member; adding one is a CHECK migration plus the label
          // and legacy-parser tables, not a rename. authorRole answers "who
          // wrote this row", raised_by_role answers "under what capacity was
          // the dispute opened".
          authorRole: "finder",
          payload,
          caseId: disputeCase.id,
        })
        .returning({ id: petEvents.id });

      const { publicToken } = await openDisputeFromEvent(tx, {
        petId: pet.id,
        raisingEventId: raisingEvent.id,
        raisedByUserId: userId,
        raisedByOrgId: null,
        raisedByRole: "owner",
        jurisdictionProvince: pet.jurisdictionProvince ?? "",
        jurisdictionLocality: pet.jurisdictionLocality ?? "",
        initialParties: [
          // Each counter-party carries whichever subject actually holds the
          // animal. `custody_dispute_parties` was always polymorphic — the
          // CHECK `dispute_party_exactly_one_subject` (db/schema.ts) admits a
          // user OR an org, `party_organization_id` has had its FK and its
          // index since migration 0025, and `current_org_custody`
          // ("Organización en custodia", _party-roles.ts) is the role that
          // names this case. No schema change was needed to open the door;
          // only this writer was pinning `userId`.
          //
          // A USER holder that is not the titular (a neighbour holding a found
          // animal under `shelter_custody`, a foster) still lands as
          // `current_owner`. The union has no "current user custody" member and
          // adding one is a CHECK migration plus the label table plus the
          // add-party form — a decision, not a rename, the same call the
          // `raised_by_role` comment above records for its own axis.
          ...counterparties.map((h) =>
            h.ownerOrganizationId
              ? { orgId: h.ownerOrganizationId, role: "current_org_custody" as const }
              : { userId: h.ownerUserId, role: "current_owner" as const },
          ),
          { userId: userId, role: "claimant_owner", positionSummary: input.reason.trim() },
        ],
        preCreatedCaseId: disputeCase.id,
      });
      disputeToken = publicToken;

      if (upload.uploaded.length > 0) {
        await tx.insert(attachments).values(
          upload.uploaded.map((u) => ({
            petId: pet.id,
            eventId: raisingEvent.id,
            uploadedByUserId: userId,
            storagePath: u.storagePath,
            mimeType: u.mimeType,
            fileSize: u.fileSize,
            caption: "Evidencia del reclamo",
          })),
        );
      }

      // Notify the counter-parties — the SAME holders the party rows name.
      //
      // TWO INDEPENDENT LEGS, not one `if/else`. The branch mirrored the single
      // party row it was written against, so on a sponsorship pair (titular +
      // sponsoring refugio) it told exactly one of the two — and told the org
      // nothing on the very case where its adoption listing is what stops.
      //
      // The org leg is not a nicety. Raising a dispute flips
      // `pets.in_custody_dispute`, and that flag blocks the animal for
      // transfers and adoption ("la mascota queda bloqueada para transferencias
      // o adopción", app/gob/disputas/[disputeToken]/page.tsx). A refugio whose
      // adoption pipeline stops without a word would be an asymmetry this fix
      // introduced, not one it found: the writer already intends "tell the
      // holder", and until now the holder was always a user. Member fan-out and
      // cap mirror `ownerProposeReturnToOrgUseCase`.
      if (userHolder?.ownerUserId) {
        await tx.insert(notifications).values({
          userId: userHolder.ownerUserId,
          notificationType: "custody_dispute_raised_against_you",
          title: `Reclamo de propiedad sobre ${pet.name}`,
          body: "Otro usuario reclamó ser dueño/a de tu mascota. El gobierno local va a revisar la disputa. Te avisaremos cuando se resuelva.",
          severity: "warning",
          relatedPetId: pet.id,
          ctaLabel: "Ver mi mascota",
          // The RESOLVED token, not caller input — this notification goes to
          // the owner and must point at their own pet.
          ctaUrl: `/mis-mascotas/${pet.publicToken}`,
          category: "custody",
        });
      }
      if (orgHolder?.ownerOrganizationId) {
        const members = await tx
          .select({ userId: organizationMemberships.userId })
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.organizationId, orgHolder.ownerOrganizationId),
              isNull(organizationMemberships.leftAt),
            ),
          )
          // ORDERED, so the cap picks the members who can act on the dispute
          // rather than the ten Postgres reached first. `joined_at` breaks a
          // tie inside a rank so the same ten answer twice.
          .orderBy(MEMBER_NOTIFICATION_RANK, organizationMemberships.joinedAt)
          .limit(ORG_NOTIFICATION_CAP);
        const memberRows = members.filter((m) => !!m.userId);
        if (memberRows.length > 0) {
          await tx.insert(notifications).values(
            memberRows.map((m) => ({
              userId: m.userId,
              notificationType: "custody_dispute_raised_against_you",
              title: `Reclamo de propiedad sobre ${pet.name}`,
              body: "Una persona reclamó ser dueña de un animal bajo la custodia de tu organización. El gobierno local va a revisar la disputa. Mientras tanto, el animal queda bloqueado para transferencias y adopción.",
              severity: "warning" as const,
              relatedPetId: pet.id,
              ctaLabel: "Ver la ficha",
              // The org portal, not /mis-mascotas — an org member has no
              // owner-side page for this animal. `publicToken` on both
              // segments; never a UUID.
              ctaUrl: orgHolder.orgPublicToken
                ? `/org/${orgHolder.orgPublicToken}/mascotas/${pet.publicToken}`
                : "/org",
              category: "custody" as const,
            })),
          );
        }
      }

      // Confirmation to claimant.
      await tx.insert(notifications).values({
        userId: userId,
        notificationType: "custody_dispute_raised_by_you",
        title: "Reclamo enviado",
        body: `Iniciamos el reclamo por ${pet.name}. Una autoridad local va a revisar la evidencia y decidir.`,
        severity: "info",
        relatedPetId: pet.id,
        ctaLabel: "Volver a mis mascotas",
        ctaUrl: "/mis-mascotas",
        category: "custody",
      });

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "claim_dispute_submitted",
        payload: {
          dispute_public_token: publicToken,
          pet_id: pet.id,
          attachments_count: upload.uploaded.length,
        },
      });
    });
  } catch (err) {
    // Roll back uploaded files if the tx failed.
    await removeWelfareEvidence(upload.uploadedPaths);
    const message = err instanceof Error ? err.message : "Error desconocido.";
    return { error: `No se pudo enviar el reclamo: ${message}` };
  }

  return { disputeToken, petToken: pet.publicToken };
}
