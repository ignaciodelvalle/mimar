// THE REAL PICKER, bound to the seam `image-picker-port.ts` declares.
//
// WHY THIS BINDING IS ITS OWN FILE, and why nothing but `app/_layout.tsx` may
// import it: `expo-image-picker` and `expo-image-manipulator` are NATIVE
// modules, and their JS entry points are not inert. `ImageManipulator` is a
// `requireNativeModule(...)` instance evaluated at import time, which THROWS in
// any process without the native runtime — a jest run with no mock, Expo Go, a
// dev client built before the module landed. That is the same argument
// `account/expo-updates-port.ts` records for `expo-updates`, and the same
// arrangement: the port's TYPE and every decision made from it stay in
// native-free modules, and the one file that touches the native import lives
// alone, so importing it is an explicit opt-in to the native dependency.
//
// WHAT THIS ADAPTER PROMISES — the contract restated from the port's header:
//   · `bytes` is the ENCODED FILE and `contentType` is what those bytes really
//     are. Everything that leaves here is JPEG, because everything that leaves
//     here has been re-encoded (see THE LOAD-BEARING STEP below).
//   · `cancelled` is not an error.
//   · `failed.detail` is DIAGNOSTIC, never shown: `acceptPickedImage` answers
//     the person with its own es-AR sentence and never reads this string. So it
//     is written in English, like every other identifier and comment here, and
//     it carries the module's error CODE when there is one, because that code
//     is the only thing that tells a reader of a Sentry breadcrumb which of the
//     module's many refusals actually happened.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO PERMISSION REQUEST IN THIS FILE
// ---------------------------------------------------------------------------
// This was the first thing looked for and the answer is that asking would be
// WRONG, not merely unnecessary. Read in expo-image-picker 57.0.16:
//
//   · Android, `ImagePickerModule.kt`: `launchCameraAsync` opens with
//     `ensureCameraPermissionsAreGranted()`; `launchImageLibraryAsync` does
//     not. It goes straight to the photo-picker contract, which is the system
//     picker running OUT OF PROCESS and holds no permission of ours.
//     `UserRejectedPermissionsException` exists in that module and is reachable
//     only from the camera path — the path this app never calls.
//   · iOS, `ImagePickerModule.swift`: `launchImageLibraryAsync` calls
//     `launchImagePicker(sourceType: .photoLibrary, …)` with no permission gate
//     of its own — `PHPickerViewController`, again out of process.
//
// So a `requestMediaLibraryPermissionsAsync()` in front of the launch would put
// a dialog in front of a flow that does not need one, and a "no" to that dialog
// would then block a pick that would otherwise have worked. The permission
// members of the module's API are deliberately unused.
//
// That is also why this file maps no `permission-denied` outcome: on THIS path,
// in THIS SDK, there is no such outcome to map. If a future change ever calls
// `launchCameraAsync`, the union in `image-picker-port.ts` genuinely lacks a
// member for "denied and cannot ask again" — the sentence `failed` earns
// ("No pudimos abrir tus fotos. Volvé a intentar.") tells somebody to retry a
// thing that can only be fixed in the phone's settings. Add the member then;
// do not collapse it onto `failed`.
//
// ---------------------------------------------------------------------------
// DESIGN DECISION, 2026-09-22 (T4-M1): recovering a pick Android threw away
// ---------------------------------------------------------------------------
// THE BUG. Android may destroy this app's process while the system photo
// picker is on top of it (low memory is the ordinary trigger; "Don't keep
// activities" in developer options reproduces it on demand). The picker
// finishes, has nobody to deliver the result to, and Android restarts the app
// fresh. `PetPhotoScreen` and the tatuaje branch of `RecordEventScreen` both
// set `phase: "picking"` and bare-`await pickImageSafely()` — a promise that
// can now never settle, because the launch it was chained to already ran, in
// a process that no longer exists. The screen remounts in its ordinary entry
// state, so the literal "stuck on Abriendo tus fotos…" only reproduces when a
// SECOND pick is attempted before the phone is told about the first — but the
// picked bytes from the FIRST attempt are still real, still sitting in
// `ImagePicker`'s own held state, and throwing them away is the actual loss
// this item closes: a person who chose a photo, had Android reclaim memory
// for it, and would otherwise have to notice nothing happened and pick again.
//
// THE MODULE'S OWN ANSWER is `getPendingResultAsync()` (`ImagePicker.d.ts`):
// on Android it returns whatever the last `launchImageLibraryAsync` produced,
// exactly once, if that result was never collected; `null` everywhere else,
// including "nothing to recover".
//
// THE PORT'S SHAPE CHANGES: `ImagePickerPort` gains `recoverPendingPick()`,
// required on every implementation (the same way `PushPort` grew `lastTap()`
// for the analogous problem — a value the native side produced before this
// JS process existed, held for one collection). `moduleMissingImagePicker`
// answers `null`: no module ever launched a picker, so nothing was ever lost.
//
// WHY A BOOTSTRAP READ AND NOT A PER-PICK ONE. `getPendingResultAsync` has to
// run before either screen has decided anything, because BY THE TIME a screen
// mounts, the answer already exists natively — it does not arrive from an
// event this app can listen for. `warmPendingImagePickRecovery()` fires the
// native call once at bootstrap (`app/_layout.tsx`, right beside
// `setImagePickerPort`), memoised, so the read is already in flight — usually
// already settled — by the time either screen's mount effect asks for it.
//
// CLAIM-ONCE, AND WHY THAT IS THE HONEST ANSWER TO "delivered to the screen
// that asked, or discarded safely" RATHER THAN A COMPROMISE ON IT. A full
// process restart drops every screen's identity along with its state — there
// is no surviving marker in memory saying "PetPhotoScreen was the one
// waiting", and writing one to disk before every single launch (so it could
// survive the restart it is meant to detect) is a cost and a failure mode of
// its own for a recovery path that exists to be a safety net, not the primary
// flow. So this recovers a PICK, not a REQUEST: whichever of the two
// picker-capable screens mounts and asks first gets it, `pickImage()`'s
// ordinary re-encode pipeline runs on it exactly as it would for a fresh
// pick, and the other screen — or the same screen mounting again later —
// gets `null`. If the person never returns to a picker-capable screen at
// all, the recovered pick is simply never claimed, which is "discarded
// safely": nothing hangs, nothing throws, no bytes are held past the process
// that decoded them.
//
// THIS IS BOOTSTRAP-ONLY, ON PURPOSE. It answers "was something lost across
// the restart that just happened", not "check again every time a screen
// mounts" — the native module holds at most one result, consumed exactly
// once, so polling it repeatedly across a long-lived app session would only
// ever find it empty after the first genuine claim.
//
// ---------------------------------------------------------------------------
// CORRECTION, 2026-09-22 (T3-R4, security review): "whichever screen mounts
// and asks first gets it" WAS WRONG TO SHIP AS THE WHOLE ANSWER.
// ---------------------------------------------------------------------------
// The paragraphs above are still true about what THIS FILE claims from the
// native module — claim-once, bootstrap-only, at most one result in flight.
// What was wrong is the paragraph that used to sit here treating "whichever
// picker-capable screen asks first" as an acceptable resolution of WHO the
// recovered pick belongs to. It is not: a pick made on pet A's tattoo form
// could surface, with no pet in common and no gesture behind it, as an
// auto-staged photo on pet B's credential — or on a different person's
// session entirely, after a logout/login on a shared device, since nothing
// here ever checked WHO was asking either.
//
// THE FIX LIVES ONE LAYER UP, in `image-picker-port.ts`'s `pickImageSafely`
// and `recoverPendingPickSafely`. This file's job is unchanged: hand back
// whatever the native module is holding, exactly once. Binding that answer to
// the screen, pet and session that actually asked for it — and refusing to
// deliver it otherwise, discarding rather than guessing — is `image-picker-
// port.ts`'s `ImagePickMarker` and `imagePickMarkerMatches`. See that module's
// own header for the mechanism.

