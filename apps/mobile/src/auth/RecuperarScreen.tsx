// Recuperar contraseña — the native half of the flow, in two steps on one
// screen (WU-R-1).
//
// WHY THIS SCREEN EXISTS AT ALL, AND WHAT IT REVERSES
// ---------------------------------------------------------------------------
// `PASSWORD_RECOVERY_URL` used to carry a written argument AGAINST a native
// recovery flow, and it was a good one: "the reset round-trip is an emailed link
// that opens in a BROWSER, so the native half would end at the same web page
// anyway, minus the rate limiting and the account-state refusals that live
// there." Both halves of that turned out to be answerable rather than true.
//
//   · THE RATE LIMITING IS NOT LOST. `POST /api/v1/auth/password-reset` is an
//     adapter over the same use-case the web form calls and spends the same two
//     buckets, keyed the same way. Switching transport buys no fresh budget.
//   · THE ROUND-TRIP IS NOT ONLY A LINK. The mail carries the recovery token
//     twice — as a link and as a six-digit code — and a code does not need a
//     browser to come back. It travels through the person's own eyes, which is
//     the one channel that survives a device with no verified App Links.
//
// THE CODE DOES TRAVEL — MEASURED 2026-09-04, and this paragraph used to say
// the opposite. It claimed Supabase's default recovery template renders the link
// and not the code, so "the browser is where a real tester finishes" until a
// PO-gated dashboard edit. A real recovery mail from the hosted project was read
// end to end that day and it carries the six-digit code, so the native loop
// closes on its own and no dashboard change is pending for it.
//
// The browser bridge stays anyway, and for a smaller reason than the one it was
// given: a mail client, a forwarded message or a template somebody edits later
// can still deliver a link and no code, and a person holding one has no other
// way through. It is a fallback now, not a workaround for a missing feature —
// which is exactly what its copy asks ("¿El correo trae un enlace y no un
// código?").
//
// TWO STEPS, ONE SCREEN, AND THE EMAIL IS NOT RE-TYPED. `verifyOtp` needs the
// address as well as the code — a six-digit code is not globally unique — so
// splitting the steps across two routes would mean either passing an e-mail
// through navigation params or asking for it twice. Keeping both in one
// component keeps it in state, where it belongs.
//
// WHAT THIS SCREEN MUST NEVER SAY
// ---------------------------------------------------------------------------
// Whether the address has an account. The server answers the same 202 either
// way and does not itself know, and `resetPasswordWithCode` collapses every
// redemption failure — wrong code, expired code, spent code, no such account —
// into one sentence for exactly the same reason. A screen that improved on
// either ("no encontramos esa cuenta") would rebuild the enumeration oracle on
// the phone, out of helpfulness, and nothing on the server would notice. It is
// the same rule `ingreso.tsx` follows for `invalid_credentials`.
//
// COPY: the web's, where the surface is the same. The title and the subtitle are
// `app/(auth)/recuperar/page.tsx`'s literal strings; the password fields are
// `UpdatePasswordForm`'s ("Nueva contraseña", "Repetir contraseña", "Mínimo 8
// caracteres."). What is NOT the web's is anything about a code, because the web
// has no code — those sentences are this surface's own.

import * as Linking from "expo-linking";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { PASSWORD_RECOVERY_URL } from "../config/api";
import { Body, ErrorNotice } from "../ui/components";
import {
  Callout,
  LinkText,
  PasswordField,
  PrimaryButton,
  Screen,
  Subtitle,
  TextField,
  Title,
} from "../ui/kit";
import { SPACE } from "../ui/theme";
import { requestPasswordReset, resetPasswordWithCode } from "./session-store";

/**
 * The six-digit length Supabase mints (`otp_length = 6`, supabase/config.toml).
 *
 * Used ONLY to size the input and to decide when the submit button lights up —
 * never to refuse a code. The server-side length is GoTrue's to change, and a
 * client that hard-refused a seven-digit code would be a build that stops working
 * the day the dashboard changes a setting nobody thought to grep for.
 */
const CODE_LENGTH = 6;

type Step = "ask" | "redeem";

