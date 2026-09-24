// Atender (walk-in clinical signing) access resolver.
//
// A veterinary clinic signs clinical events on pets it does NOT hold custody
// of: the owner brings the pet and shows the physical DIM credential. The
// shared pet-access guards (requirePetAccess / requireAlivePetAccess) resolve
// access through an OWNERSHIP row (owner path) or an org CUSTODY row (org
// path) — neither exists for a walk-in, so they fail-closed with "Mascota no
// encontrada o sin permisos." That guard is correct for custody surfaces and
// MUST NOT be weakened.
//
// This resolver is the dedicated authorization boundary for the walk-in case.
// The consent proxy is: the acting member holds `event.write` on THIS org
// (orgToken) AND knows the high-entropy DIM code (31^8, ≈ physical possession
// of the credential). No custody row is required. It resolves ONLY pet
// identity (name/species/status) — never owner PII.
//
// PROVENANCE (#43 keystone): the event authorship tier is bound to the
// SIGNER's validated matrícula, exactly as lib/infra/pet-access.ts computes it
// on the org path. A member with a validated matrícula signs as
// `verified_professional` (authorRole "vet", authorVerified true); anyone else
// signs as `org_registered` (authorRole "shelter", authorVerified false). The
// 3-line mapping below is intentionally mirrored from pet-access.ts (the
// canonical source) rather than shared, to keep this walk-in boundary
// self-contained; keep the two in sync.

import { db, pets, profiles } from "@/db";
import { DIM_TOKEN_PATTERN, normalizeDimTokenInput } from "@/lib/domain/dim-token";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";
import {
  type RateLimitConfig,
  RateLimitError,
  callerIp,
  enforceRateLimit,
} from "@/lib/infra/rate-limit";
import {
  type LiveOrgActorFailureReason,
  resolveLiveOrgActor,
} from "@/src/modules/organizations/infrastructure/authz-resolver";
import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";

// Lookup throttle: stricter than the public /p page (60/400) since the legit
// caller pool is small (a clinic looking up the pet in front of them), but it
// must exist because the DIM code is public → the lookup is an existence-oracle.
const ATENDER_LOOKUP_LIMIT: RateLimitConfig = { maxPerMinute: 20, maxPerHour: 100 };

// Re-exported under the Atender name so call sites keep reading in terms of
// this boundary; the shape itself is owned by lib/domain/dim-token.ts.
export const ATENDER_TOKEN_PATTERN = DIM_TOKEN_PATTERN;

/**
 * Normalize a raw credential code for lookup (trim + ASCII upper-case).
 *
 * Delegates to the shared DIM normaliser (2026-09-23) rather than keeping its
 * own `toUpperCase()`: a Unicode case mapping turns lookalikes (`ı` → `I`)
 * into real codes, and the same rule now governs the `/p/{token}` canonical
 * redirect in middleware.ts — one normaliser, not one per surface.
 */
export function normalizeAtenderToken(raw: string): string {
  return normalizeDimTokenInput(raw);
}

export type AtenderPet = {
  id: string;
  publicToken: string;
  name: string;
  species: string;
  status: "active" | "lost" | "deceased";
  /** "YYYY-MM-DD" or null — feeds the writers' BEFORE_BIRTH plausibility leg. */
  dateOfBirth: string | null;
  /**
   * Estado de la observación antirrábica, para que la pantalla sepa si ofrecer
   * el cierre (2026-09-17).
   *
   * ES UN CAMPO MÁS EN UNA PROYECCIÓN DELIBERADAMENTE ANGOSTA, así que va con su
   * argumento: el encabezado de este archivo dice que resuelve "ONLY pet
   * identity — never owner PII", y esto no lo contradice. El estado de
   * observación es del ANIMAL, no de su dueño, y ya se publica en la credencial
   * pública `/p/{token}` a cualquiera que escanee el QR. No agrega superficie:
   * hace que esta pantalla sepa algo que la calle ya sabe.
   */
  rabiesObservationStatus: string | null;
};

export type AtenderSigner = {
  /** How the signature is attributed in the UI header. */
  label: string;
  matriculaVerified: boolean;
  /** How the signer reads on a printed record ("Nombre (matrícula X)"), or
   * null when the profile has no display name. Writers use it to default
   * "aplicada por"-style payload fields left blank by the signer. */
  recordName: string | null;
};

export type AtenderAccessSuccess = {
  ok: true;
  user: { id: string };
  organizationId: string;
  organizationName: string;
  pet: AtenderPet;
  signer: AtenderSigner;
  eventAuthorship: PetEventAuthorship;
  error: null;
};

