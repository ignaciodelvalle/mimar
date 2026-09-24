// Use-case: executeDecomiso — opens the custody_episode case + emits the
// custody_transfer_proposed handshake event toward the receiver refugio.
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md §5.1
//
// Auth (requireDecomisoPrincipal + jurisdiction guard) is handled by the caller.
// This use-case receives a pre-authorized actor context and pre-uploaded attachments.
//
// Transaction steps:
//   1. Unowned path: CREATE pet record + pet_registered event.
//   2. openCase(custody_episode).
//   3. INSERT shelter_intake_recorded.
//   4. Ownership transitions: close prev ownerships (registered path), open govt custody.
//   5. INSERT custody_transfer_proposed.
//   6. INSERT attachment rows (files already uploaded before calling this).
//   7. Cross-ref note on originating welfare case (DC12).
//   8. Build notifications (returned post-tx).
//   9. Audit log: decomiso_executed.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  attachments,
  auditLog,
  cases,
  type db,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { findOpenCaseForPetAndKind, openCase as libOpenCase } from "@/lib/infra/case-helpers";
import { type EndedCaretakerGrant, endAllLiveOwnerships } from "@/lib/infra/end-pet-ownerships";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { generateUniqueToken, isUniqueViolation } from "@/lib/infra/unique-token";

import {
  motiveLabel,
  splitOwnershipAddressees,
  straySyntheticName,
  validateAttachments,
  validateReceiverOrg,
  validateSeizureMotive,
  validateUnownedAnimal,
} from "../domain/seizure-rules";
import type { ExecuteDecomisoInput, GovtOrg, NewNotification, ReceiverOrg } from "../domain/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UploadedAttachment = {
  filename: string;
  storagePath: string;
  mimeType: string;
  size: number;
};

export type ExecuteDecomisoContext = {
  /** Pre-authorized actor. */
  user: { id: string };
  /** Pre-resolved govt (sanitary_authority) org. */
  govtOrg: GovtOrg & { jurisdictionProvince: string };
  /** Pre-validated receiver org. */
  receiverOrg: ReceiverOrg & { id: string; displayName: string };
  /** Non-null for registered_pet path. */
  existingPet: { id: string; name: string; publicToken: string } | null;
  /** Non-null for unowned_animal path. */
  unownedData: ExecuteDecomisoInput["unownedAnimal"] | null;
  /** Attachments already uploaded to Storage before the transaction. */
  uploadedAttachments: UploadedAttachment[];
};

export type ExecuteDecomisoResult =
  | { ok: true; value: { publicCode: string }; notifications: NewNotification[] }
  | { ok: false; error: string };

/** Minimal structural view of the caller's authenticated principal. */
export type DecomisoPrincipal = {
  profile: { role: "admin" | "govt" };
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>;
};

type ValidateExecuteOk = {
  ok: true;
  /** Pre-validated receiver org (guaranteed shelter/rescue_network, active, verified). */
  receiverOrg: ReceiverOrg & { id: string };
  /** Non-null for the registered_pet path. */
  existingPet: typeof pets.$inferSelect | null;
};

