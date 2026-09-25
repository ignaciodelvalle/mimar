// The app root: providers, the session bootstrap, and one Stack.
//
// WHY expo-router AND NOT react-navigation DIRECTLY
// ---------------------------------------------------------------------------
// M1's `App.tsx` said the choice should be made against a real requirement
// rather than pre-committed by a scaffold. The requirement arrived with M2 and
// it points one way: this app has to be able to OPEN A LINK. Invariant #1 is
// that a `DIM-XXXX-XXXX` token resolves to a QR-verifiable page, and the end
// state (blocked only on a Play-signed fingerprint — see app.config.ts) is that
// scanning that QR opens THIS app at that pet. `@dim/contract/links` already
// holds the table mapping a logical destination to its path, shared with the web
// app; a file-based router whose screens ARE paths lines up with that table
// directly, while a hand-registered navigator would need a second, parallel
// mapping from path to screen name — which is exactly the drift the contract
// package exists to prevent.
//
// No blocker was found. expo-router sits on react-navigation, so nothing is lost
// if the file tree ever stops paying for itself.
//
// THE GATE IS NOT HERE. Every screen decides for itself whether it can render
// (see `useGate`), and this layout only declares the stack. A gate implemented
// as an effect in the layout has to guess at mount order and races the first
// paint; a gate implemented as a `<Redirect>` inside the screen is evaluated by
// the same render that would have drawn the protected content, so there is no
// frame in which it is visible.

import * as Sentry from "@sentry/react-native";
import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

// The PORT, not the settings card that used to export it (finding F7): this
// module runs before the first paint, and reaching a four-line object literal
// through a Card, the ui kit and expo-constants is a dependency nobody would
// look for here.
import { EXPO_UPDATES_PORT } from "../src/account/expo-updates-port";
import { useForegroundUpdateCheck } from "../src/account/foreground-update";
import { ASYNC_STORAGE_MARKER_STORE } from "../src/account/launch-gate-marker-store";
import {
  LAUNCH_GATE_UPDATING_MESSAGE,
  useLaunchUpdateGate,
} from "../src/account/launch-update-gate";
import { useSessionBootstrap } from "../src/auth/useSession";
// THE ONE MODULE IN THIS FILE THAT MAY NOT BE IMPORTED ANYWHERE ELSE. Its own
// header explains why: `expo-image-manipulator` evaluates a native module at
// import time and throws in a process that has none. This file already runs in
// exactly one process — the app's — so the opt-in is safe here and nowhere else.
import {
  expoImagePicker,
  warmPendingImagePickRecovery,
} from "../src/native/expo-image-picker-adapter";
// THE SECOND SUCH MODULE, and the same rule applies to it for the same reason:
// `expo-notifications` touches the native runtime at import time.
import { expoPush } from "../src/native/expo-push-adapter";
import { forgetSharedFiles } from "../src/native/file-share";
import { setImagePickerPort } from "../src/native/image-picker-port";
import { ensureNotificationChannelSafely, setPushPort } from "../src/native/push-port";
import { startPushRegistration } from "../src/notifications/push-session-binding";
import { usePushTapNavigation } from "../src/notifications/push-tap";
import { initSentry } from "../src/observability/sentry";
import { useNavigationBreadcrumb } from "../src/observability/use-navigation-breadcrumb";
import { HeaderBackButton } from "../src/ui/HeaderBackButton";
import { OfflineBanner } from "../src/ui/OfflineBanner";
import { HeaderMenuButton } from "../src/ui/TopLevelNavMenu";
import { FONTS, useLnFonts } from "../src/ui/fonts";
import { COLORS, TYPE } from "../src/ui/theme";

// AT MODULE SCOPE, before the first render: an error during the initial render
// is precisely the kind the pilot needs reported, and an init inside an effect
// runs after it. `initSentry` no-ops (returning false) when the build carries
// no DSN — local dev and the emulator stay silent by design; see
// src/observability/sentry.ts for everything that is deliberately off.
initSentry();