import {
  ImageManipulator,
  type ImageManipulatorContext,
  type ImageRef,
  SaveFormat,
} from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

import type { ImagePickResult, ImagePickerPort } from "./image-picker-port";

/**
 * The JPEG quality every picked photo is re-encoded at.
 *
 * 0.85 is the usual "no visible artefact at photographic sizes" setting. It is
 * a QUALITY choice and NOT a size guarantee — an earlier version of this
 * comment claimed it kept a 12 MP photo under the 5 MiB cap, which is the one
 * thing in this file that was asserted and measured nowhere. Quality alone
 * cannot bound the output: bytes scale with PIXEL COUNT, and a compression
 * ratio applied to four times the pixels is four times the file. The bound is
 * `PET_PHOTO_MAX_EDGE` below.
 */
export const PET_PHOTO_JPEG_COMPRESS = 0.85;

/**
 * The longest edge every picked photo is clamped to before it is encoded.
 *
 * WHY THIS EXISTS, and it is the difference between a working control and a
 * worse dead end than the one this adapter replaced.
 *
 * `pet-photo-view-model.ts` caps an upload at 5 MiB (`PET_PHOTO_MAX_BYTES`,
 * mirroring migration 0206's bucket limit) and refuses anything larger with
 * "Esa foto pesa más de 5 MB. Elegí una más liviana." A 48–50 MP sensor is
 * ordinary on a mid-range Android phone now, and a full-resolution re-encode of
 * one lands past that cap EVERY TIME. The person would tap "Elegir una foto",
 * wait through a decode and an encode of fifty megapixels, and be told to pick
 * a lighter one — on a phone where every photo is that size. The instruction is
 * unactionable, and the callout naming the web that this change removed was at
 * least an instruction somebody could follow.
 *
 * WHY A CLAMP AND NOT A CROP. This file's first draft argued that resizing was
 * "the screen's opinion about framing" and refused it. That argument does not
 * survive contact with this case and is withdrawn: a longest-edge clamp changes
 * no aspect ratio and removes no part of the picture. It is a byte budget, and
 * a byte budget belongs to whoever is producing the bytes.
 *
 * WHY 2048. The credential renders the photo in a square a few hundred points
 * across, and the public page is not a print surface. 2048 is several times
 * what either needs, which leaves the clamp as a ceiling nobody bumps into for
 * quality reasons while still cutting a 50 MP frame by roughly an order of
 * magnitude in pixels.
 */
