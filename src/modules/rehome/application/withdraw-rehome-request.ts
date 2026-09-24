// Use-case: the titular cancels a rehome_request the org has NOT answered yet
// (rehome-by-titular, spec REQ-3; WU3 review M-3).
//
// WHY THIS EXISTS. The lifecycle has no event opener and no event terminal:
// the case opens with the request action and closes with an action. Until
// this use-case, the only closing action was the org's answer — an org that
// never answers left the request open forever, and REQ-16 then refused the
// titular every other org ("ya hay una solicitud pendiente"). This is the
// titular's own way out of that, and it is the same class of act as the org's
// decline: an action-close, NOT an operator's manual close
// (`manualCloseAllowed` stays false — that flag is the admin/govt generic
// close button on the case detail).
//
// NOTHING ON THE SPINE. A pending request is workflow state, not a fact about
// the animal; cancelling it is the same (design ADR-1, "decline / withdraw
// before accept"). The case row carries `cancelled` + the TITULAR as actor —
// the same closedReason an org decline uses, told apart by who closed it —
// and the `case_closed` timeline entry says so in words (REQ-3: "textually
// distinct from an org decline and from an operator's manual close").
//
// THE LEDGER IS ASKED BEFORE THE STATE GUARD (2026-09-10, with the bearer
// door). This cancel's success invalidates its own precondition: once the case
// is closed there is "no pending request", which is exactly what a RETRY of
// the same cancel — a phone that never saw the 200 — would then be refused
// with, forever. So when the caller hands in a `clientIdempotencyKey`, the
// `case_closed` entry keeps it, and a later call with the same key finds that
// entry FIRST and answers the way the first attempt did: ok, the same case,
// `replayed: true`, nothing written and nobody notified twice. The web sends
// no key and takes the state path it always took.
//
// THE LOOKUP RUNS UNDER THE PET ADVISORY LOCK, the first lock every custody
// writer of this feature takes (repository header, lock order), so two replays
// of one key serialise: the second reads the first's committed entry instead
// of racing it to a "no pending request" refusal.

import {
  NOT_TITULAR_ERROR,
  NO_PENDING_REQUEST_ERROR,
  validateWithdrawRequest,
} from "../domain/rehome-rules";
import type { RehomeWithdrawPort } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

