// `/transferencias/{transferToken}` — one proposal, and the answer to it.
//
// THE DEEP-LINK DESTINATION. `mimar://transferencias/PTR-XXXX-XXXX` resolves
// here, and the path shape is deliberately the WEB's so the two forms of one
// destination cannot drift (`DEEP_LINK_MAP.petTransfer`).
//
// THE PARAMETER IS VALIDATED, not trusted. `useLocalSearchParams` is typed
// `string | string[]` because a path segment can legally repeat, and an empty
// value here would ask the screen to find a proposal named "" — which it would
// honestly report as "not in your account", a sentence about the wrong thing.
// Better to say the link is broken.
//
// AFTER AN ACCEPT THE STACK IS REPLACED, not pushed onto. The animal is now this
// person's, and `replace` is what stops the back gesture from returning to a
// proposal that no longer exists — the screen would re-read, find the row
// `accepted`, and offer nothing, which reads like the app losing its place.

import { useLocalSearchParams, useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { TransferDetailScreen } from "../../src/transfers/TransferDetailScreen";
import { ErrorNotice } from "../../src/ui/components";
import { Screen } from "../../src/ui/kit";
import { ROUTES, credentialRoute } from "../../src/ui/routes";

export default function TransferDetailRoute() {
  const gate = useGate();
  const router = useRouter();
  const params = useLocalSearchParams<{ transferToken?: string | string[] }>();

  if (!gate.allowed) return gate.element;

  const raw = params.transferToken;
  const transferToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (transferToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a una transferencia. Abrí tus transferencias y entrá desde ahí." />
      </Screen>
    );
  }

  return (
    <TransferDetailScreen
      transferToken={transferToken}
      onAccepted={(petPublicToken) => {
        // `petPublicToken` can be null when the writer could not read it back
        // inside the transaction. The list is the honest fallback — the same one
        // the web takes (`/mis-mascotas`).
        router.replace(
          petPublicToken === null ? ROUTES.misMascotas : credentialRoute(petPublicToken),
        );
      }}
    />
  );
}