/**
 * Why the walk-in surface refused, as a CODE and not only as copy.
 *
 * The code exists for exactly one caller that a string cannot serve: a PAGE
 * meeting SHIFT_EXPIRED has to `redirect("/turno-vencido")`, because the shift
 * ending must SIGN THE OPERATOR OUT and only that route handler can (cookies
 * are not writable during a Server Component render — see its header). A Server
 * ACTION meeting the same refusal renders `error` in place, exactly as it does
 * for every other refusal on this surface.
 *
 * `NO_CAPABILITY` and the token/pet refusals are atender's own; everything else
 * is `resolveLiveOrgActor`'s vocabulary passed straight through, so the two
 * halves of a refusal never disagree about what happened.
 */
export type AtenderRefusalReason =
  | LiveOrgActorFailureReason
  | "NO_CAPABILITY"
  | "BAD_TOKEN"
  | "NOT_FOUND"
  | "DECEASED"
  | "THROTTLED";

export type AtenderAccessFailure = {
  ok: false;
  reason: AtenderRefusalReason;
  error: string;
};

export type AtenderAccessResult = AtenderAccessSuccess | AtenderAccessFailure;

/**
 * Resolve the acting member's authorization on `orgToken` WITHOUT resolving a
 * specific pet. Used by the code-entry page/action to gate the surface before
 * a DIM code is even known. Returns the org + signer authorship context.
 *
 * ===========================================================================
 * IT AUTHORIZES THROUGH resolveLiveOrgActor NOW, AND IT DID NOT UNTIL 2026-08-25
 * ===========================================================================
 * This function used to resolve the caller with a bare `supabase.auth.getUser()`
 * and then import `getGrantedCapabilities` from the authz resolver DIRECTLY —
 * the capability step of that module's guard with the four steps before it
 * skipped. Seven append-only CLINICAL server actions (vaccination, deworming,
 * clinical info, medication start, note, microchip, sterilization) authorize
 * through here and got, in consequence:
 *
 *   - no maintenance kill-switch — a walk-in signature committed mid-window;
 *   - no deactivation refusal — a switched-off institutional account kept
 *     signing;
 *   - NO 8-HOUR SHIFT (B9) — on the one surface in the product that IS the
 *     scenario B9 was written for: a clinic's shared front desk, still
 *     authenticated the next morning, signing events onto a spine that never
 *     forgets.
 *
 * The refusals it could already produce are byte-identical: `requireLiveUser`
 * words NO_SESSION "Sesión expirada." and ACCOUNT_ERASED "Tu cuenta fue
 * eliminada.", which is exactly what the two hand-rolled checks here said. The
 * two ORG refusals keep atender's own wording — that is why the door is
 * `resolveLiveOrgActor` and not `requireCapabilityForOrgToken`, whose generic
 * copy would have replaced a better screen. What is new is the three refusals
 * this surface simply had no way to express.
 *
 * THE SHIFT REACHES AN ORG VET, which is the point and is not free. A clinic vet
 * commonly holds `role: "vet"` / `accountType: "personal"`, so requireLiveUser's
 * institutional predicate does not fire for them; their operator-ness lives in
 * `organization_memberships`. `resolveLiveOrgActor` re-applies the shift for
 * exactly that principal (see authz-resolver.ts), which is why entering through
 * it — rather than through requireLiveUser alone — is what actually closes B9
 * here.
 */
export async function resolveAtenderContext(orgToken: string): Promise<
  | {
      ok: true;
      user: { id: string };
      organizationId: string;
      organizationName: string;
      signer: AtenderSigner;
      eventAuthorship: PetEventAuthorship;
    }
  | AtenderAccessFailure
