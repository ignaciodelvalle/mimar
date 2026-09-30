"use server";

// Atender correction — the org door into amendEvent (portal-vet-p0, D1-D7).
//
// A clinic vet who signed a wrong lot number from Atender had no way to fix it:
// the only correction entry was the owner's event page, which authorizes
// through CUSTODY (requireAlivePetAccess) and so refuses a walk-in clinic by
// construction. This is the same correction — the same use-case, the same
// append-only `event_amended` row — reached through the walk-in resolver
// instead.
//
// WHO MAY (PO decision 2026-09-30): a member of THIS organization with
// event.write (resolveAtenderPet) and a VALIDATED matrícula, on a record that
// this same organization signed, root and every prior correction. Any verified
// colleague of the clinic, not only the original signer. The binding check is
// inside amendEvent, under the per-record lock (`door.orgScope`); the matrícula
// refusal below is the early, readable one.
//
// THE REASON IS MANDATORY here (≥5 characters): it is the only explanation the
// owner receives about a change to a signed record.
//
// THE OWNER IS TOLD. amendEvent notifies only on the admin/govt path; a vet's
// correction would be silent. The action closes through
// completeAtenderSignature, like every walk-in writer, with the
// `professional_event_amended` notice — scripts/check-atender-owner-alerts.ts
// derives amendEvent as a writer from the import below and holds it to that.

import { PROFESSIONAL_AMENDMENT_NOTIFICATION_TYPE } from "@/lib/infra/amendment";
import { amendEvent } from "@/src/modules/events/application/amendment/amend-event";
import type { AmendEventCommand } from "@/src/modules/events/application/amendment/types";

import { resolveAtenderPet } from "../atender-access";
import { completeAtenderSignature } from "../atender-signature-completion";

/** Minimum reason length on the org door — the same floor as the D5 path. */
const MIN_REASON_LENGTH = 5;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AtenderAmendResult =
  | { ok: true; error: null; redirectTo: string }
  | { ok: false; error: string };

export async function atenderAmendEventAction(
  orgToken: string,
  publicToken: string,
  input: Pick<AmendEventCommand, "targetEventId" | "reason" | "changes">,
): Promise<AtenderAmendResult> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { ok: false, error: access.error };

  if (!access.signer.matriculaVerified) {
    return {
      ok: false,
      error: "Para corregir un registro desde Atender necesitás tu matrícula validada.",
    };
  }

  // The id reaches a uuid column; a malformed one is "not found", not a 500.
  if (!UUID_SHAPE.test(input.targetEventId)) {
    return { ok: false, error: "Registro no encontrado." };
  }

  const reason = input.reason?.trim() ?? "";
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      error: "Contá el motivo de la corrección (mínimo 5 caracteres). Es lo que lee el dueño.",
    };
  }

  const result = await amendEvent(
    access.user,
    access.pet,
    access.eventAuthorship,
    {
      publicToken: access.pet.publicToken,
      targetEventId: input.targetEventId,
      reason,
      changes: input.changes,
    },
    { orgScope: { organizationId: access.organizationId } },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const receipt = await completeAtenderSignature({
    orgToken,
    publicToken: access.pet.publicToken,
    petId: access.pet.id,
    petName: access.pet.name,
    organizationName: access.organizationName,
    signerUserId: access.user.id,
    // A replayed correction appended nothing: the signer still gets the
    // receipt, the owner is not told twice.
    eventId: result.wasDuplicate ? null : result.amendmentEventId,
    eventType: "event_amended",
    occurredAt: new Date(),
    receipt: "amended",
    ownerNotice: {
      notificationType: PROFESSIONAL_AMENDMENT_NOTIFICATION_TYPE,
      severity: "info",
      title: `Se corrigió un registro de ${access.pet.name}`,
      body: `${access.organizationName} corrigió un registro de la libreta de ${access.pet.name}. El registro original sigue visible en el historial. Motivo: ${reason}.`,
      relatedCaseId: null,
      ctaLabel: "Ver el registro",
      // The ROOT record: that page shows the corrected value, the badge, and
      // the original in the history — the correction row alone shows none.
      ctaUrl: `/mis-mascotas/${access.pet.publicToken}/eventos/${input.targetEventId}`,
    },
  });

  return { ok: true, error: null, redirectTo: receipt.redirectTo ?? "" };
}
