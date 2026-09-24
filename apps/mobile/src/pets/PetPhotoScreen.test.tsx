// `PetPhotoScreen` — the render tests, driven through the REAL flow.
//
// Only the endpoints are mocked; `runPetPhotoUpload`, `acceptPickedImage` and
// the copy run for real, so these cases prove the screen's wiring end to end:
// a tap on "Usar esta foto" must reach `requestPetPhotoTicket` with this pet's
// token and come back through every phase on the way.
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. NO CONTROL IN A BUILD WITHOUT THE MODULE. The honest default port means
//      the callout names the web; a button whose only outcome is a shrug must
//      not render — the claim screen's scanner rule, applied here.
//   2. REVIEW BEFORE UPLOAD. A picked photo lands on a preview with the
//      decision, not in an upload.
//   3. A REFUSED PICK IS A SENTENCE, A CANCELLED ONE IS SILENCE.
//   4. EVERY FAILURE LANDS BACK ON REVIEW WITH THE PHOTO INTACT — the person
//      holds the photo, the retry is one tap, and re-picking would punish them
//      for a network error.
//   5. THE HAPPY WALK ENDS ON THE SERVER'S ANSWER, including whether an older
//      photo was replaced.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockTicket = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPut = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockConfirm = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockBack = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack }),
}));

jest.mock("../api/endpoints", () => ({
  requestPetPhotoTicket: (...args: unknown[]) => mockTicket(...args),
  uploadPetPhotoBytes: (...args: unknown[]) => mockPut(...args),
  confirmPetPhoto: (...args: unknown[]) => mockConfirm(...args),
}));

/**
 * `getSessionState` IS NOT DECORATION HERE (T3-R4, 2026-09-22): a recovered
 * pick is now bound to the signed-in person's id, so a screen whose session
 * answered "signed-out" would skip the recovery marker entirely — see
 * `currentSessionUserId` in `PetPhotoScreen.tsx` — and every recovery case
 * below would pass for a build where that binding had been deleted. Signed-in
 * is also what the real screen always sees: the route is behind `useGate`.
 */
const SIGNED_IN_USER_ID = "88888888-8888-4888-8888-888888888888";
jest.mock("../auth/session-store", () => ({
  sessionPort: {},
  getSessionState: () => ({ phase: "signed-in", user: { id: SIGNED_IN_USER_ID } }),
}));

import { IMAGE_PICK_MARKER_KEY } from "../native/image-pick-marker-store";
import {
  type ImagePickMarker,
  type ImagePickResult,
  resetImagePickerPort,
  setImagePickerPort,
} from "../native/image-picker-port";
import { PetPhotoScreen } from "./PetPhotoScreen";

const TOKEN = "DIM-PAMP-0001";
const STAGED = "22222222-2222-4222-8222-222222222222/333.jpg";

/**
 * Writes a recovery marker straight to the same AsyncStorage key
 * `image-pick-marker-store.ts` uses, so a test can simulate "a previous
 * process wrote this marker before it died" without going through a live
 * pick. `overrides` bends one field away from a marker that matches this
 * screen exactly, fresh.
 */
async function seedImagePickMarker(overrides: Partial<ImagePickMarker> = {}): Promise<void> {
  const marker: ImagePickMarker = {
    screen: "pet-photo",
    publicToken: TOKEN,
    sessionUserId: SIGNED_IN_USER_ID,
    launchedAt: Date.now(),
    ...overrides,
  };
  await AsyncStorage.setItem(IMAGE_PICK_MARKER_KEY, JSON.stringify(marker));
}

const ticket = {
  uploadUrl: "https://storage.test/sign/x?token=tok",
  token: "tok",
  stagedPath: STAGED,
  bucket: "uploads-staging",
  validForSeconds: 7200,
};

/** What the NEXT pick returns. Each test sets the camera roll it needs. */
let nextPick: ImagePickResult;

/**
 * What a bootstrap-time recovery read answers (T4-M1, 2026-09-22). `null` in
 * every case that is not specifically about recovery — most tests never touch
 * this, and the default says honestly that Android held onto nothing.
 */
let nextRecovery: ImagePickResult | null;

function installPicker() {
  setImagePickerPort({
    name: "fake",
    available: true,
    pickImage: async () => nextPick,
    recoverPendingPick: async () => nextRecovery,
  });
}

function aPick(over: Partial<Extract<ImagePickResult, { outcome: "picked" }>> = {}) {
  return {
    outcome: "picked" as const,
    bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
    contentType: "image/jpeg",
    previewUri: "file:///cache/a.jpg",
    ...over,
  };
}

