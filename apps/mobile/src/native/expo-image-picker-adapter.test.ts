// THE ADAPTER'S MAPPING, branch by branch, against a mocked native module.
//
// WHAT THIS FILE CAN AND CANNOT PROVE, stated first so nobody reads a green run
// as more than it is. It proves the TRANSLATION: for every shape
// `expo-image-picker` and `expo-image-manipulator` can produce, which member of
// `ImagePickResult` comes out, and what is inside it. It proves nothing about
// the OS picker, the permission dialogs, the codecs, or whether `fetch` can
// read a `file://` URI on a real phone — those live behind the native modules
// this file replaces, and the only instrument for them is a dev build on a
// device (see docs/mobile/camera-modules-handback.md, "What to verify after").
//
// WHY THE MODULES ARE MOCKED AT ALL and not merely stubbed at a seam: importing
// `expo-image-manipulator` evaluates `requireNativeModule(...)`, which throws in
// a jest process. The adapter's own header explains why that import stays at
// module scope; the price is that its test has to hoist a `jest.mock` for it,
// which is exactly what this does.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · `contentType: "image/jpeg"` → `asset.mimeType` — the HEIC test.
//   · `previewUri: jpeg.uri` → `asset.uri` — "the preview is the re-encode".
//   · dropping the `launched.canceled` early return — the cancel test.
//   · `format: SaveFormat.JPEG` → `SaveFormat.PNG` — the save-options test.
//   · `exif: false` → `true` in IMAGE_LIBRARY_OPTIONS — the options test.
//
// T4-M1 (2026-09-22) ADDS ITS OWN MUTATIONS FOR THE RECOVERY PATH (applied
// while writing, then reverted):
//   · dropping `pendingResultClaimed = true` — the claim-once test.
//   · `isPickerErrorResult` returning `false` unconditionally — the pending
//     error-result test would silently try to re-encode an object with no
//     `assets` and fail with the wrong message.
//   · `warmPendingImagePickRecovery` calling `getPendingResultAsync` again
//     instead of reusing `pendingResultRead` — the memoisation test.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

// The `mock` prefix is required: jest's factories may not close over an
// unprefixed outer binding, and both of these have to be reachable from inside
// the factories AND from the tests that program them.
const mockLaunchImageLibraryAsync = jest.fn();
const mockGetPendingResultAsync = jest.fn();
const mockSaveAsync = jest.fn();
const mockRenderAsync = jest.fn();
const mockManipulate = jest.fn();
const mockResize = jest.fn();
const mockContextRelease = jest.fn();
const mockRefRelease = jest.fn();

// THE FACTORIES DELEGATE RATHER THAN HANDING THE MOCK OVER, and it is not
// style. `jest.mock` is hoisted above every `const` in this file, and the
// factory runs at the first `require` of the module — which is also hoisted.
// Passing `mockLaunchImageLibraryAsync` directly therefore captures the binding
// while it is still in its temporal dead zone, and the adapter sees `undefined`
// ("launchImageLibraryAsync is not a function", measured). A wrapper defers the
// lookup to call time, by which point the assignment has run.
jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibraryAsync(...args),
  getPendingResultAsync: (...args: unknown[]) => mockGetPendingResultAsync(...args),
}));

jest.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: (...args: unknown[]) => mockManipulate(...args) },
  // The real enum's values, transcribed. The adapter passes `SaveFormat.JPEG`
  // and the assertions below pin the STRING it resolves to, so a rename in the
  // library shows up as a failure here rather than as a bucket refusing an
  // upload three layers away.
  SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
}));

import {
  IMAGE_LIBRARY_OPTIONS,
  PET_PHOTO_JPEG_COMPRESS,
  PET_PHOTO_MAX_EDGE,
  expoImagePicker,
  longestEdgeClamp,
  resetPendingImagePickRecoveryForTests,
  warmPendingImagePickRecovery,
} from "./expo-image-picker-adapter";

/** The bytes the re-encode is pretending to have produced. A Uint8Array, not a
 *  Blob: the adapter reads `.arrayBuffer()` because a Blob body loses its
 *  content-type on Android — see `readAsBytes`. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const MANIPULATED_URI = "file:///cache/ImageManipulator/re-encoded.jpg";

/** One asset, as `expo-image-picker` shapes it. `overrides` bends one field. */
function asset(overrides: Record<string, unknown> = {}) {
  return {
    uri: "file:///media/DCIM/original.heic",
    width: 3024,
    height: 4032,
    type: "image",
    fileName: "IMG_0042.HEIC",
    mimeType: "image/heic",
    ...overrides,
  };
}

