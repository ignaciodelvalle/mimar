// Pure domain logic for org onboarding setup checklist (Wave 3 Item 19).
//
// Derives each setup step's done/pending state from real org state —
// nothing is persisted. Steps not applicable to the org_type are omitted.
//
// Steps:
//   1. firstAnimal — register the first animal (intake) — custody org types only
//   2. coverage   — define coverage zones (cobertura)
//   3. members    — invite members (miembros/invitar)
//   4. services   — load services (servicios/nuevo) — if service_offering.create granted
//   5. capacity   — declare capacity (configuracion) — shelter only
//   6. verification — waiting on miMAR (NOT an org action, see below)
//
// The checklist auto-hides when every step the ORG can act on is done.
//
// ---------------------------------------------------------------------------
// Why `firstAnimal` leads the list (org-first readiness finding #5)
// ---------------------------------------------------------------------------
// Every step this checklist used to offer a refugio was CONFIGURATION AROUND AN
// EMPTY ROSTER: coverage zones so it can be alerted about animals it does not
// have, members to help with animals it does not have, capacity to measure
// occupancy of animals it does not have. The one action that turns miMAR into a
// working system for a shelter — registering the first animal — was not on the
// guided path at all, so the guided path led everywhere except to the product.
//
// It leads rather than trails for the same reason: the moment the first animal
// exists, the occupancy KPI, the "Requieren acción" queue and the custody list
// stop being empty shells, and the rest of the checklist starts describing real
// work instead of hypothetical work.
//
// Org-type gating mirrors `capacity`'s (a step only where it is a real job), but
// with the WIDER custody-holding set: a rescue_network holds and rehomes animals
// without declaring shelter capacity, so it needs the intake step and not the
// capacity one. A clinic or a sanitary authority takes no custody at all — the
// intake module is not even in their nav — so the step is omitted entirely
// rather than shown as a task they can never finish.
// ---------------------------------------------------------------------------
// Why `verification` is `waitingOn: "mimar"` and carries no CTA
// ---------------------------------------------------------------------------
// It used to be `{ href: "configuracion", cta: "Enviar documentación", done:
// input.isVerified }`. Every part of that was a promise the product cannot
// keep:
//   - /org/[orgToken]/configuracion has NO document upload. Its closing line
//     is literally "el estado de verificación son gestionados por el equipo de
//     miMAR" — the CTA sent the admin to a page that tells them it is not
//     their job.
//   - `done` can only flip when a miMAR admin presses Verify in the admin
//     portal (src/modules/organizations/application/admin-org-verification/
//     verify-org.ts). Nothing an org member does — no matter how correct —
//     can check that box.
//   - because `isSetupComplete` required EVERY step, an unverified org could
//     never finish onboarding: the checklist stayed pinned to the panel
//     forever, and OrgDailyLoopOrientation (which renders only once the
//     checklist is gone) was unreachable for every unverified org.
// Building a real upload flow is a product decision, not a copy fix, so the
// honest shape is the other one the brief offers: the step stops pretending to
// be an action and becomes a declared WAITING STATE. It still renders (the
// admin should see why the row is unchecked) but with no button and no lie,
// and it no longer holds the rest of onboarding hostage.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SetupStepKey =
  | "firstAnimal"
  | "firstSignedEvent"
  | "coverage"
  | "members"
  | "services"
  | "capacity"
  | "verification";

/**
 * Org types that take custody of animals, and therefore have an intake job at
 * all. Shelters and rescue networks (rescatistas) hold and rehome; clinics and
 * sanitary authorities do not. Kept as an explicit set rather than a
 * "not a clinic" negation so a NEW org_type has to opt in deliberately.
 *
 * Mirrors the `isRehoming` gate the org panel already applies to the custody
 * module cards (app/org/[orgToken]/page.tsx).
 */
const CUSTODY_ORG_TYPES: readonly string[] = ["shelter", "rescue_network"];

/**
 * Org types whose first meaningful act is SIGNING a clinical event rather than
 * taking in an animal. Same explicit-allowlist discipline as CUSTODY_ORG_TYPES,
 * and for the same reason: a new org_type must opt in deliberately.
 *
 * Only `clinic`. A `sanitary_authority` holds no patients and signs no
 * consultations — its work is oversight — and `other` is by definition
 * unspecified. Both keep today's behaviour: no leading step at all. Writing
 * this as `else` (everything that is not custody) was the first attempt and it
 * silently handed a veterinaria's onboarding step to an authority.
 */
