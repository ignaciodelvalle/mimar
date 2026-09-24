// `/adoptar` — el catálogo de adopción.
//
// A TOP-LEVEL ROUTE, beside `/mascotas`, `/transferencias` and
// `/notificaciones`, and the first one that is about animals NOBODY IN THIS APP
// HOLDS. The first is what this person is responsible for; the middle two are
// addressed to them. This is a catalogue a shelter published.
//
// THE PATH MATCHES THE WEB'S PUBLIC LANDING (`/adoptar`) and deliberately not
// the org-side queue's (`/adopciones`). That distinction is the feature: the
// second is what a REFUGIO opens to review applications, and this app has no org
// surfaces at all.
//
// IT REQUIRES A SESSION AND THE WEB PAGE DOES NOT. The endpoint requires one
// too, and the argument is in `app/api/v1/adoptions/route.ts`: this app has no
// anonymous shell, the funnel ends at a session anyway, and an anonymous
// `/api/v1` read is a different rate-limit derivation rather than a smaller one.
// The gap is on the board rather than left as a surprise.

import { useRouter } from "expo-router";

import { AdoptionCatalogueScreen } from "../../src/adoption/AdoptionCatalogueScreen";
import { useGate } from "../../src/auth/useGate";
import { ROUTES, adoptionDetailRoute } from "../../src/ui/routes";

export default function AdoptarRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <AdoptionCatalogueScreen
      onOpenPet={(petToken) => router.push(adoptionDetailRoute(petToken))}
      onOpenMyApplications={() => router.push(ROUTES.adoptarPostulaciones)}
    />
  );
}