type Deps = {
  repo: RehomeWithdrawPort;
  now: () => Date;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type WithdrawRehomeRequestInput = {
  petPublicToken: string;
  titularUserId: string;
  /** The client's replay key (a UUID), or null from a door that sends none. */
  clientIdempotencyKey?: string | null;
};

export type WithdrawRehomeRequestValue = {
  caseId: string;
  casePublicCode: string;
  petId: string;
  petPublicToken: string;
  receiverOrganizationId: string | null;
  /** `true` when the ledger recognised the key: this cancel had already happened. */
  replayed: boolean;
};

type TxOutcome =
  | {
      ok: true;
      replayed: false;
      caseId: string;
      casePublicCode: string;
      orgId: string;
      orgDisplayName: string;
    }
  | { ok: true; replayed: true; caseId: string; casePublicCode: string; orgId: string | null }
  | { ok: false; error: string };

export async function withdrawRehomeRequest(
  input: WithdrawRehomeRequestInput,
  deps: Deps,
): Promise<UseCaseResult<WithdrawRehomeRequestValue>> {
  const { repo } = deps;
  const key = input.clientIdempotencyKey ?? null;

  const pet = await repo.findPetByToken(input.petPublicToken);
  if (!pet) return { ok: false, error: "Mascota no encontrada." };

  // REQ-1 / REQ-14, re-asserted: the live OWNER row and only that.
  const ownerRow = await repo.findLiveOwnerRow(pet.id, input.titularUserId);
  if (!ownerRow) return { ok: false, error: NOT_TITULAR_ERROR };

  const now = deps.now();

  const outcome = await deps.transaction<TxOutcome>(async (tx) => {
    await repo.acquirePetAdvisoryLock(pet.id, tx);

    // The ledger, before the state guard — see the header.
    if (key !== null) {
      const done = await repo.findRequestWithdrawnByKey(pet.id, input.titularUserId, key, tx);
      if (done) {
        return {
          ok: true,
          replayed: true,
          caseId: done.caseId,
          casePublicCode: done.casePublicCode,
          orgId: done.receiverOrganizationId,
        };
      }
    }

    // The state guard: a readable refusal, re-read under the row lock below.
    const pre = await repo.findOpenRequestForPet(pet.id);
    if (!pre) return { ok: false, error: NO_PENDING_REQUEST_ERROR };

    // The org's answer and this cancel race for the same row; the lock
    // serialises them and the loser reads the flipped status.
    const locked = await repo.lockRequestCase(pre.id, tx);
    if (!locked) return { ok: false, error: NO_PENDING_REQUEST_ERROR };
    const gate = validateWithdrawRequest({
      caseKind: locked.caseKind,
      caseStatus: locked.status,
      caseOpenedByUserId: locked.openedByUserId,
      actingUserId: input.titularUserId,
    });
    if (!gate.ok) return { ok: false, error: gate.error };
    if (!locked.receiverOrganizationId) {
      return { ok: false, error: "La solicitud no tiene una organización destinataria." };
    }

    const org = await repo.findOrgById(locked.receiverOrganizationId, tx);
    const orgName = org?.displayName ?? "la organización";

    await repo.closeRequestCase(
      {
        caseId: locked.id,
        reason: "cancelled",
        closedByUserId: input.titularUserId,
        decision: "withdrawn",
        organizationId: locked.receiverOrganizationId,
        timelineNote: `El titular canceló la solicitud de nuevo hogar antes de que ${orgName} respondiera. El animal sigue con su titular y no se creó ninguna publicación.`,
        now,
        clientIdempotencyKey: key,
      },
      tx,
    );

    return {
      ok: true,
      replayed: false,
      caseId: locked.id,
      casePublicCode: locked.publicCode,
      orgId: locked.receiverOrganizationId,
      orgDisplayName: orgName,
    };
  });

  if (!outcome.ok) return { ok: false, error: outcome.error };

  // A replay wrote nothing and tells nobody again: the org was told the first
  // time, and a second "cancelada" notice for one cancel is a bug in a bandeja.
  if (outcome.replayed) {
    return {
      ok: true,
      value: {
        caseId: outcome.caseId,
        casePublicCode: outcome.casePublicCode,
        petId: pet.id,
        petPublicToken: pet.publicToken,
        receiverOrganizationId: outcome.orgId,
        replayed: true,
      },
      notifications: [],
    };
  }

  const titularName = (await repo.findDisplayName(input.titularUserId)) ?? "El titular";
  const recipients = await repo.orgAdminAndCoordinatorUserIds(outcome.orgId);
  const notifications: NewNotification[] = recipients.map((userId) => ({
    userId,
    notificationType: "rehome_request_withdrawn",
    severity: "info",
    title: `Solicitud de nuevo hogar cancelada: ${pet.name}`,
    body: `${titularName} canceló la solicitud antes de que ${outcome.orgDisplayName} respondiera. No hace falta hacer nada.`,
    dedupeKey: `rehome:request_withdrawn:${outcome.caseId}:${userId}`,
    ctaLabel: "Ver solicitud",
    ctaUrl: `/casos/${outcome.casePublicCode}`,
    relatedPetId: pet.id,
    relatedCaseId: outcome.caseId,
    category: "custody",
  }));

  return {
    ok: true,
    value: {
      caseId: outcome.caseId,
      casePublicCode: outcome.casePublicCode,
      petId: pet.id,
      petPublicToken: pet.publicToken,
      receiverOrganizationId: outcome.orgId,
      replayed: false,
    },
    notifications,
  };
}