beforeEach(() => {
  nextPick = { outcome: "cancelled" };
  nextRecovery = null;
  mockBack.mockReset();
  mockTicket.mockReset().mockResolvedValue({ outcome: "ok", payload: ticket });
  mockPut.mockReset().mockResolvedValue({ outcome: "ok" });
  mockConfirm.mockReset().mockResolvedValue({
    outcome: "ok",
    payload: { photoUrl: "https://s.test/p.jpg", replacedPrevious: false },
  });
});

afterEach(() => {
  resetImagePickerPort();
});

// THE TEST CEILING MUST OUTRANK THE `waitFor` CEILING, and until 2026-08-31 it
// did not: `pickInto` waited up to 5000 ms while Jest's own per-test default is
// also 5000 ms. Two consequences, and the second is why this kept coming back.
//
// One: the `waitFor` could never fail with its own message. Jest killed the test
// first, so the report always read "Exceeded timeout of 5000 ms for a test" —
// which names no label, no step and no cause — instead of "Abriendo tus fotos…
// is still on screen", which names all three.
//
// Two: there was NO margin left for the rest of the test. `pickInto` renders,
// presses and waits; everything after it — the asserts, and for the upload cases
// a second `waitFor` — had to fit inside whatever the first wait did not spend.
// A run where the pick took 4.2 s left 800 ms for the other half.
//
// Measured on this machine 2026-08-31: the two slowest cases in this file take
// **2244 ms and 2211 ms in isolation**, so an isolated run already spends 45% of
// a 5000 ms budget. Under `pnpm verify` — which is where this actually failed,
// with the build and the lint chain competing for the same cores — that margin
// is gone. The suite alone never reproduces it: `npx jest` in this package
// passed 66/66 on the same tree minutes after `verify` failed this one file.
//
// 15000 is derived, not borrowed: 3× the `waitFor` ceiling it has to contain.
// The previous value was borrowed — the docblock below said 5000 because
// `PetDocumentScreen.test.tsx` used 5000 — and a number chosen by imitation is
// how both ceilings ended up equal.
jest.setTimeout(15_000);

/**
 * Render, pick a photo, land wherever the pick leads. The common opening move.
 *
 * The explicit `timeout` is load-bearing: this waits on a NEGATIVE (the
 * transient "Abriendo tus fotos…" label vanishing), and under a fully parallel
 * suite the default 1s ceiling was measured flaking — 2 of 11 on one full run,
 * 1 on the next, always these, always green in isolation.
 *
 * It stays at 5000 and the TEST ceiling moved instead — see the block above.
 * Raising this one again would recreate the equality that hid the real message.
 */
async function pickInto(result: ImagePickResult) {
  nextPick = result;
  render(<PetPhotoScreen publicToken={TOKEN} />);
  fireEvent.press(screen.getByText("Elegir una foto"));
  await waitFor(() => expect(screen.queryByText("Abriendo tus fotos…")).toBeNull(), {
    timeout: 5000,
  });
}

describe("the build without the module", () => {
  it("draws the callout naming the web, and no control at all", () => {
    // The default port — no `installPicker()`. The rule the claim screen set
    // for its scanner: a missing module is a sentence, never a dead button.
    render(<PetPhotoScreen publicToken={TOKEN} />);
    expect(screen.getByText("Todavía no se puede subir una foto desde la app")).toBeTruthy();
    expect(screen.queryByText("Elegir una foto")).toBeNull();
  });
});

describe("the pick", () => {
  it("lands an accepted photo on the REVIEW step, not in an upload", async () => {
    installPicker();
    await pickInto(aPick());

    expect(screen.getByText("¿Usar esta foto?")).toBeTruthy();
    expect(screen.getByLabelText("Vista previa de la mascota")).toBeTruthy();
    // NOTHING has been uploaded: the decision is the person's, and the bytes
    // have not cost them a byte of their plan yet.
    expect(mockTicket).not.toHaveBeenCalled();
  });

  it("says nothing about a cancelled pick", async () => {
    installPicker();
    await pickInto({ outcome: "cancelled" });

    expect(screen.getByText("Elegir una foto")).toBeTruthy();
    expect(screen.queryByText(/no pudimos/i)).toBeNull();
  });

  it("refuses an iPhone HEIC with the sentence naming the export fix", async () => {
    installPicker();
    await pickInto(aPick({ contentType: "image/heic" }));

    expect(screen.getByText(/HEIC/)).toBeTruthy();
    expect(screen.queryByText("¿Usar esta foto?")).toBeNull();
  });

  it("shows an honest box when the adapter offers no preview URI", async () => {
    installPicker();
    await pickInto(aPick({ previewUri: null }));

    expect(screen.getByText("Sin vista previa")).toBeTruthy();
    expect(screen.getByText("Usar esta foto")).toBeTruthy();
  });

  it("gets OFF the spinner when the port throws instead of answering", async () => {
    // THE HANG, held down at the screen. `pick()` sets `phase: "picking"` and
    // bare-awaits; before `pickImageSafely` an adapter that threw left this
    // screen on "Abriendo tus fotos…" forever — no sentence, no retry, and
    // hardware back the only exit. The assertions are PRESENCE, in this order:
    // a sentence is shown, and the control is offered again.
    setImagePickerPort({
      name: "throwing-adapter",
      available: true,
      pickImage: async () => {
        throw new TypeError("null is not an object (evaluating 'assets[0]')");
      },
      recoverPendingPick: async () => null,
    });
    render(<PetPhotoScreen publicToken={TOKEN} />);
    fireEvent.press(screen.getByText("Elegir una foto"));

    await waitFor(() => {
      expect(screen.getByText("No pudimos abrir tus fotos. Volvé a intentar.")).toBeTruthy();
    });
    // Back on the entry control, not stuck on the picking label.
    expect(screen.getByText("Elegir una foto")).toBeTruthy();
    expect(screen.queryByText("Abriendo tus fotos…")).toBeNull();
  });
});

