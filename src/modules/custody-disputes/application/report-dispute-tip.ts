// Use-case: reportDisputeTip — anonymous third-party information on a pet
// whose titularidad is under review (open custody dispute).
//
// PO decision 2026-07-24: the D2 hardening (red-team 2026-07) removed every
// owner-relay finder flow from a disputed credential — correct, but it left a
// finder who scanned the QR with NO way to do the right thing. This path
// restores a NEUTRAL report: the tip is appended to the open custody-dispute
// CASE as a case_events row (entry_type "finder_tip"), where ONLY the
// reviewing authority reads it — CaseDetailView filters finder_tip entries
// away from every other viewer, including both disputing parties (the subject
// owner and registered dispute parties pass canReadCase for this case kind).
//
// Dispute-safety invariants (defense-in-depth, mirroring the D2 gates in
// notify-owner-of-found-pet.ts / report-pet-sighting.ts / encontre/action.ts
// — but inverted: those REFUSE disputed pets, this one REQUIRES them):
//   • pets.in_custody_dispute MUST be true — refused otherwise (the normal
//     found/sighting flows own the non-disputed case).
//   • NEVER inserts a notifications row and NEVER queries ownerships — no
//     disputing party may learn a tip exists, let alone read it.
//   • recorded_by_user_id stays NULL (finder anonymity invariant, privacy
//     hardening 2026-07-04): the tip is never linked to a DIM account.
//
// @no-auth-required: anonymous finder submits from the public credential
// (/p/[publicToken]). Rate-limited by (IP + publicToken) via the persistent
// DB-backed limiter. Limit: 1/min, 10/hour per key — and by the token alone
// (`dispute_tip_token`, lib/infra/anonymous-report-limits.ts). The caller IP arrives as
// an argument — request context (next/headers) stays in the actions layer
// (ADR 2026-07-18 native-readiness, Decision 1).

import { and, eq, inArray } from "drizzle-orm";

import { caseEvents, cases, custodyDisputes, db, disputeHoldsCustodyLock, pets } from "@/db";
import { SYNTHETIC_PET_WRITE_REFUSED, isSyntheticPet } from "@/lib/domain/synthetic-pet";
import {
  ANONYMOUS_REPORT_TOKEN_BUSY,
  ANONYMOUS_REPORT_TOKEN_LIMIT,
} from "@/lib/infra/anonymous-report-limits";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";

import type { PublicActionState } from "@/src/modules/pets/application/public/types";

