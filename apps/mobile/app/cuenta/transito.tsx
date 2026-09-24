// `/cuenta/transito` — proposals awaiting a volunteer's answer, plus the
// fosters that came of one.
//
// THE HUB, AND A DEEP-LINK DESTINATION AT THE SAME TIME — for
// `foster_proposal_received`'s ctaUrl, `/cuenta/transitos/propuestas/{token}`,
// `DEEP_LINK_MAP.fosterProposal.appPath` resolves to this same screen with no
// token: opening the hub is enough for a person to find the one proposal a
// notification named. See that table entry's own note for why there is no
// per-token route here.
//
// A THIN SHELL, like every other route file in this app: it refuses to
// render without a session and hands off to the screen, which owns the read
// and every state.

import { useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { FosterScreen } from "../../src/foster/FosterScreen";
import { credentialRoute } from "../../src/ui/routes";

export default function TransitoRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <FosterScreen onOpenPet={(petPublicToken) => router.push(credentialRoute(petPublicToken))} />
  );
}
