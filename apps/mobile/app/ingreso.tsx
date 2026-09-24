// Ingreso — email and password, and one sentence when they are wrong.
//
// THE COPY IS THE SERVER'S, VERBATIM, AND THAT IS A SECURITY PROPERTY.
// ---------------------------------------------------------------------------
// `/api/v1/auth/login` answers `invalid_credentials` for "no such account" and
// for "wrong password" alike, byte-identical, so the endpoint cannot be used to
// find out which email addresses have accounts. A client that improved on that
// — "no encontramos esa cuenta" vs "contraseña incorrecta" — would rebuild the
// enumeration oracle on the phone, out of helpfulness, and nothing on the server
// would notice.
//
// So this screen renders `apiFailureMessage(...)` and adds nothing. The only
// text it composes itself is for failures the server never sees: no connection,
// a body it could not parse, a build with no auth plane.
//
// THE PASSWORD NEVER GOES TO GoTrue FROM HERE. It goes to `/api/v1/auth/login`,
// which applies our rate limits, our account-state refusals and that single
// sentence, and hands back tokens; only then does the SDK get a session to keep
// alive. See `signIn` in session-store.ts.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCREEN OWES THE WEB LOGIN, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
// The PO compared the two side by side. Where the SURFACE is the same, the
// web's literal copy wins — the title is "Iniciar sesión" and not "Ingresá a
// miMAR", the fields are "Correo electrónico" and "Contraseña", the subtitle is
// "Hola de nuevo", and the button says what the web's button says. Two
// different sentences for one act is how a product starts feeling like two
// products, which is the whole complaint this work unit answers.
//
// Three gaps are closed rather than restyled:
//
//   · "¿Olvidaste tu contraseña?" now exists. It opened the BROWSER at
//     `/recuperar` when it landed, under a written argument that there should
//     never be a native recovery flow because "the native half would end at the
//     same web page anyway". WU-R-1 reversed that, and the reversal is recorded
//     rather than quietly edited: the mail carries the recovery token as a
//     six-digit CODE as well as a link, and a code needs no browser to come back
//     — which is the only thing that works on a device with no verified App
//     Links. The link now pushes `/recuperar`, this app's own screen, and
//     `RecuperarScreen` carries the full account of what changed and what did
//     not.
//
//   · The "Conectar con Mi Argentina (próximamente)" placeholder, disabled,
//     because invariant #6 makes federation the premise and the web has been
//     promising it on this exact screen. An app that omits the promise makes
//     the roadmap look like it has two different futures.
//
//   · The "o" divider between them, which is what makes the placeholder read as
//     an alternative rather than as a second submit button.
//
// A FOURTH gap closed later, and the reversal is worth recording rather than
// quietly editing:
//
//   · "¿No tenés cuenta? Crear cuenta" now exists and opens `/crear-cuenta`.
//     This block used to list it under "NOT closed, and on purpose", with the
//     reasoning "the callout at the bottom already says where accounts are made
//     and why, in more words than a link can carry. Replacing it with the web's
//     two-word link would drop the explanation." That was true of a callout
//     reading "por ahora las cuentas se crean desde la web" — there WAS no
//     native signup, and a link to nothing is worse than a sentence. The
//     endpoint (`POST /api/v1/auth/signup`) and the screen landed, so the
//     explanation is no longer the honest thing to show: it now describes a
//     limitation that has been lifted.
//
// NOT closed, and still on purpose:
//
//   · "← Volver al inicio". The web's back link goes to a landing page. This
//     app has no landing page: `/` is the GATE, and it forwards a signed-out
//     visitor straight back to this screen. The link would be a button that
//     appears to do nothing, which is worse than its absence.

import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { returnHref } from "../src/auth/return-to";
import { sessionEndMessage, signIn } from "../src/auth/session-store";
import { useSession } from "../src/auth/useSession";
import { Body, ErrorNotice } from "../src/ui/components";
import {
  Callout,
  LabelledDivider,
  LinkText,
  PasswordField,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  TextField,
  Title,
} from "../src/ui/kit";
import { ROUTES } from "../src/ui/routes";
import { SPACE } from "../src/ui/theme";

