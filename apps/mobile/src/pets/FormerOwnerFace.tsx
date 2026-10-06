// The read-only face a FORMER owner keeps while an official custody episode is
// open (notificaciones-destinos, 2026-10; PO 2026-07-18: «El ex-dueño conserva
// LECTURA durante el proceso»).
//
// THE WEB'S VIEW, TRANSCRIBED. `FormerOwnerCustodyReadOnlyView` in
// app/(app)/mis-mascotas/[publicToken]/page.tsx renders the animal's name and
// identity line under a banner, and nothing else — no actions, no libreta, no
// case link (the custody case is the authority's; the code is shown so the
// person can name it when they call). This is that view on a phone. Before it,
// the notification that told somebody their animal had been seized opened
// "No disponible".

import type { FormerOwnerPetReadV1 } from "@dim/contract/api";
import { StyleSheet, View } from "react-native";

import { Body, Card } from "../ui/components";
import { Callout, Title } from "../ui/kit";
import { SPACE } from "../ui/theme";
import { speciesLabel } from "./species";

export function formerOwnerIdentityLine(pet: FormerOwnerPetReadV1["pet"]): string {
  const sex = pet.sex === "male" ? "Macho" : pet.sex === "female" ? "Hembra" : null;
  return [pet.breed, sex, speciesLabel(pet.species)].filter(Boolean).join(" · ");
}

export function FormerOwnerFace({ read }: { read: FormerOwnerPetReadV1 }) {
  return (
    <View style={styles.stack}>
      <Callout tone="warn" title="Custodia oficial en curso">
        <Body>
          {`Tu mascota está bajo custodia oficial — acceso de solo lectura mientras dure el proceso. Caso ${read.custodyCase.publicCode}.`}
        </Body>
      </Callout>
      <Card>
        <Title>{read.pet.name}</Title>
        <Body>{formerOwnerIdentityLine(read.pet)}</Body>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACE.lg },
});
