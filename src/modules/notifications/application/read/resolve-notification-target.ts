// Use-case: where ONE notification leads, for the person reading it, NOW.
//
// THE PROBLEM IT SOLVES
// ---------------------------------------------------------------------------
// A notification's `cta_url` is a string its writer chose at send time. By the
// time somebody taps it the world has moved: the transfer was accepted, the
// person left the org, the custody episode closed. The 2026-10-06 audit found
// three families of dead ends that all come from trusting the stored string — a
// case link an org party cannot read, a pet link sent to somebody who no longer
// holds the pet, and a web path the app has no screen for — and every one of
// them ended on "información no disponible".
//
// So the destination is decided HERE, at read time, by the same access
// functions the destination page itself runs, and the answer is never a 404:
//
//     case (canReadCase) → pet (holder access, or the former-owner read during
//     an open custody episode) → a section the viewer can enter → explanation.
//
// The registry (`@dim/contract/notifications`' NOTIFICATION_KINDS) says where
// to look FIRST; the order above is the fallback. The explanation state is the
// floor: it says why the destination is gone and, when something is pending,
// who has to act.
//
// PURE OVER PROBES. Every database question goes through `NotificationTargetProbes`,
// so the decision rule is unit-testable outcome by outcome and the DB-backed
// adapter (`../../infrastructure/notification-target-probes.ts`) is the only
// part that touches tables.

import type { NotificationTargetOutcomeV1 } from "@dim/contract/api";
import { notificationExplanationAppRoute, notificationExplanationWebPath } from "@dim/contract/api";
import { type DeepLinkName, appRoutePath, matchWebPath } from "@dim/contract/links";
import {
  NOTIFICATION_ACTOR_COPY,
  NOTIFICATION_REASON_COPY,
  type NotificationDestination,
  type NotificationKindSpec,
  type NotificationPendingActor,
  type NotificationTargetReason,
  UNKNOWN_NOTIFICATION_KIND_SPEC,
  notificationKindSpec,
} from "@dim/contract/notifications";

/** The columns of one `notifications` row the resolver reads. */
export type NotificationTargetRow = {
  id: string;
  notificationType: string;
  title: string;
  body: string | null;
  ctaUrl: string | null;
  relatedPetId: string | null;
  relatedCaseId: string | null;
};

export type NotificationTargetViewer = {
  userId: string;
  role: "owner" | "vet" | "govt" | "admin" | "national";
};

/** What the resolver needs to know about a case. */
export type CaseFacts = {
  publicCode: string;
  caseKind: string;
  /** open | escalated | closed | merged */
  status: string;
  closedReason: string | null;
  jurisdictionLocality: string | null;
  petId: string | null;
  petName: string | null;
  openedByOrganization: { id: string; displayName: string } | null;
  receiverOrganization: { id: string; displayName: string } | null;
};

export type PetFacts = { id: string; publicToken: string; name: string };

export type NotificationTargetProbes = {
  /** A case by id or public code, or null when it does not exist. */
  findCase(ref: { caseId: string | null; publicCode: string | null }): Promise<CaseFacts | null>;
  /** `canReadCase` for this viewer — the rule `/casos/{code}` enforces. */
  canReadCase(publicCode: string): Promise<boolean>;
  findPet(ref: { petId: string | null; publicToken: string | null }): Promise<PetFacts | null>;
  /** `resolvePetHolderAccess(...).kind !== "none"` — the rule `/mis-mascotas/{token}` enforces. */
  holdsPet(publicToken: string): Promise<boolean>;
  /** `getFormerOwnerReadAccess(...).ok` — the web's read-only view during an open custody episode. */
  formerOwnerRead(publicToken: string): Promise<boolean>;
  /** The viewer's live non-titular row on a pet (co_owner, foster, caretaker), if any. */
  liveNonTitularRole(petId: string): Promise<string | null>;
  findOrgByToken(orgToken: string): Promise<{ id: string; displayName: string } | null>;
  isActiveOrgMember(orgId: string): Promise<boolean>;
  /** A membership that existed and has ended (`left_at` set), with no live one. */
  hadEndedMembership(orgId: string): Promise<boolean>;
};