describe("T4-M1 (2026-09-22): a pick Android held onto since before this screen mounted", () => {
  it("lands it on REVIEW with no tap at all", async () => {
    installPicker();
    // T3-R4 (2026-09-22): the recovered result is now discarded unless a
    // matching marker is on disk — a live process wrote it before this exact
    // launch. Every case in this block seeds one, except the ones that are
    // themselves ABOUT a marker that fails to match.
    await seedImagePickMarker();
    nextRecovery = aPick();
    render(<PetPhotoScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("¿Usar esta foto?")).toBeTruthy());
    expect(screen.getByLabelText("Vista previa de la mascota")).toBeTruthy();
    expect(mockTicket).not.toHaveBeenCalled();
  });

  it("shows the same sentence a live failure would, for a recovered failure", async () => {
    installPicker();
    await seedImagePickMarker();
    nextRecovery = { outcome: "failed", detail: "pending: ERR_IMAGE_MANIPULATOR: boom" };
    render(<PetPhotoScreen publicToken={TOKEN} />);

    await waitFor(() =>
      expect(screen.getByText("No pudimos abrir tus fotos. Volvé a intentar.")).toBeTruthy(),
    );
    // Back on the entry control — the recovery never touches "picking".
    expect(screen.getByText("Elegir una foto")).toBeTruthy();
  });

  it("says nothing for a recovered CANCEL — cancelling was already silent live", async () => {
    installPicker();
    await seedImagePickMarker();
    nextRecovery = { outcome: "cancelled" };
    render(<PetPhotoScreen publicToken={TOKEN} />);

    await waitFor(() => expect(mockTicket).not.toHaveBeenCalled());
    expect(screen.getByText("Elegir una foto")).toBeTruthy();
    expect(screen.queryByText(/no pudimos/i)).toBeNull();
  });

  describe("T3-R4 (2026-09-22): the marker binds a recovered pick to who and what asked for it", () => {
    it("discards a pick recovered for a DIFFERENT pet", async () => {
      installPicker();
      await seedImagePickMarker({ publicToken: "DIM-OTRO-0002" });
      nextRecovery = aPick();
      render(<PetPhotoScreen publicToken={TOKEN} />);

      // No `waitFor` for a negative: the effect's promise chain settles on
      // its own microtask queue, and this gives it the same room the other
      // recovery cases do before asserting nothing happened.
      await waitFor(() => expect(screen.getByText("Elegir una foto")).toBeTruthy());
      expect(screen.queryByText("¿Usar esta foto?")).toBeNull();
      expect(mockTicket).not.toHaveBeenCalled();
    });

    it("discards a pick recovered for a DIFFERENT signed-in person", async () => {
      installPicker();
      await seedImagePickMarker({ sessionUserId: "00000000-0000-4000-8000-000000000000" });
      nextRecovery = aPick();
      render(<PetPhotoScreen publicToken={TOKEN} />);

      await waitFor(() => expect(screen.getByText("Elegir una foto")).toBeTruthy());
      expect(screen.queryByText("¿Usar esta foto?")).toBeNull();
    });

    it("discards a pick recovered for a DIFFERENT screen (the tattoo form)", async () => {
      installPicker();
      await seedImagePickMarker({ screen: "tattoo" });
      nextRecovery = aPick();
      render(<PetPhotoScreen publicToken={TOKEN} />);

      await waitFor(() => expect(screen.getByText("Elegir una foto")).toBeTruthy());
      expect(screen.queryByText("¿Usar esta foto?")).toBeNull();
    });

    it("discards a STALE marker — older than the 30-minute binding window", async () => {
      installPicker();
      await seedImagePickMarker({ launchedAt: Date.now() - 31 * 60 * 1000 });
      nextRecovery = aPick();
      render(<PetPhotoScreen publicToken={TOKEN} />);

      await waitFor(() => expect(screen.getByText("Elegir una foto")).toBeTruthy());
      expect(screen.queryByText("¿Usar esta foto?")).toBeNull();
    });
  });

  it("does NOT clobber a pick the person is actively making right now", async () => {
    // The recovery is held OPEN with a deferred promise and only resolved
    // AFTER the live pick has already landed on review — a stronger proof
    // than a same-tick race, which the guard would win either way. Without
    // the `current.phase !== "choosing"` guard, resolving a stale recovery
    // AFTER review is already showing would silently swap the photo under
    // the person while they are looking at it.
    await seedImagePickMarker();
    let resolveRecovery!: (result: ImagePickResult | null) => void;
    const heldRecovery = new Promise<ImagePickResult | null>((resolve) => {
      resolveRecovery = resolve;
    });
    setImagePickerPort({
      name: "test-race",
      available: true,
      pickImage: async () => aPick({ previewUri: "file:///cache/fresh.jpg" }),
      recoverPendingPick: () => heldRecovery,
    });
    render(<PetPhotoScreen publicToken={TOKEN} />);
    fireEvent.press(screen.getByText("Elegir una foto"));

    await waitFor(() =>
      expect(screen.getByLabelText("Vista previa de la mascota").props.source).toEqual({
        uri: "file:///cache/fresh.jpg",
      }),
    );

    // ONLY NOW does Android's stale answer arrive — the screen is already
    // showing the fresh photo's review step.
    await act(async () => {
      resolveRecovery(aPick({ previewUri: "file:///cache/stale-recovered.jpg" }));
      // Let the recovery effect's continuation run to completion.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Vista previa de la mascota").props.source).toEqual({
      uri: "file:///cache/fresh.jpg",
    });
  });
});

