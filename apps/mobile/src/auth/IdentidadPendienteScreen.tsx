// Completar registro — the screen for `profilePending: true`, and since
// 2026-09-05 the place the step actually HAPPENS.
//
// WHAT THIS SCREEN USED TO REFUSE TO DO
// ---------------------------------------------------------------------------
// It collected nothing. Its header argued that a native form posting "some
// fields" would create a SECOND, weaker definition of what a verified identity is
// — the Ley 25.326 consent copy, the DNI hashing (`lib/utils/dni-hash.ts`) and
// the Mi Argentina federation path (invariant #6) all live on the web — so the
// honest move was to hand over a URL and say the awkward part out loud: the link
// carries no session, the browser opens signed out, and the person has to type
// their email and password AGAIN.
//
// WHY THAT CHANGED (PO decision, 2026-09-05)
// ---------------------------------------------------------------------------
// The argument was right about the DNI and wrong about the NAME, and the pilot
// is what measured the difference. Testers read the second login as "confirm
// your email": one hour of GoTrue log on 2026-09-05 carries 8
// invalid-credential attempts and 2 duplicate signups on that web step. The
// handoff was not a rough edge, it was the drop-off.
//
// A name is not a claim about a national registry. It is the field
// `handle_new_user` GUESSES at from an email address, and the thing every other
// surface renders the person as. `POST /api/v1/me/identity` applies the same
// rules the web action applies — both halves required, both bounded, joined by
// `identityDisplayName`, refused if the result would still read as provisional —
// so this form is step 2 rather than a weaker copy of it.
//
// THE WEB LINK IS GONE (PO decision, 2026-09-07), and the paragraph that used to
// stand here said the opposite: that it stayed, demoted, because the DNI had not
// moved. The DNI has now moved — out of `/registro` entirely — so the link led to
// a form without the field it promised, through a re-login, in a browser that
// does not share this session.
//
// The measurement that settled it is the same kind as the one two paragraphs up.
// A pilot tester walked that path on day 1, reported the browser trip, and the
// second sign-in at 18:49:31 UTC is the last event their account has. One person
// is not a study; a demoted link that no longer leads anywhere useful needs no
// study.
//
// The uniqueness claim the old paragraph cited is exactly why the field went:
// `profiles_dni_hash_unique` is partial on `dni_hash IS NOT NULL`, NOT on
// `dni_verified`, so the unverified number that form collected could squat a
// stranger's slot. The argument is written out where the field was removed,
// `app/(auth)/registro/SignupForm.tsx`. Federation (invariant #6) is still the
// half that replaces this, and now it is the ONLY thing that will.
//
// WHY THIS FILE, AND NOT `app/identidad-pendiente.tsx`. This app's jest suite is
// anchored at `<rootDir>/src` (jest.config.js says so, and says why), so a
// component that lives under `app/` cannot be render-tested — and the redirect
// below is exactly the check that caused a redirect-loop bug (fixed 2026-09-04),
// which makes it the last check in this screen that should stay untestable.
//
// `profilePending` IS A PROP, NOT A RE-DERIVED READ. The thin route already asked
// `useGate` and holds the answer; a second read here would be a second place the
// two could disagree. It is also what makes the SUCCESS path work with no
// navigation call of its own: `completeIdentity` swaps the stored user, the route
// re-renders with `profilePending: false`, and the redirect below fires.
//
// THE FORM SITS ABOVE THE EXPLANATORY COPY, which is not the usual order and is
// deliberate. `Screen keyboardAvoiding` passes `behavior={undefined}` on Android
// (kit.tsx), so on an edge-to-edge Android build the keyboard is not compensated
// for by React Native and the platform no longer resizes the window either.
// Every form screen in this app has that property and fixing it belongs in
// `kit.tsx` as its own change; what this screen does is not depend on it — the
// two fields are the first thing under the title, and the return-key chain
// SUBMITS from "Apellido", so nothing anybody has to reach is ever under the
// keyboard.

