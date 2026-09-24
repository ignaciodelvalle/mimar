// Whether this viewer owes the refugio a post-adoption check-in right now.
//
// ITS OWN MODULE, next to `route.ts`, for the reason `ppp-registries.ts` is
// one: a Next route file may export only the handlers and the segment config,
// so a helper that lives there cannot be tested without going through an HTTP
// request and every guard in front of it. This one has three outcomes a client
// branches on, and one of them is a failure.
//
// WHY THE SECTION EXISTS. The app's "Asentar" picker offers the check-in row
// only when a window is open, exactly as the web's anotar menu offers its
// "Check-in post-adopción" entry only to the adopter and its page only while a
// reminder is pending. Neither fact is on the wire otherwise: the detail's
// reminders section is the VACCINE list by construction, and the adoption is
// an event on the spine. Without this read the app could only offer the row to
// everyone — a form most people would be refused from — or to nobody.

import type { CredentialSection, OwnerPetPostAdoptionCheckinSection } from "@dim/contract/api";

import { findOpenPostAdoptionCheckinReminder } from "@/lib/infra/adoption-checkin";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";

/**
 * One indexed lookup on `reminders`, and it must never be the reason an owner
 * cannot see their pet — same posture as the PPP rule read.
 */
export const CHECKIN_WINDOW_BUDGET_MS = 2_000;

/** The window finder, injectable so a test names the case instead of a Request. */
export type CheckinWindowFinder = (
  petId: string,
  userId: string,
) => Promise<{ id: string; dueAt: Date } | null>;

/**
 * Resolve the section.
 *
 * THREE OUTCOMES, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   · `pending: false` on the ORG path — skipped, not read. An organization is
 *     never the adopter, so there is no window that could be theirs.
 *   · `pending: true | false` on the person path — a FACT about this viewer
 *     and this animal, from the same query the writer refuses on.
 *   · `unavailable` — the read did not answer. NEVER flattened into `false`: a
 *     picker that read "nothing pending" out of a failed lookup would hide the
 *     one row the person came for, and nothing on screen would say why.
 *
 * ONE QUERY AND NOT TWO. The adoption itself is not re-checked here: a
 * `post_adoption_checkin` reminder is created for the adopter at finalization
 * and for nobody else, so an open one for (pet, viewer) already says the viewer
 * adopted the animal. The writer still checks both — this is a hint for a
 * menu, and the writer is the rule.
 */
export async function resolvePostAdoptionCheckin(
  access: { kind: "owner" | "org"; petId: string; userId: string },
  finder: CheckinWindowFinder = findOpenPostAdoptionCheckinReminder,
): Promise<CredentialSection<OwnerPetPostAdoptionCheckinSection>> {
  if (access.kind === "org") return { status: "ok", data: { pending: false } };

  try {
    const window = await withDbBudgetOrThrow(
      finder(access.petId, access.userId),
      CHECKIN_WINDOW_BUDGET_MS,
      "api-v1-pet-detail-checkin-window",
    );
    return { status: "ok", data: { pending: window !== null } };
  } catch (err) {
    // A BUDGET BLOWOUT DEGRADES THIS SECTION ALONE. The rest of the face is
    // already loaded and an owner looking at their pet must still see it.
    if (err instanceof DbBudgetExceededError) return { status: "unavailable" };
    throw err;
  }
}
