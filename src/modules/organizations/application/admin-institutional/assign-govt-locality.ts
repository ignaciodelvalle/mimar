// Use-case: assignGovtLocalityForAuthority
//
// Assigns a new locality to an active govt:
//   1. Capability check (admin only)
//   2. Validate target is active institutional govt
//   3. Check for duplicate active assignment (noOp if exists)
//   4. ONE transaction: INSERT govt_assignments row
//                     + INSERT audit_log action='govt_locality_assigned'
//   5. INSERT notification to target (single insert — best-effort, try/catch)
//
// ARCH-P: the notification insert is wrapped in try/catch so a failure
// does not propagate to the caller (single-insert hardening pattern).

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import { db, govtAssignments, notifications, profiles } from "@/db";
import { canAssignGovtLocality } from "@/lib/domain/institutional-scope";
import {
  WHOLE_PROVINCE_SENTINEL,
  canonicalProvinceNameForStorage,
} from "@/lib/domain/jurisdiction-canonical";
import {
  CoordError,
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import { writeAuditLog } from "@/lib/infra/audit-log";

import { loadActorProfile } from "./helpers";
import type { AssignGovtLocalityResult } from "./types";

// D3 (PO 2026-08-04): a whole-province mandate is now assignable for ANY
// province, expressed as the empty locality sentinel. `locality` therefore
// stops being `.min(1)`; the empty string is a MEANING here, not a missing
// field, and the branch below never lets it through without a canonical
// province to attach it to.
const assignLocalitySchema = z.object({
  targetUserId: z.string().min(1, "targetUserId is required"),
  province: z.string().min(1, "Province is required"),
  locality: z.string(),
});

// Canonical (province, locality) resolution for an assignment write.
//
// WHOLE-PROVINCE branch (D3): there is no catalog row to resolve — the
// sentinel IS the value — so the strict locality resolver is bypassed and the
// PROVINCE is canonicalized on its own. Rejecting a non-canonical province
// here keeps the widening honest: an unresolvable province can never be
// granted province-wide, and `govt_assignments`' CHECK constraint would
// refuse it anyway. Only the RESOLUTION is skipped — every capability and
// target check in the caller still runs, in the same order, on the same row.
//
// Only the EXACT sentinel ("") grants the whole province. A whitespace-only
// locality is an input mistake, not a mandate — trimming it into the sentinel
// would silently promote a typo to province-wide standing.
async function resolveAssignmentJurisdiction(
  rawProvince: string,
  rawLocality: string,
): Promise<{ province: string; locality: string } | { error: string }> {
  const wholeProvince = rawLocality === WHOLE_PROVINCE_SENTINEL;
  if (!wholeProvince && rawLocality.trim() === "") {
    return { error: "VALIDATION_ERROR: Locality is required (or use the whole-province option)" };
  }
  if (wholeProvince) {
    const province = canonicalProvinceNameForStorage(rawProvince);
    if (!province) return { error: `VALIDATION_ERROR: Provincia desconocida: ${rawProvince}` };
    return { province, locality: WHOLE_PROVINCE_SENTINEL };
  }
  try {
    const normalizedLoc = await normalizeLocationForWrite(
      {
        province: rawProvince,
        provinceCode: null,
        locality: rawLocality,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
    return {
      province: normalizedLoc.province ?? rawProvince,
      locality: normalizedLoc.locality ?? rawLocality,
    };
  } catch (err) {
    if (err instanceof JurisdictionValidationError) return { error: err.message };
    if (err instanceof CoordError) return { error: err.message };
    throw err;
  }
}

export async function assignGovtLocalityForAuthority(
  actorUserId: string,
  input: { targetUserId: string; province: string; locality: string },
): Promise<AssignGovtLocalityResult> {
  // 1. Validate input
  const parsed = assignLocalitySchema.safeParse(input);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return { error: `VALIDATION_ERROR: ${firstError.message}` };
  }
  const { targetUserId, province: rawProvince, locality: rawLocality } = parsed.data;

  // 1.5 Resolve through the canonical catalog. We only persist canonical names.
  // locality:"strict" — resolveCanonicalJurisdiction (govt assignment behavior unchanged).
  const resolved = await resolveAssignmentJurisdiction(rawProvince, rawLocality);
  if ("error" in resolved) return { error: resolved.error };
  const canonicalProvince = resolved.province;
  const canonicalLocality = resolved.locality;
  const wholeProvince = canonicalLocality === WHOLE_PROVINCE_SENTINEL;

  // 2. Load actor + capability check
  const actorProfile = await loadActorProfile(actorUserId);
  if (!actorProfile) return { error: "CAPABILITY_DENIED" };
  if (!canAssignGovtLocality(actorProfile)) return { error: "CAPABILITY_DENIED" };

  // 3. Validate target is active institutional govt
  const [targetProfile] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, targetUserId))
    .limit(1);

  if (!targetProfile) return { error: "NOT_FOUND" };
  if (targetProfile.role !== "govt" || targetProfile.accountType !== "institutional") {
    return { error: "NOT_INSTITUTIONAL_GOVT" };
  }
  if (targetProfile.deactivatedAt !== null) return { error: "TARGET_DEACTIVATED" };

  // 4. Check for duplicate active assignment (UNIQUE: user_id + province + locality WHERE revoked_at IS NULL)
  const [existing] = await db
    .select({ id: govtAssignments.id })
    .from(govtAssignments)
    .where(
      and(
        eq(govtAssignments.userId, targetUserId),
        eq(govtAssignments.jurisdictionProvince, canonicalProvince),
        eq(govtAssignments.jurisdictionLocality, canonicalLocality),
        isNull(govtAssignments.revokedAt),
      ),
    )
    .limit(1);

  if (existing) {
    return { ok: true, assignmentId: existing.id, noOp: true };
  }

  // 5+6. INSERT govt_assignments + audit_log — ONE transaction.
  //
  // These were two separate autocommits until 2026-08-16. A crash between them
  // left a GRANTED JURISDICTION AUTHORITY with no audit trace, and the absence
  // of that row is indistinguishable from the absence of the grant. The
  // assignment and its accountability record are one fact; they commit or they
  // both roll back.
  const newAssignment = await db.transaction(async (tx) => {
    const [assignment] = await tx
      .insert(govtAssignments)
      .values({
        userId: targetUserId,
        jurisdictionProvince: canonicalProvince,
        jurisdictionLocality: canonicalLocality,
        grantedByUserId: actorUserId,
      })
      .returning({ id: govtAssignments.id });

    await writeAuditLog(tx, {
      action: "govt_locality_assigned",
      actorUserId,
      targetUserId,
      targetGovtAssignmentId: assignment.id,
      payload: {
        province: canonicalProvince,
        locality: canonicalLocality,
        govt_assignment_id: assignment.id,
      },
      // A grant has no prior state — the duplicate-assignment check above
      // already returned noOp if one existed.
      before: null,
      after: { province: canonicalProvince, locality: canonicalLocality },
    });

    return assignment;
  });

  // 7. INSERT notification to target govt — best-effort, must not undo the assignment.
  try {
    await db.insert(notifications).values({
      userId: targetUserId,
      notificationType: "govt_locality_assigned",
      // The operator must read what they were actually granted. A whole-province
      // mandate announced as "la localidad , Mendoza" is both broken copy and a
      // misstatement of scope (D3).
      title: wholeProvince
        ? "Nueva provincia asignada a tu cuenta"
        : "Nueva localidad asignada a tu cuenta",
      body: wholeProvince
        ? `Un administrador asignó toda la provincia de ${canonicalProvince} a tu jurisdicción.`
        : `Un administrador asignó la localidad ${canonicalLocality}, ${canonicalProvince} a tu jurisdicción.`,
      severity: "info",
      ctaLabel: "Ver mis localidades",
      ctaUrl: "/gob",
    });
  } catch (e) {
    console.error("notifications insert failed (assignGovtLocalityForAuthority did succeed)", e);
  }

  return { ok: true, assignmentId: newAssignment.id };
}
