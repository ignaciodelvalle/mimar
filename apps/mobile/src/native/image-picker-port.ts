// The IMAGE PICKER SEAM — everything this app can write without the EAS build.
//
// WHY A SEAM AND NOT AN IMPORT
// ---------------------------------------------------------------------------
// Choosing a photo needs `expo-image-picker`, which is a NATIVE module. Under
// `runtimeVersion: { policy: "fingerprint" }` (app.config.ts) adding one changes
// the fingerprint, which means a new EAS build and a store release — the
// pipeline the board records as six builds with five distinct root causes,
// three of them invisible to every local gate. That pipeline is PO-gated.
//
// So the module sits behind this port, the same arrangement
// `lib/observability/sink.ts` uses for the telemetry transport: an interface,
// a DEFAULT that says honestly that the module is not in this build, and one
// `setImagePickerPort()` call at app start. Every screen, state machine, error
// sentence and upload call was written and tested against this port BEFORE the
// module existed.
//
// THE ADAPTER IS NOW IN THE TREE (`expo-image-picker-adapter.ts`), and this
// paragraph used to say the opposite — that it "does not live in this repo yet"
// because a static import of an uninstalled package fails typecheck and Metro
// alike. That was true of the tree it was written in and is not true of this
// one: `expo-image-picker` and `expo-image-manipulator` are installed, the
// adapter imports them, and `app/_layout.tsx` installs it at module scope. What
// survives from that paragraph is the RULE it was protecting — the adapter is
// the only file allowed to touch those imports, because they evaluate native
// modules at import time and throw in a process that has none. The install
// command and the build order are in `docs/mobile/camera-modules-handback.md`.
//
// WHAT AN ADAPTER MUST PROMISE (the contract the doc restates)
// ---------------------------------------------------------------------------
//   · `bytes` is the ENCODED IMAGE FILE, not raw pixels, and `contentType` is
//     what those bytes actually are. The pet-photo bucket accepts only
//     jpeg/png/webp (migration 0206) and the server re-checks the magic bytes
//     at `confirm`, so an adapter that hands over an iPhone HEIC unconverted
//     produces an upload the PUT refuses. The recommended adapter re-encodes
//     to JPEG via `expo-image-manipulator` — which also strips EXIF, closing
//     the known GPS leak a phone photo carries (the same leak the denuncia
//     work declared for HEIC on the web).
//   · `cancelled` is not an error. The person changed their mind.
//   · The default port answers `unavailable` and nothing else. A screen must
//     read `available` BEFORE offering a pick control, so nobody hunts for a
//     button that cannot work — the rule the claim screen already follows for
//     the scanner.
//
// `previewUri` is a device-local `file://` (or `content://`) URI the screen may
// hand to `<Image>` for a preview. It is display-only: the bytes that travel
// are `bytes`, never something re-read from the URI at upload time.

/** What one pick attempt produced. */
export type ImagePickResult =
  | {
      outcome: "picked";
      /** The encoded image file, ready to PUT. A Uint8Array, not a Blob — see
       *  the note on `readAsBytes` and `uploadPetPhotoBytes` for why the blob
       *  body form loses its content-type on Android. */
      bytes: Uint8Array;
      /** What `bytes` actually are — the adapter's promise, re-checked by the screen. */
      contentType: string;
      /** Device-local URI for an `<Image>` preview, when the module offers one. */
      previewUri: string | null;
    }
  | { outcome: "cancelled" }
  /** The module is not in this build. The honest default's only answer. */
  | { outcome: "unavailable" }
  | { outcome: "failed"; detail: string };

export type ImagePickerPort = {
  /** Stable identifier, e.g. "module-missing" or "expo-image-picker". */
  readonly name: string;
  /**
   * Whether a pick can possibly succeed in this build. A screen reads this to
   * decide whether to DRAW the control at all — offering a button whose only
   * outcome is `unavailable` is the dead end this field exists to prevent.
   */
  readonly available: boolean;
  pickImage(): Promise<ImagePickResult>;
  /**
   * A pick abandoned by an Android process death, if one is waiting (T4-M1,
   * 2026-09-22 — see the adapter's header for the whole design decision).
   * `null` when there is nothing to recover, which is the only honest answer
   * on every platform but Android and for every port that never launches a
   * native picker.
   *
   * CLAIM-ONCE: the native side hands this over exactly once, and this port
   * method mirrors that — a second call, from a second screen mounting later
   * in the same process, gets `null` even though the same pick happened.
   * `pickImage()` itself is never re-entrant in the way this recovery is, so
   * it carries no such rule; this one needs it stated because two DIFFERENT
   * screens (`PetPhotoScreen`, the tatuaje branch of `RecordEventScreen`) can
   * each try to claim the same recovered pick.
   */
  recoverPendingPick(): Promise<ImagePickResult | null>;
};

/**
 * The default: this build carries no image picker, and says so.
 *
 * NOT a no-op and NOT a promise — the `consoleSink` argument, verbatim: a
 * default that pretended to pick (or silently did nothing) would let a screen
 * ship a control that lies. `available: false` is the truthful answer to "can
 * this build choose a photo", and it stays the answer until an EAS build with
 * `expo-image-picker` ships and `setImagePickerPort()` runs at app start.
 */