type ValidateExecuteErr = { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pre-tx validation (runs before attachment upload and the transaction)
// ---------------------------------------------------------------------------
// Moved verbatim from app/actions/decomiso.ts (strangler follow-up): seizure
// motive, receiver org, attachments, and the subject-kind branch (jurisdiction
// scope + double-seizure guard). Auth and govt-org resolution stay in the
// actions controller.

export async function validateExecuteDecomiso(
  input: ExecuteDecomisoInput,
  ctx: { session: DecomisoPrincipal; govtOrg: GovtOrg },
  dbInstance: typeof db,
): Promise<ValidateExecuteOk | ValidateExecuteErr> {
  const { session, govtOrg } = ctx;

  // ---- Validate seizure motive -------------------------------------------
  const motiveErr = validateSeizureMotive(input.seizureMotive, input.seizureMotiveOtherDetail);
  if (motiveErr) return { ok: false, error: motiveErr };

  // ---- Validate receiver org ---------------------------------------------
  if (!input.intendedReceiverOrganizationId?.trim()) {
    return { ok: false, error: "Seleccioná un refugio destinatario." };
  }

  const [receiverOrg] = await dbInstance
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      verified: organizations.verified,
      status: organizations.status,
      orgType: organizations.orgType,
    })
    .from(organizations)
    .where(eq(organizations.id, input.intendedReceiverOrganizationId))
    .limit(1);

  const receiverErr = validateReceiverOrg(receiverOrg, govtOrg.id);
  if (receiverErr) return { ok: false, error: receiverErr };
  // receiverOrg is guaranteed non-null here (validateReceiverOrg returns an error if null).
  const validatedReceiverOrg = receiverOrg as NonNullable<typeof receiverOrg>;

  // ---- Validate attachments (DC5) ----------------------------------------
  const attachErr = validateAttachments(input.attachmentFiles);
  if (attachErr) return { ok: false, error: attachErr };

  // ---- Subject-kind branch -----------------------------------------------
  let existingPet: typeof pets.$inferSelect | null = null;

  if (input.subjectKind === "registered_pet") {
    if (!input.petPublicToken?.trim()) {
      return { ok: false, error: "Ingresá el token de la mascota registrada." };
    }

    const [pet] = await dbInstance
      .select()
      .from(pets)
      .where(eq(pets.publicToken, input.petPublicToken))
      .limit(1);
    if (!pet) {
      return { ok: false, error: "Mascota no encontrada. Verificá el token público." };
    }

    // Jurisdiction scope check (spec §9; review 24 HIGH #4). Require the pet's
    // FULL (province, locality) pair to match an assignment before seizing —
    // province-only / null-province let a govt seize an animal (and revoke its
    // owner's custody) outside their jurisdiction. Fail-closed on any mismatch.
    if (session.profile.role === "govt") {
      // Subsumption-aware: a whole-province assignment (e.g. whole-CABA) governs
      // every barrio in it. Never widens security — barrio assignments stay exact.
      const inScope = jurisdictionScopeContains(
        session.jurisdictions,
        pet.jurisdictionProvince,
        pet.jurisdictionLocality,
      );
      if (!inScope) {
        return { ok: false, error: "Esta mascota no está en tu jurisdicción asignada." };
      }
    }

    // Double-seizure guard (Fix 5).
    const existingEpisode = await findOpenCaseForPetAndKind(pet.id, "custody_episode");
    if (existingEpisode) {
      return { ok: false, error: "Esta mascota ya tiene un decomiso/custodia activa en curso." };
    }

    existingPet = pet;
  } else {
    // Unowned path jurisdiction check (C1; review 24 HIGH #5). Require the govt
    // org's FULL (province, locality) pair to match an assignment — a
    // province-only check let a govt seize an unowned animal outside their
    // assigned locality. Fail-closed on any mismatch (incl. null org locality).
    if (session.profile.role === "govt") {
      // Subsumption-aware (whole-province assignment governs every barrio in it).
      const inScope = jurisdictionScopeContains(
        session.jurisdictions,
        govtOrg.jurisdictionProvince,
        govtOrg.jurisdictionLocality,
      );
      if (!inScope) {
        return {
          ok: false,
          error: "Tu organización sanitaria no está en tu jurisdicción asignada.",
        };
      }
    }
  }

  return { ok: true, receiverOrg: validatedReceiverOrg, existingPet };
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

type TxType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function executeDecomiso(
  input: ExecuteDecomisoInput,
  ctx: ExecuteDecomisoContext,
  tx: TxType,
): Promise<
  | {
      ok: true;
      publicCode: string;
      pendingNotifications: NewNotification[];
      endedCaretakerGrants: EndedCaretakerGrant[];
      seizedPet: { id: string; name: string; publicToken: string };
    }
  | { ok: false; error: string }