export type ResolvedNotificationTarget = {
  notificationId: string;
  notificationType: string;
  outcome: NotificationTargetOutcomeV1;
  primaryDestination: NotificationDestination;
  webHref: string;
  appRoute: string;
  webOnly: boolean;
  reason: NotificationTargetReason;
  reasonCopy: string | null;
  actorCopy: string | null;
  pendingActor: NotificationPendingActor;
  title: string;
  body: string | null;
};

// ---------------------------------------------------------------------------
// Reading the stored CTA
// ---------------------------------------------------------------------------

/** Literal siblings of `/mis-mascotas/{token}` that are not a token. */
const MY_PETS_STATIC_SEGMENTS: ReadonlySet<string> = new Set([
  "nueva",
  "postulaciones",
  "reclamar",
]);

export type StoredCta =
  | { kind: "case"; publicCode: string; path: string }
  | { kind: "pet"; publicToken: string; path: string }
  | { kind: "section"; path: string }
  | { kind: "external" };

/** What the writer's `cta_url` names, read structurally. `null` for no CTA. */
export function readStoredCta(ctaUrl: string | null): StoredCta | null {
  if (ctaUrl === null || ctaUrl.trim() === "") return null;
  const url = ctaUrl.trim();
  if (!url.startsWith("/") || url.startsWith("//")) return { kind: "external" };
  const pathOnly = url.split("#")[0]?.split("?")[0] ?? "";
  const segments = pathOnly.split("/");
  if (segments[1] === "casos" && segments[2] && segments.length === 3) {
    return { kind: "case", publicCode: decodeURIComponent(segments[2]), path: url };
  }
  if (segments[1] === "mis-mascotas" && segments[2] && !MY_PETS_STATIC_SEGMENTS.has(segments[2])) {
    return { kind: "pet", publicToken: decodeURIComponent(segments[2]), path: url };
  }
  return { kind: "section", path: url };
}

const resolveAppRoute = appRoutePath as (
  name: DeepLinkName,
  params: Record<string, string>,
) => string | null;

