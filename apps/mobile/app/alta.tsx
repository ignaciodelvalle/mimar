// `/alta` — the pet-registration wizard.
//
// A thin shell (F-5, 2026-09-24 review): it refuses to render without a
// session and hands off to `AltaScreen`, which lives under `src/` so it can be
// render-tested (`app/` sits outside jest's `roots`). Same split every other
// gated screen in this app uses — `PetPhotoScreen`, `DenunciaScreen` — and the
// same reason: the ROUTE decides who may see the screen.

import { useGate } from "../src/auth/useGate";
import { AltaScreen } from "../src/pets/AltaScreen";

export default function AltaRoute() {
  const gate = useGate();
  if (!gate.allowed) return gate.element;
  return <AltaScreen />;
}
