// Read model: "what is this pet's caretaker situation right now?"
//
// IMPORTED DIRECTLY BY THE PAGE. `app/**` sits outside the module graph, so
// `app/(app)/mis-mascotas/[publicToken]/page.tsx` calling this creates no
// cross-module edge. The tempting shortcut — a `pets` use-case that fetches
// caretaker state — is precisely the import that would invert the dependency
// fence (design H). Do not add one.

import type { CaretakersRepositoryPort } from "./ports";

type Deps = { repo: CaretakersRepositoryPort; now: () => Date };

export type ActiveCaretaker = {
  grantId: string;
  grantPublicToken: string;
  caretakerUserId: string;
  caretakerName: string;
  startsAt: Date;
  endsAt: Date;
  /**
   * KEY 2 of the two-key public-contact model. Non-null means the caretaker
   * consented at accept; the titular's own disclosure toggle is key 1. The
   * toggle must not even RENDER while this is null.
   */
  publicContactConsentAt: Date | null;
};

export type PendingCaretakerInvitation = {
  grantId: string;
  grantPublicToken: string;
  caretakerEmail: string;
  caretakerUserId: string | null;
  startsAt: Date;
  endsAt: Date;
};

/**
 * An arrangement that ENDED ON ITS OWN, recently enough to still be news.
 *
 * THE POINT OF THIS SLOT. `ends_at` passing removes ACCESS. It says nothing
 * whatsoever about where the animal is — the cron reads a clock, not a
 * doorstep. A cockpit that simply dropped the caretaker banner would leave the
 * titular to infer "she brought Pampa back", which is a conclusion the system
 * has no evidence for and the worst possible one to be wrong about.
 *
 * Only `expired` reaches here. The other outcomes are not news:
 *   - `revoked_by_owner`      — the titular did it themselves, minutes ago.
 *   - `withdrawn_by_caretaker` and the account-deactivation path — both send
 *     the titular a notification at the moment they happen.
 *   - `returned`              — the animal IS back; there is nothing to resolve.
 */
export type RecentlyEndedCaretaker = {
  caretakerName: string;
  /** When the arrangement was due to end — the date the copy shows. */
  endsAt: Date;
  /** When it actually closed. */
  endedAt: Date;
  outcome: "expired";
};

export type CaretakerState = {
  active: ActiveCaretaker | null;
  pending: PendingCaretakerInvitation | null;
  recentlyEnded: RecentlyEndedCaretaker | null;
};

/**
 * How long the lapsed-arrangement notice stays up.
 *
 * Bounded on purpose: a banner that never goes away stops being read, and a
 * month is long enough for a return to be coordinated or a claim to be started.
 * After that the arrangement is history, and history lives in the spine.
 */
export const RECENT_AUTO_END_WINDOW_DAYS = 30;

export async function getCaretakerStateForPet(petId: string, deps: Deps): Promise<CaretakerState> {
  const { repo } = deps;
  const now = deps.now();

  const open = await repo.findOpenGrantsForPet(petId);

  // An `accepted` row past its `ends_at` is NOT active. The cron closes those
  // once a day; between `ends_at` and the next 04:00 run the row still says
  // accepted, and RLS (has_titular_write_access) already stopped honouring it.
  // Reporting it as active here would have the cockpit promise an access that
  // the database no longer grants.
  const acceptedRow = open.find(
    (g) => g.status === "accepted" && g.endsAt.getTime() > now.getTime(),
  );
  const pendingRow = open.find((g) => g.status === "pending");

  let active: ActiveCaretaker | null = null;
  if (acceptedRow?.caretakerUserId) {
    active = {
      grantId: acceptedRow.id,
      grantPublicToken: acceptedRow.publicToken,
      caretakerUserId: acceptedRow.caretakerUserId,
      caretakerName: (await repo.findDisplayName(acceptedRow.caretakerUserId)) ?? "Tu cuidador/a",
      startsAt: acceptedRow.startsAt,
      endsAt: acceptedRow.endsAt,
      publicContactConsentAt: acceptedRow.publicContactConsentAt,
    };
  }

  const pending: PendingCaretakerInvitation | null = pendingRow
    ? {
        grantId: pendingRow.id,
        grantPublicToken: pendingRow.publicToken,
        caretakerEmail: pendingRow.caretakerEmail,
        caretakerUserId: pendingRow.caretakerUserId,
        startsAt: pendingRow.startsAt,
        endsAt: pendingRow.endsAt,
      }
    : null;

  // Only asked when nothing is running. A live arrangement is the answer to
  // "who is looking after this animal?", and stacking last month's lapse
  // underneath it would give the cockpit two caretaker stories at once — plus
  // an extra query on every profile load of every pet, for a banner that would
  // not render anyway.
  const recentlyEnded = active ? null : await resolveRecentlyEnded(petId, deps, now);

  return { active, pending, recentlyEnded };
}

async function resolveRecentlyEnded(
  petId: string,
  deps: Deps,
  now: Date,
): Promise<RecentlyEndedCaretaker | null> {
  const ended = await deps.repo.findLastEndedGrantForPet(petId);
  if (!ended || ended.endedReason !== "expired") return null;

  const ageMs = now.getTime() - ended.endedAt.getTime();
  if (ageMs > RECENT_AUTO_END_WINDOW_DAYS * 24 * 60 * 60 * 1000) return null;

  return {
    caretakerName: ended.caretakerUserId
      ? ((await deps.repo.findDisplayName(ended.caretakerUserId)) ?? "Tu cuidador/a")
      : "Tu cuidador/a",
    endsAt: ended.endsAt,
    endedAt: ended.endedAt,
    outcome: "expired",
  };
}
