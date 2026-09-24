// signer-provenance.ts — who is signing this clinical act, and with what
// authority.
//
// #43/#45 PROVENANCE. The tier is bound to the SIGNER's validated matrícula —
// not to their membership role, and not to the ORGANIZATION's `verified` flag.
//
// WHY IT LIVES IN lib/infra AND NOT UNDER A MODULE (moved 2026-08-17).
// It started inside `src/modules/events/application/attendance/`, which was
// right while attendance was its only caller. Then the bite-report path needed
// the same stamp — it had the identical defect, see report-bite-from-org.ts —
// and importing it from there tripped check-dependency-direction.ts:
// `surveillance → events` is forbidden, and `events → surveillance` is already
// an ALLOWED edge, so the import would have closed a cycle between the two
// modules. The fence was right and the honest reading is that this helper was
// never an events concern: "does this person hold a validated matrícula" is a
// question about the signer, asked by every module that records a signed act.
// Adding the edge would have bought one import at the price of a module cycle;
// duplicating the function would have recreated the exact drift that made this
// bug show up in three places. So it moved out to where both can reach it.
//
// WHY THIS IS ITS OWN MODULE. Until 2026-08-10 the scheduled-appointment path
// derived provenance inline in app/actions/attendance.ts as
// `role === "vet_individual" ? "vet" : "shelter"` with
// `authorVerified: organization.verified`, and produced two false tiers:
//
//   - A volunteer with role `member` in a verified refugio wrote
//     shelter + verified=true, which computeConfidence resolves to
//     `institutional_verified` — the HIGHEST tier, above professional_verified —
//     with no matrícula anywhere in the chain. It is not a branch the tier table
//     contemplates; it lands there by structural accident.
//   - An admin can invite anyone as `vet_individual` with no matrícula check,
//     producing professional_verified, labelled on screen as "Verificado por
//     veterinario matriculado".
//
// Both clear the official "al día" gate in lib/projections/pet-compliance.ts,
// whose own copy promises the opposite: "un veterinario matriculado tiene que
// firmarla".
//
// The walk-in twin (app/org/[orgToken]/atender/atender-access.ts) already got
// this right when #45 closed the "verificación profesional" theater. The
// scheduled path was the gemelo that escaped. Extracting it here — rather than
// fixing it in place — is what check-action-line-budget asked for, and it is
// also what gives the two paths one shape to compare.

import { eq } from "drizzle-orm";

import { db, profiles } from "@/db";

export type SignerProvenance = {
  authorRole: "vet" | "shelter";
  authorOrganizationId: string;
  authorVerified: boolean;
  /** Matrícula when the signer has one, else the organization's name. */
  matriculaVerified: boolean;
};

/**
 * Provenance for a clinical event signed by `userId` acting for `organizationId`.
 *
 * A signer with no verified matrícula is `shelter` + unverified. That is not a
 * downgrade of the person — it is the honest statement that the registry has no
 * professional licence backing this signature.
 */
export async function resolveSignerProvenance(
  userId: string,
  organizationId: string,
): Promise<SignerProvenance> {
  const [signer] = await db
    .select({ matriculaVerified: profiles.matriculaVerified })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  const matriculaVerified = signer?.matriculaVerified === true;

  return {
    authorRole: matriculaVerified ? "vet" : "shelter",
    authorOrganizationId: organizationId,
    authorVerified: matriculaVerified,
    matriculaVerified,
  };
}