export function RecuperarScreen({ onGoToSignIn }: { onGoToSignIn: () => void }) {
  const [step, setStep] = useState<Step>("ask");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const canAsk = email.trim().length > 0 && !busy;
  const canRedeem =
    code.trim().length >= CODE_LENGTH && password.length > 0 && confirmPassword.length > 0 && !busy;

  async function ask() {
    if (!canAsk) return;
    setBusy(true);
    setFailure(null);
    const result = await requestPasswordReset(email.trim());
    setBusy(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    // SUCCESS IS NOT AN ANSWER ABOUT THE ADDRESS — see the header. The screen
    // moves on regardless, because moving on only for a known address IS the
    // oracle.
    setStep("redeem");
  }

  async function redeem() {
    if (!canRedeem) return;
    setBusy(true);
    setFailure(null);
    const result = await resetPasswordWithCode({
      email: email.trim(),
      code: code.trim(),
      password,
      confirmPassword,
    });
    if (!result.ok) {
      setFailure(result.message);
      setBusy(false);
      return;
    }
    // On success the store flipped to `signed-in` and the route's redirect fires.
    // Deliberately NOT clearing `busy`: leaving the button disabled until this
    // screen unmounts is what stops a second submit racing the first — and a
    // second submit here would spend a code that no longer exists.
  }

  return (
    <Screen edges={["top", "bottom"]} keyboardAvoiding gap={SPACE.xl}>
      {/* Centred heading block — `text-center space-y-2` on the web, and the
          web's own two sentences. */}
      <View style={styles.heading}>
        <Title>Recuperar contraseña</Title>
        <Subtitle>
          Ingresá tu correo y te enviamos un código para crear una nueva contraseña.
        </Subtitle>
      </View>

      {step === "ask" ? (
        <View style={styles.form}>
          <TextField
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            editable={!busy}
            inputMode="email"
            invalid={failure !== null}
            label="Correo electrónico"
            onChangeText={setEmail}
            onSubmitEditing={() => void ask()}
            placeholder="tu@email.com"
            required
            returnKeyType="go"
            value={email}
          />

          {failure === null ? null : <ErrorNotice message={failure} />}

          <PrimaryButton
            disabled={!canAsk}
            label={busy ? "Enviando…" : "Enviar código"}
            onPress={() => void ask()}
          />
        </View>
      ) : (
        <View style={styles.form}>
          {/* NEUTRAL, AND DELIBERATELY INCURIOUS — the same posture the signup
              masquerade panel takes. "Si existe una cuenta" is the whole point:
              this app was not told whether one does. */}
          <Callout>
            <Body>
              Si existe una cuenta con ese correo, te enviamos un código de 6 dígitos. Revisá
              también tu carpeta de spam.
            </Body>
          </Callout>

          <TextField
            autoCapitalize="none"
            // `one-time-code` is what tells iOS and Android to offer the code
            // straight off the notification, which is the difference between
            // typing six digits and tapping once.
            autoComplete="one-time-code"
            autoCorrect={false}
            editable={!busy}
            inputMode="numeric"
            invalid={failure !== null}
            label="Código"
            // NO maxLength (A1-refuter-M3). The docblock on CODE_LENGTH says this
            // number is used "never to refuse a code", and a hard cap on the
            // input is exactly that refusal wearing a different hat: raising
            // GoTrue otp_length in the dashboard would leave every shipped build
            // silently truncating the code it was sent. The >= gate below is what
            // decides when the button lights up.
            onChangeText={setCode}
            required
            value={code}
          />

          <PasswordField
            autoCapitalize="none"
            // `new-password`, not `current-password`: it tells a password manager
            // to OFFER one rather than look one up, and the one it would look up
            // is the password being replaced.
            autoComplete="new-password"
            editable={!busy}
            label="Nueva contraseña"
            onChangeText={setPassword}
            required
            value={password}
          />
          <Body>Mínimo 8 caracteres.</Body>

          <PasswordField
            autoCapitalize="none"
            autoComplete="new-password"
            editable={!busy}
            label="Repetir contraseña"
            onChangeText={setConfirmPassword}
            onSubmitEditing={() => void redeem()}
            required
            returnKeyType="go"
            value={confirmPassword}
          />

          {failure === null ? null : <ErrorNotice message={failure} />}

          <PrimaryButton
            disabled={!canRedeem}
            label={busy ? "Cambiando…" : "Cambiar contraseña"}
            onPress={() => void redeem()}
          />

          {/* Back to step one WITHOUT clearing the address, because asking for
              another code is the recovery from a mistyped digit and re-typing an
              e-mail is not part of it. The code IS cleared: the one in the box is
              the one that just failed. */}
          <View style={styles.secondary}>
            <LinkText
              onPress={() => {
                setCode("");
                setFailure(null);
                setStep("ask");
              }}
            >
              Pedir otro código
            </LinkText>
          </View>
        </View>
      )}

      {/* THE BROWSER BRIDGE, AND IT IS NOT A FALLBACK FOR A BROKEN SCREEN. The
          mail carries a link as well as a code, and until the Supabase recovery
          template is edited to render the code the link is the only half that
          arrives. Saying that out loud beats a person staring at a code box for a
          code that is not in their inbox. Delete this block on the day the
          template lands — and not before. */}
      <View style={styles.secondary}>
        <Body>¿El correo trae un enlace y no un código?</Body>
        <LinkText
          accessibilityHint="Se abre en el navegador"
          onPress={() => void Linking.openURL(PASSWORD_RECOVERY_URL)}
        >
          Seguir en el navegador
        </LinkText>
      </View>

      <View style={styles.footer}>
        <LinkText onPress={onGoToSignIn}>Volver a iniciar sesión</LinkText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { alignItems: "center", gap: SPACE.xs + 2, marginTop: SPACE.xl3 },
  form: { gap: SPACE.lg },
  secondary: { alignItems: "center", gap: SPACE.xs },
  footer: { alignItems: "center", gap: SPACE.xs },
});