// THE SEAM IS FLIPPED HERE, AND ONLY HERE (docs/mobile/camera-modules-handback.md,
// "The wiring — two lines at bootstrap"). At module scope for the same reason
// `initSentry` is: it must have happened before the first render, because
// `PetPhotoScreen` and the tatuaje branch of `RecordEventScreen` read
// `available` DURING render to decide whether to draw a control at all. An
// install inside an effect would let both screens paint their "todavía no se
// puede" callout once, on a build that can.
//
// No test imports this file, so every existing test still runs against the
// honest default (`moduleMissingImagePicker`) — which is what keeps the callout
// states meaningful in the suite.
//
// THE CHIP SCANNER'S SEAM IS STILL UNFLIPPED. `expo-camera` is not installed;
// `setChipScannerPort` has no adapter to be handed and the claim screen keeps
// its "el número va a mano" callout. Same wall, separate commit.
setImagePickerPort(expoImagePicker);
// THE RECOVERY READ, FIRED HERE AND NOWHERE ELSE (T4-M1, 2026-09-22 — the
// adapter's header has the whole design decision). It only STARTS the native
// call; it does not await or claim it, so it never delays this module's own
// evaluation. By the time `PetPhotoScreen` or the tatuaje branch of
// `RecordEventScreen` mount and ask for it, the answer is usually already in.
warmPendingImagePickRecovery();
// THE SHARED-FILES SWEEP, ONCE PER PROCESS START (M13 security review). A
// poster PDF or the art. 14 export handed to the share sheet in the previous
// run is safe to delete now: whatever app received it has had a whole process
// lifetime to read it. Sign-out and erasure sweep too; this catches the person
// who never signs out. Synchronous and never throws.
forgetSharedFiles();

// THE PUSH SEAM, FLIPPED THE SAME WAY AND IN THE SAME PLACE — but note what is
// NOT true of it. Nothing reads `available` during render, because this unit
// ships no push screen and no toggle; the port is installed at module scope
// because that is where the seam convention puts it, not because a paint
// depends on it.
setPushPort(expoPush);

// AND THE BINDING THAT ACTUALLY REGISTERS. It subscribes to the session and
// fires once against whatever state already exists, which matters: a launch
// that restores a stored session is the ordinary case, and `bootstrapSession`
// may have resolved before this line runs. It never unsubscribes — the app has
// one session for its whole life.
startPushRegistration();

// AND THE ANDROID CHANNEL, WHICH IS NOT PART OF REGISTRATION AND MUST NOT WAIT
// FOR IT. Android draws a notification through a channel; without one, every
// message lands in expo-notifications' unnamed fallback and the app's
// declaration of how this category behaves applies to nothing. It belongs at app
// start rather than at sign-in because it is a property of the INSTALL — it has
// to exist before the first notification arrives, which can be before anybody
// has signed in on this phone at all.
//
// Fire-and-forget, and safe: the port's wrapper swallows, the call is an upsert,
// and a channel that could not be created costs a duller presentation rather
// than a lost notification. Nothing renders from it, so nothing waits for it.
void ensureNotificationChannelSafely();

/**
 * THE ANCHOR: where hardware BACK goes when there is nothing behind (NAV-1).
 *
 * A person who opens this app from a link — a notification, an invitation
 * e-mail, a QR — lands on a stack ONE screen deep. Android's back button on
 * that screen had nowhere to go, so it quit the app: they read a transfer
 * proposal, pressed back to see the rest of miMAR, and the app closed.
 *
 * `anchor` tells expo-router which sibling route to place UNDER a deep-linked
 * screen, so back unwinds into the app instead of out of it. `index` is the
 * gate — it is a decision, not a page, and it forwards to wherever the person
 * belongs — which is exactly what "one step back from a deep link" means here.
 *
 * expo-router 57 validates this against the layout's real children and throws
 * on a name that does not exist (`getRoutesCore.js`, "has invalid anchor"), so
 * a rename cannot leave it silently pointing at nothing.
 */
export const unstable_settings = { anchor: "index" };