> {
  const { user, govtOrg, receiverOrg, uploadedAttachments } = ctx;

  const now = new Date();
  const pendingNotifications: NewNotification[] = [];
  // Filled inside the transaction, flushed by the caller AFTER it commits
  // (ARCH-P). A caretaker whose arrangement this seizure ended lost write
  // access and the animal left their hands; nothing else tells them.
  const endedGrants: EndedCaretakerGrant[] = [];

  // ---------- Unowned path: CREATE the pet record in-flight ----------
  let activePet: { id: string; name: string; publicToken: string };

  if (ctx.unownedData) {
    const { unownedData } = ctx;

    // Validate (defensive — caller should have already validated, but spec requires server-side).
    const unownedErr = validateUnownedAnimal(unownedData);
    if (unownedErr) return { ok: false, error: unownedErr };

    const publicToken = await generateUniqueToken(pets, pets.publicToken, generatePublicToken, {
      executor: tx,
    });

    // Compute approximate date of birth from approxAgeMonths.
    let dateOfBirth: string | null = null;
    let birthDateIsEstimated = false;
    if (unownedData.approxAgeMonths != null && unownedData.approxAgeMonths >= 0) {
      const dob = new Date();
      dob.setMonth(dob.getMonth() - unownedData.approxAgeMonths);
      dateOfBirth = dob.toISOString().slice(0, 10);
      birthDateIsEstimated = true;
    }

    const petName = straySyntheticName(unownedData);

    let newPet: { id: string; publicToken: string; name: string };
    try {
      const [inserted] = await tx
        .insert(pets)
        .values({
          publicToken,
          name: petName,
          species: unownedData.species,
          sex: unownedData.sex,
          breed: unownedData.breed ?? null,
          color: unownedData.color ?? null,
          distinguishingFeatures: unownedData.distinguishingFeatures ?? null,
          dateOfBirth,
          birthDateIsEstimated,
          jurisdictionProvince: govtOrg.jurisdictionProvince,
          jurisdictionLocality: govtOrg.jurisdictionLocality,
          potentiallyDangerousBreed: false,
        })
        .returning();
      newPet = inserted;
    } catch (insertErr) {
      if (isUniqueViolation(insertErr)) {
        throw new Error("Token de mascota duplicado — reintentá el decomiso.");
      }
      throw insertErr;
    }

    // Emit pet_registered event (append-only protocol).
    const registeredPayload = validateEventPayload("pet_registered", {
      name: petName,
      species: unownedData.species,
      sex: unownedData.sex,
      breed: unownedData.breed ?? null,
      date_of_birth: dateOfBirth,
      birth_date_is_estimated: birthDateIsEstimated,
      color: unownedData.color ?? null,
      microchip_id: null,
      microchip_country_code: null,
      microchip_implanted_at: null,
      microchip_implanted_by: null,
      microchip_location: null,
      estimated_weight_kg: null,
      favourite_foods: [],
      known_allergies: [],
      training_level: null,
      insurance_company: null,
      insurance_policy_number: null,
      jurisdiction_province: govtOrg.jurisdictionProvince,
      jurisdiction_locality: govtOrg.jurisdictionLocality,
      potentially_dangerous_breed: false,
      acquisition_method: null,
      has_photo: false,
      has_microchip: false,
      custody_kind: "shelter_custody_by_org",
    });
    await tx.insert(petEvents).values({
      petId: newPet.id,
      eventType: "pet_registered",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: user.id,
      authorRole: "govt",
      authorOrganizationId: govtOrg.id,
      authorVerified: true,
      payload: registeredPayload,
    });

    activePet = { id: newPet.id, name: petName, publicToken };
  } else {
    // Registered pet path — existingPet is non-null (validated by caller).
    activePet = ctx.existingPet as { id: string; name: string; publicToken: string };
  }

  // THE PET ADVISORY LOCK (L-9) — the known gap `src/modules/rehome/README.md`
  // named. A seizure ends every live ownership on the animal through
  // `endAllLiveOwnerships` below, taking row locks a titular's withdraw and an
  // org's finalize take in the OPPOSITE order while holding this same key: the
  // cycle Postgres breaks with 40P01. This use-case is the first call inside
  // its `db.transaction`, and on the registered-pet path nothing above ran, so
  // this is the transaction's first statement — before any row lock.
  //
  // On the unowned path the pet was created three statements up and no other
  // transaction can name a pet that did not exist when it started, so locking
  // here rather than at the top costs nothing and lets both paths share a line.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${activePet.id}))`);

  // ---------- openCase(custody_episode) ----------
  const caseRow = await libOpenCase(
    {
      kind: "custody_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: activePet.id,
      jurisdictionCountry: "AR",
      jurisdictionProvince: govtOrg.jurisdictionProvince,
      jurisdictionLocality: govtOrg.jurisdictionLocality,
      openedByUserId: user.id,
      openedByOrganizationId: govtOrg.id,
      receiverOrganizationId: receiverOrg.id,
      openedReason: {
        code: "decomiso_executed",
        motive: input.seizureMotive,
        judicialRef: input.judicialProceedingReference ?? null,
      },
    },
    tx,
  );
  const publicCode = caseRow.publicCode;

  // ---------- INSERT shelter_intake_recorded ----------
  const intakePayload = validateEventPayload("shelter_intake_recorded", {
    intake_reason: "seizure" as const,
    intake_condition: input.intakeCondition ?? null,
    rescue_jurisdiction: govtOrg.jurisdictionProvince,
    seizure_motive: input.seizureMotive,
    seizure_motive_other_detail: input.seizureMotiveOtherDetail ?? null,
    judicial_proceeding_reference: input.judicialProceedingReference ?? null,
    originating_welfare_report_id: input.originatingWelfareReportId ?? null,
    intended_receiver_organization_id: receiverOrg.id,
  });
  const [intakeEvent] = await tx
    .insert(petEvents)
    .values({
      petId: activePet.id,
      eventType: "shelter_intake_recorded",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: user.id,
      authorRole: "govt",
      authorOrganizationId: govtOrg.id,
      authorVerified: true,
      payload: intakePayload,
      caseId: caseRow.id,
    })
    .returning();

  // ---------- Ownership transitions ----------
  const prevOwnerUserIds: string[] = [];
  const prevOwnerOrganizationIds: string[] = [];

  if (!ctx.unownedData) {
    // Registered pet path only.
    const prevOwnerOwnerships = await tx
      .select({
        ownerUserId: ownerships.ownerUserId,
        ownerOrganizationId: ownerships.ownerOrganizationId,
      })
      .from(ownerships)
      .where(and(eq(ownerships.petId, activePet.id), isNull(ownerships.endedAt)));

    // An ownership row carries EITHER a user or an organization. Collecting only
    // the user half meant an animal held by a refugio, a rescue network or a
    // clinic was seized with ZERO notification to anybody — the UPDATE below
    // terminates that ownership all the same. Nothing in the flow noticed,
    // because "no addressee" and "notified" look identical from the action's
    // return value. The split is a pure domain function so that property is
    // testable without a database (see splitOwnershipAddressees).
    const addressees = splitOwnershipAddressees(prevOwnerOwnerships);
    prevOwnerUserIds.push(...addressees.userIds);
    prevOwnerOrganizationIds.push(...addressees.organizationIds);

    // Caretakers need their three-step end, not a blanket close: the grant has
    // to flip too, or it keeps publishing the caretaker's contact on the
    // animal's public credential long after the authority took it. See
    // lib/infra/end-pet-ownerships.ts.
    const { endedCaretakerGrants } = await endAllLiveOwnerships(
      {
        petId: activePet.id,
        outcome: "ownership_transferred",
        // A rehome sponsorship over the seized animal ends too, decided by the
        // authority over both parties: neither the titular withdrew nor the
        // org resigned, and nobody adopted. The platform-side outcome is the
        // one the catalog has for that.
        sponsorshipOutcome: "withdrawn_by_platform",
        actorUserId: user.id,
        now,
        // Every other event this function writes is signed govt/verified. The
        // caretaker_ended must be too: left at the default, the person who was
        // looking after the animal reads a note about losing it that appears to
        // have been written by the owner.
        authorRole: "govt",
        authorVerified: true,
        authorOrganizationId: govtOrg.id,
      },
      tx,
    );
    endedGrants.push(...endedCaretakerGrants);
  }

  // Open transitional shelter_custody for the govt org (both paths).
  await tx.insert(ownerships).values({
    petId: activePet.id,
    ownerOrganizationId: govtOrg.id,
    role: "shelter_custody",
    startedAt: now,
  });

  // ---------- INSERT custody_transfer_proposed ----------
  const proposalPayload = validateEventPayload("custody_transfer_proposed", {
    from_user_id: null,
    from_organization_id: govtOrg.id,
    to_user_id: null,
    to_organization_id: receiverOrg.id,
    reason: "other" as const,
    matched_against_pet_id: null,
    proposed_at: now.toISOString(),
    notes: `from_decomiso=true originating_intake_event_id=${intakeEvent.id} case=${caseRow.publicCode}`,
  });
  await tx.insert(petEvents).values({
    petId: activePet.id,
    eventType: "custody_transfer_proposed",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: user.id,
    authorRole: "govt",
    authorOrganizationId: govtOrg.id,
    authorVerified: true,
    payload: proposalPayload,
    caseId: caseRow.id,
  });

  // ---------- INSERT attachment rows ----------
  for (const uploaded of uploadedAttachments) {
    await tx.insert(attachments).values({
      petId: activePet.id,
      eventId: intakeEvent.id,
      uploadedByUserId: user.id,
      storagePath: uploaded.storagePath,
      mimeType: uploaded.mimeType,
      fileSize: uploaded.size,
    });
  }

  // ---------- Cross-reference note on originating welfare case (DC12) ----------
  if (input.originatingWelfareReportId) {
    const [welfareCase] = await tx
      .select({ id: cases.id, publicCode: cases.publicCode })
      .from(cases)
      .where(
        and(
          eq(cases.welfareReportId, input.originatingWelfareReportId),
          inArray(cases.status, ["open", "escalated"]),
        ),
      )
      .limit(1);

    if (welfareCase) {
      const notePayload = validateEventPayload("note_added", {
        category: "system" as const,
        text: `Devino en decomiso. Ver caso ${caseRow.publicCode} (custodia temporal).`,
      });
      await tx.insert(petEvents).values({
        petId: activePet.id,
        eventType: "note_added",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: "govt",
        authorOrganizationId: govtOrg.id,
        authorVerified: true,
        payload: notePayload,
        caseId: welfareCase.id,
      });
    }
  }

  // ---------- Build notifications ----------

  // 14a. Previous owner(s) — urgent. Skipped for unowned_animal path.
  for (const prevUserId of prevOwnerUserIds) {
    pendingNotifications.push({
      userId: prevUserId,
      notificationType: "decomiso_owner_lost_custody",
      severity: "urgent",
      title: "Custodia oficial transferida",
      body: `La autoridad sanitaria ${govtOrg.displayName} ejecutó un decomiso sobre tu mascota ${activePet.name}. Motivo: ${motiveLabel(input.seizureMotive)}.${input.judicialProceedingReference ? ` Referencia judicial: ${input.judicialProceedingReference}.` : ""} Para más información contactá a la autoridad sanitaria de tu jurisdicción.`,
      // The primary CTA used to be `/casos/${caseRow.publicCode}` — a 404 for
      // the very person it was sent to. canReadCase() admits an owner only via
      // an ownership row with endedAt IS NULL, and step 13 above just closed
      // that row; `custody_episode` is not in PUBLIC_ANONYMOUS_KINDS either, so
      // CaseDetailView calls notFound(). The person whose animal was just seized
      // pressed the blue button and got "page not found".
      //
      // The pet page IS reachable for them — getFormerOwnerReadAccess exists for
      // exactly this window — so that is where the primary CTA now points. The
      // card already rendered a working secondary "Ver {mascota}" link; the
      // review that reasoned about this case (NotificationCard.tsx) checked the
      // small button and not the big one.
      ctaLabel: `Ver ${activePet.name}`,
      ctaUrl: `/mis-mascotas/${activePet.publicToken}`,
      relatedCaseId: caseRow.id,
      relatedPetId: activePet.id,
    });
  }

  // 14a-bis. Previous ORGANISATION owner(s) — urgent. Same fact, different
  // addressee shape: an organisation has no `userId`, so the notification goes
  // to the humans who can act for it (the same admin/coordinator predicate the
  // receiver fan-out below uses). Without this the seizure of an org-held animal
  // reached nobody at all.
  if (prevOwnerOrganizationIds.length > 0) {
    const prevOrgCoords = await tx
      .select({
        userId: organizationMemberships.userId,
        organizationId: organizationMemberships.organizationId,
      })
      .from(organizationMemberships)
      .where(
        and(
          inArray(organizationMemberships.organizationId, prevOwnerOrganizationIds),
          inArray(organizationMemberships.role, ["admin", "coordinator"]),
          isNull(organizationMemberships.leftAt),
        ),
      );
    for (const coord of prevOrgCoords) {
      pendingNotifications.push({
        userId: coord.userId,
        notificationType: "decomiso_owner_lost_custody",
        severity: "urgent",
        title: "Custodia oficial transferida",
        body: `La autoridad sanitaria ${govtOrg.displayName} ejecutó un decomiso sobre ${activePet.name}, un animal bajo la titularidad de tu organización. Motivo: ${motiveLabel(input.seizureMotive)}.${input.judicialProceedingReference ? ` Referencia judicial: ${input.judicialProceedingReference}.` : ""} Para más información contactá a la autoridad sanitaria de tu jurisdicción.`,
        ctaLabel: `Ver ${activePet.name}`,
        ctaUrl: `/mis-mascotas/${activePet.publicToken}`,
        relatedCaseId: caseRow.id,
        relatedPetId: activePet.id,
      });
    }
  }

  // 14b. Receiver org coordinators — urgent.
  const receiverCoords = await tx
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, receiverOrg.id),
        inArray(organizationMemberships.role, ["admin", "coordinator"]),
        isNull(organizationMemberships.leftAt),
      ),
    );
  for (const coord of receiverCoords) {
    pendingNotifications.push({
      userId: coord.userId,
      notificationType: "decomiso_handoff_proposed_receiver",
      severity: "urgent",
      title: `Decomiso entrante — ${activePet.name}`,
      body: `La autoridad ${govtOrg.displayName} ejecutó un decomiso y propuso transferirte la custodia de ${activePet.name}. Tenés 7 días para aceptar o rechazar.`,
      ctaLabel: "Ver propuesta",
      ctaUrl: `/casos/${caseRow.publicCode}`,
      relatedCaseId: caseRow.id,
      relatedPetId: activePet.id,
    });
  }

  // 14c. Govt actor confirmation — info.
  //
  // This message used to assert "El refugio … fue notificado y tiene 7 días para
  // aceptar" UNCONDITIONALLY. When the receiver org has no admin/coordinator
  // member, the loop above pushes ZERO notifications: nobody at the shelter is
  // told, the 7-day backstop closes nothing, and the operator is affirmatively
  // told the opposite — which suppresses the phone call they would otherwise
  // make. An animal's custody hangs off this sentence, so it now follows the
  // fact (2026-08-17).
  const receiverWasNotified = receiverCoords.length > 0;
  if (!receiverWasNotified) {
    await writeAuditLog(tx, {
      action: "notification_fanout_empty",
      actorUserId: user.id,
      payload: {
        route: "decomiso_handoff_proposed_receiver",
        reason: "no_receiver_coordinators",
        case_id: caseRow.id,
        case_public_code: caseRow.publicCode,
        pet_id: activePet.id,
        receiver_org_id: receiverOrg.id,
      },
    });
  }
  pendingNotifications.push({
    userId: user.id,
    notificationType: "decomiso_confirmed_govt",
    severity: "info",
    title: `Decomiso ejecutado — ${activePet.name}`,
    body: receiverWasNotified
      ? `El decomiso de ${activePet.name} fue registrado. El refugio ${receiverOrg.displayName} fue notificado y tiene 7 días para aceptar.`
      : `El decomiso de ${activePet.name} fue registrado, pero ${receiverOrg.displayName} no tiene ningún admin o coordinador activo a quien avisar: nadie del refugio fue notificado. Contactalos por fuera del sistema para coordinar la entrega.`,
    ctaLabel: "Ver caso",
    ctaUrl: `/casos/${caseRow.publicCode}`,
    relatedCaseId: caseRow.id,
    relatedPetId: activePet.id,
  });

  // Fix 3: Admins also receive a decomiso_confirmed_admin notification.
  const adminProfiles = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.role, "admin"), isNull(profiles.deactivatedAt)));
  for (const admin of adminProfiles) {
    if (admin.id === user.id) continue;
    pendingNotifications.push({
      userId: admin.id,
      notificationType: "decomiso_confirmed_admin",
      severity: "info",
      title: `Decomiso ejecutado — ${activePet.name}`,
      body: `La autoridad ${govtOrg.displayName} ejecutó un decomiso sobre ${activePet.name} (${motiveLabel(input.seizureMotive)}). Destinatario: ${receiverOrg.displayName}.`,
      ctaLabel: "Ver caso",
      ctaUrl: `/casos/${caseRow.publicCode}`,
      relatedCaseId: caseRow.id,
      relatedPetId: activePet.id,
    });
  }

  // ---------- Audit log ----------
  await tx.insert(auditLog).values({
    actorUserId: user.id,
    action: "decomiso_executed",
    payload: {
      case_id: caseRow.id,
      case_public_code: caseRow.publicCode,
      pet_id: activePet.id,
      pet_public_token: activePet.publicToken,
      subject_kind: input.subjectKind,
      govt_org_id: govtOrg.id,
      receiver_org_id: receiverOrg.id,
      seizure_motive: input.seizureMotive,
      judicial_ref: input.judicialProceedingReference ?? null,
      originating_welfare_report_id: input.originatingWelfareReportId ?? null,
      attachment_count: input.attachmentFiles.length,
    },
  });

  return {
    ok: true,
    publicCode,
    pendingNotifications,
    endedCaretakerGrants: endedGrants,
    seizedPet: activePet,
  };
}
