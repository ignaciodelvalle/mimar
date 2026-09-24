# Camera modules handback — the pet photo and the chip scan, from seam to store

> Written 2026-08-30, by the lane that closed board rows 1 and 4 up to the
> native wall. Both `apps/mobile/src/native/image-picker-port.ts` and
> `chip-scanner-port.ts` point here by name; this is the document they promise.
>
> **Everything that can be written and tested without an EAS build is DONE and
> in the tree.** What remains is exactly the part no local gate can see: two
> native modules, the two adapter files that import them, and the store build
> that carries them. This page says what to install, what that does to the
> fingerprint, which EAS profile to use, in what order, what to verify after —
> and which steps belong to the PO alone, starting with the one that is a
> policy obligation rather than an engineering step (Data Safety, below).

---

## What is already in the tree, tested, and needs no build

| Piece | Files | Proven by |
|---|---|---|
| The two seams: an interface, an honest default, a one-call `set…Port()` | `apps/mobile/src/native/image-picker-port.ts`, `chip-scanner-port.ts` | `native-ports.test.ts` |
| The photo screen: pick → review → upload, every failure back to review with the photo intact | `apps/mobile/src/pets/PetPhotoScreen.tsx`, route `app/mascotas/[publicToken]/foto.tsx`, entry row in `OwnerFace.tsx` (any holder role — the server's own gate) | `PetPhotoScreen.test.tsx`, `PetDocumentScreen.test.tsx` |
| The screen-side gate: jpeg/png/webp membership from the contract, HEIC refused with its own sentence, the 5 MiB cap mirrored | `apps/mobile/src/pets/pet-photo-view-model.ts` | `pet-photo-view-model.test.ts` |
| The walk ticket → PUT → confirm, three failure arms with their own es-AR copy | `pet-photo-upload-flow.ts` over the three calls in `src/api/endpoints.ts` | `pet-photo-upload-flow.test.ts`, `pet-photo-upload.test.ts` |
| The scan integrated into the claim screen: `ScanView` mounts only when the port carries one, a read goes through `chipCodeFromScan` into the SAME field the keyboard writes, and runs nothing | `apps/mobile/src/claims/ClaimScreen.tsx`, `claim-view-model.ts` | `ClaimScreen.test.tsx`, `claim-view-model.test.ts` |

In a build **without** the modules, nothing above is a dead end: the photo
screen draws a callout naming the web, and the claim screen keeps its "el
número va a mano" callout. Shipping the current tree changes nothing for
testers until the modules arrive — that is the seam's whole point.

---

## The three modules, and the one command

From `apps/mobile/`:

```
npx expo install expo-image-picker expo-image-manipulator expo-camera
```

`expo install` (not `pnpm add`) so each package lands at the version pinned for
this SDK line — version skew against `expo-modules-core` is exactly what the
fourth build failure was (`eas-build-profiles.md`, "a C++ compiler, nine and a
half minutes in").

| Module | Why |
|---|---|
| `expo-image-picker` | The OS photo picker. The `pickImage()` behind the seam. |
| `expo-image-manipulator` | **Not optional.** Re-encodes whatever the picker returns to JPEG, which does two load-bearing things at once: an iPhone HEIC becomes a format the bucket accepts (migration 0206 allowlists jpeg/png/webp), and the re-encode drops EXIF — including the GPS position of wherever the photo was taken, the known leak the picker port's header records. Skipping it "because Android" ships the leak the day an iOS build exists. |
| `expo-camera` | The barcode read off a chip sticker. The `ScanView` behind the seam. |

The install edits `apps/mobile/package.json` and the workspace lockfile. That
commit is mechanical agent work the day the PO says go — nothing about it needs
the PO's machine.

---

## The two adapters — full source, to commit WITH the install

These files cannot enter the tree before the install: a static import of a
package that is not in `package.json` fails typecheck and Metro alike. They
ship in the same commit as the install, plus the wiring below. Treat the source
here as the reviewed draft; the compiler gets the final word (see
"What to verify" — the image-manipulator API note in particular).

### `apps/mobile/src/native/expo-image-picker-adapter.ts`

```ts
// The real picker, behind the seam. See image-picker-port.ts for the contract.
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

import type { ImagePickResult, ImagePickerPort } from "./image-picker-port";

export const expoImagePicker: ImagePickerPort = {
  name: "expo-image-picker",
  available: true,
  async pickImage(): Promise<ImagePickResult> {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        // EXIF is not requested — and the re-encode below strips it anyway.
        exif: false,
        quality: 1,
      });
      if (res.canceled) return { outcome: "cancelled" };
      const asset = res.assets[0];
      if (asset === undefined) return { outcome: "failed", detail: "picker returned no asset" };

      // THE LOAD-BEARING STEP. Re-encode to JPEG whatever arrived:
      //   · HEIC becomes a format the bucket accepts (0206 allowlist);
      //   · EXIF — including GPS — does not survive the re-encode.
      // NOTE: verify this call against the INSTALLED expo-image-manipulator —
      // SDK 52+ added an object API (`ImageManipulator.manipulate(...)`) and
      // deprecated `manipulateAsync`; use whichever the installed major exports
      // (the doc's checklist has the verification step).
      const jpeg = await ImageManipulator.manipulateAsync(asset.uri, [], {
        compress: 0.85,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      const blob = await (await fetch(jpeg.uri)).blob();
      return {
        outcome: "picked",
        bytes: blob,
        contentType: "image/jpeg",
        previewUri: jpeg.uri,
      };
    } catch (error) {
      return {
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
```

The screen re-validates the result (`acceptPickedImage`): an adapter bug that
hands over HEIC unconverted is refused with a sentence instead of costing the
person an upload the server will refuse. The size cap (5 MiB) is checked there
too — after the re-encode, which is the size that travels.

### `apps/mobile/src/native/expo-camera-adapter.tsx`

```tsx
// The real scanner, behind the seam. See chip-scanner-port.ts for the contract:
// the view asks for its OWN permission, renders its own denial state, calls
// onCode with the RAW string, stops on both exits, and never navigates.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Body } from "../ui/components";
import { Callout, SecondaryButton } from "../ui/kit";
import { RADIUS } from "../ui/theme";

import type { ChipScanViewProps, ChipScannerPort } from "./chip-scanner-port";

function ExpoChipScanView({ onCode, onCancel }: ChipScanViewProps) {
  const [permission, requestPermission] = useCameraPermissions();
  // One code per mount: barcode events fire repeatedly while the code is in
  // frame, and the screen expects ONE call, exactly like one keyboard entry.
  const reported = useRef(false);

  useEffect(() => {
    if (permission !== null && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  if (permission === null) return <View style={styles.camera} />;
  if (!permission.granted) {
    return (
      <Callout tone="neutral" title="Sin acceso a la cámara">
        <Body>
          Para escanear el chip, permitile a miMAR usar la cámara desde los ajustes del teléfono.
          Mientras tanto, el número se puede escribir a mano.
        </Body>
        <SecondaryButton label="Volver" onPress={onCancel} />
      </Callout>
    );
  }
  return (
    <View>
      <CameraView
        style={styles.camera}
        // The formats seen on real chip stickers. QR included: some registries
        // print one carrying the same 15 digits.
        barcodeScannerSettings={{
          barcodeTypes: ["code128", "code39", "itf14", "ean13", "datamatrix", "qr"],
        }}
        onBarcodeScanned={({ data }) => {
          if (reported.current) return;
          reported.current = true;
          onCode(data);
        }}
      />
      <SecondaryButton label="Cancelar" onPress={onCancel} />
    </View>
  );
}

export const expoChipScanner: ChipScannerPort = {
  name: "expo-camera",
  ScanView: ExpoChipScanView,
};

const styles = StyleSheet.create({
  camera: { width: "100%", aspectRatio: 3 / 4, borderRadius: RADIUS.control },
});
```

What a scanned string MEANS stays the claim view-model's decision
(`chipCodeFromScan`): fifteen digits after separators, or the field is left
alone. The adapter must not pre-filter — one validation door, two input
methods.

### The wiring — two lines at bootstrap

In `apps/mobile/app/_layout.tsx`, at module scope (before the component, so it
runs once per process):

```ts
import { setChipScannerPort } from "../src/native/chip-scanner-port";
import { setImagePickerPort } from "../src/native/image-picker-port";
import { expoChipScanner } from "../src/native/expo-camera-adapter";
import { expoImagePicker } from "../src/native/expo-image-picker-adapter";

setImagePickerPort(expoImagePicker);
setChipScannerPort(expoChipScanner);
```

Tests never import `_layout.tsx`, so every existing test keeps running against
the honest defaults — the suite needs no change for this commit.

### Permissions / config plugins

In `app.config.ts` `plugins`, add the two config plugins with es-AR strings
(the UI-language invariant applies to permission dialogs too):

```ts
[
  "expo-image-picker",
  { photosPermission: "miMAR usa tus fotos para ponerle imagen a la credencial de tu mascota." },
],
[
  "expo-camera",
  { cameraPermission: "miMAR usa la cámara para escanear el código del microchip." },
],
```

On Android these land `CAMERA` and the media-read permission in the manifest at
prebuild. `expo-image-manipulator` needs no plugin.

---

## What changes in the fingerprint — and what that rules out

`app.config.ts` sets `runtimeVersion: { policy: "fingerprint" }`. Installing a
native module and adding config plugins changes the prebuilt native project,
so the fingerprint CHANGES. Two consequences, both by design:

1. **No OTA can ship any of this.** An `eas update` whose JS calls
   `expo-image-picker` would only ever be served to builds that already contain
   it — that is the exact crash the policy exists to prevent
   (`ota-policy.md`). The modules reach phones inside a full store build or not
   at all.
2. **The local/EAS fingerprint agreement has to hold again.** The first real
   build died on two causes of fingerprint divergence
   (`eas-build-profiles.md`, "Two ways to break a fingerprint") — both were
   toolchain pinning, both are fixed in the tree, and neither should recur —
   but the check runs again on this build, and a mismatch is a refused build,
   not a broken one.

---

## Which EAS build, in which order

Per `eas-build-profiles.md`: `development` is the PO's own iteration build,
`preview` is the testers' APK, `production` is the Play `.aab`. This change
rides the **same release as build 7** — the one PO-gated item 1 already owes
Play (build 6, tree `371a2122`, was never uploaded), because build 5 shipped
without `EXPO_PUBLIC_SUPABASE_*` and cannot sign in. One release, both fixes:
the env vars and the camera modules. Do not spend
two `versionCode`s where one release serves (every build burns one,
`autoIncrement` — the tally in that doc is the record).

Order, with the owner of each step:

| # | Step | Owner |
|---|---|---|
| 1 | **Revise the Play Data Safety form** — see the next section. Before ANY build with uploads reaches Play. | **PO** |
| 2 | `npx expo install expo-image-picker expo-image-manipulator expo-camera` in `apps/mobile/`; commit with the lockfile | agent (mechanical), on the PO's go |
| 3 | Commit the two adapters above + the two `set…Port` lines + the config plugins; `pnpm --filter mimar exec tsc --noEmit` and the mobile Jest suite green; full `pnpm verify` + `pnpm test:verified` per the Definition of Done | agent, same window as 2 |
| 4 | `npx eas-cli build --profile development --platform android`, install on the PO's device, walk the two flows against staging (checklist below) | **PO** (agent can watch logs) |
| 5 | `--profile preview` for the 12 testers, **with `EXPO_PUBLIC_SUPABASE_*` set** — the build-5 lesson; they are baked at build time | **PO** |
| 6 | `--profile production`, upload to Play internal testing as build 7 | **PO** |

---

## The PO's own steps — and the one that is not optional

### Data Safety, FIRST (board: PO-gated item 2)

The board's PO-gated list, item 2, verbatim in substance: the Data Safety form
submitted on 27/08 declared that **the app does not collect photos. That stops
being true the moment a build with these modules reaches Play**, and a form
that no longer matches the binary is a Play policy violation by itself —
independent of review outcomes, and enforced retroactively against the listing.

What changes in the form:

- **Photos and videos → Photos**: now collected. Purpose: app functionality.
  Shared: no (the photo goes to miMAR's own storage; the public credential
  serves it, but no third party receives it in Play's sense). Optional: yes —
  the app works without setting a photo.
- **Camera**: the chip scan processes frames on-device and stores nothing; the
  barcode string is sent to miMAR only as the lookup the person then submits.
  Whether that needs a declaration depends on the form's current wording —
  answer it while filling it, not from this page.
- While in the form: the account-deletion URL it names
  (`/cuenta/privacidad`) and the art. 14 export it references are already live
  in the app (WU-R block on the board) — nothing to change there, just do not
  regress it.

The form is edited in Play Console → App content → Data safety, and the edit
must be submitted **before or together with** build 7's rollout, never after.

### The rest of the PO list, unchanged

Items 1 (build 7 with the env vars — build 6 was never uploaded) and 3–11 of
the board's PO-gated list are untouched by this handback; item 1 simply gains
a second reason to happen.

---

## What to verify after — the checklist for step 4

On the development build, against staging, before anything reaches testers:

1. **The seams flipped.** The photo screen offers "Elegir una foto" (no more
   web callout); the claim screen offers "Escanear el chip" under Microchip and
   the "a mano" callout is gone. Both are seam-driven — if either callout is
   still there, the `set…Port` wiring did not run.
2. **HEIC in, JPEG out.** Pick a photo taken by an iPhone (or any HEIC file
   placed in the gallery). It must upload — because the adapter re-encoded it —
   and the staged object's magic bytes must be JPEG. If it is refused with the
   HEIC sentence instead, the manipulator call is not running; check the
   image-manipulator API note in the adapter (SDK 52+ renamed the entry point —
   this is the single most likely compile-time correction to the draft above).
3. **The GPS leak is actually closed.** Download the pet's public photo after
   confirm and run `exiftool` (or any EXIF viewer) over it: no GPS tags. The
   server re-encode should guarantee this on its own; the point of checking the
   client side too is that the STAGED object (private bucket) is also clean.
4. **The three failure arms fire for real.** Airplane mode mid-upload → the
   connection sentence, photo still on the review step. Wait out a ticket (or
   revoke it server-side) → the "permiso venció" sentence, and a retry works
   end to end. A non-image renamed `.jpg` → the server's
   `photo_not_an_image` sentence at confirm.
5. **The scan sets the field and nothing else.** Scan a real chip sticker: the
   fifteen digits land in the field, NO lookup fires until Buscar is tapped.
   Scan the sticker's other barcode (lot/product): the field does not change
   and the sentence names the keyboard. Deny the camera permission: the denial
   state renders, Volver works, the keyboard path still works.
6. **Permission dialogs are es-AR.** Both custom strings from the config
   plugins appear (a default English dialog means the plugin config was
   dropped at prebuild).
7. **The suite still stands.** `pnpm --filter mimar test` and the full
   Definition-of-Done gate on the commit that added the adapters — the seams
   keep every existing test meaningful because defaults stay honest in test
   processes.

## Known-risk pointers, so nobody re-derives them

- The build pipeline's five root causes are each a section at the end of
  `eas-build-profiles.md`; three are invisible to every local gate. Read them
  before the first rebuild, not after it fails.
- `expo-image-manipulator`'s API changed shape at SDK 52 (object API in,
  `manipulateAsync` deprecated). The adapter draft above uses the legacy name;
  whichever the installed major exports is the one to ship. This is flagged in
  the adapter source and in checklist item 2.
- `expo-camera`'s barcode types list is a guess ratified by hardware: verify
  against a real vet sticker in step 5 and trim or extend the list to what
  scans. The seam means the list lives in ONE file.
