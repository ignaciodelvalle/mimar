// `/adoptar/postulaciones` — mis postulaciones.
//
// UNDER `/adoptar` AND NOT UNDER `/mascotas`, which is where the WEB files it
// (`/mis-mascotas/postulaciones`). Following the web here would put "animals I
// asked to adopt" under "animals I am responsible for", and the whole point of
// this screen is that those are different sets: somebody with postulaciones has
// no pet yet, by definition.
//
// A STATIC SEGMENT BESIDE A DYNAMIC ONE (`[petToken].tsx`). expo-router resolves
// the static one first, so a listing would have to carry the literal token
// "postulaciones" for the two to collide — and tokens are `DIM-XXXX-XXXX`.

import { useRouter } from "expo-router";

import { MyApplicationsScreen } from "../../src/adoption/MyApplicationsScreen";
import { useGate } from "../../src/auth/useGate";
import { ROUTES, adoptionDetailRoute } from "../../src/ui/routes";

export default function PostulacionesRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <MyApplicationsScreen
      onOpenFicha={(petToken) => router.push(adoptionDetailRoute(petToken))}
      // `dismissTo` (NAV-4): the catalogue is usually the screen this list was
      // opened FROM, and pushing another copy of it is how a back button ends
      // up walking through two catalogues. See `adoptar/[petToken].tsx`.
      onBrowse={() => router.dismissTo(ROUTES.adoptar)}
    />
  );
}
