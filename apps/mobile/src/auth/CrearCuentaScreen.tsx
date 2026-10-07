// Crear cuenta — step 1 of the web's two-step signup, and ONLY step 1.
//
// WHAT THIS SCREEN IS, AND WHERE IT STOPS
// ---------------------------------------------------------------------------
// The web collects an account (email, password twice, the legal checkboxes) and
// then, on the same page, an identity (nombre, apellido, DNI, localidad). This
// screen is the first half and hands the second to `identidad-pendiente`, which
// already exists and already says why it refuses to collect a name natively:
// the DNI hashing, the Ley 25.326 consent copy and the Mi Argentina federation
// path all live on the web, and a native form posting "some fields" would be a
// second, weaker definition of what a verified identity is (invariant #6).
//
// That is not a gap this screen leaves open by accident — it is the shape of
// the SERVER. `POST /api/v1/auth/signup` is step 1 and there is no `/api/v1`
// door for step 2: `completeIdentity` is still coupled to the web request, and
// the route header says so out loud. A native screen for a use-case with no
// endpoint would be a form that cannot submit.
//
// THE SCREEN IT REPLACES SAID NONE OF THIS EXISTS. Until now `ingreso.tsx`
// carried a card reading "Por ahora las cuentas se crean desde la web", and its
// own header explained that the web's "¿No tenés cuenta? Crear cuenta" link was
// deliberately NOT mirrored because "the callout at the bottom already says
// where accounts are made and why". Both were true and both are now wrong: the
// endpoint landed, so the link is the honest affordance and the callout was the
// stopgap.
//
// ---------------------------------------------------------------------------
// WHERE SOMEBODY LANDS AFTERWARDS, AND WHY IT IS NOT THIS SCREEN'S DECISION
// ---------------------------------------------------------------------------
// `SignupV1` is `{ session: AuthSessionV1 | null }` and BOTH arms are a 201:
//
//   · WITH a session (the current posture — email confirmations are OFF, PO
//     decision 2026-07-10) the store seeds the SDK, reads `/me`, and flips to
//     `signed-in`. The redirect below then goes to `/` — THE GATE — and the
//     gate decides. It will find `profilePending: true`, because a brand-new
//     account still carries the PROVISIONAL, email-derived display name the
//     `handle_new_user` trigger writes (the row itself is created in the same
//     transaction as the account — "no profile row" is not a state signup
//     produces, and this comment used to claim it was). The gate then sends the
//     person to `identidad-pendiente`. Routing straight there from here would be
//     this screen re-deciding something `useGate` already decides for every
//     other screen, and it would be wrong the day identity completion gets an
//     `/api/v1` door.
//
//   · WITHOUT one, the screen shows the panel at the bottom and points at
//     ingreso. It does NOT say why, and MUST not: `session: null` means the
//     email already has an account OR (if confirmations are ever switched on)
//     a genuine new one is waiting to be confirmed, and the server keeps those
//     two byte-identical precisely so this screen cannot become the
//     account-enumeration oracle audit 28-#3 closed on the web form. Copy that
//     helpfully said "esa cuenta ya existe" would rebuild it on the phone, out
//     of kindness, and nothing on the server would notice.
//
// THE COPY IS THE WEB'S WHERE THE SURFACE IS THE SAME, which is the rule
// `ingreso.tsx` follows for the login page: "Crear cuenta", "Creá la libreta
// digital de tu mascota", "Paso 1 de 2", "Correo electrónico", "Contraseña",
// "Repetir contraseña", "Mínimo 8 caracteres.", "Continuar", the Mi Argentina
// stub and the "o" divider. Two different sentences for one act is how a
// product starts feeling like two products.
//
// THE SUBMIT BUTTON IS NOT DISABLED FOR A BAD PASSWORD, only for a missing one.
// See `canSubmitSignup`: a dead button with no sentence beside it is the
// failure mode where somebody cannot tell whether the app is broken or they
// are. Let them press it, then say what is wrong — in the contract's declared
// order, so the message is about the first field of the form and not about
// whichever rule zod happened to collect first.