export const PET_PHOTO_MAX_EDGE = 2048;

/**
 * The options the library picker is launched with. Exported so a test can pin
 * them: three of the five are load-bearing and one of them silently changes
 * which Android component opens.
 */
export const IMAGE_LIBRARY_OPTIONS: ImagePicker.ImagePickerOptions = {
  // Images only. A video would arrive with a `type` this adapter refuses below,
  // but refusing it after the person picked it is a worse experience than not
  // offering it.
  mediaTypes: ["images"],
  // One photo. The screen's whole review step is written around exactly one.
  allowsMultipleSelection: false,
  // No crop UI. The credential's frame is decided by the screen's square
  // preview, and a cropper here would be a second, contradictory opinion about
  // it. It is also mutually exclusive with the picker paths this app wants.
  allowsEditing: false,
  // Do not hand EXIF back to JS. Belt to the re-encode's braces: the
  // manipulator drops the tags from the FILE, and this keeps the same tags —
  // including the GPS position of wherever the photo was taken — from ever
  // being materialised as a JS object that some future log could serialise.
  exif: false,
  // No pre-compression. Whatever loss this flow takes, it takes ONCE, in the
  // re-encode below, at a quality this file chooses.
  quality: 1,
  // NOT DECORATION, and not merely the default restated. `legacy: true` routes
  // Android away from the system photo picker and into `createLegacyIntent`'s
  // `ACTION_GET_CONTENT`, which browses far beyond the photo library — any
  // provider that answers the intent, including cloud and file-manager apps.
  // That is a much wider surface for a flow whose whole job is "one photo of
  // the animal", and the narrower picker is the one this app wants. (The first
  // draft of this comment claimed the legacy path drags a storage permission
  // back in. It does not: `ACTION_GET_CONTENT` is SAF and runs out of process
  // too. The conclusion stands; the reason it gave was wrong.)
  legacy: false,
};

/**
 * The real module, as a port.
 *
 * `available: true` is a claim about the BUILD, not about the moment: this
 * module is only ever installed by `app/_layout.tsx`, which only exists in a
 * binary that was compiled with the native module linked in. A build without it
 * never runs this file at all — it keeps the honest default.
 */
