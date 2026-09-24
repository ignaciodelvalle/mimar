// POSTULARSE — the application form.
//
// THE ONE WRITE IN THIS APP THAT LANDS IN SOMEBODY ELSE'S QUEUE. Everything else
// a person does here changes their own records, their animal's, or an exposure
// they control. This sends a letter about themselves to a shelter, which a human
// reads. That is why the form asks for a real motivation and why the server
// bounds how many of them one account may send.
//
// WHAT IT SHOWS BEFORE THE FORM is the CONTACT CARD — the name and email the
// shelter will see. The web shows the same block for the same reason: consent to
// share a profile is not consent to a mystery, and a checkbox over an unseen
// payload is a checkbox nobody can honestly tick.
//
// THE VALIDATION IS THE CONTRACT'S. `validateApplicationDraft` parses against
// `adoptionApplicationInputSchema`, which
// `__tests__/adoption-application-input-parity.test.ts` proves agrees with the
// server's own domain rule. A local "at least thirty characters" written here
// for a nicer message is the drift the contract package exists to stop.
//
// A REFUSAL SENDS THE PERSON BACK TO THE FICHA rather than guessing at a reason.
// The server's `adoption_application_refused` is ONE code for every domain
// refusal, so this screen cannot tell "ya te postulaste" from "esta mascota ya
// no está disponible" — and the ficha's `applyBlockedReason` is where the
// difference is actually stated.

import { useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { submitAdoptionApplication } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  Choice,
  Eyebrow,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { COLORS, SPACE, TYPE } from "../ui/theme";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useScrollToError } from "../ui/use-scroll-to-error";

import {
  EMPTY_APPLICATION_DRAFT,
  HOUSING_TYPE_OPTIONS,
  PRIOR_PETS_OPTIONS,
  validateApplicationDraft,
} from "./adoption-view-model";
import type { ApplicationDraft } from "./adoption-view-model";

const HOUSING_VALUES = HOUSING_TYPE_OPTIONS.map((o) => o.value);
const PRIOR_PETS_VALUES = PRIOR_PETS_OPTIONS.map((o) => o.value);

export function AdoptionApplyScreen({
  petToken,
  petName,
  applicantName,
  applicantEmail,
  onSubmitted,
  onBackToFicha,
}: {
  petToken: string;
  /** From the ficha the person tapped through from — never re-fetched here. */
  petName: string | null;
  applicantName: string | null;
  applicantEmail: string | null;
  onSubmitted: () => void;
  onBackToFicha: () => void;
}) {
  const [draft, setDraft] = useState<ApplicationDraft>(EMPTY_APPLICATION_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // THE BACK GESTURE MAY NOT DISCARD A TYPED APPLICATION (critic gap 2). This
  // form is the longest in the app and the one a person writes about an animal
  // they want to take home.
  //
  // `allowLeave` IS NOT OPTIONAL, and the first draft of this screen dropped it
  // (finding H1, review 2026-09-07). The guard fires on EVERY navigation away,
  // this screen's own post-submit exit included — so a postulación the shelter
  // already had asked "¿Salir sin guardar?", and "Seguir editando" left the
  // person on a form they had already sent. `app/alta.tsx` is the precedent.
  const { allowLeave } = useDraftDiscardGuard(draft !== EMPTY_APPLICATION_DRAFT);
  // The refusal appears at the BOTTOM of a form this long — below the fold on
  // any phone, and under the keyboard when a field is focused. See
  // `use-scroll-to-error.ts`; `scrollRef` is the door, the context is not.
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(error);

  const patch = (next: Partial<ApplicationDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  async function onSubmit() {
    const validated = validateApplicationDraft(draft);
    if (!validated.ok) {
      setError(validated.message);
      return;
    }
    setBusy(true);
    const result = await submitAdoptionApplication(sessionPort, petToken, validated.input);
    setBusy(false);
    if (result.outcome === "ok") {
      // The letter is in the shelter's queue. See the guard above.
      allowLeave();
      onSubmitted();
      return;
    }
    setError(apiFailureMessage(result) ?? "No pudimos enviar tu postulación.");
  }

  return (
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      <Title>{petName === null ? "Postularme" : `Adoptar a ${petName}`}</Title>

      <Card>
        <Eyebrow>Lo que verá el refugio de vos</Eyebrow>
        <Text style={styles.contactName}>{applicantName ?? "(sin nombre)"}</Text>
        {applicantEmail === null ? null : <Text style={styles.contact}>{applicantEmail}</Text>}
      </Card>

      <Choice
        label="¿Dónde vivís?"
        required
        options={HOUSING_VALUES}
        selected={draft.housingType}
        optionLabel={(value) => HOUSING_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value}
        onSelect={(housingType) => patch({ housingType })}
        disabled={busy}
      />

      <Choice
        label="¿Tuviste mascotas antes?"
        required
        options={PRIOR_PETS_VALUES}
        selected={draft.priorPets}
        optionLabel={(value) => PRIOR_PETS_OPTIONS.find((o) => o.value === value)?.label ?? value}
        onSelect={(priorPets) => patch({ priorPets })}
        disabled={busy}
      />

      <TextField
        label="¿Por qué querés adoptar?"
        required
        multiline
        numberOfLines={4}
        editable={!busy}
        value={draft.motivation}
        onChangeText={(motivation) => patch({ motivation })}
        placeholder="Contale al refugio por qué esta mascota y cómo sería su día a día con vos."
      />

      <TextField
        label="Otras mascotas en casa"
        multiline
        editable={!busy}
        value={draft.otherPets}
        onChangeText={(otherPets) => patch({ otherPets })}
      />

      <TextField
        label="Tu rutina diaria"
        multiline
        editable={!busy}
        value={draft.dailyRoutine}
        onChangeText={(dailyRoutine) => patch({ dailyRoutine })}
      />

      <TextField
        label="Algo más que quieras contar"
        multiline
        editable={!busy}
        value={draft.notes}
        onChangeText={(notes) => patch({ notes })}
      />

      {/* CONSENT IS AN ACT, NOT A DEFAULT (Ley 25.326). The switch starts off and
          the contract schema takes `z.literal(true)`, so a form submitted
          without it never becomes a request. */}
      <View style={styles.consent}>
        <Switch
          accessibilityLabel="Autorizo a compartir mis datos de contacto con el refugio"
          value={draft.consent}
          disabled={busy}
          onValueChange={(consent) => patch({ consent })}
        />
        <Text style={styles.consentLabel}>
          Autorizo a miMAR a compartir mi nombre, email y teléfono con el refugio para que puedan
          contactarme.
        </Text>
      </View>

      {error === null ? null : (
        <View ref={errorAnchor}>
          <Callout tone="warn">
            <Body>{error}</Body>
          </Callout>
        </View>
      )}

      <PrimaryButton
        label={busy ? "Enviando…" : "Enviar postulación"}
        disabled={busy}
        onPress={() => void onSubmit()}
      />
      <SecondaryButton label="Volver a la ficha" onPress={onBackToFicha} disabled={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  contactName: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    color: COLORS.ink,
  },
  contact: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkSoft,
  },
  consent: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACE.sm,
  },
  consentLabel: {
    flex: 1,
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkSoft,
  },
});