/** A `fetch` that answers exactly one URI with `JPEG_BYTES`. */
function fetchServing(uri: string) {
  return jest.fn(async (requested: unknown) => {
    if (requested !== uri) throw new Error(`unexpected fetch of ${String(requested)}`);
    // `.arrayBuffer()`, not `.blob()` — the adapter reads bytes now. The buffer
    // is sliced to the view's own bounds so the Uint8Array the adapter builds
    // equals JPEG_BYTES exactly.
    return {
      arrayBuffer: async () =>
        JPEG_BYTES.buffer.slice(
          JPEG_BYTES.byteOffset,
          JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength,
        ),
    };
  });
}

beforeEach(() => {
  mockLaunchImageLibraryAsync.mockReset();
  mockGetPendingResultAsync.mockReset().mockResolvedValue(null as never);
  resetPendingImagePickRecoveryForTests();
  mockManipulate.mockReset();
  mockRenderAsync.mockReset();
  mockSaveAsync.mockReset();
  mockResize.mockReset();
  mockContextRelease.mockReset();
  mockRefRelease.mockReset();

  // The happy chain: manipulate(uri) → context, [.resize(size)] →  the same
  // context, .renderAsync() → ref, .saveAsync(opts) → { uri }. Each test that
  // needs a failure re-programs one link; every other link stays honest so the
  // failure under test is the only one in the run.
  const context = {
    resize: mockResize,
    renderAsync: mockRenderAsync,
    release: mockContextRelease,
  };
  // `resize` is chainable in the real library and returns the context.
  mockResize.mockReturnValue(context);
  mockManipulate.mockReturnValue(context);
  mockRenderAsync.mockResolvedValue({
    saveAsync: mockSaveAsync,
    release: mockRefRelease,
  } as never);
  mockSaveAsync.mockResolvedValue({ uri: MANIPULATED_URI, width: 2048, height: 1536 } as never);

  (globalThis as { fetch: unknown }).fetch = fetchServing(MANIPULATED_URI);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the port's own declaration", () => {
  it("names the module it is bound to and says a pick can succeed", () => {
    // Pinned against literals, not against the object that produced them: the
    // screens read `available` to decide whether to DRAW a control at all, and
    // `name` is what a breadcrumb carries.
    expect(expoImagePicker.name).toBe("expo-image-picker");
    expect(expoImagePicker.available).toBe(true);
  });
});

describe("what the picker is asked for", () => {
  it("asks for one image, no crop, no EXIF, no pre-compression, no legacy picker", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as never);

    await expoImagePicker.pickImage();

    expect(mockLaunchImageLibraryAsync).toHaveBeenCalledWith(IMAGE_LIBRARY_OPTIONS);
    // And the options themselves, against literals. `legacy: false` is the one
    // that silently changes which Android component opens — and therefore
    // whether a storage permission comes back into this flow.
    expect(IMAGE_LIBRARY_OPTIONS.mediaTypes).toEqual(["images"]);
    expect(IMAGE_LIBRARY_OPTIONS.allowsMultipleSelection).toBe(false);
    expect(IMAGE_LIBRARY_OPTIONS.allowsEditing).toBe(false);
    expect(IMAGE_LIBRARY_OPTIONS.exif).toBe(false);
    expect(IMAGE_LIBRARY_OPTIONS.quality).toBe(1);
    expect(IMAGE_LIBRARY_OPTIONS.legacy).toBe(false);
  });
});

describe("a photo comes back", () => {
  it("re-encodes it to JPEG and hands over those bytes, that type, that preview", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({
      outcome: "picked",
      bytes: JPEG_BYTES,
      // THE HEIC THAT WENT IN IS NOT WHAT COMES OUT. The asset above declares
      // `image/heic`, which `acceptPickedImage` refuses by name; what the
      // adapter promises is what the re-encode produced.
      contentType: "image/jpeg",
      // The preview is the RE-ENCODED file, not the original: the person has to
      // be looking at the bytes that will actually travel.
      previewUri: MANIPULATED_URI,
    });
  });

  it("re-encodes the ORIGINAL uri, with the JPEG save options", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ uri: "file:///media/DCIM/particular.heic" })],
    } as never);

    await expoImagePicker.pickImage();

    expect(mockManipulate).toHaveBeenCalledWith("file:///media/DCIM/particular.heic");
    expect(mockRenderAsync).toHaveBeenCalledTimes(1);
    expect(mockSaveAsync).toHaveBeenCalledWith({ compress: 0.85, format: "jpeg" });
    expect(PET_PHOTO_JPEG_COMPRESS).toBe(0.85);
  });

  it("reads the bytes from the re-encoded file and not from the original", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);

    await expoImagePicker.pickImage();

    expect(globalThis.fetch).toHaveBeenCalledWith(MANIPULATED_URI);
  });

  it("accepts an asset whose type the platform could not determine", async () => {
    // `type: null` is documented as "rare, but some Android ContentProviders".
    // It is not a refusal — the re-encode is the real test of whether the file
    // is an image, and it runs either way.
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ type: null })],
    } as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toMatchObject({ outcome: "picked", contentType: "image/jpeg" });
  });
});

