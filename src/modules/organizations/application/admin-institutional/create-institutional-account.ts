// Use-case: createInstitutionalAccountForAuthority
//
// Creates a new institutional account (govt, admin or national) with:
//   1. Zod validation
//   2. Authority pre-flight — fail fast, before any auth user exists. NOT the
//      authoritative check: that one runs again INSIDE the transaction (5.0,
//      security review L6), and a refusal there rolls back and compensates
//      the auth user like any other transaction failure. Both ask the same
//      question (creationRefusal, jurisdiction-admin Phase 4):
//        - no administrative authority at all → CAPABILITY_DENIED;
//        - role admin | national → the platform admin only;
//        - role govt → requireJurisdictionAdminFor(the ONE province every
//          resolved initial locality lies in). None, or two provinces, is no
//          single place: platform only. A jurisdiction admin therefore always
//          names at least one locality of their own province.
//   3. Pre-flight duplicate email check via auth admin SDK
//   4. auth.admin.createUser (CONFIRMED, NO password, first-access flag)
//   5. DB transaction: profile + govt_assignments + audit_log + notification
//      (compensating auth.admin.deleteUser on tx failure)
//   6. auth.admin.generateLink — ONE first-access link (after commit)
//   7. mail that link through the repo's mail path (./access-link-mail.ts);
//      the same link goes back to the admin panel to forward by hand
//
// WHAT A FAILURE SAYS (Phase-4 security review, LOW-2/3/4):
//   - no identity-provider or Postgres text ever reaches the UI: it is
//     logged server-side and the caller reads CREATE_INSTITUTIONAL_FAILED;
//   - a JURISDICTION admin reads that same sentence for an address that is
//     already registered — the platform keeps DUPLICATE_EMAIL — so creating
//     accounts is not a way to learn who is on the platform. The refused
//     attempt is audited (institutional_create_refused: role and reason,
//     never the address) and delegated attempts are rate-limited per actor;
//   - the orphan-auth-user record keeps the ids and error CODES only: never
//     the intended address, never raw error text.
//
// §2.2: notifications accumulate in pendingNotifications[] inside the tx and
// are inserted AFTER the transaction commits (best-effort, logged on failure).

import { eq } from "drizzle-orm";
import { z } from "zod/v4";

import { auditLog, db, govtAssignments, notifications, profiles } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { jurisdictionAdminRefusal } from "@/lib/infra/jurisdiction-admin-refusals";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  JURISDICTION_ADMIN_REFUSAL_COPY,
  JURISDICTION_ADMIN_WRITER_COPY,
} from "@/lib/ui/jurisdiction-admin-copy";
import {
  FIRST_ACCESS_PATH,
  armedPasswordSetupMetadata,
} from "@/src/modules/auth/domain/first-access";
import {
  hasAdminAuthority,
  requireJurisdictionAdminFor,
  requirePlatformAdmin,
} from "@/src/modules/organizations/application/admin-authority/authority";
import { provinceOfProvinceNames } from "@/src/modules/organizations/application/admin-authority/target-province";

import { mailInstitutionalAccessLink } from "./access-link-mail";
import { databaseNow } from "./helpers";
import { resolveGovtLocality } from "./resolve-govt-locality";
import type { CreateInstitutionalResult } from "./types";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const localitySchema = z.object({
  province: z.string().min(1, "Province is required"),
  locality: z.string().min(1, "Locality is required"),
  // INDEC id of the row the admin picked (C2b). Without it a name is accepted
  // only when it names exactly one catalogue row in the province.
  localityIndecId: z.string().nullish(),
});

const createInstitutionalSchema = z.object({
  // `national` (pilot T1-P9): the read-only, country-wide observer role
  // (migration 0214). It holds no govt_assignments — its read scope is
  // universal by role — so initial localities are refused rather than dropped.
  role: z.enum(["govt", "admin", "national"]),
  email: z.email("Invalid email address"),
  displayName: z
    .string()
    .min(2, "Display name must be at least 2 characters")
    .max(100, "Display name must be at most 100 characters")
    .trim(),
  initialLocalities: z.array(localitySchema),
});

