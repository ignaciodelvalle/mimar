// Ajustes — who you are, and the two ways out.
//
// WHAT `GET /me` GIVES US, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
// Four fields: id, display name, role, account type. No email, no DNI in any
// form, no phone, no jurisdiction. That is the whole defence for what a stolen
// access token buys, and this screen must not undo it by fetching the missing
// pieces from somewhere else to make a nicer profile card. What it can show, it
// shows; what it cannot, it does not invent.
//
// THE TWO SIGN-OUTS ARE DIFFERENT PROMISES AND ARE LABELLED AS SUCH
// ---------------------------------------------------------------------------
//   "Cerrar sesión" ends it HERE. It always works, because the local delete does
//   not depend on the network (see `dropLocalSession` — the library will leave a
//   session in place on a 5xx, and this app does not).
//
//   "Cerrar sesión en todos los dispositivos" is a REQUEST to the server, it can
//   fail, and on success it also ends this one — GoTrue rejects the access token
//   immediately and the refresh comes back `refresh_token_not_found`. Presenting
//   it as a bigger version of the first button would surprise somebody who meant
//   to sign out their old phone and got signed out of the one in their hand. So
//   the confirmation says so, in those words.
//
// AND, SINCE THIS APP CAN CREATE ACCOUNTS, IT HAS TO BE ABLE TO END ONE
// ---------------------------------------------------------------------------
// Two sign-outs and no deletion is the shape Google Play rejects: the rule
// attaches to account CREATION, and `/crear-cuenta` is native. `AccountDeletion
// Card` is that third way out. It is placed AFTER the two sign-outs and before
// the footnote, in escalating order of permanence — end this session, end every
// session, end the account — so nobody reaches the destructive one by aiming at
// the mild one.
//
// SINCE WU-R IT IS A SIGNPOST AND NOT A DOOR OUT OF THE APP. The card used to
// open the web page in a browser; it now pushes `/cuenta/privacidad`, which is a
// native screen carrying BOTH Ley 25.326 rights — the art. 14 export as well as
// the art. 16 supresión. Its position in the escalating order is unchanged, and
// so is the reasoning: what sits here is still the entrance to the most
// permanent thing this screen can do.

import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { AboutSection } from "../src/account/AboutSection";
import { AccountDeletionCard } from "../src/account/AccountDeletionCard";
import { signOut, signOutEverywhere } from "../src/auth/session-store";
import { useGate } from "../src/auth/useGate";
import { API_BASE_URL } from "../src/config/api";
import { Body, Card, ErrorNotice, Row } from "../src/ui/components";
import { FONTS } from "../src/ui/fonts";
import { PrimaryButton, Screen, SecondaryButton } from "../src/ui/kit";
import { ROUTES } from "../src/ui/routes";
import { COLORS, LEADING, SPACE, TYPE } from "../src/ui/theme";

type RevokeState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "sending" }
  | { phase: "failed"; message: string };

const ROLE_LABELS = {
  owner: "Titular",
  vet: "Veterinaria",
  govt: "Organismo público",
  national: "Lectura nacional",
  admin: "Administración",
} as const;

const ACCOUNT_TYPE_LABELS = {
  personal: "Personal",
  institutional: "Institucional",
} as const;