// ===========================================================================
// THE CLAMP. The failure it prevents is not an error state — it is a person
// being told "elegí una más liviana" about a phone on which no lighter photo
// exists, which is a worse dead end than the web callout this adapter replaced.
// ===========================================================================
describe("the longest-edge clamp", () => {
  it("pins the LONG edge of a portrait photo, leaving the short one derived", () => {
    // 3024×4032 is an ordinary phone frame held upright. Clamping `width` here
    // — the obvious one-liner — would pin the SHORT edge and leave the long one
    // at 2730, above the budget the clamp exists to enforce.
    expect(longestEdgeClamp(3024, 4032)).toEqual({ height: 2048 });
  });

  it("pins the LONG edge of a landscape photo", () => {
    expect(longestEdgeClamp(8000, 6000)).toEqual({ width: 2048 });
  });

  it("pins width on an exact square, and either answer is the same clamp", () => {
    expect(longestEdgeClamp(4000, 4000)).toEqual({ width: 2048 });
  });

  it("asks for NO resize when the photo already fits — resize upscales too", () => {
    // An 800px photo forced to 2048 is a bigger file carrying no more picture.
    expect(longestEdgeClamp(800, 600)).toBeNull();
    // And the boundary itself is inside the budget, not over it.
    expect(longestEdgeClamp(2048, 1536)).toBeNull();
  });

  it("clamps anyway when the platform gave no dimensions", () => {
    // Documented as possible ("can be 0 if the system did not provide"). With
    // no information this picks the survivable wrong answer: upscaling a small
    // photo wastes bytes, while letting a 50 MP frame through hits the cap.
    expect(longestEdgeClamp(0, 0)).toEqual({ width: 2048 });
    expect(longestEdgeClamp(0, 4032)).toEqual({ width: 2048 });
  });

  it("is pinned to 2048", () => {
    expect(PET_PHOTO_MAX_EDGE).toBe(2048);
  });
});

describe("the clamp is actually in the render chain", () => {
  it("resizes a 50 MP frame before rendering it", async () => {
    // 8160×6120 is a 50 MP sensor — ordinary on a mid-range Android phone, and
    // the exact case whose full-resolution re-encode lands past the 5 MiB cap.
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ width: 8160, height: 6120 })],
    } as never);

    await expoImagePicker.pickImage();

    expect(mockResize).toHaveBeenCalledWith({ width: 2048 });
    // Order matters: a resize scheduled after the render would not be in it.
    expect(mockResize.mock.invocationCallOrder[0]).toBeLessThan(
      mockRenderAsync.mock.invocationCallOrder[0] as number,
    );
  });

  it("does not resize a photo that already fits", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ width: 1200, height: 900 })],
    } as never);

    await expoImagePicker.pickImage();

    expect(mockResize).not.toHaveBeenCalled();
    // But it is still re-encoded — the clamp is a byte budget, not the reason
    // the manipulator is in this path. EXIF and HEIC are.
    expect(mockRenderAsync).toHaveBeenCalledTimes(1);
    expect(mockSaveAsync).toHaveBeenCalledWith({ compress: 0.85, format: "jpeg" });
  });
});

