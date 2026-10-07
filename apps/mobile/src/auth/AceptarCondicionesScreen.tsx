// Aceptar condiciones — an EXISTING account accepts the current legal version
// before it keeps using the app (2026-10-07).
//
// WHY (legal review 2026-10-02, rows P10, P11 and D5; PO decision D2 = b, a
// conservative interim counsel may loosen): a substantive change of the Terms
// needs a new acceptance, not an email (Disp. 377/2026 inc. b), and accounts
// created before this version consented to the international transfer inside
// the Terms box rather than in a box of its own (Dec. 1558/2001 art. 5 inc. 1).
// `/me` answers `legalAcceptancePending: true` for such an account and `useGate`
// sends it here. The web twin is /aceptar-condiciones; both write through
// `acceptLegalTermsForUser`, and the boxes are the SAME component signup uses.
//
// A GENERAL CIRCUIT (legal report 2026-10, §3.1 row 5: F-9 closed — silence is
// not acceptance, CCyC art. 979): every bump of LEGAL_VERSION brings every
// personal account on an older version here once, with the list of what
// changed (`LEGAL_VERSION_CHANGES` in the contract).
//
// THE WAY OUT IS NOT ONLY "ACEPTAR": somebody who does not agree can sign out,
// or open the web page where they download their data and delete the account —
// the one owner page the web gate lets through while an acceptance is owed.
//
// `legalAcceptancePending` is READ by the thin route and PASSED DOWN, and the
// redirect below is the load-bearing check, for `IdentidadPendienteScreen`'s
// reason: `allowPendingLegal` lets this screen render while an acceptance is
// owed; it says nothing about whether one still is.

import { legalChangesSince } from "@dim/contract/reference";
import * as Linking from "expo-linking";
import { Redirect } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";

import { ACCOUNT_DELETION_URL } from "../config/api";
import { Body, Card } from "../ui/components";
import {
  Callout,
  LinkText,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  Title,
} from "../ui/kit";
import { ROUTES } from "../ui/routes";
import { SPACE } from "../ui/theme";
import { LegalConsentBoxes, type LegalConsents, NO_LEGAL_CONSENTS } from "./LegalConsentBoxes";
import { canSubmitLegalAcceptance, toLegalAcceptanceInput } from "./legal-acceptance-input";
import { returnHref } from "./return-to";
import { acceptLegalTerms, signOut } from "./session-store";

export function AceptarCondicionesScreen({
  legalAcceptancePending,
  next,
}: {
  legalAcceptancePending: boolean;
  /** The destination the gate interrupted; `returnHref` re-checks it. */
  next?: string | string[];
}) {
  // NEVER pre-ticked, and never restored by anything but the person's own tap:
  // a consent the app ticks on somebody's behalf is not theirs.
  const [consents, setConsents] = useState<LegalConsents>(NO_LEGAL_CONSENTS);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const patch = useCallback((change: Partial<LegalConsents>) => {
    setConsents((current) => ({ ...current, ...change }));
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    setFailure(null);
    const verdict = toLegalAcceptanceInput(consents);
    if (!verdict.ok) {
      setFailure(verdict.message);
      return;
    }
    setBusy(true);
    const result = await acceptLegalTerms(verdict.input);
    if (!result.ok) {
      setFailure(result.message);
      setBusy(false);
      return;
    }
    // Saved: the store now holds a user with no `legalAcceptancePending`, the
    // route re-renders through `useGate`, and the redirect below takes over.
    // `busy` stays on so a second tap cannot race the first.
  }, [busy, consents]);

  if (!legalAcceptancePending) {
    const destination = returnHref(next);
    return <Redirect href={destination === ROUTES.root ? ROUTES.misMascotas : destination} />;
  }

  return (
    <Screen edges={["top", "bottom"]} gap={SPACE.xl}>
      <View style={styles.heading}>
        <Title>Actualizamos los términos y la política de privacidad</Title>
        <Subtitle>Para seguir usando tu cuenta necesitamos que los aceptes de nuevo.</Subtitle>
      </View>

      <Card>
        <Body>Cambió esto:</Body>
        {/* The CURRENT version's changes. `/me` says only that an acceptance is
            owed, not which version the account holds, so the app lists what
            this version changed; the web lists every change since the
            account's own version. */}
        {legalChangesSince(null).map((change) => (
          <Body key={change}>· {change}</Body>
        ))}
      </Card>

      <View style={styles.form}>
        <LegalConsentBoxes value={consents} disabled={busy} onChange={patch} />

        {failure === null ? null : (
          <Callout tone="err">
            <Body>{failure}</Body>
          </Callout>
        )}

        <PrimaryButton
          label={busy ? "Guardando…" : "Aceptar y continuar"}
          onPress={() => void submit()}
          disabled={busy || !canSubmitLegalAcceptance(consents)}
        />
      </View>

      <View style={styles.footer}>
        <Body>Si no estás de acuerdo, podés descargar tus datos o eliminar tu cuenta.</Body>
        <LinkText
          accessibilityHint="Se abre en el navegador"
          onPress={() => void Linking.openURL(ACCOUNT_DELETION_URL)}
        >
          Mis datos y eliminar mi cuenta
        </LinkText>
      </View>

      {/* The path travels with the sign-out so the gate does not reopen THIS
          screen at the next sign-in — see `signedOutHref`. */}
      <SecondaryButton
        label="Cerrar sesión"
        onPress={() => void signOut(ROUTES.aceptarCondiciones)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { alignItems: "center", gap: SPACE.xs + 2 },
  form: { gap: SPACE.lg },
  footer: { gap: SPACE.xs },
});