import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Body, Card, ErrorNotice } from "../ui/components";
import {
  Callout,
  Eyebrow,
  LabelledDivider,
  LinkText,
  PasswordField,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  TextField,
  Title,
} from "../ui/kit";
import { SPACE } from "../ui/theme";
import { useReturnKeyChain } from "../ui/use-return-key-chain";
import { LegalConsentBoxes } from "./LegalConsentBoxes";
import { signUp } from "./session-store";
import {
  EMPTY_SIGNUP_DRAFT,
  type SignupDraft,
  canSubmitSignup,
  toSignupInput,
} from "./signup-input";

// THE LEGAL BOXES MOVED to `./LegalConsentBoxes.tsx` (2026-10-07) when they
// became three and a second screen (`AceptarCondicionesScreen`) needed them:
// Terms and Privacy; the international transfer to Brasil and Estados Unidos,
// on its own and set apart; and the 18+ declaration (legal review 2026-10-02,
// rows P10 and P9; PO decision D2 = b). The web form says the same words.

export function CrearCuentaScreen({ onGoToSignIn }: { onGoToSignIn: () => void }) {
  const [draft, setDraft] = useState<SignupDraft>(EMPTY_SIGNUP_DRAFT);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  const patch = useCallback((next: Partial<SignupDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    setFailure(null);

    // The CONTRACT's schema, run locally first, so a refusal is a field
    // sentence instead of a round trip that answers `invalid_request` with no
    // field detail — and instead of a request that spends one of three signups
    // per minute this caller's IP is allowed.
    const verdict = toSignupInput(draft);
    if (!verdict.ok) {
      setFailure(verdict.message);
      return;
    }

    setBusy(true);
    const result = await signUp(verdict.input);
    if (!result.ok) {
      setFailure(result.message);
      setBusy(false);
      return;
    }
    if (!result.signedIn) {
      // 201 with no session. Not an error, and the screen must not name a
      // cause — see the header.
      setNeedsSignIn(true);
      setBusy(false);
      return;
    }
    // Signed in. The store flipped to `signed-in` and the route's redirect
    // fires. Deliberately NOT clearing `busy`: leaving the button disabled
    // until this screen unmounts is what stops a second submit racing the
    // first, and a second submit here would answer with the masquerade.
  }, [busy, draft]);

  // Return-key advance across the three single-line fields (M10, native-feel
  // audit): correo → contraseña → repetir contraseña, "done" on the last one
  // submitting — the shared chain instead of this screen's own
  // `returnKeyType="go"` + `onSubmitEditing` on just the last field.
  const chain = useReturnKeyChain(3, () => void submit());

  if (needsSignIn) {
    return (
      <Screen edges={["top", "bottom"]} gap={SPACE.xl}>
        <View style={styles.heading}>
          <Title>Tu cuenta está lista</Title>
        </View>
        <Card>
          {/* NEUTRAL, AND DELIBERATELY INCURIOUS. Two different situations
              produce this panel and the server keeps them indistinguishable on
              purpose; a sentence that guessed at which one would undo that.

              AND STILL A SUCCESS, SAID AS ONE (2026-09-09). The panel used to
              be headed "Ya podés ingresar" over "Continuá desde la pantalla de
              ingreso…", and after tapping "Crear cuenta" that read as a
              rejection, or as an errand somewhere else — the week a stale
              bundle was sending testers to the browser to sign in again, and
              the GoTrue log filled with invalid-credential attempts and
              duplicate signups. Two facts, no cause: the account is ready, and
              the next step is the sign-in screen IN THIS APP.

              U-3 (PO decision 21A, native review): "Ya podés ingresar desde
              esta misma app con ese correo y tu contraseña" read, for an
              email that already had an account, as an instruction to use the
              PASSWORD JUST TYPED — which is not the account's password, so the
              very next sign-in attempt failed. The sentence below says the
              same two facts without implying which password: it never says
              "esa cuenta ya existe" (the oracle this screen must not become),
              and it now points at "tu contraseña de siempre" instead of the
              one on this form. */}
          <Body>Si ese correo ya tenía cuenta, entrá con tu contraseña de siempre.</Body>
        </Card>
        <PrimaryButton label="Ir a iniciar sesión" onPress={onGoToSignIn} />
      </Screen>
    );
  }

  return (
    <Screen edges={["top", "bottom"]} keyboardAvoiding gap={SPACE.xl}>
      {/* Centred heading block — `text-center space-y-2` on the web. */}
      <View style={styles.heading}>
        <Title>Crear cuenta</Title>
        <Subtitle>Creá la libreta digital de tu mascota</Subtitle>
      </View>

      {/* The web's `Paso 1 de 2` eyebrow, and it earns its place here more than
          there: this app finishes step 2 on a DIFFERENT surface, so somebody
          who does not know a second step is coming would read the jump to
          `identidad-pendiente` as a failure. */}
      <View style={styles.heading}>
        <Eyebrow>Paso 1 de 2</Eyebrow>
      </View>

      <View style={styles.form}>
        <TextField
          {...chain(0)}
          accessibilityLabel="Correo electrónico"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          editable={!busy}
          inputMode="email"
          invalid={failure !== null}
          label="Correo electrónico"
          onChangeText={(email) => patch({ email })}
          placeholder="tu@email.com"
          required
          value={draft.email}
        />

        <PasswordField
          {...chain(1)}
          accessibilityLabel="Contraseña"
          autoCapitalize="none"
          // `new-password`, not `current-password`: it is what tells a password
          // manager to OFFER one rather than to look one up, and this form has
          // no account to look up yet.
          autoComplete="new-password"
          editable={!busy}
          label="Contraseña"
          onChangeText={(password) => patch({ password })}
          required
          value={draft.password}
        />
        <Body>Mínimo 8 caracteres.</Body>

        <PasswordField
          {...chain(2)}
          accessibilityLabel="Repetir contraseña"
          autoCapitalize="none"
          autoComplete="new-password"
          editable={!busy}
          label="Repetir contraseña"
          onChangeText={(confirmPassword) => patch({ confirmPassword })}
          required
          value={draft.confirmPassword}
        />

        <LegalConsentBoxes
          value={{
            tosAccepted: draft.tosAccepted,
            transferAccepted: draft.transferAccepted,
            adultDeclared: draft.adultDeclared,
          }}
          disabled={busy}
          onChange={patch}
        />

        {failure === null ? null : <ErrorNotice message={failure} />}

        <PrimaryButton
          label={busy ? "Creando la cuenta…" : "Continuar"}
          onPress={() => void submit()}
          disabled={busy || !canSubmitSignup(draft)}
        />
      </View>

      <LabelledDivider label="o" />

      {/* The Mi Argentina stub, after the form both visually and in the tree —
          invariant #6 makes federation the premise and the web promises it on
          this exact page. An app that omits the promise makes the roadmap look
          like it has two different futures. */}
      <SecondaryButton disabled label="Conectar con Mi Argentina (próximamente)" />

      <Callout>
        {/* WHAT COMES NEXT, said before it happens. The web finishes the
            identity step inline; this app sends the person to a screen that
            hands them a URL, and arriving there unannounced reads like the
            signup failed. */}
        <Body>
          Después de crear la cuenta te vamos a pedir tu nombre y tu apellido para completar la
          credencial. Es acá mismo y una sola vez.
        </Body>
      </Callout>

      <View style={styles.footer}>
        <Body>¿Ya tenés cuenta?</Body>
        <LinkText onPress={onGoToSignIn}>Iniciar sesión</LinkText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { alignItems: "center", gap: SPACE.xs + 2 },
  form: { gap: SPACE.lg },
  footer: { alignItems: "center", gap: SPACE.xs },
});