/** The in-app route for a web path, or `null` when the app has no screen for it. */
export function appRouteForWebPath(path: string): string | null {
  const match = matchWebPath(path);
  if (match === null) return null;
  return resolveAppRoute(match.name, match.params);
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const CLOSED_STATES = new Set(["closed", "merged"]);

function resolvedStateLabel(caseFacts: CaseFacts): string {
  if (caseFacts.status === "merged") return "se unificó con otro caso";
  switch (caseFacts.closedReason) {
    case "resolved":
      return "el caso está resuelto";
    case "cancelled":
      return "el caso se canceló";
    case "auto_expired":
      return "el caso se cerró por falta de respuesta";
    default:
      return "el caso está cerrado";
  }
}

async function counterpartyName(
  caseFacts: CaseFacts | null,
  probes: NotificationTargetProbes,
): Promise<string | null> {
  if (caseFacts === null) return null;
  const { receiverOrganization: receiver, openedByOrganization: opener } = caseFacts;
  if (receiver && !(await probes.isActiveOrgMember(receiver.id))) return receiver.displayName;
  if (opener && !(await probes.isActiveOrgMember(opener.id))) return opener.displayName;
  return null;
}

async function actorCopyFor(
  spec: NotificationKindSpec,
  caseFacts: CaseFacts | null,
  probes: NotificationTargetProbes,
): Promise<string | null> {
  if (caseFacts !== null && CLOSED_STATES.has(caseFacts.status)) {
    return NOTIFICATION_ACTOR_COPY.resolved(resolvedStateLabel(caseFacts));
  }
  switch (spec.pendingActor) {
    case "recipient":
      return spec.action ? NOTIFICATION_ACTOR_COPY.recipient(spec.action) : null;
    case "counterparty":
      return spec.counterpartyAction
        ? NOTIFICATION_ACTOR_COPY.counterparty(
            await counterpartyName(caseFacts, probes),
            spec.counterpartyAction,
          )
        : null;
    case "authority":
      return NOTIFICATION_ACTOR_COPY.authority(caseFacts?.jurisdictionLocality ?? null);
    case "none":
      return null;
    default: {
      const unhandled: never = spec.pendingActor;
      throw new Error(`Unhandled pending actor: ${String(unhandled)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Section access
// ---------------------------------------------------------------------------

type SectionVerdict = { ok: true } | { ok: false; endedOrg: string | null };

async function canEnterSection(
  path: string,
  viewer: NotificationTargetViewer,
  probes: NotificationTargetProbes,
): Promise<SectionVerdict> {
  const segments = (path.split("#")[0]?.split("?")[0] ?? "").split("/");
  const root = segments[1] ?? "";
  if (root === "admin") {
    return viewer.role === "admin" || viewer.role === "national"
      ? { ok: true }
      : { ok: false, endedOrg: null };
  }
  if (root === "gob") {
    return viewer.role === "govt" || viewer.role === "admin" || viewer.role === "national"
      ? { ok: true }
      : { ok: false, endedOrg: null };
  }
  if (root === "org" && segments[2]) {
    const org = await probes.findOrgByToken(decodeURIComponent(segments[2]));
    if (org === null) return { ok: false, endedOrg: null };
    if (await probes.isActiveOrgMember(org.id)) return { ok: true };
    return {
      ok: false,
      endedOrg: (await probes.hadEndedMembership(org.id)) ? org.displayName : null,
    };
  }
  // Everything else is a session page about the viewer's own account
  // (`/cuenta/…`, `/mis-turnos`, `/transferencias/{token}`, `/cuidado/{token}`)
  // or a public one (`/p/{token}`, `/adoptar`): each renders its own state for
  // whoever holds the session or the link, and none of them 404s its addressee.
  return { ok: true };
}

/**
 * The two case refusals that are DECISIONS rather than gaps, each with its own
 * sentence: the org that filed a welfare denuncia (the 2026-08-17 legal review
 * shaped that reader set), and a co-holder of the pet — co_owner, foster or
 * caretaker — on a titular-only case (design F2). Widening either is pending
 * with the PO / legal; until then the viewer is told why, not "no existe".
 */
async function reservedCaseExplanation(
  caseFacts: CaseFacts,
  probes: NotificationTargetProbes,
): Promise<{ reason: NotificationTargetReason; copy: string } | null> {
  if (caseFacts.caseKind === "welfare_denuncia" && caseFacts.openedByOrganization) {
    if (await probes.isActiveOrgMember(caseFacts.openedByOrganization.id)) {
      return {
        reason: "case_reserved_to_investigators",
        copy: NOTIFICATION_REASON_COPY.case_reserved_to_investigators(
          caseFacts.jurisdictionLocality,
        ),
      };
    }
  }
  if (caseFacts.petId && (await probes.liveNonTitularRole(caseFacts.petId)) !== null) {
    return {
      reason: "case_titular_only",
      copy: NOTIFICATION_REASON_COPY.case_titular_only(caseFacts.petName),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

const FALLBACK_ORDER: readonly Exclude<NotificationDestination, "none">[] = [
  "case",
  "pet",
  "section",
];

/** One resolution in progress: the inputs, and what each attempt learned. */
type Attempt = {
  row: NotificationTargetRow;
  viewer: NotificationTargetViewer;
  probes: NotificationTargetProbes;
  spec: NotificationKindSpec;
  stored: StoredCta | null;
  /** The case the row is about, once found (readable or not). */
  caseFacts: CaseFacts | null;
  deniedCase: CaseFacts | null;
  deniedPet: PetFacts | null;
  endedOrg: string | null;
};

async function landed(
  attempt: Attempt,
  outcome: Exclude<NotificationTargetOutcomeV1, "explain">,
  webHref: string,
  appRoute: string | null,
): Promise<ResolvedNotificationTarget> {
  return {
    ...baseOf(attempt),
    outcome,
    webHref,
    // A destination the app has no screen for is still a destination: the app
    // shows the explanation screen, which offers the browser (`webOnly`).
    appRoute: appRoute ?? notificationExplanationAppRoute(attempt.row.id),
    webOnly: appRoute === null,
    reason: appRoute === null ? "web_only" : "destination",
    reasonCopy: appRoute === null ? NOTIFICATION_REASON_COPY.web_only() : null,
    actorCopy: await actorCopyFor(attempt.spec, attempt.caseFacts, attempt.probes),
  };
}

function explained(
  attempt: Attempt,
  reason: NotificationTargetReason,
  reasonCopy: string,
  actorCopy: string | null,
): ResolvedNotificationTarget {
  return {
    ...baseOf(attempt),
    outcome: "explain",
    webHref: notificationExplanationWebPath(attempt.row.id),
    appRoute: notificationExplanationAppRoute(attempt.row.id),
    webOnly: false,
    reason,
    reasonCopy,
    actorCopy,
  };
}

function baseOf(attempt: Attempt) {
  return {
    notificationId: attempt.row.id,
    notificationType: attempt.row.notificationType,
    primaryDestination: attempt.spec.primaryDestination,
    pendingActor: attempt.spec.pendingActor,
    title: attempt.row.title,
    body: attempt.row.body,
  };
}

async function tryCase(attempt: Attempt): Promise<ResolvedNotificationTarget | null> {
  const { row, stored, probes, spec } = attempt;
  const publicCode = stored?.kind === "case" ? stored.publicCode : null;
  if (publicCode === null && row.relatedCaseId === null) return null;
  const found = await probes.findCase({ caseId: row.relatedCaseId, publicCode });
  if (found === null) return null;
  attempt.caseFacts = found;
  if (await probes.canReadCase(found.publicCode)) {
    const href = `/casos/${encodeURIComponent(found.publicCode)}`;
    return landed(attempt, "case", href, appRouteForWebPath(href));
  }
  attempt.deniedCase = found;
  // Two refusals are decisions, not gaps, and they explain themselves rather
  // than fall through to the pet: widening either reader set is pending with
  // the PO / legal (plan notificaciones-destinos-2026-10).
  const reserved = await reservedCaseExplanation(found, probes);
  if (reserved === null) return null;
  return explained(
    attempt,
    reserved.reason,
    reserved.copy,
    await actorCopyFor(spec, found, probes),
  );
}

async function tryPet(attempt: Attempt): Promise<ResolvedNotificationTarget | null> {
  const { row, stored, probes, spec } = attempt;
  const publicToken = stored?.kind === "pet" ? stored.publicToken : null;
  const petId = row.relatedPetId ?? attempt.caseFacts?.petId ?? null;
  if (publicToken === null && petId === null) return null;
  const pet = await probes.findPet({ petId, publicToken });
  if (pet === null) return null;
  const root = `/mis-mascotas/${encodeURIComponent(pet.publicToken)}`;
  if (await probes.holdsPet(pet.publicToken)) {
    // The writer's own pet-scoped page when it named one for THIS pet; the
    // registry's face otherwise (an external link, a list, nothing at all).
    const ownPage = stored?.kind === "pet" && stored.publicToken === pet.publicToken;
    const href = ownPage ? stored.path : spec.petFace ? `${root}/${spec.petFace}` : root;
    return landed(attempt, "pet", href, appRouteForWebPath(href) ?? appRouteForWebPath(root));
  }
  if (await probes.formerOwnerRead(pet.publicToken)) {
    // The web renders the read-only custody view at the pet's own page, and the
    // app's pet screen asks the API for the same face.
    return landed(attempt, "pet", root, appRouteForWebPath(root));
  }
  attempt.deniedPet = pet;
  return null;
}

async function trySection(attempt: Attempt): Promise<ResolvedNotificationTarget | null> {
  const { stored } = attempt;
  if (stored?.kind !== "section") return null;
  // A notification ABOUT a case or a pet whose subject was found and refused
  // explains the refusal; a generic list ("/mis-mascotas") in its place would
  // hide what happened. The section is a fallback only when it is the kind's
  // own destination, or when no subject could be identified at all.
  const subjectRefused = attempt.deniedCase !== null || attempt.deniedPet !== null;
  if (subjectRefused && attempt.spec.primaryDestination !== "section") return null;
  const verdict = await canEnterSection(stored.path, attempt.viewer, attempt.probes);
  if (verdict.ok) return landed(attempt, "section", stored.path, appRouteForWebPath(stored.path));
  attempt.endedOrg = attempt.endedOrg ?? verdict.endedOrg;
  return null;
}

const ATTEMPTS: Record<
  Exclude<NotificationDestination, "none">,
  (attempt: Attempt) => Promise<ResolvedNotificationTarget | null>
> = { case: tryCase, pet: tryPet, section: trySection };

/** The floor: why the destination is gone, from what the attempts learned. */
async function explanationFor(attempt: Attempt): Promise<ResolvedNotificationTarget> {
  const { spec, probes, row, deniedCase, deniedPet, endedOrg } = attempt;

  if (spec.primaryDestination === "none") {
    return explained(
      attempt,
      "informational",
      NOTIFICATION_REASON_COPY.informational(spec.informational ?? null),
      null,
    );
  }

  // An org party whose membership ended — on the case, or on the stored section.
  const caseOrgs = deniedCase
    ? [deniedCase.openedByOrganization, deniedCase.receiverOrganization]
    : [];
  for (const org of caseOrgs) {
    if (org && (await probes.hadEndedMembership(org.id))) {
      return explained(
        attempt,
        "membership_ended",
        NOTIFICATION_REASON_COPY.membership_ended(org.displayName),
        null,
      );
    }
  }
  if (endedOrg !== null) {
    return explained(
      attempt,
      "membership_ended",
      NOTIFICATION_REASON_COPY.membership_ended(endedOrg),
      null,
    );
  }

  // "Ya no tenés a {mascota} a cargo" is the honest sentence only when the
  // notification was ABOUT the reader's pet. When it was about a case the
  // reader is not a party to, the pet fallback was a courtesy that failed too,
  // and the case is what to explain — the reader may never have held the pet.
  const caseFirst = deniedCase !== null && spec.primaryDestination === "case";
  if (deniedPet !== null && !caseFirst) {
    return explained(
      attempt,
      "pet_no_longer_held",
      NOTIFICATION_REASON_COPY.pet_no_longer_held(deniedPet.name, row.body ?? row.title),
      null,
    );
  }

  if (deniedCase !== null) {
    return explained(
      attempt,
      "case_not_available",
      NOTIFICATION_REASON_COPY.case_not_available(),
      await actorCopyFor(spec, deniedCase, probes),
    );
  }

  // Nothing to look at: no case, no pet, no section the stored CTA names (an
  // erased row, an external link, a writer that stored nothing). Say so, and
  // who acts if the registry knows.
  return explained(
    attempt,
    "informational",
    NOTIFICATION_REASON_COPY.informational(null),
    await actorCopyFor(spec, attempt.caseFacts, probes),
  );
}

export async function resolveNotificationTarget(
  row: NotificationTargetRow,
  viewer: NotificationTargetViewer,
  probes: NotificationTargetProbes,
): Promise<ResolvedNotificationTarget> {
  const spec = notificationKindSpec(row.notificationType) ?? UNKNOWN_NOTIFICATION_KIND_SPEC;
  const attempt: Attempt = {
    row,
    viewer,
    probes,
    spec,
    stored: readStoredCta(row.ctaUrl),
    caseFacts: null,
    deniedCase: null,
    deniedPet: null,
    endedOrg: null,
  };

  if (spec.primaryDestination !== "none") {
    const order = [
      spec.primaryDestination,
      ...FALLBACK_ORDER.filter((d) => d !== spec.primaryDestination),
    ];
    for (const destination of order) {
      const result = await ATTEMPTS[destination](attempt);
      if (result !== null) return result;
    }
  }

  return explanationFor(attempt);
}
