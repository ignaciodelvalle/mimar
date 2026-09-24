// DeactivatedAccountBanner — the standing explanation for an account the person
// switched off themselves.
//
// WHY A BANNER AND NOT A LANDING ROUTE
// ---------------------------------------------------------------------------
// /turno-vencido is the precedent for "a liveness refusal needs somewhere to
// go", and it is deliberately NOT the model here. A shift-expired operator is
// REDIRECTED there, and the route's first job is to end their session. Both
// halves are wrong for this state:
//
//   · DEACTIVATED must not redirect. requireUserOrRedirect tolerates this one
//     refusal on purpose — bouncing a deactivated account off every surface is
//     literally the 2026-07-04 ERR_TOO_MANY_REDIRECTS incident. A dedicated
//     route would need a redirect to be reached, so building one means
//     reintroducing the exact shape that incident taught us to avoid.
//   · DEACTIVATED must not sign anybody out. The person needs a surface to read
//     the explanation on and a control to undo their own decision from; signing
//     them out strands them outside both.
//
// So the surface is IN PLACE rather than somewhere to be sent. It rides the
// citizen shell's existing `banner` slot beside IdentityPendingBanner, which
// means it finds the person WHERE THE REFUSAL FINDS THEM — on whatever page
// they were trying to act on — instead of only when something bounces them.
// It costs no extra round-trip: `deactivated_at` is already in the layout's
// request-cached profile.
//
// Not dismissible, same reasoning as IdentityPendingBanner: the app is still
// readable and this is not a wall, but nothing the person writes will be
// recorded while the state holds, and a banner they can hide is a promise the
// system then quietly breaks.
//
// It never reads like an error, because it is not one. The person chose this.
// The copy says what happened, that they did it, and where the way back is.

import Link from "next/link";

interface DeactivatedAccountBannerProps {
  /**
   * Server-resolved from `profiles.deactivated_at` — pass
   * `profile?.deactivatedAt != null`, the same predicate requireLiveUser uses
   * to refuse the writes this banner explains. Do not re-derive it from
   * anything else: the two must not be able to disagree.
   */
  deactivated: boolean;
}

export function DeactivatedAccountBanner({ deactivated }: DeactivatedAccountBannerProps) {
  if (!deactivated) return null;

  return (
    // No `role="status"`: this is not a live region. The state is server-rendered
    // on every request and is already there when the page loads, so announcing
    // it as an update would be wrong — and biome would rather have an <output>,
    // which is for computed results. Same shape as IdentityPendingBanner.
    <div className="flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-2 text-center text-sm text-ln-op-ink-2">
      <span>
        Desactivaste tu cuenta. Podés seguir mirando tus datos, pero no vamos a registrar cambios
        hasta que la actives de nuevo.
      </span>
      <Link href="/cuenta" className="font-semibold underline underline-offset-2">
        Activar mi cuenta
      </Link>
    </div>
  );
}
