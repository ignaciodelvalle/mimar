// `/crear-cuenta` — the account half of the web's two-step signup.
//
// A THIN ROUTE over `CrearCuentaScreen`, unlike its sibling `ingreso.tsx` which
// is a whole screen in this directory. The split is not cosmetic: this app's
// jest suite is anchored at `<rootDir>/src` (jest.config.js says so, and says
// why — a `<rootDir>`-absolute glob makes micromatch read `\` as an escape on
// Windows and match nothing), so a component that lives under `app/` cannot be
// render-tested. A signup form is the last screen in this app that should be
// untestable.
//
// NO `useGate` HERE, AND THAT IS THE DIFFERENCE FROM EVERY OTHER ROUTE. The
// gate answers "who is holding this phone" for screens that need a session;
// this one is reached WITHOUT one, exactly like `ingreso`. What it does share
// with ingreso is the already-signed-in bounce, which fires when a session
// arrives while this screen is mounted — which is precisely what a successful
// signup does.
//
// THE BOUNCE GOES TO `/` — THE GATE — AND NOT TO A DESTINATION. A brand-new
// account still carries the provisional, email-derived display name the
// `handle_new_user` trigger writes (the row is created with the account; "no
// profile row" is not a state signup produces, and this comment used to say it
// was), so `/me` answers `profilePending: true` and the gate sends the person to
// `identidad-pendiente`, which since 2026-09-05 COLLECTS nombre and apellido and
// posts them to `POST /api/v1/me/identity` — this comment used to say step 2 was
// "on the web: see IDENTITY_COMPLETION_URL for why this app must not fake it",
// and it also predicted its own expiry ("the day identity completion gets an
// /api/v1 door of its own"). That day was 2026-09-05. Naming the screen here
// would still be wrong: it duplicates a decision `useGate` already makes for
// every route.

import { Redirect, useRouter } from "expo-router";

import { CrearCuentaScreen } from "../src/auth/CrearCuentaScreen";
import { useSession } from "../src/auth/useSession";
import { ROUTES } from "../src/ui/routes";

export default function CrearCuentaRoute() {
  const session = useSession();
  const router = useRouter();

  if (session.phase === "signed-in") return <Redirect href={ROUTES.root} />;

  return (
    <CrearCuentaScreen
      // REPLACE, not push. Somebody who decides they already have an account
      // does not want this form behind the back gesture, and somebody sent here
      // by the "ya podés ingresar" panel must not be able to swipe back onto a
      // filled-in signup form whose next submit answers with the masquerade.
      onGoToSignIn={() => router.replace(ROUTES.ingreso)}
    />
  );
}
