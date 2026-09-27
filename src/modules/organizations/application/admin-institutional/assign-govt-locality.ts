// Use-case: assignGovtLocalityForAuthority
//
// Assigns a new locality to an active govt:
//   1. Validate + resolve the place through the canonical catalogue (read-only)
//   2. ONE transaction (security review L6 — every read the grant depends on
//      sits in the snapshot that writes it):
//        a. authority, from the one admin-authority loader: the platform
//           admin, or a jurisdiction admin granting a place in their own
//           province (jurisdiction-admin Phase 4);
//        b. target is an active institutional govt (locked FOR UPDATE, so a
//           concurrent deactivation waits) — for a jurisdiction admin, one
//           whose active grants already lie wholly in that province, who is
//           neither the actor nor another appointee;
//        c. duplicate active assignment → noOp;
//        d. INSERT govt_assignments + INSERT audit_log 'govt_locality_assigned'
//   3. INSERT notification to target (single insert — best-effort, try/catch)
//
// ARCH-P: the notification insert is wrapped in try/catch so a failure
// does not propagate to the caller (single-insert hardening pattern).

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import { db, govtAssignments, notifications, profiles } from "@/db";
import {
  WHOLE_PROVINCE_SENTINEL,
  canonicalProvinceNameForStorage,
} from "@/lib/domain/jurisdiction-canonical";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { jurisdictionAdminRefusal } from "@/lib/infra/jurisdiction-admin-refusals";
import {
  JURISDICTION_ADMIN_REFUSAL_COPY,
  JURISDICTION_ADMIN_WRITER_COPY,
} from "@/lib/ui/jurisdiction-admin-copy";
import {
  hasAdminAuthority,
  requireJurisdictionAdminFor,
  requirePlatformAdmin,
} from "@/src/modules/organizations/application/admin-authority/authority";
import {
  govtTargetProvince,
  provinceOfProvinceNames,
  singleProvince,
} from "@/src/modules/organizations/application/admin-authority/target-province";

import { resolveGovtLocality } from "./resolve-govt-locality";
import type { AssignGovtLocalityResult } from "./types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Optional and last, like deactivate-govt's: tests join a transaction they roll back. */
export type AssignGovtLocalityExecutor = typeof db | Tx;

