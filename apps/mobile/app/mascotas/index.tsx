// Mis mascotas — the list, and the four things it can honestly be.
//
//   loading   — a spinner with a sentence, not a bare spinner.
//   failed    — the server's own message plus a retry. NEVER an empty list:
//               "no tenés mascotas" is a claim, and a failed read has not earned
//               the right to make it. That confusion is the single most likely
//               way this screen could lie, because both states draw nothing.
//   empty     — an invitation, not a statement of absence.
//   loaded    — the pets, plus an honest note when the server TRUNCATED the list.
//
// `truncated` DESERVES ITS OWN NOTE. The payload carries `total` and a boolean
// saying the array is shorter than it; a client that ignores both shows a
// complete-looking list that is not complete. There is no pagination in v1, so
// the honest answer is to say how many are missing and where to see them, not to
// pretend the page is the set.
//
// ONE READ PER MOUNT, PLUS PULL-TO-REFRESH. No focus-refetch and no timer: the
// endpoint runs a 120/min per-user limiter, and a list that re-reads every time
// it comes back into view spends that on nothing.

import type { MyPetsV1, MyPetsV1Item } from "@dim/contract/api";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../../src/api/client";
import { fetchMyPets } from "../../src/api/endpoints";
import { sessionPort } from "../../src/auth/session-store";
import { useGate } from "../../src/auth/useGate";
import { petStatusLabel } from "../../src/credential/credential-view-model";
import { speciesLabel } from "../../src/pets/species";
import { Body, Card, EmptyState, ErrorNotice, Loading, StaleNotice } from "../../src/ui/components";
import { FONTS } from "../../src/ui/fonts";
import { PrimaryButton, Screen, SecondaryButton } from "../../src/ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../../src/ui/reload-state";
import { ROUTES, credentialRoute } from "../../src/ui/routes";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../../src/ui/theme";
import { useReconnect } from "../../src/ui/use-reconnect";

type ListState = { phase: "loading" } | ReadyState<MyPetsV1> | { phase: "failed"; message: string };

