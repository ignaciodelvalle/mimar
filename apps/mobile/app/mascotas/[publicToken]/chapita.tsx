// Chapa física — alternar el interés en la §4.20 demand-signal placeholder.
//
// UNA RUTA REAL, anidada bajo la mascota, por la razón de `cuidado`, `mudanza`
// y `vacunas`: gana el gesto de volver y el header del stack, y anidarla bajo
// el animal es lo que hace que "atrás" caiga en la mascota de la que vino.
//
// La ruta es una cáscara fina: valida el parámetro y delega. Quién puede
// alternar el interés lo decide el servidor (`canTogglePhysicalTagInterest`) y
// llega como un 403 vía `PhysicalTagInterestScreen`; esta pantalla nunca lo
// deriva.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { PhysicalTagInterestScreen } from "../../../src/pets/PhysicalTagInterestScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function ChapitaRoute() {
  const gate = useGate();
  const params = useLocalSearchParams<{ publicToken?: string | string[] }>();

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

  return <PhysicalTagInterestScreen publicToken={publicToken} />;
}