const CLINICAL_ORG_TYPES: readonly string[] = ["clinic"];

/**
 * Who has to act for a step to become done.
 *   "org"   — someone inside the organization; `href`/`cta` are non-null.
 *   "mimar" — the miMAR team, out of the org's hands; `href`/`cta` are null
 *             and the step is excluded from `isSetupComplete` /
 *             `firstPendingStep`.
 */
export type SetupStepWaitingOn = "org" | "mimar";

export type SetupStep = {
  key: SetupStepKey;
  /** Short label shown in the checklist. */
  label: string;
  /** Longer hint shown when the step is pending. */
  hint: string;
  /**
   * Route (relative to /org/[orgToken]/) where the user completes the step.
   * `null` when `waitingOn !== "org"` — there is nowhere to send them.
   */
  href: string | null;
  /** CTA button label, or `null` when there is no action to offer. */
  cta: string | null;
  done: boolean;
  waitingOn: SetupStepWaitingOn;
};

/** Input state derived from org + membership data. No DB calls here. */
export type OrgSetupInput = {
  orgType: string;
  /**
   * True when the org has EVER held an animal — any ownership row, ended or
   * not. Only read for custody org types; see CUSTODY_ORG_TYPES.
   *
   * "Ever", not "now", and the distinction is the whole point. This used to be
   * `hasAnimals`, filtered on `endedAt IS NULL`: a shelter that adopted out its
   * last animal flipped back to false, the step un-completed, and the entire
   * checklist REAPPEARED (it auto-hides only while everything is done). The
   * product handed a refugio homework for having succeeded at its job
   * (QA 2026-08-08, S3-F04).
   *
   * The bug underneath was a category error: the step asks a HISTORICAL
   * question — "did you register your first animal?" — and it was answering
   * with a CACHE OF THE PRESENT. That is invariant 3 of this project read
   * backwards. Ownership rows are not deleted on transfer, they get `endedAt`,
   * so dropping that one clause turns the same cheap query into the record of
   * what happened.
   *
   * Consequence accepted by the PO (2026-08-08): once true it stays true, even
   * if the roster empties and the org starts over. The checklist is a
   * PUT-INTO-SERVICE guide, not a status panel — an org with an empty roster
   * does not need to be taught again how to register an animal.
   */
  hasEverHeldAnimal: boolean;
  /**
   * True when the org has EVER authored a clinical event — the non-custody
   * equivalent of `hasEverHeldAnimal`, derived from
   * `pet_events.authorOrganizationId` (the spine, via its own partial index).
   * Only read for non-custody org types.
   */
  hasSignedEvent: boolean;
  /** True when at least one coverage zone exists for the org. */
  hasCoverage: boolean;
  /**
   * Number of active memberships. The admin who created the org already
   * counts; step is done when there is MORE than one member (i.e. at least
   * one other person was invited).
   */
  memberCount: number;
  /**
   * True when the org has the service_offering.create capability granted
   * (only then is the services step applicable).
   */
  canCreateServices: boolean;
  /** True when at least one service offering exists. */
  hasServices: boolean;
  /** True when any capacity column is set (non-null) for a shelter. */
  hasCapacityDeclared: boolean;
  /** True when the org is verified (verified=true on the organizations row). */
  isVerified: boolean;
};

// ---------------------------------------------------------------------------
// Step derivation — pure, no side effects
// ---------------------------------------------------------------------------

/**
 * Derives the list of applicable setup steps for the org, each with their
 * done/pending state computed from the org's real data.
 *
 * Returns an empty array when all steps are done (checklist should hide).
 * Returns only steps applicable to this org_type.
 */
