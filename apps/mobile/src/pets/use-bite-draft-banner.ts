// Whether the signed-in account has an unsent "mordedura" draft — the
// question "Mis mascotas" needs answered to show or hide its banner.
//
// M5 / Re-1 (PO decision 3): a bite report is time-sensitive, rabies
// observation windows included, and nothing told a person who started one
// and got interrupted that it was still sitting on the phone. See
// `event-draft-store.ts` for what a draft is and is not.
//
// ONE DRAFT ONLY, THE MOST RECENT. Several bite drafts across several pets
// is the rare case, and the brief's own answer for it is "keep it simple":
// the banner opens the newest one rather than asking who to worry about
// first.

import { useCallback, useState } from "react";

import { getSessionState } from "../auth/session-store";
import { type FoundEventDraft, listEventDrafts } from "./event-draft-store";

export type BiteDraftBanner = FoundEventDraft;

export type UseBiteDraftBanner = {
  /** The most recent unsent bite draft for the signed-in account, or `null`. */
  banner: BiteDraftBanner | null;
  /** Re-read from storage. Call on every focus — see `app/mascotas/index.tsx`. */
  refresh: () => Promise<void>;
};

/**
 * `banner` starts `null` rather than "loading": the screen already shows a
 * spinner for the pets themselves, and a banner that pops in a beat after
 * the list would read as a second, unrelated loading state. `refresh` runs
 * on every focus, so the true answer arrives before anyone could act on the
 * absence of a banner that has not looked yet.
 */
export function useBiteDraftBanner(): UseBiteDraftBanner {
  const [banner, setBanner] = useState<BiteDraftBanner | null>(null);

  const refresh = useCallback(async () => {
    const session = getSessionState();
    // NOBODY SIGNED IN, OR SOMEBODY ELSE'S SESSION MID-SWAP: there is no
    // owner to read for, and reading the LAST owner's drafts here would be
    // exactly the cross-account leak `eventDraftKey`'s owner segment exists
    // to prevent.
    if (session.phase !== "signed-in") {
      setBanner(null);
      return;
    }
    const found = await listEventDrafts({ ownerId: session.user.id, kind: "bite" });
    // ASKED AGAIN, AFTER THE SCAN. `getAllKeys` plus a `readEventDraft` per
    // candidate is several awaits deep, and a sign-out (or a switch to
    // somebody else on the same phone) can land inside that window. Without
    // this check, the answer computed for the OLD owner would still be handed
    // to `setBanner` — exactly the cross-account leak the id check above
    // exists to prevent, just reached through a stale closure instead of a
    // stale read.
    const after = getSessionState();
    if (after.phase !== "signed-in" || after.user.id !== session.user.id) return;
    setBanner(found[0] ?? null);
  }, []);

  return { banner, refresh };
}