describe("the native bitmaps are released", () => {
  it("releases both shared objects after a successful pick", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);

    await expoImagePicker.pickImage();

    expect(mockRefRelease).toHaveBeenCalledTimes(1);
    expect(mockContextRelease).toHaveBeenCalledTimes(1);
  });

  it("releases them when the encode THREW — the largest bitmap in the process", async () => {
    // The arm that matters. A 50 MP frame decoded to ARGB_8888 is ~200 MB of
    // native memory the JS heap barely accounts for, and the photo the encoder
    // choked on is exactly the one nobody would think to free.
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);
    mockSaveAsync.mockRejectedValue(new Error("Failed to write a file") as never);

    await expoImagePicker.pickImage();

    expect(mockRefRelease).toHaveBeenCalledTimes(1);
    expect(mockContextRelease).toHaveBeenCalledTimes(1);
  });

  it("releases the context even when the render never produced a ref", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);
    mockRenderAsync.mockRejectedValue(new Error("Failed to load the image") as never);

    await expoImagePicker.pickImage();

    expect(mockContextRelease).toHaveBeenCalledTimes(1);
    // There is no ref to release, and reaching for one would be a TypeError in
    // the `finally` — which is the worst place to throw.
    expect(mockRefRelease).not.toHaveBeenCalled();
  });
});

describe("the person changed their mind", () => {
  it("is `cancelled`, and nothing is encoded", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({ outcome: "cancelled" });
    // Not merely "the outcome is right": a cancel that still ran the encoder
    // would burn a decode of a photo nobody chose.
    expect(mockManipulate).not.toHaveBeenCalled();
  });
});

describe("the picker refuses to open", () => {
  it("reports the module's error CODE in the detail, not just its message", async () => {
    // The shape Expo's `CodedError` has. The code is the half a breadcrumb
    // reader can act on; the message alone is usually the generic one.
    const coded = Object.assign(new Error("Failed to resolve activity"), {
      code: "ERR_MISSING_ACTIVITY",
    });
    mockLaunchImageLibraryAsync.mockRejectedValue(coded as never);

    const result = await expoImagePicker.pickImage();

    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({
      detail: "launch: ERR_MISSING_ACTIVITY: Failed to resolve activity",
    });
  });

  it("still reports a plain Error that carries no code", async () => {
    mockLaunchImageLibraryAsync.mockRejectedValue(new Error("picker exploded") as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({ outcome: "failed", detail: "launch: picker exploded" });
  });

  it("still reports something that was never an Error at all", async () => {
    mockLaunchImageLibraryAsync.mockRejectedValue("just a string" as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({ outcome: "failed", detail: "launch: just a string" });
  });

  it("names a permission refusal as a failure, and says which one in the detail", async () => {
    // ON THE LIBRARY PATH THIS IS NOT REACHABLE IN SDK 57 — the adapter's
    // header records why (the system picker runs out of process and holds no
    // permission of ours). The branch is tested anyway because the OS is
    // allowed to change its mind, and because the mapping has to be a decision
    // somebody made rather than a crash.
    //
    // IT IS ALSO THE INTERFACE MISMATCH, pinned so it cannot be forgotten:
    // `failed` is the ONLY member this can become, and the sentence the screen
    // gives `failed` tells the person to retry — which is wrong advice for a
    // permission denied permanently. If a camera path is ever added, the union
    // in `image-picker-port.ts` needs its own member first.
    const denied = Object.assign(new Error("User rejected permissions"), {
      code: "ERR_USER_REJECTED_PERMISSIONS",
    });
    mockLaunchImageLibraryAsync.mockRejectedValue(denied as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({
      outcome: "failed",
      detail: "launch: ERR_USER_REJECTED_PERMISSIONS: User rejected permissions",
    });
  });
});

describe("the picker answers with something unusable", () => {
  it("refuses a success that carries no asset instead of crashing on it", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [] } as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({
      outcome: "failed",
      detail: "picker reported success with no asset",
    });
    expect(mockManipulate).not.toHaveBeenCalled();
  });

  it("refuses a success whose `assets` is NULL instead of throwing at the screen", async () => {
    // THE REGRESSION THIS FILE EXISTS TO HOLD DOWN. `assets` is typed
    // `ImagePickerAsset[] | null`; null is the cancelled shape, but nothing in
    // the module's types stops a `canceled: false` result from carrying it, and
    // `null[0]` is a TypeError — thrown OUTSIDE the encode try, so it escaped
    // `pickImage()` as a rejected promise. Both screens bare-await after
    // setting a "picking" phase, so that stranded them on a spinner with no
    // sentence, no retry and only hardware back as an exit.
    mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: null } as never);

    // `resolves` and not a try/catch: the point of the assertion is that it
    // does not reject.
    await expect(expoImagePicker.pickImage()).resolves.toEqual({
      outcome: "failed",
      detail: "picker reported success with no asset",
    });
  });

  it("refuses a video, and names what it got", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset({ type: "video", mimeType: "video/mp4" })],
    } as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({
      outcome: "failed",
      detail: "picker returned a video, not an image",
    });
    expect(mockManipulate).not.toHaveBeenCalled();
  });
});

