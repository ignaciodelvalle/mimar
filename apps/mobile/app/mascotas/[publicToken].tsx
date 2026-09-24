// One pet, reached from the list — ONE document with TWO faces.
//
// The route is a thin shell: it resolves the path parameter, refuses to render
// without a session, and mounts `PetDocumentScreen`. The honesty rules live in
// the faces.
//
// WHY TWO AND NOT THREE. This file used to argue for three faces — owner,
// libreta, public credential — on the layering argument that none is a
// superset of the others: deleting the credential tab would "take away the one
// screen an owner can hand to a stranger". The layering argument was RIGHT
// about the data and wrong about the navigation: the public credential is not
// a FACE of the owner's document, it is a DIFFERENT document that the owner's
// document links to. The web has always drawn it that way — its card has
// exactly two faces, banded "Credencial · frente" and "Libreta · dorso", and
// the anonymous page lives at `/p/{token}`, one tap from the QR. A third tab
// here made the phone a different product from the web, which is the thing
// the PO ordered against (2026-08-28: "1 solo perfil mobile native, lo más
// símil al web posible, nada de mantener 2 cosas").
//
// WHERE THE PUBLIC DOCUMENT WENT. `CredentialScreen` survives intact —
// offline cache and all — as the route `/mascotas/{token}/credencial`
// (`publicCredentialRoute`), reached from the front face's QR block (now
// tappable; it was inert) and from "Más". Nothing an owner could hand to a
// stranger was deleted; it moved to where the web keeps it.
//
// THE PARAMETER IS VALIDATED, not trusted. `useLocalSearchParams` is typed
// `string | string[]` because a path segment can legally repeat, and a bad
// value here would become a request for `/api/v1/pets/undefined` — which the
// server answers 404, i.e. "no existe esa mascota", which is a lie about the
// pet rather than about the link. Better to say the link is broken.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { type DocumentFace, isDocumentFace } from "../../src/pets/DocumentChromeNative";
import { PetDocumentScreen } from "../../src/pets/PetDocumentScreen";
import { ErrorNotice } from "../../src/ui/components";
import { Screen } from "../../src/ui/kit";
import { DOCUMENT_FACE_PARAM } from "../../src/ui/routes";

export default function PetDetailRoute() {
  const gate = useGate();
  const params = useLocalSearchParams<{
    publicToken?: string | string[];
    [DOCUMENT_FACE_PARAM]?: string | string[];
  }>();

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

  // AN UNKNOWN `?face=` IS NOT AN ERROR, it is the default — the same posture
  // `asentar.tsx` takes with an unknown `kind`. A link that names a face this
  // build does not have still points at a real animal, and refusing to draw the
  // document over a query string would turn a cosmetic disagreement into a dead
  // link. Only the path parameter is worth a refusal, because without it there
  // is no animal at all.
  const rawFace = params[DOCUMENT_FACE_PARAM];
  const face = (Array.isArray(rawFace) ? rawFace[0] : rawFace)?.trim() ?? "";
  const initialFace: DocumentFace = isDocumentFace(face) ? face : "credencial";

  return <PetDocumentScreen publicToken={publicToken} initialFace={initialFace} />;
}
