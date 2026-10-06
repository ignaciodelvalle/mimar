// What the owner sees right after activating a lost-pet search, shared by the
// wizard (which navigates there) and the route that renders it.
//
// A PLAIN MODULE, NOT "use client": the success screen is a server-rendered
// route (`./activada/page.tsx`), and a server component cannot call a function
// exported from a client module — it would receive a client reference.

import { lostThirdPersonPhrase } from "@/lib/utils/format";

/**
 * The confirmation route a successful "Marcar como perdida" lands on.
 *
 * WHY A ROUTE AND NOT WIZARD STATE (2026-10-06). The wizard used to flip a
 * `submitted` flag after `setPetLostAction` resolved and render the success
 * screen in place. That action revalidates, and in Next 15.5 ANY revalidation
 * inside a server action re-renders the CURRENT route in the same response
 * (`pathWasRevalidated`, set unconditionally — "TODO: only revalidate if the
 * path matches" in next/dist/server/web/spec-extension/revalidate.js). Both
 * places that mount the wizard branch on the status the action just changed:
 * `/perdida` swaps to UpdateLastSeenForm once the pet is lost, and the profile's
 * `marcar-perdida` sheet swaps to MarkLostNotApplicableNotice. The wizard was
 * unmounted with its flag, and the owner never saw "Activamos la búsqueda" nor
 * the WhatsApp and poster buttons. A route reads the episode from the database
 * on a fresh render, so nothing has to survive the refresh.
 */
export function lostActivatedPath(publicToken: string): string {
  return `/mis-mascotas/${publicToken}/perdida/activada`;
}

/**
 * The text the success screen's "Compartir por WhatsApp" pre-fills (T1-L14).
 *
 * It said "{nombre} está perdida — ayudanos a encontrarla" to every animal: a
 * male dog's lost post went out feminine into every group chat it was shared
 * to. The adjective now comes from lostThirdPersonPhrase ("está perdido" /
 * "está perdida" / "se perdió" for an unknown sex), and the second clause is
 * pronoun-free so it needs no gender at all.
 */
export function lostShareText(petName: string, petSex: string | null | undefined): string {
  return `${petName} ${lostThirdPersonPhrase(petSex)} — ayudanos a que vuelva a casa. Su perfil público:`;
}
