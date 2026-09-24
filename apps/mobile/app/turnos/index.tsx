// `/turnos` — mis turnos.
//
// A TOP-LEVEL ROUTE, beside `/mascotas` rather than under it. Every row names an
// animal, but the question the screen answers is not per-pet: "what do I have
// booked", across all of them, ordered by time. It also lists turnos for animals
// this person does not own, because booking accepts any active ownership role.
//
// The route is a thin shell: it refuses to render without a session and hands
// off. Every rule about which controls exist lives on the server and arrives as
// `capabilities`.

import { useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { TurnosScreen } from "../../src/turnos/TurnosScreen";
import { ROUTES, turnoRoute } from "../../src/ui/routes";

export default function TurnosRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <TurnosScreen
      onOpen={(token) => router.push(turnoRoute(token))}
      onSearch={() => router.push(ROUTES.buscarTurnos)}
    />
  );
}
