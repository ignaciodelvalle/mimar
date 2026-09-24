// Use-cases and pure helpers for the "Buscar nuevo hogar" foster CTA.
//
// findRehomeOrgs — query: verified shelter/rescue_network orgs covering the
//   pet's jurisdiction (province/locality). NO capacity filter.
//
// filterRehomeOrgCandidates — pure filter: shelter + rescue_network + verified.
//   Extracted so it can be unit-tested without a DB.
//
// sendRehomeRequest — use-case: notify org admins/coordinators about the foster
//   user's rehome request. Lean MVP — no new schema, best-effort notification.
//   Auth: caller must be the active foster of this pet.
//   Coverage (2026-08-22): the org must WORK WHERE THE PET LIVES — the same
//   `orgCoversZone` predicate the rehome-by-titular flow refuses on (W-4),
//   shared through lib/domain/org-coverage.ts. The picker only lists covering
//   orgs, but this is a server action: any active foster could POST any orgId
//   and land a request in the inbox of an org three provinces away.

import { orgCoversZone } from "@/lib/domain/org-coverage";

import type { FosterRepository } from "../infrastructure/foster-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Pure type — org candidate shape (subset returned from the repo query)
// ---------------------------------------------------------------------------

export type RehomeOrgCandidate = {
  id: string;
  displayName: string;
  orgType: string;
  verified: boolean;
  publicToken: string;
  email: string;
  phone: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

// ---------------------------------------------------------------------------
// Pure filter — testable without DB
// ---------------------------------------------------------------------------

const REHOME_ELIGIBLE_ORG_TYPES = new Set(["shelter", "rescue_network"]);

/**
 * Filters a list of org candidates to those eligible for rehome requests:
 * verified + shelter or rescue_network type.
 */
export function filterRehomeOrgCandidates(orgs: RehomeOrgCandidate[]): RehomeOrgCandidate[] {
  return orgs.filter((org) => org.verified && REHOME_ELIGIBLE_ORG_TYPES.has(org.orgType));
}

// ---------------------------------------------------------------------------
// sendRehomeRequest use-case
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
};

type SendRehomeRequestDeps = {
  repo: typeof FosterRepository;
  actor: Actor;
};

export type SendRehomeRequestInput = {
  petPublicToken: string;
  targetOrgId: string;
};

export async function sendRehomeRequest(
  input: SendRehomeRequestInput,
  deps: SendRehomeRequestDeps,
): Promise<UseCaseResult<void>> {
  const { repo, actor } = deps;
  const { user } = actor;

  // 1. Pet lookup.
  const petRow = await repo.findPetByToken(input.petPublicToken);
  if (!petRow) {
    return { ok: false, error: "Mascota no encontrada." };
  }

  // 2. Auth: verify caller is the active foster.
  const fosterRow = await repo.findActiveFosterByUser(petRow.id, user.id);
  if (!fosterRow) {
    return {
      ok: false,
      error: "No tenés un tránsito activo para esta mascota.",
    };
  }

  // 2b. The animal's state has to make the request MEAN something (2026-08-25).
  // The titular twin (`validateRequestOpen`) refuses lost and deceased; this
  // door did not, and its notification body asserts that the foster "está
  // cuidando a X en tránsito y busca darle un hogar definitivo" — false for an
  // animal nobody can find, and worse for one that died. No case and no spine
  // event ride on this path, so the cost is only the org's inbox and a search
  // effort pointed at the wrong problem; that is still a cost, and the refusal
  // is one branch.
  //
  // The sentences are the twin's, verbatim. They are COPIED rather than
  // imported because `foster -> rehome` is not an allowed module edge (see
  // rehome-rules.ts's coverage note, which moved the shared PREDICATE to
  // lib/domain for the same reason); two string literals did not earn a third
  // module.
  //
  // WHAT PINS THEM (corrected 2026-08-25). The first version of this comment
  // said "the test asserts them by exact text", and that was not a coupling at
  // all: the test asserted its OWN hardcoded literal, so changing the rehome
  // sentence and its own test would have let this copy drift with a green
  // suite. Two independent assertions are not a pin. The test now imports
  // PET_LOST_ERROR / PET_DECEASED_ERROR from rehome's domain and compares
  // against those — a test file is not part of the runtime module graph, so it
  // can reach across the edge the production code may not.
  const petStatus = (petRow as { status: string }).status;
  if (petStatus === "lost") {
    return { ok: false, error: "Esta mascota está reportada como perdida." };
  }
  if (petStatus === "deceased") {
    return { ok: false, error: "Esta mascota está registrada como fallecida." };
  }

  // 3. Validate target org — must exist and be verified shelter/rescue_network.
  const orgRow = await repo.findOrgById(input.targetOrgId);
  if (!orgRow) {
    return { ok: false, error: "Organización no encontrada." };
  }
  if (!REHOME_ELIGIBLE_ORG_TYPES.has(orgRow.orgType)) {
    return {
      ok: false,
      error: "La organización no es de tipo válido para recibir solicitudes de nuevo hogar.",
    };
  }
  if (!orgRow.verified) {
    return { ok: false, error: "La organización no está verificada." };
  }

  // 3b. Coverage — the org has to work where the animal lives (W-4, foster
  // half). Same predicate and same sentence as the titular flow, so whichever
  // door a request comes through, the refusal reads the same.
  const petName = (petRow as { name: string }).name;
  const zone = {
    province: petRow.jurisdictionProvince ?? null,
    locality: petRow.jurisdictionLocality ?? null,
  };
  if (!zone.province) {
    return {
      ok: false,
      error: `${petName} no tiene provincia registrada, así que no se puede elegir una organización por zona.`,
    };
  }
  const coverage = await repo.findOrgCoverage(input.targetOrgId);
  if (!orgCoversZone(coverage, zone)) {
    return {
      ok: false,
      error: `${orgRow.displayName} no cubre la zona de ${petName}. Elegí una organización que trabaje en ${zone.locality ?? zone.province}.`,
    };
  }

  // 4. Resolve foster user contact info.
  const fosterProfile = await repo.findProfileById(user.id);
  const fosterName = fosterProfile?.displayName ?? "Tránsito";
  const fosterPhone = fosterProfile?.phone ?? null;

  const petToken = (petRow as { publicToken: string }).publicToken;

  // 5. Resolve org admins + coordinators for notification fan-out.
  const recipients = await repo.orgAdminAndCoordinatorUserIds(input.targetOrgId);

  const pendingNotifications: NewNotification[] = recipients.map((r) => ({
    userId: r.userId,
    notificationType: "rehome_request_received",
    title: `Solicitud de nuevo hogar: ${petName}`,
    body: [
      `${fosterName} está cuidando a ${petName} en tránsito y busca darle un hogar definitivo.`,
      fosterPhone ? `Contacto: ${fosterPhone}.` : null,
      `Ver mascota: /p/${petToken}`,
    ]
      .filter(Boolean)
      .join(" "),
    severity: "info",
    ctaLabel: "Ver mascota",
    ctaUrl: `/p/${petToken}`,
    relatedPetId: petRow.id,
  }));

  return { ok: true, value: undefined, notifications: pendingNotifications };
}