> {
  const actor = await resolveLiveOrgActor(orgToken);

  if (!actor.ok) {
    // ONE MESSAGE FOR BOTH ORG REFUSALS, deliberately and unchanged: "no such
    // org" and "you are not a member of it" must not be distinguishable here,
    // or the walk-in surface becomes an org-existence oracle for any signed-in
    // account. `error` is null on those two branches by construction, which is
    // what makes forgetting to word them a compile error rather than a leak.
    if (actor.reason === "NO_ORGANIZATION" || actor.reason === "NO_MEMBERSHIP") {
      return { ok: false, reason: actor.reason, error: "No pertenecés a esta organización." };
    }
    return { ok: false, reason: actor.reason, error: actor.error ?? "Sesión expirada." };
  }

  if (!actor.granted.has("event.write")) {
    return {
      ok: false,
      reason: "NO_CAPABILITY",
      error:
        "Necesitás el permiso 'Registrar eventos clínicos' (event.write). Pediselo a un administrador.",
    };
  }

  const organizationId = actor.organization.id;
  const organizationName = actor.organization.displayName;

  // Signer profile: matrícula only — the PROVENANCE tier, not an authorization
  // input. The right-to-erasure lockout that used to be read here is gone from
  // this query on purpose: `resolveLiveOrgActor` → `requireLiveUser` refuses a
  // `profiles.deleted_at` account before this line runs, with the same message,
  // and two copies of a check are two chances for one of them to drift.
  const [signerProfile] = await db
    .select({
      displayName: profiles.displayName,
      matriculaNumber: profiles.matriculaNumber,
      matriculaVerified: profiles.matriculaVerified,
    })
    .from(profiles)
    .where(eq(profiles.id, actor.userId))
    .limit(1);

  const matriculaVerified = signerProfile?.matriculaVerified === true;

  // #43 provenance mapping — mirrored from lib/infra/pet-access.ts (org path).
  const eventAuthorship: PetEventAuthorship = matriculaVerified
    ? {
        authorRole: "vet",
        authorOrganizationId: organizationId,
        authorVerified: true,
      }
    : {
        authorRole: "shelter",
        authorOrganizationId: organizationId,
        authorVerified: false,
      };

  const signerLabel =
    matriculaVerified && signerProfile?.matriculaNumber
      ? `matrícula ${signerProfile.matriculaNumber}`
      : organizationName;

  // How the signer reads on a printed record: name + matrícula for a verified
  // vet, plain name otherwise. Used by writers to fill "aplicada por"-style
  // payload fields the professional understandably leaves blank when they ARE
  // the applier — without it, the shared libreta's Profesional column showed
  // "—" on a SIGNED dose while an owner-declared one showed its cited name
  // (9-role external run, 2026-08-18).
  const signerRecordName = signerProfile?.displayName
    ? matriculaVerified && signerProfile.matriculaNumber
      ? `${signerProfile.displayName} (matrícula ${signerProfile.matriculaNumber})`
      : signerProfile.displayName
    : null;

  return {
    ok: true,
    user: { id: actor.userId },
    organizationId,
    organizationName,
    signer: { label: signerLabel, matriculaVerified, recordName: signerRecordName },
    eventAuthorship,
  };
}

/**
 * Resolve the full walk-in signing context: org authorization (event.write) +
 * the pet identified by its DIM credential token. No custody row is required.
 * Rejects deceased pets (clinical events target living animals — parity with
 * requireAlivePetAccess). Never exposes owner PII.
 */
export async function resolveAtenderPet(
  orgToken: string,
  publicToken: string,
): Promise<AtenderAccessResult> {
  const context = await resolveAtenderContext(orgToken);
  if (!context.ok) return context;

  const normalized = normalizeAtenderToken(publicToken);
  if (!ATENDER_TOKEN_PATTERN.test(normalized)) {
    return { ok: false, reason: "BAD_TOKEN", error: "El formato del código es DIM-XXXX-XXXX." };
  }

  // Throttle the code lookup. The DIM code is DIM's PUBLIC Tier-0 credential, so
  // this authenticated lookup doubles as a national existence-oracle (confirms a
  // code is live + returns name/species). Rate-limit per acting org + IP —
  // mirrors the /p/[publicToken] public-page limiter — so it can't be used for
  // token-space enumeration. Fail-open on limiter-infra error (never block a
  // legit clinical sign because the bucket store hiccuped).
  try {
    const ip = callerIp(await headers());
    await enforceRateLimit(
      "atender_lookup",
      `${context.organizationId}:${ip}`,
      ATENDER_LOOKUP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        ok: false,
        reason: "THROTTLED",
        error: "Demasiados intentos de búsqueda. Esperá un momento e intentá de nuevo.",
      };
    }
    // non-RateLimitError → limiter infra failure → fail open.
  }

  // Resolve ONLY pet identity — no ownerships join, no owner PII.
  const [petRow] = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      status: pets.status,
      // Needed by the atender writers' plausibility guard (BEFORE_BIRTH leg) —
      // pet identity data, not owner PII.
      dateOfBirth: pets.dateOfBirth,
      rabiesObservationStatus: pets.rabiesObservationStatus,
    })
    .from(pets)
    // Art. 16 (Ley 25.326): an erased pet must answer exactly like a code that
    // never existed — same NOT_FOUND, same copy. This resolver gates the seven
    // walk-in clinical WRITERS, so without the filter a clinic could keep
    // appending events to a credential the erasure switched off.
    .where(and(eq(pets.publicToken, normalized), isNull(pets.deletedAt)))
    .limit(1);

  if (!petRow) {
    return {
      ok: false,
      reason: "NOT_FOUND",
      error: `No se encontró ninguna mascota con el código ${normalized}.`,
    };
  }
  if (petRow.status === "deceased") {
    return {
      ok: false,
      reason: "DECEASED",
      error: "Esta mascota está registrada como fallecida y no acepta nuevos eventos.",
    };
  }

  return {
    ok: true,
    user: context.user,
    organizationId: context.organizationId,
    organizationName: context.organizationName,
    pet: petRow,
    signer: context.signer,
    eventAuthorship: context.eventAuthorship,
    error: null,
  };
}