/** One audit action per role, so a filter by action never mixes them up. */
const INSTITUTIONAL_CREATED_ACTION = {
  govt: "institutional_govt_created",
  admin: "institutional_admin_created",
  national: "institutional_national_created",
} as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Optional and last, like deactivate-govt's: tests join a transaction they roll back. */
export type CreateInstitutionalExecutor = typeof db | Tx;

/** Thrown inside the transaction to roll it back with a result code. */
class Refused extends Error {}

/** The one sentence a failed creation reads — never provider or database text. */
export const CREATE_INSTITUTIONAL_FAILED =
  "No se pudo crear la cuenta. Si el problema sigue, consultá al administrador de la plataforma.";
export const CREATE_INSTITUTIONAL_RATE_LIMITED =
  "Hiciste demasiados intentos de alta seguidos. Probá de nuevo en un rato.";

/**
 * Account creations a jurisdiction admin may ATTEMPT (review LOW-3). Generous
 * for staffing a province, far too few to sweep addresses. The platform admin
 * is not limited.
 */
export const DELEGATED_CREATE_LIMIT = { maxPerHour: 30, maxPerDay: 100 } as const;
export const DELEGATED_CREATE_RATE_KEY = "institutional_create_delegated";

/** A failure's code for the logs and the orphan record: SQLSTATE or error name. */
function errorCode(err: unknown): string {
  return pgErrorCode(err) ?? (err instanceof Error ? err.name : "unknown");
}

/**
 * Why `actorUserId` may not create this account, or null when they may. Asked
 * twice with the same inputs: before the auth user exists, and inside the
 * transaction that makes it institutional.
 */