export default function AjustesScreen() {
  const gate = useGate({ allowPendingIdentity: true });
  const router = useRouter();
  const [revoke, setRevoke] = useState<RevokeState>({ phase: "idle" });
  // Never cleared on purpose: this screen unmounts when the sign-out lands, and
  // an "idle" button between the store flip and the unmount is a second tap.
  const [signingOut, setSigningOut] = useState(false);

  if (!gate.allowed) return gate.element;
  const { user } = gate;

  async function confirmRevoke() {
    setRevoke({ phase: "sending" });
    const result = await signOutEverywhere(ROUTES.ajustes);
    if (!result.ok) {
      // The session is untouched on failure. A half-done revocation that also
      // signed you out locally would be the worst of both: the other devices
      // keep working and you lost the one you are holding.
      setRevoke({ phase: "failed", message: result.message });
      return;
    }
    // On success the store flips to `signed-out` (reason `revoked_all`) and the
    // gate redirects. Routed EXPLICITLY here too (NAV-2), the same shape as the
    // plain sign-out above: leaving it to the gate means the destination
    // depends on which screen re-renders first. The gate is what stops the
    // `next` parameter from carrying "/ajustes" through the sign-in — see
    // `signedOutHref`, which is why both enders here name the path they were
    // pressed on — and this is what stops the flash.
    router.replace("/");
  }

  return (
    <Screen>
      <Card title="Tu cuenta">
        {user.profilePending ? (
          <Body>
            Todavía no completaste tus datos, así que no tenemos un nombre para mostrar acá.
          </Body>
        ) : (
          <>
            <Row label="Nombre" value={user.displayName} />
            <Row label="Rol" value={ROLE_LABELS[user.role]} />
            <Row label="Tipo de cuenta" value={ACCOUNT_TYPE_LABELS[user.accountType]} />
            {/* THE EDIT DOOR IS INSIDE THIS CARD and hidden while the identity
                is pending, which is not a styling choice. The row exists — the
                `handle_new_user` trigger writes one with every account — but it
                is still carrying the provisional, email-derived name, and
                `/api/v1/me/profile` answers 404 for exactly that state on BOTH
                methods (2026-09-04): a save here is not signup step 2, which
                also collects a DNI. So offering the control would be a button
                whose only outcome is an error. The gate on the route refuses it
                too; this is what stops a person reaching the refusal at all. */}
            <View style={styles.editRow}>
              <SecondaryButton
                label="Editar mis datos"
                onPress={() => router.push(ROUTES.editarCuenta)}
              />
            </View>
          </>
        )}
      </Card>

      <Card title="Servidor">
        {/* Shown because a tester with three builds on one phone has no other
            way to tell which backend they are looking at, and "los datos no
            aparecen" is otherwise unanswerable. Mono, like every other machine
            string in this design. */}
        <Text style={styles.machine}>{API_BASE_URL}</Text>
      </Card>

      <View style={styles.actions}>
        <SecondaryButton
          label={signingOut ? "Cerrando sesión…" : "Cerrar sesión"}
          disabled={signingOut}
          onPress={() => {
            // AWAITED, and the await is the fix. `signOut()` flips the store
            // to `signed-out` as its LAST act, after the keychain delete.
            // Firing it and navigating in the same tick meant `/` evaluated
            // while the store still said `signed-in`, forwarded to
            // `/mascotas`, and drew a flash of the pet list — plus one wasted
            // authenticated request — before the state landed and the gate
            // bounced it back. The cost of doing it in the right order is one
            // keychain delete, and `signOut` cannot reject (see clearSession).
            // AND A BUSY STATE (A6-cuenta-resiliencia-04). `signOut` reaches
            // GoTrue, which now has the same 10 s budget as everything else —
            // but ten seconds is long enough to press a button that looks idle
            // four more times, and each press is another sign-out racing the
            // first. The label says what is happening and the control refuses a
            // second tap.
            setSigningOut(true);
            void (async () => {
              await signOut(ROUTES.ajustes);
              router.replace("/");
            })();
          }}
        />

        {revoke.phase === "confirming" ? (
          <Card title="Cerrar sesión en todos los dispositivos">
            <Body>
              Vas a cerrar la sesión en todos los teléfonos y navegadores donde entraste, incluido
              este. Después tenés que volver a ingresar acá.
            </Body>
            <View style={styles.confirmActions}>
              <PrimaryButton
                label="Sí, cerrar todo"
                tone="seal"
                onPress={() => void confirmRevoke()}
              />
              <SecondaryButton label="Cancelar" onPress={() => setRevoke({ phase: "idle" })} />
            </View>
          </Card>
        ) : (
          <PrimaryButton
            label={
              revoke.phase === "sending"
                ? "Cerrando sesiones…"
                : "Cerrar sesión en todos los dispositivos"
            }
            tone="seal"
            disabled={revoke.phase === "sending"}
            onPress={() => setRevoke({ phase: "confirming" })}
          />
        )}

        {revoke.phase === "failed" ? (
          <ErrorNotice
            message={`${revoke.message} Tu sesión en este teléfono sigue abierta.`}
            onRetry={() => setRevoke({ phase: "confirming" })}
          />
        ) : null}
      </View>

      <AccountDeletionCard />

      {/* B-02, measured on the shipped build 10 (shot 114). This said photos,
          NOTIFICATIONS and Mi Argentina were all missing, on a build where
          `notificaciones` is a registered route with a working screen and
          Mascota → Más offers "Foto de la mascota". A footnote that denies two
          features the person can reach from the same app teaches them to
          distrust the third, which is the only one that is actually true. */}
      <Text style={styles.footnote}>
        Cargar una foto al registrar una mascota y el ingreso con Mi Argentina todavía no están en
        la app.
      </Text>

      <AboutSection />
    </Screen>
  );
}

const styles = StyleSheet.create({
  editRow: { marginTop: SPACE.md },
  actions: { gap: SPACE.md, marginTop: SPACE.sm },
  confirmActions: { gap: SPACE.sm, marginTop: SPACE.sm },
  machine: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.inkSoft,
  },
  footnote: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
    marginTop: SPACE.lg,
  },
});
