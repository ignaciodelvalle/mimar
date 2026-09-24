// Read model behind `/cuidado/{grantToken}` — the invitation page.
//
// IMPORTED DIRECTLY BY THE PAGE, like its sibling get-caretaker-state-for-pet.
// `app/**` sits outside the module graph, so no cross-module edge is created.
//
// WHY THIS IS A READ AND NOTHING ELSE. The spec's scenario says, in as many
// words, that "no ownership row exists yet" while the invitee is reading the
// scope. The invitation page is where a person decides; a page that created the
// grant on view would turn "Aceptar el cuidado" into a decoration and the
// consent checkbox into a form field nobody answered.
//
// WHY THE OUTSIDER BRANCH EXISTS. `public_token` is unguessable, but it travels
// by email and email gets forwarded. The page shows a pet's name and photo and
// the titular's display name — a payload this module has no business handing to
// somebody who is neither party. An outsider gets the shape, not the data:
// enough for the page to say "this invitation is not for you" without leaking
// whose it is. Same posture as requirePetAccess's not-found-or-forbidden.

import { caretakerAutoEndNotice, caretakerScopeSentence } from "../domain/grant-copy";
import type { GrantStatus } from "../domain/types";
import type { CaretakersRepositoryPort } from "./ports";

type Deps = { repo: CaretakersRepositoryPort; now: () => Date };

export type GrantViewerRelation = "invitee" | "titular" | "outsider";

export type GrantView = {
  grantPublicToken: string;
  status: GrantStatus;
  relation: GrantViewerRelation;
  /** Only a PENDING invitation addressed to this viewer can be answered. */
  canRespond: boolean;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  /** Null for an outsider — see the header. */
  pet: { name: string; publicToken: string; photoStoragePath: string | null } | null;
  /** Null for an outsider — see the header. */
  titularName: string | null;
  /** Both halves of what the invitee is agreeing to. Always present. */
  scopeSentence: string;
  /**
   * Non-null only for an ENDED arrangement seen by its caretaker. An `expired`
   * row is deliberately excluded: an unanswered invitation never became an
   * arrangement, so "tu período de cuidado terminó" would describe access the
   * person never had. The state machine draws the same line (no
   * `caretaker_ended` event for `expire_invitation`).
   */
  endedNotice: string | null;
};

export type GrantViewer = {
  userId: string;
  email: string;
  /**
   * GoTrue's `email_confirmed_at` is non-null for this account (A09-1). The
   * e-mail branch of `resolveRelation` is an ADDRESSEE proof, and an address
   * nobody proved proves nothing — an unconfirmed viewer resolves to `outsider`,
   * which is the fail-closed shape this file already documents.
   */
  emailConfirmed: boolean;
};

export async function getGrantForViewer(
  grantPublicToken: string,
  viewer: GrantViewer,
  deps: Deps,
): Promise<GrantView | null> {
  const { repo } = deps;
  const grant = await repo.findGrantByToken(grantPublicToken);
  if (!grant) return null;

  const relation = resolveRelation(grant, viewer);

  const base = {
    grantPublicToken: grant.publicToken,
    status: grant.status,
    relation,
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
    scopeSentence: caretakerScopeSentence(),
  };

  if (relation === "outsider") {
    return {
      ...base,
      canRespond: false,
      note: null,
      pet: null,
      titularName: null,
      endedNotice: null,
    };
  }

  const pet = await repo.findPetSummaryById(grant.petId);
  const titularName = await repo.findDisplayName(grant.grantedByUserId);

  return {
    ...base,
    canRespond: relation === "invitee" && grant.status === "pending",
    note: grant.note,
    pet: pet
      ? {
          name: pet.name,
          publicToken: pet.publicToken,
          photoStoragePath: pet.primaryPhotoStoragePath,
        }
      : null,
    titularName,
    endedNotice:
      relation === "invitee" && grant.status === "ended" && pet
        ? caretakerAutoEndNotice({ petName: pet.name, endedAt: grant.endsAt, now: deps.now() })
        : null,
  };
}

/**
 * Who is looking.
 *
 * The email branch is not a convenience: `caretaker_user_id` is NULL until
 * accept whenever the invitee had no account at designation time, so on their
 * very first visit — the one that matters — an id match is impossible. Same
 * id-or-email pair the accept/reject use-cases match on, so the page cannot
 * offer a button the action would then refuse.
 *
 * `emailConfirmed` is part of that pair as of A09-1, and keeping it here is what
 * preserves the sentence above: the accept use-case refuses an unproved address,
 * so a relation resolved without the term would render "Aceptar el cuidado" over
 * an action that answers "confirmá tu correo".
 */
function resolveRelation(
  grant: { grantedByUserId: string; caretakerUserId: string | null; caretakerEmail: string },
  viewer: GrantViewer,
): GrantViewerRelation {
  if (grant.caretakerUserId && grant.caretakerUserId === viewer.userId) return "invitee";
  if (
    !grant.caretakerUserId &&
    viewer.email &&
    viewer.emailConfirmed &&
    grant.caretakerEmail.toLowerCase() === viewer.email.toLowerCase()
  ) {
    return "invitee";
  }
  if (grant.grantedByUserId === viewer.userId) return "titular";
  return "outsider";
}