import { Redirect } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Body, Card } from "../ui/components";
import {
  Callout,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  TextField,
  Title,
} from "../ui/kit";
import { ROUTES } from "../ui/routes";
import { SPACE } from "../ui/theme";
import { useReturnKeyChain } from "../ui/use-return-key-chain";
import {
  EMPTY_IDENTITY_DRAFT,
  type IdentityDraft,
  canSubmitIdentity,
  toIdentityInput,
} from "./identity-input";
import { returnHref } from "./return-to";
import { completeIdentity, signOut } from "./session-store";

export function IdentidadPendienteScreen({
  profilePending,
  next,
}: {
  profilePending: boolean;
  /**
   * The destination the gate was interrupting, when there was one — a PROP for
   * `profilePending`'s reason: the thin route already asked, and a second read
   * here is a second place the two could disagree. `returnHref` re-checks it
   * before it is navigated to, because `mimar://identidad-pendiente?next=…` is a
   * URL anybody can compose.
   */
  next?: string | string[];
}) {
  const [draft, setDraft] = useState<IdentityDraft>(EMPTY_IDENTITY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<keyof IdentityDraft | null>(null);

  // NO `useScrollToError`, and the omission is measured rather than lazy. That
  // hook moves the Screen's ScrollView through `ScreenScrollContext`, whose
  // PROVIDER lives inside `Screen` — so a screen component that renders its own
  // `<Screen>` is outside it and reads null. (`DenunciaScreen` and
  // `RecordEventScreen` call it from exactly that position; the hook is
  // best-effort by design and degrades to no-op, so nothing goes red. Worth
  // fixing, not here.) On a form this short it would buy nothing anyway: the
  // refusal renders between the last field and the button, both on screen.

  const patch = useCallback((next: Partial<IdentityDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    setFailure(null);
    setInvalidField(null);

    // The CONTRACT's schema, run locally first, so a refusal is a field sentence
    // instead of a round trip that answers `invalid_request` with no field detail
    // — the error envelope is one key (§2), so "which box" is a thing this screen
    // answers and the wire does not.
    const verdict = toIdentityInput(draft);
    if (!verdict.ok) {
      setFailure(verdict.message);
      setInvalidField(verdict.field);
      return;
    }

    setBusy(true);
    const result = await completeIdentity(verdict.input);
    if (!result.ok) {
      // THE TYPED VALUES SURVIVE. `draft` is this component's own state and
      // nothing here clears it — the web form had to fight React 19's automatic
      // reset for the same property (bug #46) and echo the names back through
      // `IdentityFormState`. Somebody whose save was refused must not have to
      // retype their own name.
      setFailure(result.message);
      setBusy(false);
      return;
    }
    // Saved. The store swapped the session user for the one the write returned,
    // so `profilePending` is now false, this component re-renders through the
    // route's `useGate`, and the redirect at the top of the render takes over.
    // Deliberately NOT clearing `busy`: leaving the button disabled until the
    // screen unmounts is what stops a second submit racing the first.
  }, [busy, draft]);

  // "Apellido" ends the chain and SUBMITS. Every other multi-field form in this
  // app leaves the last field on `done`-and-blur, because "a person reviewing six
  // fields has not said save yet" (`useReturnKeyChain`). Two required fields with
  // one button is the opposite case — the claim lookup makes the same call for
  // the same reason: finishing the last box IS the ask.
  const chain = useReturnKeyChain(2, () => void submit());

  // THE LOAD-BEARING CHECK, and it stays exactly where it was. A caller whose
  // identity is already complete — a deep link, a stale back-stack entry, the
  // redirect loop `return-to.ts` used to create by carrying
  // `next=/identidad-pendiente` through sign-in, or the save that just landed —
  // must not keep seeing this screen. `allowPendingIdentity: true` on the gate is
  // a build-time relaxation that lets THIS screen render while identity is
  // pending; it says nothing about whether it still is.
  //
  // IT LANDS ON `next` WHEN THERE IS ONE (A4-custodia-03). The pet list is still
  // the default and still what an ordinary signup gets; what changed is that a
  // person who arrived here from a caretaker invitation now finishes step 2 and
  // lands on the invitation instead of on an empty list.
  //
  // `returnHref` ANSWERS `/` FOR "NOTHING USABLE" — an absent parameter and a
  // hostile one alike — and this screen keeps sending that to the pet list
  // rather than to the gate. `/` would forward there anyway; going straight
  // spends one fewer render of a screen that redirects.
  if (!profilePending) {
    const destination = returnHref(next);
    return <Redirect href={destination === ROUTES.root ? ROUTES.misMascotas : destination} />;
  }

  return (
    <Screen edges={["top", "bottom"]} keyboardAvoiding gap={SPACE.xl}>
      <View style={styles.heading}>
        <Title>Completá tu registro</Title>
        <Subtitle>Es una sola vez.</Subtitle>
      </View>

      <View style={styles.form}>
        <TextField
          autoCapitalize="words"
          autoComplete="given-name"
          editable={!busy}
          invalid={invalidField === "firstName"}
          label="Nombre"
          onChangeText={(firstName) => patch({ firstName })}
          required
          textContentType="givenName"
          value={draft.firstName}
          {...chain(0)}
        />

        <TextField
          autoCapitalize="words"
          autoComplete="family-name"
          editable={!busy}
          invalid={invalidField === "lastName"}
          label="Apellido"
          onChangeText={(lastName) => patch({ lastName })}
          required
          textContentType="familyName"
          value={draft.lastName}
          {...chain(1)}
        />

        {/* BETWEEN THE LAST FIELD AND THE BUTTON, which is where somebody who
            just pressed Guardar is looking. The `err` tone is an assertive live
            region and an alert role (kit.tsx), so a TalkBack user hears it
            without exploring the screen. */}
        {failure === null ? null : (
          <Callout tone="err">
            <Body>{failure}</Body>
          </Callout>
        )}

        <PrimaryButton
          label={busy ? "Guardando…" : "Guardar"}
          onPress={() => void submit()}
          disabled={busy || !canSubmitIdentity(draft)}
        />
      </View>

      <Card>
        <Body>
          Con tu nombre y tu apellido podemos emitir la credencial de tus mascotas a tu nombre.
        </Body>
      </Card>

      {/* THE WEB DOOR IS GONE (2026-09-07), and it went because the thing behind
          it went first.

          It existed for exactly one reason — the DNI, which this app
          deliberately never collects — and `/registro` stopped asking for one on
          the same day (see the removed field in
          `app/(auth)/registro/SignupForm.tsx` for the full argument: an
          unverified number unlocked nothing and could squat the unique index on
          somebody else's identity). Keeping the link would have sent a person
          through a re-login, into a browser that does not share this app's
          session, to reach a form that no longer has the field they were
          promised. That is worse than not offering it.

          A pilot tester reported this exact trip on day 1 and it was the last
          thing their account ever did.

          The DNI is not gone from the product: `/cuenta/verificar-dni` still
          asks, voluntarily and with its own audit trail, and it is what actually
          gates the vet upgrade, creating an organization or a consultorio, and
          volunteering as tránsito. Nothing points there from here because
          nothing here needs it — this screen exists to get a name, and once
          Guardar lands it disappears. */}

      {/* The path travels with the sign-out so the gate suppresses the `next`
          parameter for THIS screen only — see `signedOutHref`. A constant and
          not `usePathname()` because this screen has exactly one address. */}
      <SecondaryButton
        label="Cerrar sesión"
        onPress={() => void signOut(ROUTES.identidadPendiente)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { alignItems: "center", gap: SPACE.xs + 2 },
  form: { gap: SPACE.lg },
});
