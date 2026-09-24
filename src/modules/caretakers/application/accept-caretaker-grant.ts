// Use-case: the INVITEE accepts a caretaker invitation.
//
// THE ACTOR HERE IS NOT THE TITULAR. Everywhere else in this module the titular
// acts; here the invitee does, on a row addressed to them by token. That
// asymmetry is why the calling action cannot use `requireTitularAccess` — the
// accepting user holds no ownership row on this pet yet, by definition. It
// authorizes with `requireUserOrRedirect` plus the id-or-email match below,
// exactly as `acceptPetTransferAction` does for the same shape of invitation.
//
// THE ONE TRANSACTION. `insertAcceptGrant` writes the ownership row, the
// `caretaker_designated` event and the grant UPDATE together. Splitting them
// would produce, on a mid-way failure, either a caretaker with access and no
// event (unexplainable in the spine) or an event with no access (a lie in an
// append-only log). Neither is recoverable by a retry.
//
// WHY THIS DOES NOT TRIP THE TITULAR-ONLY FENCE, stated rather than left to be
// rediscovered: `caretaker_designated` IS a member of TITULAR_ONLY_EVENT_TYPES
// (a caretaker must not name a sub-caretaker — deny-list row
// `caretaker-sub-designation`), and the writer that emits it is reached from
// this use-case. It is nevertheless safe here because the actor holds NO
// ownership row on the pet at all — that is what "invitee" means — so the role
// the deny-list protects against cannot possibly be the one acting. The grant
// token, minted by the titular under `requireTitularAccess`, IS the authority.
// The repository method carries an inner-writer suffix so the fence can see the
// exemption in the name instead of an allowlist entry.

import { UNCONFIRMED_EMAIL_CARETAKER_ERROR } from "../domain/grant-copy";
import type { CaretakersRepositoryPort } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