export const moduleMissingImagePicker: ImagePickerPort = {
  name: "module-missing",
  available: false,
  pickImage: async () => ({ outcome: "unavailable" }),
  // No module ever launched a picker, so no activity was ever destroyed mid-pick
  // and there is nothing to recover. `null`, not `unavailable` — this is not a
  // pick somebody is waiting on, it is the truthful "nothing happened" answer.
  recoverPendingPick: async () => null,
};

let activePort: ImagePickerPort = moduleMissingImagePicker;

/**
 * Installs the process-wide port. Called once during app bootstrap
 * (`app/_layout.tsx`), by the wiring line the handback doc specifies.
 * Returns the port it replaced so a test can restore it.
 */
export function setImagePickerPort(port: ImagePickerPort): ImagePickerPort {
  const previous = activePort;
  activePort = port;
  return previous;
}

/** The currently installed port. */
export function getImagePickerPort(): ImagePickerPort {
  return activePort;
}

/**
 * One pick, from the installed port, with the "never throws" half of the
 * contract ACTUALLY ENFORCED.
 *
 * WHY THIS EXISTS AND WHY EVERY SCREEN GOES THROUGH IT. `pickImage` promises a
 * member of `ImagePickResult` and no other outcome — but until this function,
 * that promise was enforced nowhere. It was a sentence in a header, and an
 * adapter that let one TypeError escape (the real one found in review: a
 * `canceled: false` result carrying `assets: null`, indexed outside the
 * adapter's own try) turned it into a REJECTED PROMISE. Both callers await it
 * bare after setting a "picking" phase, so a rejection strands the screen on a
 * spinner: no sentence, no retry, only hardware back. That is precisely the
 * silence this port's header calls the one answer a tap may not get.
 *
 * Fixing the adapter closes that instance. This closes the CLASS — including
 * for the next adapter, and for a fake a test installs. `failed` is the honest
 * member for it: something broke, nothing was uploaded, trying again is safe.
 */
/**
 * `marker` IS `null` ONLY WHEN THERE IS NO SESSION TO BIND TO — see each
 * caller's own `null` check. Both screens that call this are behind
 * `useGate`, so that arm is a defensive default rather than an expected path;
 * when it IS taken, the pick still runs (the person is looking at a live
 * picker, and refusing to open it would be a worse answer than an unbound
 * recovery some day), it is simply not recoverable if the process dies before
 * it returns.
 *
 * `store` IS A PARAMETER AND NOT THE REAL BINDING IMPORTED HERE, for the same
 * reason `runLaunchUpdateGate` takes its marker store as an argument: this
 * file stays native-free, so it can be tested without an AsyncStorage mock.
 * `image-pick-marker-store.ts` is what a screen actually passes.
 */