export const expoImagePicker: ImagePickerPort = {
  name: "expo-image-picker",
  available: true,
  pickImage,
  recoverPendingPick: recoverPendingImagePick,
};

async function pickImage(): Promise<ImagePickResult> {
  let launched: ImagePicker.ImagePickerResult;
  try {
    launched = await ImagePicker.launchImageLibraryAsync(IMAGE_LIBRARY_OPTIONS);
  } catch (error) {
    // The picker itself refused to open: no activity to handle the intent, a
    // permission the OS took away under us. Both are `failed` — neither is the
    // person's doing. (A second launch while one is already up is NOT in this
    // list: Android's `launchContract` answers that with `canceled = true`, so
    // it arrives below as a cancel, which is the right member for it.)
    return { outcome: "failed", detail: `launch: ${failureDetail(error)}` };
  }

  return processLaunchResult(launched);
}

/**
 * The one native call `warmPendingImagePickRecovery` and `recoverPendingImagePick`
 * share, memoised so the native module is asked exactly once per process — see
 * the header's DESIGN DECISION for why a bootstrap read and not a per-call one.
 */
let pendingResultRead: ReturnType<typeof ImagePicker.getPendingResultAsync> | null = null;

/** Whether the one recoverable pick has already been handed to a screen. */
let pendingResultClaimed = false;

/**
 * Starts the native read early, without waiting for it or claiming its
 * answer. Called once from `app/_layout.tsx`, beside `setImagePickerPort`, so
 * the result is already in flight before either picker-capable screen mounts.
 * Idempotent: a second call — from a test, or from a screen that ends up
 * calling `recoverPendingImagePick` before bootstrap does — reuses the same
 * read instead of asking the native module twice.
 */
export function warmPendingImagePickRecovery(): void {
  if (pendingResultRead === null) pendingResultRead = ImagePicker.getPendingResultAsync();
}

/**
 * Forgets the memoised read and the claim, so the next call asks the native
 * module again. For tests only — the real process never does this, because a
 * process that could ask again is one that was never actually recovering
 * from having lost its state.
 */
export function resetPendingImagePickRecoveryForTests(): void {
  pendingResultRead = null;
  pendingResultClaimed = false;
}

/**
 * `recoverPendingPick` on the real port. See the header's DESIGN DECISION for
 * the claim-once contract this implements.
 */
async function recoverPendingImagePick(): Promise<ImagePickResult | null> {
  warmPendingImagePickRecovery();
  const pending = await pendingResultRead;
  // Either nothing was pending, or another screen already claimed the one
  // pending result while this call was awaiting the same memoised read.
  if (pending === null || pendingResultClaimed) return null;
  pendingResultClaimed = true;

  if (isPickerErrorResult(pending)) {
    // The module itself reports the abandoned attempt as a failure (a decode
    // error, a permission the OS revoked while the process was gone) — carried
    // through the same `failed` member a live failure uses, with a `pending:`
    // prefix so a breadcrumb reader can tell the two apart.
    return { outcome: "failed", detail: `pending: ${pending.code}: ${pending.message}` };
  }
  return processLaunchResult(pending);
}

/**
 * `true` for the shape `ImagePicker.CodedError`-style results take:
 * `{ code, message, exception? }`, with no `canceled`/`assets` at all. The two
 * possible answers from `getPendingResultAsync` do not share a discriminant
 * property, so this checks for the one field only the error shape has.
 */
function isPickerErrorResult(
  result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult,
): result is ImagePicker.ImagePickerErrorResult {
  return "code" in result;
}

/**
 * Everything a launch result becomes, from either the live launch or a
 * recovered one — extracted so the re-encode pipeline (and its release
 * discipline) exists in exactly one place. `launched.assets`, the clamp, the
 * JPEG re-encode and the EXIF strip apply identically to a pick that just
 * happened and to one Android held onto since before this process existed.
 */
