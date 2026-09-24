// `/adoptar/{petToken}` — la ficha de una mascota en adopción.
//
// THE SEGMENT IS A PUBLIC TOKEN AND THE SCREEN IS NOT THE CREDENTIAL.
// `/mascotas/{token}` is what somebody responsible for an animal opens; this is
// what a person considering adopting one reads, about an animal a shelter holds.
// Two screens, two payloads, two authorization questions — and the tokens happen
// to have the same shape, which is the only thing they share.
//
// THE PET NAME TRAVELS TO THE FORM AS A PARAM. `postular` needs it for its own
// title and re-reading the whole ficha to get one string would be a second round
// trip for a word this screen already has. It is display copy: if it is ever
// missing or stale, the form says "Postularme" and nothing is wrong.

import { useLocalSearchParams, useRouter } from "expo-router";

import { AdoptionDetailScreen } from "../../src/adoption/AdoptionDetailScreen";
import { useGate } from "../../src/auth/useGate";
import { ROUTES, adoptionApplyRoute } from "../../src/ui/routes";

export default function AdoptionFichaRoute() {
  const gate = useGate();
  const router = useRouter();
  const { petToken } = useLocalSearchParams<{ petToken: string }>();

  if (!gate.allowed) return gate.element;

  return (
    <AdoptionDetailScreen
      petToken={petToken}
      onApply={(token, name) => router.push(adoptionApplyRoute(token, name))}
      // `dismissTo` AND NOT `push` (NAV-4). "Volver al catálogo" pushed a
      // SECOND catalogue on top of the ficha, so the stack grew
      // catálogo → ficha → catálogo → ficha and hardware back walked a chain of
      // duplicates. `dismissTo` pops to the catalogue when it is behind us and
      // replaces the ficha when it is not — which is the deep-link case, where
      // there is no catalogue to go back to.
      onBackToCatalogue={() => router.dismissTo(ROUTES.adoptar)}
    />
  );
}
