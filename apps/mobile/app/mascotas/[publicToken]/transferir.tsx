// `/mascotas/{token}/transferir` — ofrecer la titularidad de este animal.
//
// NESTED UNDER THE PET, unlike the other three transfer commands, and the
// asymmetry is the feature's rather than this router's: `initiate` is the only
// one addressed by an ANIMAL. Nesting it here is also what makes the back
// gesture land on the pet somebody came from.
//
// NO CAPABILITY IS PRE-JUDGED. The rule is the narrowest on this surface — the
// caller must hold the ACTIVE `role='owner'` ownership row — and the pet payload
// carries no flag for it. A local guess would be a second copy of a rule that
// lives in one place, so the screen asks and renders the server's refusal.
//
// The pet's NAME is not resolved here either. It would cost a read for one word
// in one sentence, and the screen has an honest fallback ("esta mascota") for
// the case a deep link lands on this form with no list behind it.

import { useLocalSearchParams, useRouter } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { TransferInitiateScreen } from "../../../src/transfers/TransferInitiateScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";
import { transferRoute } from "../../../src/ui/routes";

export default function TransferirRoute() {
  const gate = useGate();
  const router = useRouter();
  const params = useLocalSearchParams<{
    publicToken?: string | string[];
    name?: string | string[];
  }>();

  if (!gate.allowed) return gate.element;

  const raw = params.publicToken;
  const publicToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const rawName = params.name;
  const petName = (Array.isArray(rawName) ? rawName[0] : rawName)?.trim() || null;

  if (publicToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a una mascota. Volvé a tu lista de mascotas y entrá desde ahí." />
      </Screen>
    );
  }

  return (
    <TransferInitiateScreen
      publicToken={publicToken}
      petName={petName}
      // REPLACE, not push: the form is finished, and a back gesture onto a form
      // whose submission already created a proposal invites a second one.
      onSent={(transferToken) => router.replace(transferRoute(transferToken))}
    />
  );
}