export async function reportDisputeTip(
  publicToken: string,
  /** Trusted caller IP, resolved by the action wrapper via callerIp(). */
  ip: string,
  formData: FormData,
): Promise<PublicActionState> {
  if (!publicToken) return { ok: false, error: "Token de mascota inválido." };

  // Name, contact and location are all OPTIONAL — the only required field is
  // the information itself. Lowering the barrier is the point: a finder who
  // wants to stay anonymous must still be able to help the authority.
  const finderName = String(formData.get("finderName") ?? "")
    .trim()
    .slice(0, 80);
  const finderContact = String(formData.get("finderContact") ?? "")
    .trim()
    .slice(0, 120);
  const info = String(formData.get("info") ?? "")
    .trim()
    .slice(0, 1000);
  const locationText = String(formData.get("locationText") ?? "")
    .trim()
    .slice(0, 200);

  if (!info) return { ok: false, error: "Contanos qué viste o qué sabés de esta mascota." };

  // ORDER: pure input validation → limiter → token lookup.
  //
  // Rate limit — consumed only after PURE INPUT validation (tester fix #6): a
  // rejected form (missing info) must not burn the (IP, token) budget, because
  // the finder has to be able to fix the field and retry immediately. Nothing
  // above this line touches the database, so nothing above it can be asked a
  // question about a token.
  //
  // AND IT RUNS BEFORE THE LOOKUP (fixed 2026-08-21). It used to sit after the
  // pet row and the dispute gate, which made this an unbounded ORACLE: the form
  // is hand-postable — no page load required — and the refusals are DISTINCT
  // strings ("Mascota no encontrada." vs "…no tiene una revisión de titularidad
  // abierta."), so a caller could enumerate which DIM tokens exist AND which of
  // those animals are under custody review, at whatever rate Postgres would
  // serve. That second bit is the sensitive one: an open custody dispute is a
  // fact about a household, not about a pet. The limiter is what makes the
  // enumeration finite, and a limiter consulted after the read it was meant to
  // prevent bounds nothing.
  try {
    await enforceRateLimit(`dispute_tip:${publicToken}`, ip, {
      maxPerMinute: 1,
      maxPerHour: 10,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        ok: false,
        error: "Ya enviaste un aviso hace poco. Probá de nuevo en unos minutos.",
      };
    }
    throw err;
  }

  const [pet] = await db
    .select({
      id: pets.id,
      name: pets.name,
      inCustodyDispute: pets.inCustodyDispute,
      seedTag: pets.seedTag,
    })
    .from(pets)
    // PO-4: a soft-deleted pet resolves nowhere public, including this
    // hand-postable tip path.
    .where(publicPetByToken(publicToken))
    .limit(1);
  if (!pet) return { ok: false, error: "Mascota no encontrada." };
  // A seeded pet records no real act (lib/domain/synthetic-pet.ts).
  if (isSyntheticPet(pet)) return { ok: false, error: SYNTHETIC_PET_WRITE_REFUSED };

  // Hard gate: this path exists ONLY for disputed pets. A non-disputed pet
  // must use the regular found/sighting flows (which notify the owner) — a
  // tip silently parked on a case nobody reviews would strand the finder's
  // effort, and the neutral copy would be a lie.
  if (!pet.inCustodyDispute) {
    return {
      ok: false,
      error:
        "Esta mascota no tiene una revisión de titularidad abierta. " +
        "Usá el formulario de aviso de la credencial.",
    };
  }

  // Resolve the in-dispute (open OR escalated) linked case (open-dispute.ts pre-creates the
  // case and links it via cases.custody_dispute_id in the same transaction,
  // so a disputed pet always has one). The tip lands on the case timeline the
  // authority reviews (/gob/casos + /admin/casos via getCaseDetail).
  const [target] = await db
    .select({ caseId: cases.id })
    .from(custodyDisputes)
    .innerJoin(cases, eq(cases.custodyDisputeId, custodyDisputes.id))
    .where(
      and(
        eq(custodyDisputes.petId, pet.id),
        disputeHoldsCustodyLock(),
        inArray(cases.status, ["open", "escalated"]),
      ),
    )
    .limit(1);
  if (!target) {
    // in_custody_dispute=true without an open dispute case is an integrity
    // bug — report it, but give the finder an honest answer, not a fake ok.
    reportError(
      "public-credential/dispute-tip",
      new Error("disputed pet has no open dispute case"),
      {
        publicToken,
      },
    );
    return {
      ok: false,
      error: "No pudimos registrar la información. Probá de nuevo más tarde.",
    };
  }

  // THE ANIMAL'S OWN CEILING (audit A03-2). The bucket above is per ADDRESS,
  // so N addresses meant 10 × N tips an hour on the case timeline the reviewing
  // authority has to read. This one is keyed on the token alone and placed
  // after every refusal that writes nothing; derivation and placement in
  // lib/infra/anonymous-report-limits.ts.
  try {
    await enforceRateLimit("dispute_tip_token", publicToken, ANONYMOUS_REPORT_TOKEN_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false, error: ANONYMOUS_REPORT_TOKEN_BUSY };
    throw err;
  }

  // The notes body is what the authority reads on the case timeline. Rendered
  // ONLY for govt/admin viewers (CaseDetailView filters finder_tip entries for
  // everyone else) — parties never see it.
  const noteLines = [
    `Información de un tercero (credencial pública): ${info}`,
    locationText ? `Dónde: ${locationText}` : null,
    `Nombre: ${finderName || "no informado"}`,
    `Contacto: ${finderContact || "no informado"}`,
  ].filter(Boolean);

  await db.insert(caseEvents).values({
    caseId: target.caseId,
    entryType: "finder_tip",
    notes: noteLines.join("\n"),
    payload: {
      source: "public_credential",
      finder_name: finderName || null,
      finder_contact: finderContact || null,
      location_text: locationText || null,
    },
    // Finder anonymity invariant: never linked to a DIM account.
    recordedByUserId: null,
    occurredAt: new Date(),
  });

  // Deliberately NO notification insert of any kind here: neither disputing
  // party may learn that a tip exists. The authority discovers it on the case
  // timeline they already review.

  return { ok: true, error: null };
}
