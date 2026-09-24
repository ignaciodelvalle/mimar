// Privacidad y datos personales — the Ley 25.326 rights, natively.
//
// A REAL ROUTE UNDER `/cuenta`, and the segment is not decoration. `ajustes` is
// this app's settings screen and it is where the entry point lives, so the
// obvious path was `/ajustes/privacidad`. It is `/cuenta/privacidad` instead,
// matching the WEB's leaf exactly, for the reason `/transferencias` and
// `/cuidado` match theirs: this is the URL the app has been handing people in a
// browser since the Play submission, it is the URL the Data safety form names,
// and the day verified App Links land, the `https` form and the `mimar://` form
// should differ only in scheme rather than needing a translation row.
//
// A THIN SHELL. It refuses to render without a session and hands off; every rule
// about what may be exported or erased lives on the server.
//
// `allowPendingIdentity` IS ON, unlike most screens here, and it is the one
// decision in this file. Somebody whose signup stopped at step 1 has an account,
// has rows in `profiles`, and is exactly as entitled to art. 14 and art. 16 as
// anybody else — Ley 25.326 attaches to the data, not to how complete the
// registration is. Gating this behind `identidad-pendiente` would send a person
// who wants OUT of the system to a screen asking them to finish joining it.

import { PrivacyScreen } from "../../src/account/PrivacyScreen";
import { useGate } from "../../src/auth/useGate";

export default function PrivacidadRoute() {
  const gate = useGate({ allowPendingIdentity: true });

  if (!gate.allowed) return gate.element;

  return <PrivacyScreen />;
}
