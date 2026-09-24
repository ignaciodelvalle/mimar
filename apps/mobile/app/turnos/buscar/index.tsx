// `/turnos/buscar` — buscar un turno.
//
// NESTED UNDER `/turnos`, and the web's `/turnos/buscar` is a tree of its own with
// `/mis-turnos` beside it. The browser grew the two separately and the board
// records that neither is in its nav at all — deep links only. A stack navigator
// has no such history, and on a phone the honest arrangement is the one the person
// walks: you open your turnos, you do not have the one you need, you look for it.
//
// NOT A DEEP-LINK DESTINATION, and nothing may point here from outside: no
// `DEEP_LINK_MAP` entry names it, and this screen is behind a session anyway.
//
// The route is a thin shell: it refuses to render without a session and hands off.
// Every rule about which offerings exist, which slots are takeable and which
// animals may take one lives on the server and arrives in the payload.

import { useRouter } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { BuscarTurnoScreen } from "../../../src/turnos/BuscarTurnoScreen";
import { buscarOfferingRoute } from "../../../src/ui/routes";

export default function BuscarTurnoRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return <BuscarTurnoScreen onOpenOffering={(token) => router.push(buscarOfferingRoute(token))} />;
}