async function processLaunchResult(
  launched: ImagePicker.ImagePickerResult,
): Promise<ImagePickResult> {
  // THE PERSON CHANGED THEIR MIND. Not an error, and it gets no sentence.
  if (launched.canceled) return { outcome: "cancelled" };

  // `?.` AND NOT `[0]`, and the difference is a screen that hangs forever.
  // `assets` is typed `ImagePickerAsset[] | null` — null is the CANCELLED
  // shape, but nothing in the module's types stops a `canceled: false` result
  // from carrying it, and `null[0]` is a TypeError, not a value. Thrown from
  // here — outside the `try` below — it would escape `pickImage()` as a
  // rejected promise, and neither screen catches one: both set
  // `phase: "picking"` and bare-await, so the person would be left on a spinner
  // with no error, no retry and only hardware back as an exit. That is the
  // exact silence the port's header forbids. `pickImageSafely()` in
  // `image-picker-port.ts` is the second line of that defence.
  const asset = launched.assets?.[0];
  if (asset === undefined) {
    // `canceled: false` with nothing in `assets` is not a documented state. It
    // is here because the alternative to naming it is a crash on `asset.uri`.
    return { outcome: "failed", detail: "picker reported success with no asset" };
  }
  if (asset.type != null && asset.type !== "image") {
    // `mediaTypes` above already asks for images only, so this is the module
    // disagreeing with its own options — worth naming rather than feeding a
    // video to an image encoder. `null` means the platform could not tell, and
    // that is not a refusal: the re-encode below is the real test.
    return { outcome: "failed", detail: `picker returned a ${asset.type}, not an image` };
  }

  // The two SharedObjects the chain below allocates, hoisted so `finally` can
  // release them on every exit — including the throwing ones. See RELEASING
  // below for why "the GC will get there" is not good enough here.
  let context: ImageManipulatorContext | null = null;
  let rendered: ImageRef | null = null;
  try {
    // ===================================================================
    // THE LOAD-BEARING STEP: clamp, then re-encode to JPEG.
    // ===================================================================
    // Two things at once, and neither is optional:
    //
    //   · FORMAT. An iPhone hands over HEIC. The pet-photo bucket allowlists
    //     jpeg/png/webp (migration 0206) and the server re-sniffs the magic
    //     bytes at `confirm`, so an unconverted HEIC is an upload that is
    //     refused after it has been paid for. `acceptPickedImage` refuses it
    //     one step earlier with its own sentence — which is the safety net,
    //     not the plan.
    //   · EXIF. A phone photo carries the GPS position of where it was taken,
    //     which for a pet is usually the owner's home. `renderAsync` decodes to
    //     a bitmap and `saveAsync` writes a fresh file from it; tags do not
    //     survive that. The server re-encodes again before anything reaches the
    //     public bucket, but the STAGED object in the private bucket is written
    //     from these bytes, so the leak has to close here too.
    //
    // And a third, which the first draft of this file refused to do and was
    // wrong to refuse:
    //
    //   · SIZE. The clamp. See `PET_PHOTO_MAX_EDGE` for the whole argument —
    //     without it, every photo from a 48 MP phone is refused by the screen's
    //     own 5 MiB cap, with a sentence telling the person to pick a lighter
    //     one on a phone where no lighter one exists.
    //
    // Rotation and cropping are still NOT done here, and that distinction is
    // the real one: those change what the picture IS, which belongs to the
    // screen. A longest-edge clamp changes only how many pixels carry it.
    //
    // `ImageManipulator.manipulate(...)` and not `manipulateAsync(...)`: the
    // latter is deprecated in expo-image-manipulator 57 in favour of this
    // contextual API. The handback doc flagged this as the most likely
    // correction to its draft, and it was.
    context = ImageManipulator.manipulate(asset.uri);
    const clamp = longestEdgeClamp(asset.width, asset.height);
    if (clamp !== null) context.resize(clamp);
    rendered = await context.renderAsync();
    const jpeg = await rendered.saveAsync({
      compress: PET_PHOTO_JPEG_COMPRESS,
      format: SaveFormat.JPEG,
    });

    const bytes = await readAsBytes(jpeg.uri);
    return {
      outcome: "picked",
      bytes,
      // NOT `asset.mimeType`. What arrived is irrelevant — these bytes were
      // written by the call above, and this is what that call was told to
      // produce. The screen re-checks it anyway.
      contentType: "image/jpeg",
      // The RE-ENCODED file, not `asset.uri`. The preview must show what is
      // actually going to be uploaded, and on iOS the original may be a HEIC
      // the `<Image>` renders differently — or not at all.
      previewUri: jpeg.uri,
    };
  } catch (error) {
    // A file the decoder cannot read, a cache directory it cannot write, a
    // `file://` the fetch below cannot open. The person can pick another photo,
    // which is what the screen's sentence tells them to do.
    return { outcome: "failed", detail: `encode: ${failureDetail(error)}` };
  } finally {
    // ===================================================================
    // RELEASING, which is not a tidiness habit on this particular path.
    // ===================================================================
    // Both of these are SharedObjects holding NATIVE memory that the JS heap
    // barely accounts for. `ImageRef.getAdditionalMemoryPressure()` reports the
    // bitmap's `allocationByteCount`, and a 50 MP frame decoded to ARGB_8888 is
    // roughly 200 MB of it. The collector does get there eventually — but
    // "eventually", on a mid-range Android phone, after somebody has re-picked
    // two or three times because they did not like the first photo, is where
    // the OOM killer lives. The library's own reference implementation ends
    // with exactly these two calls.
    //
    // In `finally` and not after the `return`, so the throwing paths release
    // too: an image the encoder choked on is the largest one in the process.
    rendered?.release();
    context?.release();
  }
}