export default function MisMascotasScreen() {
  const gate = useGate();
  const router = useRouter();
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  // A read started before the screen unmounted must not write into a dead
  // component; and two overlapping reads must not race to be last.
  const generation = useRef(0);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    const mine = ++generation.current;
    if (mode === "initial") setState({ phase: "loading" });
    else setRefreshing(true);

    const result = await fetchMyPets(sessionPort);
    if (mine !== generation.current) return;
    if (result.outcome === "ok") setState(loaded(result.payload));
    // THE MEASURED ONE (S-2 / B-05, shots 137-140): with airplane mode on, a
    // pull-to-refresh replaced the two pets on screen AND the "Registrar otra
    // mascota" button with a full-screen error — and turning the network back on
    // cleared the offline banner while the list stayed broken until the person
    // found "Volver a intentar". The animals were still in the phone the whole
    // time. See `reload-state.ts`.
    else
      setState((current) =>
        reloadFailed(current, result, apiFailureMessage(result) ?? "No se pudo leer."),
      );
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load("initial");
  }, [load]);

  // Reload after a registration: coming back to this screen with a pet that is
  // not in the list is the one moment where a stale cache is obviously wrong.
  // Guarded by a ref so the FIRST focus does not double-read on mount.
  const mounted = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!mounted.current) {
        mounted.current = true;
        return;
      }
      void load("refresh");
    }, [load]),
  );

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05). The offline banner already
  // clears itself on this exact event; the list used to sit broken beside it
  // until somebody pressed a button. A refresh and not an initial read: whatever
  // is on screen stays there while it happens.
  useReconnect(() => void load("refresh"));

  if (!gate.allowed) return gate.element;

  return (
    <Screen
      refreshControl={
        // Pull-to-refresh stays, and the spinner is tinted: the platform default
        // is a grey that reads as chrome from another app on a cream page.
        <RefreshControl
          colors={[COLORS.accent]}
          onRefresh={() => void load("refresh")}
          refreshing={refreshing}
          tintColor={COLORS.accent}
        />
      }
    >
      {state.phase === "loading" ? (
        <Loading label="Buscando tus mascotas…" />
      ) : state.phase === "failed" ? (
        // NOT an empty list. See the header. Only the FIRST read reaches this:
        // once there are animals on screen they stay.
        <ErrorNotice message={state.message} onRetry={() => void load("initial")} />
      ) : (
        <>
          {state.staleFailure === null ? null : (
            <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
          )}
          <ListBody
            view={state.view}
            onOpen={(token) => router.push(credentialRoute(token))}
            onRegister={() => router.push(ROUTES.altaMascota)}
          />
        </>
      )}

      <View style={styles.footer}>
        {/* THE HUB'S ONLY ENTRY POINT that is not a deep link. It sits here and
            not on a pet because half of what it lists is about animals that are
            not in the list above — a proposal is an offer from somebody else's
            pet, and the person answering it may hold nothing at all yet.

            NO PENDING COUNT ON THE LABEL, deliberately. The web's list page
            renders one, and it costs two `count()` queries per page load
            (`lib/analytics/owner-pending-counts.ts`). Reproducing it here would
            mean a second round trip on the app's most-opened screen to decorate
            a button; the hub itself answers the question in one read, and it is
            one tap away. If the badge earns its cost, it belongs in
            `MyPetsV1` rather than in a call this screen makes on the side. */}
        <SecondaryButton
          label="Transferencias"
          accessibilityHint="Propuestas de transferencia recibidas y enviadas."
          onPress={() => router.push(ROUTES.transferencias)}
        />
        {/* TRÁNSITO'S ONLY ENTRY POINT, and it sits beside Transferencias for the
            same reason: half of what it holds is a proposal addressed to this
            person about an animal they do not yet hold — `foster_proposal_received`
            names `/cuenta/transitos/propuestas/{token}` on the web, and
            `DEEP_LINK_MAP.fosterProposal` now opens this same screen from that
            notification instead of falling through to the browser.

            NO PENDING COUNT ON THE LABEL, for the reason every button in this
            footer carries none: it would be a second round trip on the app's
            most-opened screen to decorate a button. */}
        <SecondaryButton
          label="Tránsito"
          accessibilityHint="Propuestas de tránsito, y las mascotas que cuidás hoy."
          onPress={() => router.push(ROUTES.transito)}
        />
        {/* THE INBOX'S ONLY ENTRY POINT, and it sits here for the transfer hub's
            reason: most of what it lists is not about the animals above it.
            NO UNREAD BADGE ON THE LABEL, deliberately and for exactly the reason
            the button above carries no pending count — reproducing it would mean
            a second round trip on the app's most-opened screen to decorate a
            button. The badge earning its cost means it belongs in `MyPetsV1`,
            not in a call this screen makes on the side. */}
        <SecondaryButton
          label="Notificaciones"
          accessibilityHint="Avisos sobre tus mascotas y tu cuenta."
          onPress={() => router.push(ROUTES.notificaciones)}
        />
        {/* MIS TURNOS' ONLY ENTRY POINT, and the reason it needs one at all is
            worth stating: on the WEB this capability is not in the navigation
            either — `/mis-turnos` is reachable from a notification CTA and from
            the booking flow's redirect, and from nowhere else. A browser makes
            that survivable because a person can type the address. A phone does
            not, so an unlinked native screen is a screen that does not exist.

            It sits beside the two above rather than on a pet for their reason,
            one step weaker: every turno DOES name an animal, but the question
            "what do I have booked" is asked across all of them at once, and the
            list also holds turnos for animals that are not above it — booking
            accepts any active ownership role, so a foster's turno is the
            foster's.

            NO UPCOMING COUNT ON THE LABEL, for the reason the two buttons above
            carry no badge: it would be a second round trip on the app's
            most-opened screen to decorate a button. If it earns its cost it
            belongs in `MyPetsV1`. */}
        <SecondaryButton
          label="Mis turnos"
          accessibilityHint="Turnos reservados, y el código de check-in de cada uno."
          onPress={() => router.push(ROUTES.turnos)}
        />
        {/* RECLAMAR'S ONLY ENTRY POINT, and it needs one for the reason "Mis
            turnos" above does, one step stronger: on the WEB this capability is
            reached from a card on `/mis-mascotas` and from nowhere else, and a
            phone has no address bar to type into. An unlinked native screen is a
            screen that does not exist.

            It sits at the bottom of this footer rather than beside "Registrar
            otra mascota" on purpose. The two are genuinely close — both end with
            an animal in this list — and they are not the same act: registering
            creates a record, reclaiming asserts something about one that already
            exists and that somebody else may hold. Putting them side by side
            would invite a person to reach for whichever button is nearer. */}
        <SecondaryButton
          label="Reclamar una mascota"
          accessibilityHint="Si tu mascota ya está registrada por su microchip o su tatuaje."
          onPress={() => router.push(ROUTES.reclamar)}
        />
        {/* ADOPCIÓN'S ONLY ENTRY POINT. The buttons above it are about animals
            or messages that already belong to this person; this one opens a
            catalogue of animals nobody here holds. It sits with them anyway
            because the alternative — a top-level destination with no way in — is
            a screen that exists and cannot be reached.

            IT IS NO LONGER THIS FOOTER'S ODD ONE OUT, which is what this comment
            claimed while it was the last button, and the claim had to be
            corrected rather than left standing over an arrangement that changed.
            "Denunciar maltrato" below it is one step further out, and the two are
            not the same kind of outward: an adoption is an animal this person may
            come to hold, and the screen is a catalogue they browse. See that
            button's own note for where the line actually ends.

            THE ENTRY IS HERE AND THE HEADER TITLES ARE IN `app/_layout.tsx`.
            Both are needed and neither substitutes for the other: this button is
            how a person reaches the catalogue, and the registration is what stops
            the header from reading `adoptar` in lowercase English-looking
            form. */}
        <SecondaryButton
          label="Adoptar"
          accessibilityHint="Mascotas publicadas por refugios verificados."
          onPress={() => router.push(ROUTES.adoptar)}
        />
        {/* DENUNCIAR IS HERE BECAUSE THE WEB PUT IT HERE, and the web wrote down
            why: `/mis-mascotas/page.tsx` carries "+ Denunciar maltrato animal"
            under the comment "about someone else's animal, so it can never live
            on your own credential (§9.2)". That rules out the pet screen and
            leaves this list, which is the only hub either client has.

            IT IS LAST, BELOW ADOPTAR, and the order is the footer's own: this
            list runs from what the reader is responsible for towards what they
            are not. Transferencias and Notificaciones are addressed to them, Mis
            turnos belong to their animals, Reclamar is an animal that IS theirs
            and is recorded under somebody else, Adoptar is one they may come to
            hold. Denunciar is where that line ENDS rather than another point on
            it: denunciar maltrato is not an act on your animals at all. It is a
            civic act about somebody else's, and it ends with a case file at an
            authority naming a person. It is on this screen because this list is
            the only hub, not because it belongs among what the list is about.

            THE EXTRA SPACE ABOVE IT IS THE POINT, AND THE WRAPPER IS WHAT MAKES
            IT REAL. `styles.footer` sets ONE uniform `gap` for every child in
            here, so "it sits apart from the others" was a sentence in a comment
            and nothing on the screen until this `View` existed. A button that
            files a criminal allegation against a named person must not be
            reachable by a thumb that was aiming at the one above it.

            NOT IN AJUSTES, which is the other place a footer button gets pushed
            to. A denuncia is something somebody files standing in the street
            looking at an animal; a settings screen is where you go when nothing
            is happening. */}
        <View style={styles.civicAction}>
          <SecondaryButton
            label="Denunciar maltrato"
            accessibilityHint="Denunciar maltrato o abandono de un animal ante la autoridad. Ley 14.346."
            onPress={() => router.push(ROUTES.denunciar)}
          />
        </View>
        <SecondaryButton label="Ajustes" onPress={() => router.push(ROUTES.ajustes)} />
      </View>
    </Screen>
  );
}

