// `/denunciar` — denunciar maltrato animal (Ley 14.346).
//
// A TOP-LEVEL ROUTE, and the furthest out of all of them. `/reclamar` is about
// an animal the person does not hold; this one is usually about an animal nobody
// holds, in a place the person happened to walk past, and about a NAMED THIRD
// PARTY the denuncia accuses. There is nothing in this app's tree it belongs
// under.
//
// The route is a thin shell: it refuses to render without a session and hands
// off. Every rule about what may be sent lives in the contract and on the server.

import { useGate } from "../src/auth/useGate";
import { DenunciaScreen } from "../src/denuncias/DenunciaScreen";

export default function DenunciarRoute() {
  const gate = useGate();
  if (!gate.allowed) return gate.element;
  return <DenunciaScreen />;
}