describe("the upload", () => {
  it("walks ticket → PUT → confirm for THIS pet and ends on the server's answer", async () => {
    installPicker();
    await pickInto(aPick());
    fireEvent.press(screen.getByText("Usar esta foto"));

    await waitFor(() => expect(screen.getByText("Foto actualizada")).toBeTruthy());
    expect(mockTicket).toHaveBeenCalledWith({}, TOKEN, "image/jpeg");
    expect(mockPut).toHaveBeenCalledWith(ticket, expect.any(Uint8Array), "image/jpeg");
    expect(mockConfirm).toHaveBeenCalledWith({}, TOKEN, STAGED);
  });

  it("says when the new photo REPLACED one, and when it did not", async () => {
    installPicker();
    mockConfirm.mockResolvedValue({
      outcome: "ok",
      payload: { photoUrl: "https://s.test/p.jpg", replacedPrevious: true },
    });
    await pickInto(aPick());
    fireEvent.press(screen.getByText("Usar esta foto"));

    await waitFor(() => expect(screen.getByText(/Reemplaza a la que estaba/)).toBeTruthy());
  });

  it("lands an EXPIRED ticket back on review, photo intact, promising a fresh permission", async () => {
    installPicker();
    mockPut.mockResolvedValue({ outcome: "expired" });
    await pickInto(aPick());
    fireEvent.press(screen.getByText("Usar esta foto"));

    await waitFor(() => expect(screen.getByText(/permiso venció/)).toBeTruthy());
    // The photo is still there and the retry is one tap — re-picking would
    // punish the person for the network's failure.
    expect(screen.getByText("Usar esta foto")).toBeTruthy();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("lands a dead PUT back on review naming the connection", async () => {
    installPicker();
    mockPut.mockResolvedValue({ outcome: "failed", detail: "HTTP 503" });
    await pickInto(aPick());
    fireEvent.press(screen.getByText("Usar esta foto"));

    await waitFor(() => expect(screen.getByText(/Revisá tu conexión/)).toBeTruthy());
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("shows the server's own sentence when confirm refuses the file", async () => {
    installPicker();
    mockConfirm.mockResolvedValue({
      outcome: "api-error",
      code: "photo_not_an_image",
      retryAfterSeconds: null,
    });
    await pickInto(aPick());
    fireEvent.press(screen.getByText("Usar esta foto"));

    // `photo_not_an_image`'s copy: the FILE is the problem, retrying the same
    // one cannot work — so the person is back where "Elegir otra" is.
    await waitFor(() => expect(screen.getByText(/no es una foto que podamos usar/)).toBeTruthy());
    expect(screen.getByText("Elegir otra")).toBeTruthy();
  });

  it("a second pick from review replaces the photo under consideration", async () => {
    installPicker();
    await pickInto(aPick());

    nextPick = aPick({ previewUri: "file:///cache/b.jpg", contentType: "image/png" });
    fireEvent.press(screen.getByText("Elegir otra"));

    await waitFor(() =>
      expect(screen.getByLabelText("Vista previa de la mascota").props.source).toEqual({
        uri: "file:///cache/b.jpg",
      }),
    );
  });
});