function RootLayout() {
  const fontsReady = useLnFonts();
  useSessionBootstrap();
  // One breadcrumb per screen change, ids stripped (OBS-5). Called BEFORE the
  // font gate returns early — a hook that runs conditionally is not a hook, and
  // the cold-start screens are the ones whose order matters most.
  useNavigationBreadcrumb(usePathname());
  // THE FIRST LAUNCH OF A FRESH INSTALL WAITS FOR A PENDING OTA (2026-09-09).
  // A Play install runs the bundle baked into the binary on its first open, and
  // `fallbackToCacheTimeout: 0` means whatever was published since applies on
  // the SECOND open — a tester was shown a screen deleted two days earlier and
  // followed its stale instruction into the browser. This holds that one
  // launch, bounded, and every other launch answers `done` synchronously. It
  // only exists in builds that embed it, so it cannot fix installs that
  // predate it — see `src/account/launch-update-gate.ts` for both halves.
  const launchGate = useLaunchUpdateGate(EXPO_UPDATES_PORT, ASYNC_STORAGE_MARKER_STORE);
  // AN OTA HOTFIX HAS TO REACH A PHONE NOBODY RESTARTS (A6-cuenta-resiliencia-08).
  // `checkAutomatically` is ON_LOAD, so a resident app never looks; this stages
  // the bundle on the way back to the foreground, silently, so the next launch
  // applies it instead of the one after that. It never reloads on its own — see
  // `src/account/foreground-update.ts`. Called BEFORE the font gate returns
  // early, like the breadcrumb above: a hook that runs conditionally is not one.
  // `suspended` while the launch gate is fetching: two fetches into one staging
  // directory is the overlap that hook's own `running` guard exists to stop.
  useForegroundUpdateCheck(EXPO_UPDATES_PORT, { suspended: launchGate !== "done" });
  // WHERE A TAPPED NOTIFICATION GOES. A hook and not a module-scope subscription
  // like the two `set…Port` calls above, for one reason: navigating needs a
  // router, and the router does not exist until this layout has rendered. It
  // handles both arrivals — the listener for a tap on a running app, and the
  // module's held response for the tap that STARTED the process, which is the
  // common one and the one a manual test never produces. Called before the font
  // gate returns early, like the two hooks above and for the same reason.
  usePushTapNavigation();

  // THE FIRST PAINT WAITS FOR THE TYPEFACE, and the alternative is worse than a
  // pause. React Native draws immediately with the system face and re-lays-out
  // when the font arrives; at these sizes IBM Plex Serif and Roboto have very
  // different metrics, so what the user sees is the whole screen jumping. This
  // is a few hundred milliseconds ONCE per cold start, on a bundled asset with
  // no network in the path. `useLnFonts` releases the gate on failure too, so a
  // font that cannot load costs an ugly app rather than an app that never opens.
  //
  // THE LAUNCH GATE SHARES THIS FRAME. While it is deciding (a local read,
  // milliseconds) it is indistinguishable from the font wait; while it is
  // fetching, one sentence says so. A bare `Text` and not the kit's `Body`,
  // for the reason `expo-updates-port.ts` gives: the root layout must not pull
  // in the UI kit to draw a spinner.
  if (!fontsReady || launchGate !== "done") {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: COLORS.canvas,
          }}
        >
          <ActivityIndicator color={COLORS.accent} />
          {launchGate === "updating" ? (
            <Text
              style={{
                marginTop: 16,
                color: COLORS.inkSoft,
                fontFamily: fontsReady ? FONTS.sans : undefined,
                fontSize: TYPE.md,
              }}
            >
              {LAUNCH_GATE_UPDATING_MESSAGE}
            </Text>
          ) : null}
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {/* Once, above the Stack: the network's absence said proactively, on
          every screen, before anybody spends a tap on a dead spot. */}
      <OfflineBanner />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: COLORS.canvas },
          headerTintColor: COLORS.ink,
          // The header title is the same display face as a `Title` inside the
          // page. A stack header in the system font over a serif screen is the
          // seam that made the app look assembled rather than designed.
          headerTitleStyle: {
            fontFamily: FONTS.serif,
            fontSize: TYPE.lg,
            color: COLORS.ink,
          },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: COLORS.canvas },
          // A-4 (native review): app-wide, replacing the automatic back
          // control's TalkBack name ("Navigate up", AndroidX's own unlabelled
          // default) with "Volver". See `HeaderBackButton`'s own header for
          // why no declarative prop does this in this build's react-navigation
          // / react-native-screens versions. `identidad-pendiente` and
          // `mascotas/index` override this back to `() => null` below — they
          // hide the back control on purpose and were never this component's
          // decision to make.
          headerLeft: (props) => <HeaderBackButton {...props} />,
        }}
      >
        {/* The gate renders no chrome of its own — it is a decision, not a page. */}
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* Ingreso draws its own title, exactly as the web login does — that page
            has no chrome either. A stack header saying "Ingresar" above an
            `<h1>` saying "Iniciar sesión" is the same word twice in two voices. */}
        <Stack.Screen name="ingreso" options={{ headerShown: false }} />
        {/* Same reasoning as ingreso, one door over: the web's `/registro` page
            has no chrome either and this screen draws its own "Crear cuenta"
            title. A stack header repeating it would be the same words twice in
            two voices. */}
        <Stack.Screen name="crear-cuenta" options={{ headerShown: false }} />
        <Stack.Screen
          name="identidad-pendiente"
          // `headerLeft: () => null` — not just `headerBackVisible: false` —
          // since the screenOptions default now supplies its OWN `headerLeft`,
          // which a per-screen `headerBackVisible` no longer has any control
          // over once one is set.
          options={{ title: "Falta un paso", headerBackVisible: false, headerLeft: () => null }}
        />
        {/* HEADER MENU ON BOTH — U-1 (M2, Samsung J7 2016 / Android 8): every
            top-level destination used to be a footer link below every pet
            card, unreachable from here or from the pet screen without
            scrolling past the whole list. `HeaderMenuButton` sits in the
            native header, which never scrolls, and opens a sheet naming all
            eight at once. See `src/ui/TopLevelNavMenu.tsx`. The footer stays
            — this is a second door, not a replacement. */}
        <Stack.Screen
          name="mascotas/index"
          options={{
            title: "Mis mascotas",
            headerBackVisible: false,
            // See the note on `identidad-pendiente` above: the global
            // `headerLeft` default needs its own override here too.
            headerLeft: () => null,
            headerRight: () => <HeaderMenuButton />,
          }}
        />
        {/* The pet screen carries THREE faces now — the owner's chrome, the
            libreta and the public credential — so the header can no longer name
            one of them. "Mascota" is what the screen is; the switcher inside it
            says which face is showing. */}
        <Stack.Screen
          name="mascotas/[publicToken]"
          options={{ title: "Mascota", headerRight: () => <HeaderMenuButton /> }}
        />
        <Stack.Screen
          name="mascotas/[publicToken]/eventos/[eventId]"
          options={{ title: "Registro" }}
        />
        {/* The header says the ACT, not the kind: which asiento is being written
            is the screen's own title, and the picker has not decided yet when
            this header first draws.
            "Anotar", not "Asentar" (U-2, native review): this native header
            used to disagree with the credential front's own pill for the same
            act, reached from the same button. */}
        <Stack.Screen name="mascotas/[publicToken]/asentar" options={{ title: "Anotar" }} />
        <Stack.Screen name="alta" options={{ title: "Registrar una mascota" }} />
        <Stack.Screen name="ajustes" options={{ title: "Ajustes" }} />
        {/* Registered for its TITLE, like `editar` below. An unregistered route
            takes its header from the last path segment, which here would read
            "privacidad" — lowercase, and half the name: the screen carries BOTH
            Ley 25.326 rights, and a header saying only "Privacidad" would let
            somebody who came to download their file think they were on the
            deletion page. "Mis datos" is what both halves are about. */}
        <Stack.Screen name="cuenta/privacidad" options={{ title: "Mis datos" }} />
        {/* The header says the ACT and the screen says the subject, which is the
            rule `mascotas/[publicToken]/editar` follows one line down. Unlike
            that one, this route's own segment would already read "editar" — the
            registration is here for the capital letter and for the accent. */}
        <Stack.Screen name="cuenta/editar" options={{ title: "Editar" }} />
        {/* The transfer hub is a SIBLING of the pet list, not a child of a pet:
            half of what it shows is offers from animals somebody else owns. */}
        <Stack.Screen name="transferencias/index" options={{ title: "Transferencias" }} />
        {/* The inbox, a sibling for the same reason and a stronger one: a
            notification is addressed to a person, not to an animal. */}
        <Stack.Screen name="notificaciones" options={{ title: "Notificaciones" }} />
        {/* THE DEEP-LINK DESTINATION. A person can arrive here from a
            notification with no history behind them, so the header says what the
            screen IS rather than naming a step in a flow they did not walk. */}
        <Stack.Screen name="transferencias/[transferToken]" options={{ title: "Transferencia" }} />
        {/* The header says the ACT. Which animal is the screen's own title. */}
        <Stack.Screen name="mascotas/[publicToken]/transferir" options={{ title: "Transferir" }} />
        {/* Registered for its TITLE and nothing else. An unregistered route
            takes its header from the path segment, which here would read
            "editar" — a lowercase English-looking verb in a Spanish stack. The
            screen carries two forms under one act, and the header says the act. */}
        <Stack.Screen name="mascotas/[publicToken]/editar" options={{ title: "Editar" }} />
        {/* LA FOTO. Sin registrar, el encabezado diría "foto" en minúscula. EL
            TÍTULO SE TRANSCRIBE, NO SE INVENTA — la condición del integrador al
            registrar `/reclamar`: "Foto de la mascota" es el `<Title>` que la
            pantalla ya dibuja en su estado de entrada, y "Foto" es la etiqueta
            del campo en el formulario de la web (`LnPhotoField`). Es el SUJETO
            y no el resultado, como `/denunciar`: la pantalla se retitula sola
            ("¿Usar esta foto?", "Foto actualizada") y un encabezado que la
            siguiera renombraría la página mientras alguien decide. */}
        <Stack.Screen
          name="mascotas/[publicToken]/foto"
          options={{ title: "Foto de la mascota" }}
        />
        {/* MUDANZA. Sin registrar, el encabezado saldría de la ruta — "mudanza",
            en minúscula, sobre una pantalla cuyo propio título va capitalizado:
            el mismo hueco que `/reclamar` tenía y que WU-S dejó abierto en las
            dos rutas de turnos.

            EL TÍTULO SE TRANSCRIBE, NO SE INVENTA, que es la condición que el
            integrador puso cuando cerró la registración de `/reclamar`. "Mudanza
            de {nombre}" es el `<h1>` de la web en `/mis-mascotas/{token}/mudanza`
            y el `<Title>` que esta pantalla dibuja; acá va sin el nombre por la
            razón que fijó "Mascota en adopción" para las fichas — el encabezado
            se dibuja antes de que resuelva el fetch, y uno que se completa
            después se lee como que la pantalla cambió abajo del lector.

            ES EL ACTO Y NO EL RESULTADO, como `/denunciar`: la pantalla se
            retitula sola cuando el movimiento queda anotado, y un encabezado que
            siguiera ese cambio renombraría la página justo cuando alguien está
            leyendo en qué localidad quedó registrado su animal. */}
        <Stack.Screen
          name="mascotas/[publicToken]/mudanza"
          options={{ title: "Registrar una mudanza" }}
        />
        {/* DEVOLUCIÓN. Sin registrar, el encabezado saldría de la ruta —
            "devolucion", en minúscula y sin tilde, que es la peor de las tres
            formas que este archivo existe para evitar.

            EL TÍTULO SE TRANSCRIBE: "Devolución" es el `<h1>` de la web en
            `/mis-mascotas/{token}/devolucion` en sus tres estados y la etiqueta
            de la fila del "⋯ Más" que lleva ahí. Va SIN el nombre del animal por
            la razón que fijó "Mascota en adopción": el encabezado se dibuja antes
            de que resuelva el fetch, y uno que se completa después se lee como
            que la pantalla cambió abajo del lector — y acá el nombre además
            aparece en el propio título de la pantalla. */}
        <Stack.Screen name="mascotas/[publicToken]/devolucion" options={{ title: "Devolución" }} />
        {/* ACOMPAÑAMIENTO DE ADOPCIÓN. Sin registrar, el encabezado saldría de
            la ruta — "buscar-hogar", en minúscula y con guion, sobre una
            pantalla cuyo propio título va capitalizado.

            EL TÍTULO SE TRANSCRIBE, NO SE INVENTA: "Acompañamiento de adopción"
            es la etiqueta de la fila de "Más" que la abre (`OwnerFace.tsx`,
            `gates.canSeeAdoptionSupport`), la de la fila del "⋯ Más" de la web
            (`_more/MasSheet.helpers.ts`), el `<Title>` de `RehomeScreen` y el
            `<h1>` de la web en `/mis-mascotas/{token}/buscar-hogar` para el
            titular ("Acompañamiento de adopción para {nombre}"). Va SIN el nombre por
            la razón que fijó Mudanza: el encabezado se dibuja antes de que
            resuelva el fetch. No es "Buscar hogar", que es la pregunta del
            FOSTER en esa misma ruta de la web y sigue siendo web-only acá. */}
        <Stack.Screen
          name="mascotas/[publicToken]/buscar-hogar"
          options={{ title: "Acompañamiento de adopción" }}
        />
        {/* Registered BY THE INTEGRATOR at the 2026-08-30 merge, not by the lane
            that shipped the screen: this file was a parallel lane's territory in
            that window, and the lane that owned it did not land. The gap is the
            one WU-S recorded for both `turnos` routes and that `cuidado/
            [grantToken]` has carried longer — an unregistered route takes its
            header from the path segment, so this one read "reclamar", lowercase,
            over a screen whose own title is capitalised.

            The wording was NOT invented here, which is why an integrator could
            close it at all: "Reclamar una mascota" is already the string the
            screen's own <Title> uses in its entry state AND the web's <h1> on
            `/mis-mascotas/reclamar`. Naming the act rather than the step matters
            more here than on most of these, because this screen's title changes
            under it three times — the lookup question, then the animal's name —
            and a header that tracked it would rename the page mid-flow. */}
        <Stack.Screen name="reclamar" options={{ title: "Reclamar una mascota" }} />
        {/* ADOPCIÓN — four routes, and every one of them needs a title for the
            reason `cuenta/privacidad` does: the path segments here are
            "adoptar", "[petToken]", "postular" and "postulaciones", so an
            unregistered stack would show a lowercase verb, a raw token, or a
            word that names the ACT on a screen that is a LIST.

            "Adoptar" for the catalogue and "Mascota en adopción" for the ficha,
            NOT the animal's name — the header draws before the fetch resolves,
            and a header that fills in after the body has painted reads as the
            screen changing under the reader. The animal is named by the screen
            itself, once. */}
        <Stack.Screen name="adoptar/index" options={{ title: "Adoptar" }} />
        <Stack.Screen name="adoptar/[petToken]" options={{ title: "Mascota en adopción" }} />
        {/* THE ACT, on the form. Which animal is display copy the route already
            carries in a query param, and it is the screen's own title. */}
        <Stack.Screen name="adoptar/[petToken]/postular" options={{ title: "Postularme" }} />
        {/* "Mis postulaciones" and not "Postulaciones": the same word means the
            shelter's REVIEW QUEUE on the web (`/adopciones`), and this app has
            no org surfaces at all. The possessive is what keeps a tester from
            reading this screen as one they do not have. */}
        <Stack.Screen name="adoptar/postulaciones" options={{ title: "Mis postulaciones" }} />
        {/* DENUNCIAR MALTRATO. Unregistered, the header would read "denunciar" —
            a lowercase Spanish verb, which is the one failure mode this file
            exists to prevent, on the screen where it would be read as the app
            addressing the reader in the imperative.

            THE TITLE IS TRANSCRIBED, NOT INVENTED, which is the condition the
            integrator set when it closed `/reclamar`'s registration and
            deliberately left the two `turnos` routes open: what a header should
            SAY is copy, and a merge is no place to argue it. Nothing is argued
            here — "Denunciar maltrato" is already the screen's own `<Title>` in
            its form state and already the label on the `/mascotas` footer button
            that reaches it. Two surfaces had decided this string before this line
            existed.

            IT IS THE ACT AND NOT THE OUTCOME. The screen's other state titles
            itself "Denuncia registrada", and a header that tracked it would
            rename the page under somebody at the moment they are trying to write
            down a reference code — the same argument `/reclamar` records about a
            screen whose title moves three times. */}
        <Stack.Screen name="denunciar" options={{ title: "Denunciar maltrato" }} />
        {/* BUSCAR TURNO. El título es el `<Title>` que la pantalla ya dibuja en
            su estado de picker y el `<h1>` de la web en `/turnos/buscar`, así que
            transcribe una decisión que alguien ya tomó en vez de tomar una. */}
        <Stack.Screen name="turnos/buscar/index" options={{ title: "Buscar turno" }} />
        {/* La grilla de una offering. El encabezado NO es el nombre del servicio:
            se dibuja antes de que resuelva el fetch, y uno que se completa después
            se lee como que la pantalla cambió abajo del lector. Es el mismo
            argumento que fijó "Mascota en adopción" para las fichas de adopción. */}
        <Stack.Screen name="turnos/buscar/[offeringToken]" options={{ title: "Reservar turno" }} />
        {/* LAS CINCO QUE EL RECUENTO DEL 31/08 DEJÓ SIN ENCABEZADO y cuyo string
            ya estaba decidido por dos superficies — transcriptas, no inventadas,
            2026-09-01. Las otras tres del recuento (`perdida`,
            `turnos/[appointmentToken]`, `cuidado/[grantToken]`) tenían
            superficies en desacuerdo y se registran más abajo con la
            resolución del PO del 01/09 — ver ese bloque.
            __tests__/mobile-screen-titles.test.ts cierra la clase: una ruta
            nueva sin registrar pone el gate en rojo.

            · "Mis turnos": el <Title> de la pantalla en sus dos estados y el
              botón del pie de /mascotas que la alcanza. Verificado en pantalla
              el 31/08 — la condición que WU-S dejó escrita quedó cumplida.
            · "Recuperar contraseña": el <Title> de RecuperarScreen y el <h1> de
              la web en /recuperar.
            · "Compartir": el <Title> de SharesScreen en sus dos estados y la
              FaceAction de /mascotas que la abre.
            · "Cuidador temporal": el <Title> de CaretakerPetScreen (dos
              estados), la FaceAction, y el <h1> de la web ("Cuidador temporal
              de {nombre}" — acá sin el nombre, por la razón que fijó Mudanza:
              el encabezado se dibuja antes del fetch).
            · "Credencial pública": la FaceAction que la abre y la
              autodescripción de la página pública (funcionalidades + el OG de
              /p/{token}). El "Credencial" pelado de la pantalla es su
              placeholder de carga, no un título decidido. */}
        <Stack.Screen name="turnos/index" options={{ title: "Mis turnos" }} />
        {/* TRÁNSITO. Unregistered, the header would read "transito" — a
            lowercase Spanish noun with its accent stripped by the path, on a
            screen `mascotas/index.tsx`'s footer button already calls
            "Tránsito". TRANSCRIBED, not invented: it is that button's own
            label, and it is the noun the web's own section uses
            (`/cuenta/transitos`, "Tránsitos activos", "Propuestas de
            tránsito") without the plural this app's single hub does not
            have — see `ROUTES.transito`'s own note. */}
        <Stack.Screen name="cuenta/transito" options={{ title: "Tránsito" }} />
        {/* CASOS (M11). "Mis casos" is the screen's own title and the web's
            widget's default heading; "Caso" is the singular the detail
            screen falls back to while its case kind is still loading. */}
        <Stack.Screen name="casos/index" options={{ title: "Mis casos" }} />
        <Stack.Screen name="casos/[publicCode]" options={{ title: "Caso" }} />
        <Stack.Screen name="recuperar" options={{ title: "Recuperar contraseña" }} />
        <Stack.Screen name="mascotas/[publicToken]/compartir" options={{ title: "Compartir" }} />
        <Stack.Screen
          name="mascotas/[publicToken]/cuidado"
          options={{ title: "Cuidador temporal" }}
        />
        <Stack.Screen
          name="mascotas/[publicToken]/credencial"
          options={{ title: "Credencial pública" }}
        />
        {/* LAS TRES QUE TENÍAN SUPERFICIES EN DESACUERDO, decididas por el PO el
            01/09 (las preguntas vivieron en la fence, TITLE_PENDING):
            · «Modo perdida» — el string del botón que la abre y el nombre con
              que el proyecto entero habla de la función; «Búsqueda» queda como
              título interno del estado activo.
            · «Turno» — lo que la pantalla ya dice en carga y error; corto como
              Mascota/Registro/Transferencia. El nombre del servicio vive en el
              contenido, no en el encabezado (la regla de Mudanza).
            · «Cuidado temporal» — el ACTO que le confiaron al invitado; el lado
              del dueño sigue «Cuidador temporal» (la PERSONA que designó) y la
              asimetría es la decisión, no un descuido. */}
        <Stack.Screen name="mascotas/[publicToken]/perdida" options={{ title: "Modo perdida" }} />
        <Stack.Screen name="turnos/[appointmentToken]" options={{ title: "Turno" }} />
        {/* The check-in QR's front-desk fallback (M8/F-8): same noun as the
            owner's turno screen above, the one title this surface already has. */}
        <Stack.Screen name="appointment/[appointmentToken]" options={{ title: "Turno" }} />
        <Stack.Screen name="cuidado/[grantToken]" options={{ title: "Cuidado temporal" }} />
        {/* LA CUARTA, decidida por el PO el 11/09 — la pregunta tambien vivio en
            TITLE_PENDING y se respondio por la lectura (b):
            «Recordatorios» — el sustantivo ANCHO, y gana por lo que la pantalla
            hace y no por lo que se llama el dato. Ahi adentro tambien se
            CANCELAN recordatorios, no solo se programan vacunas, asi que
            «Proximas vacunas» nombraba una parte del contenido como si fuera el
            todo. La tarjeta que la abre ya decia «Recordatorios»: la app habia
            renombrado en un solo lugar la cosa que estaba espejando, y esta
            decision resuelve la asimetria hacia el nombre mas honesto en vez de
            hacia el original. La seccion de la web se renombro con ella, asi
            que las tres superficies vuelven a decir lo mismo. */}
        <Stack.Screen name="mascotas/[publicToken]/vacunas" options={{ title: "Recordatorios" }} />
        {/* CHAPA FÍSICA (D2, 2026-09-25). TRANSCRIBED from the row that opens it
            (`OwnerFace.tsx`'s own label) and from the web sheet's heading
            (`PhysicalTagInterestSheet.tsx`, "Chapa física — anotado") — no
            surface disagrees, so this is a straight transcription and not a
            TITLE_PENDING question. */}
        <Stack.Screen name="mascotas/[publicToken]/chapita" options={{ title: "Chapa física" }} />
        {/* PERRO DE ASISTENCIA (D3, 2026-09-25). Transcribed from the row that
            opens it (`OwnerFace.tsx`) and from the web page's own heading
            (`AsistenciaPage`, "Perro de asistencia · {nombre}") minus the name,
            which the screen's own title carries. */}
        <Stack.Screen
          name="mascotas/[publicToken]/asistencia"
          options={{ title: "Perro de asistencia" }}
        />
        {/* LA RUTA NO RECONOCIDA (NAV-M1). Sin registrar, el encabezado sale del
            nombre del archivo: "+not-found", en inglés y con un signo más, sobre
            la única pantalla que por definición ve alguien que llegó desde
            AFUERA de la app — un link de un mail o un QR. Es el peor lugar para
            que el producto hable como un router.

            EL TÍTULO SE TRANSCRIBE: es el `<Title>` que la pantalla ya dibuja,
            el mismo criterio con el que se registró "Recuperar contraseña" (la
            misma frase en el encabezado y en la página). */}
        <Stack.Screen name="+not-found" options={{ title: "No pudimos abrir ese link" }} />
      </Stack>
    </SafeAreaProvider>
  );
}

// `Sentry.wrap` is what attaches the SDK's own error boundary to the root, so
// a render-phase throw is captured WITH its component stack instead of only
// surfacing as the native crash that follows it. With no DSN the wrapper is
// inert chrome around an unreported tree — harmless in dev, load-bearing in
// the pilot build.
export default Sentry.wrap(RootLayout);