// D3 (PO 2026-08-04): a whole-province mandate is now assignable for ANY
// province, expressed as the empty locality sentinel. `locality` therefore
// stops being `.min(1)`; the empty string is a MEANING here, not a missing
// field, and the branch below never lets it through without a canonical
// province to attach it to.
const assignLocalitySchema = z.object({
  targetUserId: z.string().min(1, "targetUserId is required"),
  province: z.string().min(1, "Province is required"),
  locality: z.string(),
  // INDEC id of the row the admin picked (C2b). Optional for the whole-province
  // sentinel; a named locality without it is accepted only when unambiguous.
  localityIndecId: z.string().nullish(),
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
//
// LOCALITY branch (C2b): the INDEC id the picker resolved wins, and a name
// that is ambiguous inside its province is refused — see resolveGovtLocality.
async function resolveAssignmentJurisdiction(
  rawProvince: string,
  rawLocality: string,
  localityIndecId: string | null,
): Promise<{ province: string; locality: string; localityId: string | null } | { error: string }> {
  const wholeProvince = rawLocality === WHOLE_PROVINCE_SENTINEL;
  if (!wholeProvince && rawLocality.trim() === "") {
    return { error: "VALIDATION_ERROR: Locality is required (or use the whole-province option)" };
  }
  if (wholeProvince) {
    const province = canonicalProvinceNameForStorage(rawProvince);
    if (!province) return { error: `VALIDATION_ERROR: Provincia desconocida: ${rawProvince}` };
    return { province, locality: WHOLE_PROVINCE_SENTINEL, localityId: null };
  }
  return resolveGovtLocality({ province: rawProvince, locality: rawLocality, localityIndecId });
}

export async function assignGovtLocalityForAuthority(
  actorUserId: string,
  input: {
    targetUserId: string;
    province: string;
    locality: string;
    localityIndecId?: string | null;
  },
  exec: AssignGovtLocalityExecutor = db,
): Promise<AssignGovtLocalityResult> {
  // 1. Validate input
  const parsed = assignLocalitySchema.safeParse(input);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return { error: `VALIDATION_ERROR: ${firstError.message}` };
  }
  const {
    targetUserId,
    province: rawProvince,
    locality: rawLocality,
    localityIndecId,
  } = parsed.data;

  // 1.5 Resolve through the canonical catalog. We only persist canonical names.
  // locality:"strict", by INDEC id when the picker sent one (C2b).
  const resolved = await resolveAssignmentJurisdiction(
    rawProvince,
    rawLocality,
    localityIndecId ?? null,
  );
  if ("error" in resolved) return { error: resolved.error };
  const canonicalProvince = resolved.province;
  const canonicalLocality = resolved.locality;
  const localityId = resolved.localityId;
  const wholeProvince = canonicalLocality === WHOLE_PROVINCE_SENTINEL;

  // 2. ONE transaction: authority, target, duplicate check, grant, audit.
  //
  // The grant and its audit row were two separate autocommits until
  // 2026-08-16: a crash between them left a GRANTED JURISDICTION AUTHORITY
  // with no audit trace. They commit or they both roll back — and since L6 the
  // authority and target reads that justify them live in the same snapshot.
  type Outcome = { refused: AssignGovtLocalityResult } | { assignmentId: string; noOp: boolean };
  let outcome: Outcome;
  try {
    outcome = await exec.transaction(async (tx): Promise<Outcome> => {
      // a. Authority, in this transaction's snapshot: the platform admin, or a
      //    jurisdiction admin — for whom the GRANTED place must be their
      //    province (derived from the resolved catalogue, never from input).
      if (!(await hasAdminAuthority(tx, actorUserId))) {
        return { refused: { error: "CAPABILITY_DENIED" } };
      }
      const grantProvince = await provinceOfProvinceNames(tx, [canonicalProvince]);
      if (!(await requireJurisdictionAdminFor(tx, actorUserId, grantProvince))) {
        return { refused: { error: JURISDICTION_ADMIN_WRITER_COPY.OUT_OF_PROVINCE } };
      }

      // b. Target is an active institutional govt.
      const [targetProfile] = await tx
        .select({
          id: profiles.id,
          role: profiles.role,
          accountType: profiles.accountType,
          deactivatedAt: profiles.deactivatedAt,
        })
        .from(profiles)
        .where(eq(profiles.id, targetUserId))
        .for("update")
        .limit(1);

      // b'. A jurisdiction admin grants only to a funcionario already wholly
      //     inside their province (single(P)) — never to themself, never to
      //     another appointee. The platform admin is not narrowed here.
      //
      //     NO ORACLE (Phase-4 review LOW-1): for a jurisdiction admin this is
      //     asked BEFORE the target row's own checks, and a target that does
      //     not exist, is not an institutional govt or is deactivated reads
      //     exactly like one in another province. Only the platform admin
      //     learns which of those it was.
      if (!(await requirePlatformAdmin(tx, actorUserId))) {
        const target = await govtTargetProvince(tx, targetUserId);
        if (
          !targetProfile ||
          targetProfile.role !== "govt" ||
          targetProfile.accountType !== "institutional" ||
          targetProfile.deactivatedAt !== null ||
          targetUserId === actorUserId ||
          target.isAppointee ||
          !(await requireJurisdictionAdminFor(tx, actorUserId, singleProvince(target)))
        ) {
          return { refused: { error: JURISDICTION_ADMIN_WRITER_COPY.OUT_OF_PROVINCE } };
        }
      }

      if (!targetProfile) return { refused: { error: "NOT_FOUND" } };
      if (targetProfile.role !== "govt" || targetProfile.accountType !== "institutional") {
        return { refused: { error: "NOT_INSTITUTIONAL_GOVT" } };
      }
      if (targetProfile.deactivatedAt !== null) return { refused: { error: "TARGET_DEACTIVATED" } };

      // c. Duplicate active assignment (UNIQUE: user_id + province + locality
      // WHERE revoked_at IS NULL).
      const [existing] = await tx
        .select({ id: govtAssignments.id, localityId: govtAssignments.localityId })
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
        // A DIFFERENT row with the same name (a within-province homonym, C2b). The
        // name-only check used to answer noOp here, and the admin read "assigned"
        // for a locality that was never granted. While scope is matched by name the
        // two would be the same scope twice, so this is refused, not inserted.
        if (
          existing.localityId !== null &&
          localityId !== null &&
          existing.localityId !== localityId
        ) {
          return {
            refused: {
              error: `VALIDATION_ERROR: Este operador ya tiene asignada otra localidad llamada ${canonicalLocality} en ${canonicalProvince}. Revocala antes de asignar esta.`,
            },
          };
        }
        return { assignmentId: existing.id, noOp: true };
      }

      // d. The grant and its accountability record — one fact.
      const [assignment] = await tx
        .insert(govtAssignments)
        .values({
          userId: targetUserId,
          jurisdictionProvince: canonicalProvince,
          jurisdictionLocality: canonicalLocality,
          localityId,
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
          locality_id: localityId,
          govt_assignment_id: assignment.id,
        },
        // A grant has no prior state — the duplicate-assignment check above
        // already returned noOp if one existed.
        before: null,
        after: { province: canonicalProvince, locality: canonicalLocality },
      });

      return { assignmentId: assignment.id, noOp: false };
    });
  } catch (err) {
    // A database refusal (a foreign grant for an appointee, a grant outside
    // the granter's province) is translated, never shown raw.
    const refusal = jurisdictionAdminRefusal(err);
    if (refusal) return { error: JURISDICTION_ADMIN_REFUSAL_COPY[refusal] };
    throw err;
  }

  if ("refused" in outcome) return outcome.refused;
  if (outcome.noOp) return { ok: true, assignmentId: outcome.assignmentId, noOp: true };
  const newAssignment = { id: outcome.assignmentId };

  // 7. INSERT notification to target govt — best-effort, must not undo the assignment.
  try {
    await exec.insert(notifications).values({
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