describe("the re-encode itself fails", () => {
  it("reports a file the decoder cannot read", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);
    mockRenderAsync.mockRejectedValue(
      Object.assign(new Error("Failed to load the image"), {
        code: "ERR_IMAGE_MANIPULATOR",
      }) as never,
    );

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({
      outcome: "failed",
      detail: "encode: ERR_IMAGE_MANIPULATOR: Failed to load the image",
    });
  });

  it("reports a cache directory it cannot write to", async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);
    mockSaveAsync.mockRejectedValue(new Error("Failed to write a file") as never);

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({ outcome: "failed", detail: "encode: Failed to write a file" });
  });

  it("reports a re-encoded file whose bytes cannot be read back", async () => {
    // The step the handback doc could not verify without a device: `fetch` of a
    // `file://` URI. If it ever stops working, this is the arm it lands in, and
    // the person gets a sentence rather than an unhandled rejection.
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error("Network request failed");
    });

    const result = await expoImagePicker.pickImage();

    expect(result).toEqual({ outcome: "failed", detail: "encode: Network request failed" });
  });
});

// ===========================================================================
// T4-M1 (2026-09-22): RECOVERING A PICK ANDROID ALREADY FINISHED. See the
// adapter's own header for the design decision this proves.
// ===========================================================================
describe("recovering a pick Android held onto", () => {
  it("answers null when the native module has nothing pending", async () => {
    mockGetPendingResultAsync.mockResolvedValue(null as never);

    await expect(expoImagePicker.recoverPendingPick()).resolves.toBeNull();
    expect(mockGetPendingResultAsync).toHaveBeenCalledTimes(1);
  });

  it("runs a recovered PICK through the same re-encode pipeline as a live one", async () => {
    mockGetPendingResultAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);

    const result = await expoImagePicker.recoverPendingPick();

    expect(result).toEqual({
      outcome: "picked",
      bytes: JPEG_BYTES,
      contentType: "image/jpeg",
      previewUri: MANIPULATED_URI,
    });
    // The clamp, the JPEG re-encode, the EXIF strip — all of it, not a
    // shortcut that hands back the original bytes.
    expect(mockManipulate).toHaveBeenCalledWith(asset().uri);
  });

  it("maps a recovered CANCEL the same as a live one", async () => {
    mockGetPendingResultAsync.mockResolvedValue({ canceled: true, assets: null } as never);

    await expect(expoImagePicker.recoverPendingPick()).resolves.toEqual({ outcome: "cancelled" });
  });

  it("maps the module's own ERROR RESULT to `failed`, prefixed so a breadcrumb tells it apart", async () => {
    // The shape `ImagePickerErrorResult` takes: no `canceled`, no `assets`.
    mockGetPendingResultAsync.mockResolvedValue({
      code: "ERR_IMAGE_MANIPULATOR",
      message: "Failed to load the image",
    } as never);

    const result = await expoImagePicker.recoverPendingPick();

    expect(result).toEqual({
      outcome: "failed",
      detail: "pending: ERR_IMAGE_MANIPULATOR: Failed to load the image",
    });
    // Not run through the re-encode pipeline — there is no asset to encode.
    expect(mockManipulate).not.toHaveBeenCalled();
  });

  it("CLAIM-ONCE: a second caller gets null even though the native answer was real", async () => {
    mockGetPendingResultAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);

    const first = await expoImagePicker.recoverPendingPick();
    const second = await expoImagePicker.recoverPendingPick();

    expect(first).toMatchObject({ outcome: "picked" });
    expect(second).toBeNull();
    // ONE native read, not two — the second caller reused the memoised
    // answer instead of asking the module again.
    expect(mockGetPendingResultAsync).toHaveBeenCalledTimes(1);
  });

  it("warms the read without claiming it, so a screen mounting after can still claim it", async () => {
    mockGetPendingResultAsync.mockResolvedValue({
      canceled: false,
      assets: [asset()],
    } as never);

    warmPendingImagePickRecovery();
    // The warm call started the read but took nothing — the module was asked
    // exactly once, and the answer is still there for the first real claim.
    expect(mockGetPendingResultAsync).toHaveBeenCalledTimes(1);

    const claimed = await expoImagePicker.recoverPendingPick();
    expect(claimed).toMatchObject({ outcome: "picked" });
    // The claim reused the warmed read — still exactly one native call.
    expect(mockGetPendingResultAsync).toHaveBeenCalledTimes(1);
  });
});