async function creationRefusal(
  exec: CreateInstitutionalExecutor,
  actorUserId: string,
  role: "govt" | "admin" | "national",
  place: string | null,
): Promise<string | null> {
  if (!(await hasAdminAuthority(exec, actorUserId))) return "CAPABILITY_DENIED";
  if (role !== "govt") {
    return (await requirePlatformAdmin(exec, actorUserId))
      ? null
      : JURISDICTION_ADMIN_WRITER_COPY.CREATE_PLATFORM_ROLE;
  }
  return (await requireJurisdictionAdminFor(exec, actorUserId, place))
    ? null
    : JURISDICTION_ADMIN_WRITER_COPY.CREATE_OUTSIDE_PROVINCE;
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createInstitutionalAccountForAuthority(
  actorUserId: string,
  input: {
    role: "govt" | "admin" | "national";
    email: string;
    displayName: string;
    initialLocalities: { province: string; locality: string; localityIndecId?: string | null }[];
  },
  exec: CreateInstitutionalExecutor = db,
): Promise<CreateInstitutionalResult> {
  // 1. Validate inputs
  const parsed = createInstitutionalSchema.safeParse(input);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return { error: `VALIDATION_ERROR: ${firstError.message}` };
  }
  const { role, email, displayName, initialLocalities } = parsed.data;
  if (role === "national" && initialLocalities.length > 0) {
    return {
      error:
        "VALIDATION_ERROR: Un observador nacional no lleva localidades: lee todo el país por su rol.",
    };
  }

  // 1.5 Resolve each initial locality through the canonical catalog before
  // touching auth or the DB. Bad data fails fast with a clear message — no
  // orphan auth users to compensate for. The catalog returns the canonical
  // (Province name, Locality name) pair, which is what we persist, plus the
  // ar_localities row the admin picked (C2b): by INDEC id when the picker sent
  // one, and an ambiguous name without it is refused (resolveGovtLocality).
  const canonicalLocalities: { province: string; locality: string; locality_id: string }[] = [];
  for (const l of initialLocalities) {
    const resolved = await resolveGovtLocality(l);
    if ("error" in resolved) return { error: resolved.error };
    // Two rows naming the same (province, name) would collide on the active
    // unique index and surface as DB_TX_FAILED after the auth user exists.
    // Same row twice is a harmless repeat; two homonyms is a real conflict.
    const clash = canonicalLocalities.find(
      (c) => c.province === resolved.province && c.locality === resolved.locality,
    );
    if (clash) {
      if (clash.locality_id === resolved.localityId) continue;
      return {
        error: `VALIDATION_ERROR: Elegiste dos localidades llamadas ${resolved.locality} en ${resolved.province}. Asigná una sola.`,
      };
    }
    canonicalLocalities.push({
      province: resolved.province,
      locality: resolved.locality,
      locality_id: resolved.localityId,
    });
  }

  // 2. Authority pre-flight: no auth user is created for an actor without it.
  // The place of a govt account is where its grants will lie — the resolved
  // catalogue provinces, never the actor's word.
  const place =
    role === "govt"
      ? await provinceOfProvinceNames(
          exec,
          canonicalLocalities.map((l) => l.province),
        )
      : null;
  const preflight = await creationRefusal(exec, actorUserId, role, place);
  if (preflight) return { error: preflight };

  // A jurisdiction admin (not the platform admin) is rate-limited, and reads
  // one sentence for every refusal below (review LOW-3).
  const delegated = !(await requirePlatformAdmin(exec, actorUserId));
  if (delegated) {
    try {
      await enforceRateLimit(DELEGATED_CREATE_RATE_KEY, actorUserId, DELEGATED_CREATE_LIMIT);
    } catch (err) {
      if (err instanceof RateLimitError) return { error: CREATE_INSTITUTIONAL_RATE_LIMITED };
      throw err;
    }
  }
  /** A delegated refusal: audited (never the address), answered generically. */
  const refuseDelegated = async (reason: string): Promise<CreateInstitutionalResult> => {
    try {
      await writeAuditLog(exec, {
        action: "institutional_create_refused",
        actorUserId,
        payload: { role, reason },
      });
    } catch (auditErr) {
      console.error("institutional_create_refused audit insert failed", auditErr);
    }
    return { error: CREATE_INSTITUTIONAL_FAILED };
  };

  const supabase = createAdminClient();

  // 3. Pre-flight duplicate email check
  const { data: existingUsers, error: listErr } = await supabase.auth.admin.listUsers({
    perPage: 200,
  });
  if (listErr) {
    console.error("createInstitutionalAccountForAuthority: listUsers failed", listErr);
    return { error: CREATE_INSTITUTIONAL_FAILED };
  }

  const duplicateUser = existingUsers?.users.find((u) => u.email === email);
  if (duplicateUser) {
    return delegated ? refuseDelegated("duplicate_email") : { error: "DUPLICATE_EMAIL" };
  }

  // 4. Create the auth user WITHOUT a password and with the first-access flag
  // (pilot T1-P3). The person chooses the password at FIRST_ACCESS_PATH, and
  // every guarded page sends them there until they do.
  //
  // CONFIRMED ON PURPOSE (`email_confirm: true`) — this is the security
  // boundary, not a convenience. The hosted project runs with signup OPEN and
  // autoconfirm ON (PO D2). GoTrue's signup, handed the address of an existing
  // UNCONFIRMED user, sets the caller's password on that user and confirms it:
  // anybody who knew or guessed the operator's address could `signUp` with it
  // before the invitee opened the mail and walk away with a govt/admin/national
  // account (security review, pilot T1-P3). A CONFIRMED user is refused as
  // "already registered". The price is that GoTrue will not send an invite to a
  // confirmed address, so the link is mailed by us in step 7.
  //
  // The arming instant (Postgres clock) rides in the same call: only a session
  // authenticated after it may set the first password (domain/first-access.ts).
  const armedAt = await databaseNow();
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: armedPasswordSetupMetadata(armedAt),
    user_metadata: {
      display_name: displayName,
      // NOTE: do NOT pass role here. The handle_new_user trigger (db/triggers.sql)
      // hardcodes role='owner' and IGNORES all request metadata — a `user_role`
      // key would be dead and misleading. The real role is set by the in-tx
      // UPDATE below (step 5a), which is the authoritative role-setting path.
    },
  });

  if (authErr || !authData.user) {
    // GoTrue's text ("already registered", …) is logged, never returned: for a
    // delegated actor it would be the very oracle LOW-3 closes.
    console.error("createInstitutionalAccountForAuthority: auth createUser failed", authErr);
    return delegated
      ? refuseDelegated("auth_create_failed")
      : { error: CREATE_INSTITUTIONAL_FAILED };
  }

  const authUserId = authData.user.id;

  // 5. DB transaction: update profile + insert assignments + audit_log + notification
  // Note: handle_new_user trigger already created a profile row — we UPDATE it here
  // to set account_type='institutional' and the correct role.
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await exec.transaction(async (tx) => {
      // 0. The authoritative authority check, in this transaction's snapshot
      // (L6): an admin deactivated — or an appointment revoked — between the
      // pre-flight and here is seen.
      const refusal = await creationRefusal(tx, actorUserId, role, place);
      if (refusal) throw new Refused(refusal);

      // a. Update the auto-created profile to institutional
      const updatedRows = await tx
        .update(profiles)
        .set({
          displayName,
          role,
          accountType: "institutional",
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, authUserId))
        .returning({ id: profiles.id });

      if (updatedRows.length < 1) {
        throw new Error("PROFILE_UPDATE_FAILED: profile row not found after auth.admin.createUser");
      }

      // b. If role='govt': insert govt_assignments for each canonical locality
      if (role === "govt" && canonicalLocalities.length > 0) {
        await tx.insert(govtAssignments).values(
          canonicalLocalities.map((l) => ({
            userId: authUserId,
            jurisdictionProvince: l.province,
            jurisdictionLocality: l.locality,
            localityId: l.locality_id,
            grantedByUserId: actorUserId,
          })),
        );
      }

      // c. Insert audit_log
      await tx.insert(auditLog).values({
        actorUserId,
        action: INSTITUTIONAL_CREATED_ACTION[role],
        targetUserId: authUserId,
        payload: {
          role,
          display_name: displayName,
          email,
          initial_localities: canonicalLocalities,
          method: "auth_admin_sdk",
        },
      });

      // d. Welcome notification to the new operator (accumulated post-tx)
      pendingNotifications.push({
        userId: authUserId,
        notificationType: "institutional_account_created",
        title: "Tu cuenta institucional fue creada",
        body: "Un administrador te creó una cuenta. Te enviamos un mail con el link para entrar y elegir tu contraseña.",
        severity: "info",
        ctaLabel: "Acceder",
        ctaUrl: "/iniciar-sesion",
      });
    });
  } catch (txErr) {
    // Compensating delete: remove the auth user to avoid orphans
    try {
      await supabase.auth.admin.deleteUser(authUserId);
    } catch (cleanupErr) {
      // Best-effort orphan logging — do NOT swallow the original error. The
      // record carries ids and error CODES only (review LOW-4): the intended
      // address and raw error text stay in the server log, out of audit_log.
      console.error("institutional create: compensating deleteUser failed", {
        authUserId,
        txErr,
        cleanupErr,
      });
      try {
        await exec.insert(auditLog).values({
          actorUserId,
          action: "institutional_create_orphan_auth_user",
          payload: {
            orphan_auth_user_id: authUserId,
            tx_error_code: errorCode(txErr),
            cleanup_error_code: errorCode(cleanupErr),
          },
        });
      } catch {
        // Swallow — we've done our best
      }
    }
    if (txErr instanceof Refused) return { error: txErr.message };
    // A database refusal of the act itself is translated, never shown raw.
    const refusal = jurisdictionAdminRefusal(txErr);
    if (refusal) return { error: JURISDICTION_ADMIN_REFUSAL_COPY[refusal] };
    console.error("createInstitutionalAccountForAuthority: transaction failed", txErr);
    return { error: CREATE_INSTITUTIONAL_FAILED };
  }

  if (pendingNotifications.length > 0) {
    try {
      await exec.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  // 6. ONE first-access link, generated AFTER the transaction commits so a
  // rolled-back creation never hands anybody a link to an account that no
  // longer exists. It lands on FIRST_ACCESS_PATH with a session in the
  // fragment. Exactly one: a second magic link would overwrite the first in
  // GoTrue's one-time-token slot and void whichever copy went out earlier.
  const redirectTo = `${resolveSiteUrl()}${FIRST_ACCESS_PATH}`;
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  // Empty when generation failed: the panel then points at "Reset credentials".
  const magicLink =
    linkErr || !linkData?.properties?.action_link ? "" : linkData.properties.action_link;

  // 7. Mail it. Best-effort: a mail that cannot go out does not undo a
  // committed account — the admin gets the same link to forward by hand, and
  // the panel says which of the two happened.
  const inviteEmailSent = magicLink
    ? await mailInstitutionalAccessLink({ to: email, displayName, actionLink: magicLink })
    : false;

  return {
    ok: true,
    profileId: authUserId,
    magicLink,
    inviteEmailSent,
  };
}