function ListBody({
  view,
  onOpen,
  onRegister,
}: {
  view: MyPetsV1;
  onOpen: (publicToken: string) => void;
  onRegister: () => void;
}) {
  const { pets, total, truncated } = view;

  if (pets.length === 0) {
    return (
      <EmptyState
        headline="Todavía no registraste ninguna mascota"
        body="Registrala una vez y su credencial queda disponible para siempre: un QR que cualquiera puede escanear si se pierde."
        actionLabel="Registrar una mascota"
        onAction={onRegister}
      />
    );
  }

  return (
    <>
      {pets.map((pet) => (
        <PetRow key={pet.publicToken} pet={pet} onPress={() => onOpen(pet.publicToken)} />
      ))}

      {truncated ? (
        <Card title="La lista está incompleta">
          <Body>
            {`Estamos mostrando ${pets.length} de ${total}. Todavía no hay paginado en la app: para ver el resto entrá desde la web.`}
          </Body>
        </Card>
      ) : null}

      <PrimaryButton label="Registrar otra mascota" onPress={onRegister} />
    </>
  );
}

function PetRow({ pet, onPress }: { pet: MyPetsV1Item; onPress: () => void }) {
  // A photo the server HAS and this phone could not fetch (S-1 / VT-2). RN's
  // <Image> draws nothing on a failed load — a blank box the size of the frame,
  // which reads as "this animal has no photo" and is a different claim.
  const [photoFailed, setPhotoFailed] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pet.name}, ${speciesLabel(pet.species)}, ${petStatusLabel(pet.status)}`}
      onPress={onPress}
      style={styles.petRow}
    >
      {pet.photoUrl === null || photoFailed ? (
        // A placeholder that says WHAT is missing. A grey square says nothing.
        //
        // THE SERVER SIDE OF THE UPLOAD NOW EXISTS — `POST /pets/{token}/photo`
        // and the three calls in `api/endpoints.ts` that drive it
        // (`requestPetPhotoTicket` → `uploadPetPhotoBytes` → `confirmPetPhoto`).
        // What is still missing on THIS side is the picker: choosing an image
        // needs a native module this build does not carry, so it is a screen and
        // an `expo install` rather than a protocol. The placeholder stays until
        // then, and it is no longer describing a blocked path — only an unbuilt
        // one.
        <View style={styles.photoFallback}>
          {/* TWO DIFFERENT ABSENCES, TWO DIFFERENT WORDS (S-1 / VT-2). "Sin
              foto" is a fact about the animal's record; a photo that was
              uploaded and would not LOAD is a fact about this phone's last ten
              seconds, and drawing the same square for both told an owner their
              photo was gone. */}
          <Text style={styles.photoFallbackText}>
            {photoFailed ? "Foto no disponible" : "Sin foto"}
          </Text>
        </View>
      ) : (
        <Image
          source={{ uri: pet.photoUrl }}
          style={styles.photo}
          accessibilityIgnoresInvertColors
          onError={() => setPhotoFailed(true)}
        />
      )}

      {/* ONE LINE EACH (S-6). The row is a photo, a text column and a status
          chip in a fixed-height row; `pets.name` is unbounded `text` with no cap
          anywhere in the web's writer (see PetProfileEditScreen's header), so a
          long name wrapped to three lines, pushed the species under the chip and
          left the list looking broken for the one owner who has such a name. The
          full name is still on the row's accessibilityLabel above, and one tap
          away on the document. */}
      <View style={styles.petText}>
        <Text numberOfLines={1} style={styles.petName}>
          {pet.name}
        </Text>
        <Text numberOfLines={1} style={styles.petSpecies}>
          {speciesLabel(pet.species)}
        </Text>
      </View>

      <StatusChip status={pet.status} />
    </Pressable>
  );
}

/**
 * The status chip.
 *
 * "Perdida" and "Fallecida" are not decorated the same way as "Activa", and that
 * is not styling: a lost animal is the state the whole product exists for, and a
 * list where it reads like every other row buries the one row that matters.
 */
function StatusChip({ status }: { status: MyPetsV1Item["status"] }) {
  const tone = status === "lost" ? styles.chipAlert : styles.chipQuiet;
  const label = status === "lost" ? styles.chipAlertLabel : styles.chipQuietLabel;
  return (
    <View style={[styles.chip, tone]}>
      <Text style={[styles.chipLabel, label]}>{petStatusLabel(status)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { marginTop: SPACE.lg, gap: SPACE.sm },
  // The one break in the footer's uniform `gap`, and it carries an argument
  // rather than a taste: "Denunciar maltrato" opens a criminal allegation about
  // a named third party, and every other child of this View is an act on the
  // reader's own records. `marginTop` STACKS on the parent's gap, so the button
  // sits at twice the distance of any other pair — the smallest amount of layout
  // that makes a mis-tap cost a deliberate correction instead of a case file.
  civicAction: { marginTop: SPACE.sm },
  petRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.control,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACE.md,
    // The 44dp floor, stated (CA-3). A row with a 52pt photo clears it today by
    // accident, and the day somebody renders a row for a pet with no photo and
    // a one-line name it stops clearing it silently. The a11y fence now walks
    // `app/` too, and this is the discipline it asks every pressable file for.
    minHeight: TOUCH_TARGET,
  },
  photo: { width: 52, height: 52, borderRadius: RADIUS.control, backgroundColor: COLORS.stripe },
  photoFallback: {
    width: 52,
    height: 52,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.stripe,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  photoFallbackText: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wide,
    color: COLORS.inkFaint,
  },
  petText: { flex: 1, gap: 2 },
  // Serif, because a pet's name is the display element of this row — the same
  // role the web gives it on the credential document.
  petName: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    lineHeight: TYPE.lg * LEADING.lg,
    color: COLORS.ink,
  },
  petSpecies: { fontFamily: FONTS.sans, fontSize: TYPE.md, color: COLORS.inkMuted },
  chip: {
    borderRadius: RADIUS.chip,
    borderWidth: 1,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
  },
  chipQuiet: { backgroundColor: COLORS.stripe, borderColor: COLORS.border },
  chipAlert: { backgroundColor: COLORS.dangerSurface, borderColor: COLORS.dangerBorder },
  chipLabel: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
  },
  chipQuietLabel: { color: COLORS.inkMuted },
  chipAlertLabel: { color: COLORS.danger },
});
