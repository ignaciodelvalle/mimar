// Editar los datos de la mascota, y sus contactos de emergencia.
//
// A REAL ROUTE, nested under the pet, for the reason modo perdida and compartir
// are: it earns the back gesture and the stack header, and nesting it under the
// animal is what makes "back" land on the pet somebody came from.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. Every rule about who may edit what lives on
// the server and arrives as `capabilities`; `PetProfileEditScreen` renders them
// and invents none.
//
// `?seccion=` names the section to open on (owner-pet-actions): the panel's
// "Contactos de emergencia" row sends `contactos`. AN UNKNOWN SECTION IS NOT AN
// ERROR, it is the top of the form — the posture the pet document takes with an
// unknown `?face=`; only the path parameter is worth a refusal.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { PetProfileEditScreen } from "../../../src/pets/PetProfileEditScreen";
import { petEditSectionFromParam } from "../../../src/pets/pet-profile-edit-view-model";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";
import { PET_EDIT_SECTION_PARAM } from "../../../src/ui/routes";

export default function EditarRoute() {
  const gate = useGate();
  const params = useLocalSearchParams<{
    publicToken?: string | string[];
    [PET_EDIT_SECTION_PARAM]?: string | string[];
  }>();

  if (!gate.allowed) return gate.element;

  const raw = params.publicToken;
  const publicToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (publicToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a una mascota. Volvé a tu lista de mascotas y entrá desde ahí." />
      </Screen>
    );
  }

  return (
    <PetProfileEditScreen
      publicToken={publicToken}
      initialSection={petEditSectionFromParam(params[PET_EDIT_SECTION_PARAM])}
    />
  );
}
