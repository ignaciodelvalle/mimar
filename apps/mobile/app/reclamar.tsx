// `/reclamar` — reclamar una mascota por su microchip o su tatuaje.
//
// A TOP-LEVEL ROUTE, beside `/mascotas` and not under it, and the reason is
// sharper than the transfer hub's: the animal this screen is about is one the
// person does NOT hold. Nesting it under `/mascotas/[publicToken]` would put a
// pet in the address, and there is no pet to put there — the server derives the
// animal from the private identifier and refuses to be told which one it is.
//
// The route is a thin shell: it refuses to render without a session and hands
// off. Every rule about which controls exist lives on the server and arrives as
// `canClaim`.

import { useRouter } from "expo-router";

import { useGate } from "../src/auth/useGate";
import { ClaimScreen } from "../src/claims/ClaimScreen";
import { credentialRoute } from "../src/ui/routes";

export default function ReclamarRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  // `replace`, not `push`: once the animal is registered to this person it is
  // THEIRS, and the screen behind — a form asking whose it is — is a question
  // that has been answered. A back gesture from the credential should land on
  // the pet list, not re-open the claim form with the chip still in the field.
  return <ClaimScreen onOpenPet={(token) => router.replace(credentialRoute(token))} />;
}
