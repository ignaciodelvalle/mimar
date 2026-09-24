// One row of "Mis mascotas" — extracted out of `app/mascotas/index.tsx` (M3,
// R-1) so it can be memoized and tested in isolation.
//
// THE FINDING THIS FILE ANSWERS. A real Samsung J7 2016 (Android 8, Exynos
// 7580, 2 GB RAM) measured "Mis mascotas" with many pets as janky well above
// the 25% target. Two causes were named: the list rendered every card at once
// (fixed in `index.tsx` by switching to `FlatList`), and some card element
// re-uploaded a bitmap every frame.
//
// THE BITMAP CAUSE, AS FAR AS THE CODE CAN PIN IT. There is no `elevation` or
// `shadow*` anywhere in `apps/mobile/src/ui` (checked: neither this row's
// styles nor `Card`/`EmptyState`/`Screen` set one), so Android's "draw into an
// offscreen layer for the shadow" path — the classic per-frame re-upload
// culprit — is not in play. There is also no `Animated` loop running while
// this row is on screen; the only `Animated` in this app are `DocumentTurn`
// (the credential flip, a different screen) and the loading skeleton
// (`skeleton.tsx`), which unmounts once the list has loaded. What IS real: the
// row used to be built inline inside `pets.map(...)` in the screen component,
// with a brand-new `PetRow` element, a brand-new `onPress` closure and a
// brand-new `source={{ uri: pet.photoUrl }}` object literal constructed on
// EVERY render of the screen — including the one `setRefreshing(true)` and
// `setRefreshing(false)` cause on every pull-to-refresh and every focus
// re-read. None of those re-renders change a single pet's data, but with no
// memoization anywhere every row's `<Image>` received a new `source` object by
// reference on each one, which is exactly the "Image without stable source
// identity" suspect. `React.memo` plus a stable `onPress` (see
// `app/mascotas/index.tsx`'s `useCallback`) and a `useMemo`'d `source` close
// that path. THIS IS NOT CONFIRMED AS THE MEASURED CAUSE — it is the one
// concrete defect the code shows; the J7 needs to re-run TN-3 (the jank
// measurement) at N4 on the next build to say whether it moved the number.
import { memo, useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { MyPetsV1Item } from "@dim/contract/api";

import { petStatusLabel } from "../credential/credential-view-model";
import { FONTS } from "../ui/fonts";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import { speciesLabel } from "./species";

// TEST-ONLY INSTRUMENTATION. `React.memo`'s whole job is to skip calling the
// wrapped function when props are shallow-equal, and there is no public React
// API that reports "did this call happen" — a `<Profiler>` fires for every
// COMMIT of the tree it wraps whether or not a memoized child inside bailed
// out, so it cannot tell the two apart. Counting inside the function body is
// the only ground truth. Mirrors the `...ForTests` convention already used in
// `native/expo-image-picker-adapter.ts`.
let renderCount = 0;

export function resetPetRowRenderCountForTests(): void {
  renderCount = 0;
}

export function getPetRowRenderCountForTests(): number {
  return renderCount;
}

function PetRowImpl({
  pet,
  onPress,
}: {
  pet: MyPetsV1Item;
  /** Stable across re-renders (a `useCallback` in the screen) so this memoized
   * row does not re-render just because its parent did. */
  onPress: (publicToken: string) => void;
}) {
  renderCount += 1;

  // A photo the server HAS and this phone could not fetch (S-1 / VT-2). RN's
  // <Image> draws nothing on a failed load — a blank box the size of the frame,
  // which reads as "this animal has no photo" and is a different claim.
  const [photoFailed, setPhotoFailed] = useState(false);

  // STABLE SOURCE IDENTITY (M3 / R-1). `{ uri: pet.photoUrl }` written inline
  // in JSX is a new object every render; memoizing it on `pet.photoUrl` means
  // <Image> only sees a new `source` when the URL itself changed.
  const photoSource = useMemo(
    () => (pet.photoUrl === null ? null : { uri: pet.photoUrl }),
    [pet.photoUrl],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pet.name}, ${speciesLabel(pet.species)}, ${petStatusLabel(pet.status)}`}
      onPress={() => onPress(pet.publicToken)}
      style={styles.petRow}
    >
      {photoSource === null || photoFailed ? (
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
          source={photoSource}
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
 * The list row for `app/mascotas/index.tsx`, memoized (M3 / R-1: `FlatList`
 * mounts every row that scrolls on screen, and without this a pull-to-refresh
 * or a focus re-read re-rendered every visible row for no reason — see the
 * header comment for the measured defect this closes).
 */
export const PetRow = memo(PetRowImpl);

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