/**
 * The resize this photo needs, or `null` when it already fits.
 *
 * A LONGEST-EDGE CLAMP: whichever side is longer is pinned to
 * `PET_PHOTO_MAX_EDGE` and the other is left for the manipulator to derive,
 * which is what preserves the aspect ratio (`resize` computes the omitted side
 * from the ratio). Passing both would be a stretch, and passing `width`
 * unconditionally would clamp the SHORT edge of a portrait photo — the shape
 * every phone camera produces held upright — leaving the long edge above the
 * budget the clamp exists to enforce.
 *
 * `null` when it already fits, because `resize` UPSCALES as readily as it
 * downscales: an 800px photo forced to 2048 would be a bigger file carrying no
 * more picture.
 *
 * WHEN THE DIMENSIONS ARE UNKNOWN. `width`/`height` are documented as possibly
 * `0` ("if the system did not provide" them). There is no right answer with no
 * information, so this picks the survivable wrong one: clamp anyway, on the
 * width. Guessing wrong that way upscales a small photo, which wastes some
 * bytes; guessing the other way lets a fifty-megapixel frame through to the cap
 * that refuses it with advice nobody can act on.
 */
export function longestEdgeClamp(
  width: number,
  height: number,
): { width: number } | { height: number } | null {
  if (width <= 0 || height <= 0) return { width: PET_PHOTO_MAX_EDGE };
  if (Math.max(width, height) <= PET_PHOTO_MAX_EDGE) return null;
  return height > width ? { height: PET_PHOTO_MAX_EDGE } : { width: PET_PHOTO_MAX_EDGE };
}

/**
 * The bytes behind a device-local URI, as a `Uint8Array`.
 *
 * React Native's `fetch` reads `file://` and `content://` through the platform
 * networking layer. `.arrayBuffer()` is backed by the same read as `.blob()` in
 * RN (FileReader routes it through the native module), so this costs no more
 * than reading a blob would.
 *
 * A Uint8Array AND NOT A BLOB, AND THAT IS THE FIX FOR THE UPLOAD BUG, NOT A
 * STYLE CALL. Measured on a real Android device on 2026-09-12: a signed PUT
 * with a `Blob` body reaches Supabase Storage as `content-type:
 * application/octet-stream` no matter what header the caller sets, and the
 * bucket refuses it (`InvalidMimeType`). RN's own JSON calls prove the header
 * survives for non-blob bodies, so the blob path is where it is lost. A
 * `Uint8Array` routes through the base64 request-body branch, which uses the
 * content-type header (and errors loudly rather than defaulting to
 * octet-stream if it is ever missing). See `uploadPetPhotoBytes`.
 */
async function readAsBytes(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A diagnostic line for `failed.detail` — never a sentence for a person.
 *
 * Expo's `CodedError` carries the part worth keeping (`ERR_MISSING_ACTIVITY`,
 * and so on); its `message` alone is often the generic half.
 */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return `${code}: ${message}`;
  }
  return message;
}
