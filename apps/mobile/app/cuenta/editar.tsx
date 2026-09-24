// Editar mis datos — the person's own name, phone and default contacts.
//
// A REAL ROUTE UNDER `/cuenta`, beside `/cuenta/privacidad`, and the segment is
// the same choice for a weaker reason: nothing outside the app links here today,
// so the deep-link argument that pins `privacidad` does not apply. What applies
// is that the two account screens should not live at two different depths — one
// under `/cuenta` because a store reviewer's URL says so and the other under
// `/ajustes` because that is where its button is — which is how a route tree
// stops describing anything.
//
// The web's own leaf is `/cuenta/editar` (it redirects to the `?sheet=` form
// today, a URL mechanism a stack navigator does not have), so the paths agree
// for free.
//
// A THIN SHELL. It refuses to render without a session and hands off.
//
// `allowPendingIdentity` IS OFF, unlike `/cuenta/privacidad`, and the asymmetry
// is deliberate rather than an oversight. Somebody whose signup stopped at step
// 1 has no `profiles` row, so there is nothing for this form to edit — the
// endpoint answers 404 and `updateProfileForUser` answers NOT_FOUND. The gate
// sends them to `identidad-pendiente`, which is the screen that actually helps.
// Privacidad goes the other way because a person exercising Ley 25.326 must not
// be told to finish joining first.

import { EditProfileScreen } from "../../src/account/EditProfileScreen";
import { useGate } from "../../src/auth/useGate";

export default function EditarCuentaRoute() {
  const gate = useGate();

  if (!gate.allowed) return gate.element;

  return <EditProfileScreen />;
}