export async function pickImageSafely(
  marker: Omit<ImagePickMarker, "launchedAt"> | null,
  store: ImagePickMarkerStore,
  now: () => number = Date.now,
): Promise<ImagePickResult> {
  if (marker !== null) {
    try {
      // BEFORE THE LAUNCH, NOT AFTER. The process can die while the native
      // picker is on top of this app — that is the whole scenario this marker
      // exists for — so the write has to already be on disk by the time that
      // happens. A marker that failed to persist just means a later recovery
      // finds nothing and discards, the same as if none had ever been written.
      await store.write({ ...marker, launchedAt: now() });
    } catch {
      // Best-effort, for the reason above.
    }
  }
  try {
    return await activePort.pickImage();
  } catch (error) {
    return {
      outcome: "failed",
      // Diagnostic, never shown — `acceptPickedImage` answers the person. The
      // prefix names the port so a breadcrumb says WHICH implementation broke
      // its promise, which is the only thing that makes this debuggable.
      detail: `${activePort.name} threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The pending-pick recovery, with the same "never throws" enforcement
 * `pickImageSafely` gives the live pick, and for the same reason: a screen
 * calls this from a mount effect, bare-awaited, and a rejection there must not
 * become an unhandled promise or a crash on first paint.
 *
 * `null` ON ANY FAILURE, NOT `failed`. Unlike `pickImageSafely`, nobody is
 * looking at a spinner waiting for this — the screen is sitting in its normal
 * entry state either way — so there is nobody to hand a sentence to. Silently
 * not recovering is exactly the "discarded safely" half of T4-M1's contract.
 */
/**
 * `expected` names the screen, pet and session asking — see
 * `imagePickMarkerMatches`. `store` is read (and always cleared — see below)
 * even when the native side answers `null`, so a marker from an attempt whose
 * native result already evaporated (a `getPendingResultAsync` answer is
 * itself claim-once, and consumed at most once per process, see the
 * adapter's header) does not linger on disk forever.
 *
 * THE NATIVE CALL ALWAYS RUNS, REGARDLESS OF WHETHER THE MARKER MATCHES. It
 * has to: the native module holds at most one pending result, and the only
 * way to drain it is to ask. Asking and then discarding the answer (because
 * the marker names a different screen, pet, user, or is stale) is what
 * "delivered to the screen that asked, or discarded safely" means now that
 * "the screen that asked" is a checked identity rather than "whichever one
 * mounts first".
 */
export async function recoverPendingPickSafely(
  expected: { screen: ImagePickScreen; publicToken: string; sessionUserId: string },
  store: ImagePickMarkerStore,
  now: () => number = Date.now,
): Promise<ImagePickResult | null> {
  let marker: ImagePickMarker | null = null;
  try {
    marker = await store.read();
  } catch {
    marker = null;
  }
  try {
    // CLAIM-ONCE AT THIS LAYER TOO. Whatever the marker said, it describes a
    // launch that has now been asked about; it must not be readable by a
    // second recovery attempt later in the same process, matching or not.
    await store.clear();
  } catch {
    // Best-effort, same as every other write in this neighbourhood.
  }
  try {
    const result = await activePort.recoverPendingPick();
    if (result === null) return null;
    if (marker === null || !imagePickMarkerMatches(marker, expected, now())) return null;
    return result;
  } catch {
    return null;
  }
}

/** Restores the honest default. Primarily for tests. */
export function resetImagePickerPort(): void {
  activePort = moduleMissingImagePicker;
}

// ===========================================================================
// THE RECOVERY MARKER — binding a recovered pick to who and what asked for it
// (T3-R4, 2026-09-22, security review).
// ===========================================================================
// THE GAP THIS CLOSES. `recoverPendingPick()` on the adapter is claim-once
// against the NATIVE module, not against this app's own screens: before this
// marker existed, "whichever picker-capable screen mounts and asks first gets
// it" meant a pick made on pet A's tattoo form could surface on pet B's photo
// screen after a process death — no pet in common, no gesture, and (because
// the check was never about WHO was signed in either) it could surface after a
// logout/login on a shared device, silently staging one person's photo under
// another's session.
//
// THE FIX IS A MARKER, NOT A SMARTER CLAIM. `pickImageSafely` persists
// `{screen, publicToken, sessionUserId, launchedAt}` to durable storage BEFORE
// the native picker opens — see `image-pick-marker-store.ts` for why that has
// to be AsyncStorage and not memory, and the adapter's own header for why the
// write has to happen before the launch and not after (the process can die
// while the picker is on top of this app, and the write must already be on
// disk by then). `recoverPendingPickSafely` reads it back and refuses to
// deliver a recovered pick unless every field matches the screen asking for
// it AND the marker is recent — `IMAGE_PICK_MARKER_MAX_AGE_MS` below.
export type ImagePickScreen = "pet-photo" | "tattoo";

/**
 * What was written to disk just before a real launch, so a recovery can be
 * checked against it. `launchedAt` is `Date.now()` at write time, in device
 * clock ms — the same clock `event-draft-store.ts` uses for its own age
 * check, and for the same reason: there is no server timestamp for a pick
 * that never left the device.
 */
export type ImagePickMarker = {
  screen: ImagePickScreen;
  publicToken: string;
  sessionUserId: string;
  launchedAt: number;
};

/** The marker's durable store, as a port. `image-pick-marker-store.ts` is the
 *  real AsyncStorage binding; this module stays native-free. */
export type ImagePickMarkerStore = {
  read(): Promise<ImagePickMarker | null>;
  write(marker: ImagePickMarker): Promise<void>;
  clear(): Promise<void>;
};

/**
 * How old a marker may be and still bind a recovered pick to it: 30 minutes.
 *
 * Long enough to cover the ordinary case this exists for — Android reclaimed
 * the process while the system picker was on top of it, and the person comes
 * straight back to the app once it restarts — and short enough that a marker
 * from an abandoned attempt days ago cannot silently attach a stale photo to
 * whatever the person happens to be doing now.
 */
export const IMAGE_PICK_MARKER_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Whether a stored marker may deliver its recovered pick to THIS request.
 *
 * EVERY FIELD IS A REFUSAL ON ITS OWN, deliberately: a marker naming the
 * right screen and pet but the wrong session user is exactly the
 * cross-session leak this whole mechanism exists to close, and it must be
 * refused as firmly as a marker naming nothing in common at all.
 *
 * THE AGE CHECK IS NOT SYMMETRIC LIKE `event-draft-store.ts`'s. A draft that
 * looks like it is from the future is ambiguous and gets the benefit of no
 * doubt either way; a pick marker that looks like it is from the future is
 * not ambiguous, because `pickImageSafely` writes it with the SAME `now()`
 * this function is handed to judge it — so `age < 0` only happens if the
 * clock moved backward between the write and this read, and a marker that
 * predates its own write is never one this call actually produced. Refused,
 * not guessed at.
 */
export function imagePickMarkerMatches(
  marker: ImagePickMarker,
  expected: { screen: ImagePickScreen; publicToken: string; sessionUserId: string },
  now: number,
): boolean {
  if (marker.screen !== expected.screen) return false;
  if (marker.publicToken !== expected.publicToken) return false;
  if (marker.sessionUserId !== expected.sessionUserId) return false;
  const age = now - marker.launchedAt;
  return age >= 0 && age <= IMAGE_PICK_MARKER_MAX_AGE_MS;
}
