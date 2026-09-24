// Crear cuenta — step 1 of the web's two-step signup, and ONLY step 1.
//
// WHAT THIS SCREEN IS, AND WHERE IT STOPS
// ---------------------------------------------------------------------------
// The web collects an account (email, password twice, the legal checkbox) and
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

import * as Linking from "expo-linking";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { PRIVACY_URL, TERMS_URL } from "../config/api";
import { Body, Card, ErrorNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
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
import { COLORS, LEADING, RADIUS, SPACE, TYPE } from "../ui/theme";
import { signUp } from "./session-store";
import {
  EMPTY_SIGNUP_DRAFT,
  type SignupDraft,
  canSubmitSignup,
  toSignupInput,
} from "./signup-input";

/**
 * The legal checkbox, LOCAL TO THIS SCREEN rather than promoted into `kit.tsx`.
 *
 * That is the kit's own rule, stated on `Choice`: "a primitive with one caller
 * is a guess about the second. It moves the day a second screen needs it." This
 * app has exactly one checkbox and it is this one — a Términos acceptance is
 * not a general boolean control, it is a legal act with a fixed shape.
 *
 * `accessibilityRole="checkbox"` with `accessibilityState.checked` is what makes
 * a screen reader announce it as something with two states rather than as a
 * button that does something unnamed. The label is the whole sentence, and the
 * two document links inside it are their OWN targets — nested `Pressable`s
 * would swallow the tap, so the links are separate rows under the sentence
 * instead of inline inside it. That is a deliberate divergence from the web,
 * where an inline `<a>` inside a `<label>` works and here it does not.
 */
function TosCheckbox({
  checked,
  onToggle,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.tos}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel="Leí y acepto los Términos y condiciones y la Política de privacidad, obligatorio"
        accessibilityState={{ checked, disabled }}
        disabled={disabled}
        hitSlop={SPACE.sm}
        onPress={onToggle}
        style={styles.tosRow}
      >
        <View style={[styles.box, checked ? styles.boxChecked : null]}>
          {/* Decoration. The state a screen reader needs travels on
              `accessibilityState`, never on this glyph. */}
          <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.boxMark}>
            {checked ? "✓" : ""}
          </Text>
        </View>
        <Text style={styles.tosLabel}>
          Leí y acepto los Términos y condiciones y la Política de privacidad.
        </Text>
      </Pressable>
      <View style={styles.tosLinks}>
        <LinkText
          accessibilityHint="Se abre en el navegador"
          onPress={() => void Linking.openURL(TERMS_URL)}
        >
          Términos y condiciones
        </LinkText>
        <LinkText
          accessibilityHint="Se abre en el navegador"
          onPress={() => void Linking.openURL(PRIVACY_URL)}
        >
          Política de privacidad
        </LinkText>
      </View>
    </View>
  );
}

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
              the next step is the sign-in screen IN THIS APP. */}
          <Body>Ya podés ingresar desde esta misma app con ese correo y tu contraseña.</Body>
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
          accessibilityLabel="Repetir contraseña"
          autoCapitalize="none"
          autoComplete="new-password"
          editable={!busy}
          label="Repetir contraseña"
          onChangeText={(confirmPassword) => patch({ confirmPassword })}
          onSubmitEditing={() => void submit()}
          required
          returnKeyType="go"
          value={draft.confirmPassword}
        />

        <TosCheckbox
          checked={draft.tosAccepted}
          disabled={busy}
          onToggle={() => patch({ tosAccepted: !draft.tosAccepted })}
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

  tos: { gap: SPACE.sm },
  tosRow: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm },
  box: {
    width: TYPE.lg,
    height: TYPE.lg,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
    // The control is small by design (it sits inside a sentence); the TAP
    // target is the whole row plus the hitSlop above, which is what WCAG 2.5.5
    // is about. `marginTop` aligns the box with the first line of the label
    // rather than with the block.
    marginTop: (TYPE.md * LEADING.md - TYPE.lg) / 2,
  },
  boxChecked: { borderColor: COLORS.accent, backgroundColor: COLORS.focusRing },
  boxMark: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.sm, color: COLORS.accent },
  tosLabel: {
    flex: 1,
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  // Indented to the label's left edge so the two documents read as belonging to
  // the sentence above them rather than as two more form rows.
  tosLinks: { gap: SPACE.xs, paddingLeft: TYPE.lg + SPACE.sm },
});
