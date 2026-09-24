// `/transferencias` — the hub.
//
// A TOP-LEVEL ROUTE, beside `/mascotas` rather than under it, because half of
// what it lists is about animals this person does not own. There is no pet token
// in the path and there could not be one.
//
// The route is a thin shell: it refuses to render without a session and hands
// off. Every rule about which answers are available lives on the server and
// arrives as `capabilities`.

import { useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { TransfersScreen } from "../../src/transfers/TransfersScreen";
import { caretakerGrantRoute, transferRoute } from "../../src/ui/routes";

export default function TransferenciasRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <TransfersScreen
      onOpen={(token) => router.push(transferRoute(token))}
      onOpenCaretakerGrant={(grantToken) => router.push(caretakerGrantRoute(grantToken))}
    />
  );
}
