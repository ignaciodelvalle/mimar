// `/recuperar` — password recovery, without leaving the app.
//
// A THIN ROUTE over `RecuperarScreen`, for `crear-cuenta.tsx`'s reason: this
// app's jest suite is anchored at `<rootDir>/src` (jest.config.js says so, and
// says why), so a component that lives under `app/` cannot be render-tested. A
// screen that takes an e-mail, a one-time code and a new password is not one to
// leave untestable.
//
// NO `useGate` HERE, like `ingreso` and `crear-cuenta`: this route is reached
// WITHOUT a session, by somebody who cannot get one. What it shares with both is
// the already-signed-in bounce — which here fires on SUCCESS, because a
// completed reset leaves the device holding a live recovery session.
//
// THE BOUNCE GOES TO `/` — THE GATE — and not to a destination, for the reason
// `crear-cuenta.tsx` states: the account that just recovered may still have no
// profile row, in which case `useGate` sends the person to `identidad-pendiente`
// rather than to a pet list. Naming a screen here would duplicate a decision the
// gate already makes for every route, and would be the wrong one for exactly the
// person most likely to have forgotten their password.
//
// THIS ROUTE IS NOT A DEEP-LINK DESTINATION and must never become one. See
// `ROUTES.recuperar` for why a `mimar://` url in front of account recovery would
// be worse than no native flow at all.

import { Redirect, useRouter } from "expo-router";

import { RecuperarScreen } from "../src/auth/RecuperarScreen";
import { useSession } from "../src/auth/useSession";
import { ROUTES } from "../src/ui/routes";

export default function RecuperarRoute() {
  const session = useSession();
  const router = useRouter();

  if (session.phase === "signed-in") return <Redirect href={ROUTES.root} />;

  return (
    <RecuperarScreen
      // REPLACE, not push. Somebody who gives up on recovery does not want a
      // half-filled reset form behind the back gesture — and the code in it is
      // one that may already have been spent.
      onGoToSignIn={() => router.replace(ROUTES.ingreso)}
    />
  );
}