export default function IngresoScreen() {
  const session = useSession();
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string | string[] }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Already in. Reached when a session arrives while this screen is mounted —
  // the "cerrar sesión en todos los dispositivos" flow bounces through here, and
  // since WU-O so does a deep link that found an expired session.
  if (session.phase === "signed-in") return <Redirect href={returnHref(params.next)} />;

  // Why the person is looking at this screen, when we know. `null` for a
  // deliberate sign-out: telling somebody "cerraste sesión" right after they
  // pressed "Cerrar sesión" is noise.
  const reason = session.phase === "signed-out" ? sessionEndMessage(session.reason) : null;

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setFailure(null);
    const result = await signIn(email.trim(), password);
    if (!result.ok) {
      setFailure(result.message);
      setBusy(false);
      return;
    }
    // On success the store flips to `signed-in` and the redirect above fires.
    // Deliberately NOT clearing `busy` first: leaving the button disabled until
    // this screen unmounts is what stops a second submit racing the first.
  }

  return (
    <Screen edges={["top", "bottom"]} keyboardAvoiding gap={SPACE.xl}>
      {/* Centred heading block — `text-center space-y-2` on the web. */}
      <View style={styles.heading}>
        <Title>Iniciar sesión</Title>
        <Subtitle>Hola de nuevo</Subtitle>
      </View>

      {/* A Callout and not a Card, because that is what the web renders here:
          the account-state notices on the login page are bordered tinted blocks
          (`rounded border px-4 py-3`), not titled panels. Neutral tone — an
          operator whose eight hours ran out did nothing wrong, and dressing a
          routine boundary in the error palette teaches people to ignore the
          error palette. The web's comment on the same block says exactly that. */}
      {reason === null ? null : (
        <Callout>
          <Body>{reason}</Body>
        </Callout>
      )}

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
          onChangeText={(next) => {
            setEmail(next);
            // A password is scoped to the email it was typed for; editing the
            // account must drop the stale one. Same rule as the web form, and
            // for the same reason (PO QA #44).
            setPassword("");
          }}
          placeholder="tu@email.com"
          required
          value={email}
        />

        <PasswordField
          accessibilityLabel="Contraseña"
          autoCapitalize="none"
          autoComplete="current-password"
          editable={!busy}
          label="Contraseña"
          onChangeText={setPassword}
          onSubmitEditing={() => void submit()}
          required
          returnKeyType="go"
          value={password}
        />

        {/* Right-aligned, as on the web (`flex justify-end`). PUSH and not
            replace, unlike the two `router.replace` calls elsewhere in this
            flow: somebody who taps this by accident, or who remembers the
            password on the way, must be able to come back with the gesture
            their phone already gives them. */}
        <View style={styles.forgot}>
          <LinkText onPress={() => router.push(ROUTES.recuperar)}>
            ¿Olvidaste tu contraseña?
          </LinkText>
        </View>

        {failure === null ? null : <ErrorNotice message={failure} />}

        <PrimaryButton
          label={busy ? "Ingresando…" : "Iniciar sesión"}
          onPress={() => void submit()}
          disabled={!canSubmit}
        />
      </View>

      <LabelledDivider label="o" />

      {/* The Mi Argentina stub, after the form both visually and in the tree —
          so focus order is email → contraseña → ingresar → stub, which is the
          order the web comments spell out for the same three controls. */}
      <SecondaryButton disabled label="Conectar con Mi Argentina (próximamente)" />

      {/* The web's own two-word affordance, in the web's own words. A Card with
          a paragraph stood here while there was no native signup to point at;
          now that there is, the paragraph would be explaining a limitation that
          no longer exists. What DOES still need saying — that the identity step
          finishes on the web — is said on the signup screen itself, where it is
          about to happen, rather than here where it is one step early. */}
      <View style={styles.footer}>
        <Body>¿No tenés cuenta?</Body>
        <LinkText onPress={() => router.push(ROUTES.crearCuenta)}>Crear cuenta</LinkText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { alignItems: "center", gap: SPACE.xs + 2, marginTop: SPACE.xl3 },
  form: { gap: SPACE.lg },
  forgot: { alignItems: "flex-end" },
  footer: { alignItems: "center", gap: SPACE.xs },
});