export function deriveSetupSteps(input: OrgSetupInput): SetupStep[] {
  const isShelter = input.orgType === "shelter";
  const isRescueNetwork = input.orgType === "rescue_network";
  const needsCapacity = isShelter; // rescue_network doesn't declare shelter capacity

  const steps: SetupStep[] = [];

  // First animal — leads the actionable steps for any org that takes custody.
  // See the header note for why it is first and why the gate is wider than
  // `capacity`'s.
  if (CUSTODY_ORG_TYPES.includes(input.orgType)) {
    steps.push({
      key: "firstAnimal",
      label: "Primer animal",
      hint: "Registrá tu primer animal — o importá tu planilla completa por CSV desde la misma pantalla.",
      href: "intake",
      cta: "Registrar animal",
      done: input.hasEverHeldAnimal,
      waitingOn: "org",
    });
  } else if (CLINICAL_ORG_TYPES.includes(input.orgType)) {
    // The same idea for a clinic: lead with the one act
    // that turns miMAR into a working system FOR THEM.
    //
    // A clinic used to get no leading step at all — `firstAnimal` is gated on
    // CUSTODY_ORG_TYPES, correctly, because a clinic never holds a patient. But
    // nothing replaced it, so a brand-new veterinaria's guided path opened with
    // coverage zones and inviting members: precisely the "configuration around
    // an empty roster" this file's header calls out and claims to have fixed —
    // fixed for refugios only. The clinic half was never written (found while
    // preparing the vet pilot, 2026-08-08).
    //
    // Signing a clinical event is a clinic's equivalent of a shelter's first
    // intake: the moment the libreta, the professional seal and the owner's
    // timeline stop being empty shells. It is also the one thing only they can
    // do, and the reason a matriculated vet is on the platform at all.
    //
    // Unlike the intake step it is not fully self-serve — it needs a patient to
    // walk in with a DIM code. Accepted by the PO (2026-08-08): in a working
    // veterinaria that is hours, not weeks, and a step that teaches the core
    // loop beats one they can tick without learning anything.
    steps.push({
      key: "firstSignedEvent",
      label: "Primera atención",
      // "el código de la credencial", not "el código DIM": DIM is the internal
      // codename and never appears in copy a user reads (lint:brand). It also
      // matches what the destination screen itself says — CodeEntryForm's own
      // hint is "Ingresá el código de la credencial que te muestra el dueño".
      hint: "Atendé tu primera mascota: pedí el código de la credencial que te muestra el dueño y firmá el acto con tu matrícula.",
      href: "atender",
      cta: "Atender mascota",
      done: input.hasSignedEvent,
      waitingOn: "org",
    });
  }

  steps.push(
    {
      key: "coverage",
      label: "Zonas de cobertura",
      hint: "Definí las zonas donde trabajás para recibir alertas de animales perdidos.",
      href: "cobertura",
      cta: "Definir zonas",
      done: input.hasCoverage,
      waitingOn: "org",
    },
    {
      key: "members",
      label: "Miembros del equipo",
      hint: "Invitá a las personas que trabajan con vos en la organización.",
      href: "miembros/invitar",
      cta: "Invitar miembros",
      // Done when there's at least one non-admin member (memberCount > 1 means
      // someone besides the founding admin was invited).
      done: input.memberCount > 1,
      waitingOn: "org",
    },
  );

  // Services step — only shown when the org has the capability to create them.
  if (input.canCreateServices) {
    steps.push({
      key: "services",
      label: "Servicios",
      hint: "Cargá los servicios que ofrecés (vacunaciones, castraciones, etc.).",
      href: "servicios/nuevo",
      cta: "Cargar servicios",
      done: input.hasServices,
      waitingOn: "org",
    });
  }

  // Capacity step — shelter only.
  if (needsCapacity) {
    steps.push({
      key: "capacity",
      label: "Capacidad del refugio",
      hint: "Declarar tu capacidad permite calcular ocupación y detectar sobre-cupo.",
      href: "configuracion",
      cta: "Declarar capacidad",
      done: input.hasCapacityDeclared,
      waitingOn: "org",
    });
  }

  // Verification — a WAITING STATE, not an action. See the header note.
  steps.push({
    key: "verification",
    label: "Verificación",
    hint: "La revisa el equipo de miMAR con los datos que ya cargaste. No hay nada que enviar desde acá: cuando la aprueben, el estado se actualiza solo.",
    href: null,
    cta: null,
    done: input.isVerified,
    waitingOn: "mimar",
  });

  return steps;
}

/**
 * Returns true when every step the ORGANIZATION can act on is complete.
 *
 * Steps with `waitingOn !== "org"` are excluded on purpose: keeping them in
 * the predicate is what made onboarding uncompletable for unverified orgs
 * (see the header note). They still RENDER — they just cannot hold the
 * checklist open forever.
 */
export function isSetupComplete(steps: SetupStep[]): boolean {
  const actionable = steps.filter((s) => s.waitingOn === "org");
  return actionable.length > 0 && actionable.every((s) => s.done);
}

/**
 * Returns the first pending step the org can actually act on, or null when
 * there is nothing left for them to do. Used to auto-focus a CTA — so a step
 * with no CTA to focus must never be returned.
 */
export function firstPendingStep(steps: SetupStep[]): SetupStep | null {
  return steps.find((s) => !s.done && s.waitingOn === "org") ?? null;
}
