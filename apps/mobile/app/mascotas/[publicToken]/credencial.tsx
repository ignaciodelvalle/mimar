// The pet's PUBLIC credential, as its own route — one tap from the QR.
//
// A ROUTE AND NOT A FACE (two-face rewrite, PO decision 2026-08-28). The web's
// owner card links to `/p/{token}` from its QR block; this is that link's
// native landing. `CredentialScreen` renders here UNCHANGED — its offline
// cache, its degraded-envelope handling and its per-section honesty all
// predate the rewrite and none of them moved.
//
// BEHIND THE GATE, deliberately, even though the document itself is public. The
// anonymous reader's surface is the web page the QR encodes, and a device this
// app has never signed in on still lands on the sign-in screen like every other
// route.
//
// WHAT THAT SENTENCE NO LONGER COVERS, SAID OUT LOUD RATHER THAN LEFT AS A
// STALE COMMENT (lote 1b review, F11). Until `useDisplayOnlyGate`
// (A6-cuenta-resiliencia-05) this route required a VERIFIED identity; it now
// renders in the `session-unverified` state too, which means an open of
// `mimar://mascotas/<token>/credencial` can draw the cached credential with
// nobody confirmed behind it. The precondition is not nothing — the device must
// hold tokens the app stored at some earlier sign-in and has not been able to
// check since (see `useDisplayOnlyGate`: `signed-out`, `unconfigured` and
// `starting` are refused exactly as before) — so the phone is UNCONFIRMED, not
// anonymous, and `user` is `null` in that arm so nothing needing an identity
// can compile against it.
//
// The bytes it can show are already public at `/p/{token}` and already on this
// device, so this widens no data. What it widens is WHO may read them on a
// borrowed or shared phone before the next verification lands, and that is a
// product decision rather than a code one — flagged to the PO, behaviour
// unchanged.

import { useLocalSearchParams } from "expo-router";

import { useDisplayOnlyGate } from "../../../src/auth/useGate";
import { CredentialScreen } from "../../../src/credential/CredentialScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function PublicCredentialRoute() {
  // THE DISPLAY-ONLY GATE, and this is the route it exists for
  // (A6-cuenta-resiliencia-05). `CredentialScreen` keeps a complete credential on
  // the device precisely so it can be read with no signal, and the ordinary gate
  // answered `session-unverified` — the cold start with no network — with a retry
  // screen, so the cache was reachable only when it was not needed. Everything
  // else the gate refuses it still refuses; see `useDisplayOnlyGate`.
  const gate = useDisplayOnlyGate();
  const params = useLocalSearchParams<{ publicToken?: string | string[] }>();

  if (!gate.allowed) return gate.element;

  const raw = params.publicToken;
  const publicToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (publicToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no tiene un código de credencial. Volvé a tu lista de mascotas y entrá desde ahí." />
      </Screen>
    );
  }

  return <CredentialScreen publicToken={publicToken} />;
}