type Deps = {
  repo: CaretakersRepositoryPort;
  now: () => Date;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type AcceptCaretakerGrantInput = {
  grantPublicToken: string;
  callerUserId: string;
  /** The caller's authenticated email, resolved by the action from the session. */
  callerEmail: string;
  /**
   * GoTrue's `email_confirmed_at` is non-null for the accepting account.
   *
   * Load-bearing on the e-mail arm below, for the same reason the transfer twin
   * carries it (audit A09-1, PO decision 2026-09-02): `caretaker_user_id` is
   * NULL exactly when the address had no account at designation time, so this
   * comparison is the whole of the proof that the caller is the invitee — and
   * the prize is write access on somebody else's animal plus, with lost-mode
   * disclosure on, the caretaker's name and phone on its public credential.
   */
  callerEmailConfirmed: boolean;
  /**
   * KEY 2 of the two-key public-contact model. Absent means NOT consented —
   * an unchecked checkbox sends no field, and silence is never consent.
   */
  publicContactConsent?: boolean;
};

export type AcceptCaretakerGrantValue = {
  petPublicToken: string | null;
  petName: string;
};

/**
 * A refusal whose message is written FOR the invitee. The catch below surfaces
 * it verbatim instead of the generic "volvé a intentarlo": these are decisions,
 * not hiccups, and retrying cannot change any of them.
 */
class AcceptRefusal extends Error {
  readonly name = "AcceptRefusal";
}

export async function acceptCaretakerGrant(
  input: AcceptCaretakerGrantInput,
  deps: Deps,
): Promise<UseCaseResult<AcceptCaretakerGrantValue>> {
  const { repo, transaction } = deps;
  const now = deps.now();
  const consent = input.publicContactConsent === true;

  const grant = await repo.findGrantByToken(input.grantPublicToken);
  if (!grant) return { ok: false, error: "Invitación no encontrada." };

  if (grant.grantedByUserId === input.callerUserId) {
    return { ok: false, error: "No podés aceptar tu propia invitación." };
  }

  // Id-or-email match: the invitation may have been addressed to an email with
  // no account, and the account created afterwards through the invite link.
  //
  // THE E-MAIL ARM ALSO NEEDS THE ADDRESS TO BE PROVED (A09-1). Knowing an
  // invited address is not the same fact as reading its mail, and only the
  // second one is evidence the row was addressed to whoever is calling. The id
  // arm is untouched: an id was resolved by the titular at designation time and
  // is not a claim about a mailbox.
  const matchesId = grant.caretakerUserId !== null && grant.caretakerUserId === input.callerUserId;
  const callerEmail = (input.callerEmail ?? "").trim().toLowerCase();
  const addressedToCallerEmail =
    callerEmail.length > 0 && grant.caretakerEmail.trim().toLowerCase() === callerEmail;
  if (!matchesId && addressedToCallerEmail && !input.callerEmailConfirmed) {
    return { ok: false, error: UNCONFIRMED_EMAIL_CARETAKER_ERROR };
  }
  if (!matchesId && !addressedToCallerEmail) {
    return { ok: false, error: "Esta invitación no es para tu cuenta." };
  }

  if (grant.status !== "pending") {
    return { ok: false, error: "Esta invitación ya no está disponible." };
  }
  if (grant.endsAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      error: "El período de cuidado ya terminó. Pedile al titular que te invite de nuevo.",
    };
  }

  const pet = await repo.findPetSummaryById(grant.petId);

  try {
    await transaction(async (tx) => {
      // Stale-read guard, the acceptPetTransfer shape: re-read the row under a
      // lock and re-check. Between the read above and this line the titular may
      // have cancelled, or the 7-day cron may have expired it.
      const locked = await repo.findGrantByIdForUpdate(grant.id, tx);
      if (!locked || locked.status !== "pending") {
        throw new AcceptRefusal("Esta invitación ya no está disponible.");
      }

      // THE INVITATION DOES NOT SURVIVE A CHANGE OF OWNER (H4).
      //
      // A grant is an agreement between the TITULAR and one person. Day 0 the
      // titular invites; day 1 the pet changes hands (a P2P transfer, an
      // adoption finalize, a decomiso, a resolved dispute); day 2 this runs.
      // Without the check the invitee becomes an active caretaker on a
      // STRANGER'S pet: write access on the new owner's animal, a row in a panel
      // nobody filled in, and — with the new owner's lost-mode disclosure toggle
      // on — their name and phone published on that pet's public credential.
      // The new owner has no remedy either: cancel and revoke both belong to the
      // granter, who no longer has access, so the only exit is expiry (180 days).
      // It is also DIRIGIBLE, not just an accident: designate an accomplice,
      // sell the pet, have them accept inside the 7-day invitation window.
      //
      // INSIDE the transaction, after the locked re-read, for the same reason
      // that re-read exists: every pre-transaction read is stale by
      // construction, and the hand-off writers close ownership rows in a
      // transaction of their own.
      const granterIsStillTitular = await repo.hasLiveTitularOwnership(
        locked.petId,
        locked.grantedByUserId,
        tx,
      );
      if (!granterIsStillTitular) {
        throw new AcceptRefusal(
          "Quien te invitó ya no es titular de esta mascota. Pedile al titular actual que te invite de nuevo.",
        );
      }

      await repo.insertAcceptGrant(
        {
          grantId: grant.id,
          petId: grant.petId,
          caretakerUserId: input.callerUserId,
          grantPublicToken: grant.publicToken,
          endsAt: grant.endsAt,
          note: grant.note,
          publicContactConsent: consent,
          now,
        },
        tx,
      );
    });
  } catch (err) {
    // A refusal is an answer, not a failure: surface the sentence written for
    // the invitee. Anything else is an internal fault and gets the retry copy.
    if (err instanceof AcceptRefusal) {
      return { ok: false, error: err.message };
    }
    console.error("[caretakers/accept] accept transaction failed:", err);
    return {
      ok: false,
      error: "No pudimos aceptar la invitación. Volvé a intentarlo en unos minutos.",
    };
  }

  const petName = pet?.name ?? "tu mascota";
  const caretakerName = (await repo.findDisplayName(input.callerUserId)) ?? "Tu cuidador/a";
  const endsAtLabel = formatArDate(grant.endsAt);

  const notifications: NewNotification[] = [
    {
      userId: grant.grantedByUserId,
      notificationType: "caretaker_invitation_accepted",
      // Stable across: a retry of this action (the accept transaction is
      // guarded by the pending→accepted status flip, so a genuine second accept
      // cannot happen; what this key absorbs is a re-flush of the SAME accept).
      // Distinct across: other grants. An invitation is accepted at most once,
      // so there is no legitimate second copy to protect.
      dedupeKey: `caretaker:invitation_accepted:${grant.id}:${grant.grantedByUserId}`,
      severity: "success",
      title: `${caretakerName} aceptó cuidar a ${petName}`,
      body: `El cuidado temporal va hasta el ${endsAtLabel}. Podés finalizarlo cuando quieras.`,
      ctaLabel: "Ver mascota",
      ctaUrl: pet ? `/mis-mascotas/${pet.publicToken}` : "/mis-mascotas",
      relatedPetId: grant.petId,
      category: "custody",
    },
  ];

  return {
    ok: true,
    value: { petPublicToken: pet?.publicToken ?? null, petName },
    notifications,
  };
}

function formatArDate(date: Date): string {
  return date.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}
