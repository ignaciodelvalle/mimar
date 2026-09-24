// `AltaScreen` — F-4 (the province name on the summary) and Re-2, decision 16A
// (the wizard's draft survives a process death).
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. THE CONFIRM STEP SHOWS A PROVINCE NAME, not the raw ISO code the wire
//      carries — the exact defect the review found on the review screen.
//   2. A DRAFT WRITTEN TO DISK COMES BACK, fields and step both, when the
//      wizard is mounted again — the process-death scenario the review names.
//   3. THE SERVER ACCEPTING THE REGISTRATION IS THE ONLY ORDINARY REASON the
//      draft is deleted.
//   4. A DRAFT NEVER SURVIVES INTO ANOTHER ACCOUNT: the owner id is part of
//      the storage key, so a different signed-in person's mount finds nothing.
//
// MOST OF THESE seed the draft directly on disk via `writeAltaDraft` rather
// than driving `LocalityPicker`'s live search — that component's own cascade
// (province → debounced search → pick) is `LocalityPicker.test.tsx`'s job, and
// re-driving it here would test the picker a second time instead of the
// screen's OWN behaviour: what it does with a draft that already has a
// province in it. ONE case below goes through the REAL write path instead
// (type → background the app → remount) — seeding alone would leave a suite
// that stays green even if `persistNow` were deleted.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, AppState, type AppStateStatus } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

const mockRegisterPet = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("../api/endpoints", () => ({
  registerPet: (...args: unknown[]) => mockRegisterPet(...args),
  // `LocalityPicker` imports this from the same module; unused by these cases
  // but a module mock replaces the whole module, and an omitted export would
  // be `undefined` at the picker's own call site.
  searchLocalities: jest.fn(),
}));

// M4, decision 10A: `requestPushPermissionAndRegister` is the ONE call allowed
// to show the OS dialog, and it is mocked wholesale here for the same reason
// `push-session-binding.test.ts` mocks `./push-registration` — what this file
// proves is WHICH BUTTON calls it and WHEN, not the registration plumbing
// behind it, which has its own coverage in `push-registration.test.ts`.
const mockRequestPushPermissionAndRegister = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("../notifications/push-registration", () => ({
  requestPushPermissionAndRegister: (...args: unknown[]) =>
    mockRequestPushPermissionAndRegister(...args),
}));

const SIGNED_IN_A = "11111111-1111-4111-8111-111111111111";
const SIGNED_IN_B = "22222222-2222-4222-8222-222222222222";
const mockSession: { userId: string | undefined } = { userId: SIGNED_IN_A };
jest.mock("../auth/session-store", () => ({
  sessionPort: {},
  getSessionState: () =>
    mockSession.userId === undefined
      ? { phase: "signed-out", reason: "user_action" }
      : { phase: "signed-in", user: { id: mockSession.userId } },
  draftSweepEpoch: () => 0,
}));

import type { PushPort } from "../native/push-port";
import { resetPushPort, setPushPort } from "../native/push-port";
import { readPushPrimingDismissed } from "../notifications/push-priming-preference";
import { AltaScreen } from "./AltaScreen";
import { altaDraftKey, writeAltaDraft } from "./alta-draft-store";
import { EMPTY_DRAFT, type PetDraft } from "./register-input";

/** A push port whose only relevant member for these cases is the peek. */
function portWithPeek(outcome: PushPort["getPermissionStatus"]): PushPort {
  return {
    name: "fake",
    available: true,
    requestPermission: async () => ({ outcome: "granted" }),
    getPermissionStatus: outcome,
    getExpoPushToken: async () => ({ outcome: "unavailable" }),
    lastTap: async () => null,
    onTap: () => () => undefined,
    ensureNotificationChannel: async () => undefined,
  };
}

/** Enough for `toRegisterPetInput` to accept it — the confirm step's own gate. */
const VALID_DRAFT: PetDraft = {
  ...EMPTY_DRAFT,
  name: "Pampa",
  species: "dog",
  sex: "female",
  provinceCode: "AR-S",
  localityName: "Rosario",
};

const CONFIRM_STEP = 5;

async function seed(ownerId: string, draft: PetDraft, stepIndex: number): Promise<void> {
  await writeAltaDraft(altaDraftKey(ownerId), draft, stepIndex);
}

async function altaDraftKeys(): Promise<readonly string[]> {
  return (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith("mimar.altaDraft."));
}

async function flushStorage(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * SPIED ON THE PUBLIC API and left calling through — same idiom
 * `RecordEventScreen.test.tsx` uses for this platform surface. The point is
 * only to get hold of the listener `use-alta-draft.ts` registered.
 */
const appStateListener = jest.spyOn(AppState, "addEventListener");

/** Take the app out of the foreground, the way an incoming call does. */
function emitAppState(next: AppStateStatus): void {
  const listener = appStateListener.mock.calls.at(-1)?.[1] as
    | ((state: AppStateStatus) => void)
    | undefined;
  if (listener === undefined) throw new Error("the screen registered no AppState listener");
  act(() => listener(next));
}

beforeEach(async () => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockRegisterPet.mockReset();
  mockRequestPushPermissionAndRegister.mockReset();
  mockRequestPushPermissionAndRegister.mockResolvedValue({ outcome: "registered" });
  mockNav.reset();
  mockSession.userId = SIGNED_IN_A;
  await AsyncStorage.clear();
  // The honest default: no push module in this build, which is what every
  // case in this file gets UNLESS it opts in with `setPushPort`. It is also
  // what keeps every pre-existing case in this file navigating straight to
  // the credential exactly as before — `shouldOfferPushPriming` answers
  // `false` against `unavailable`, so the priming card never appears for a
  // test that never asked for it.
  resetPushPort();
});

describe("AltaScreen — F-4, el resumen muestra el nombre de la provincia", () => {
  it("shows the province NAME on the confirm step, not the raw ISO code", async () => {
    await seed(SIGNED_IN_A, VALID_DRAFT, CONFIRM_STEP);

    render(<AltaScreen />);

    await waitFor(() => expect(screen.getByText("Santa Fe")).toBeOnTheScreen());
    expect(screen.queryByText("AR-S")).toBeNull();
  });
});

describe("AltaScreen — Re-2, decision 16A: el borrador sobrevive a la muerte del proceso", () => {
  it("restores the fields AND the step from a draft written to disk", async () => {
    await seed(SIGNED_IN_A, { ...EMPTY_DRAFT, name: "Pampa" }, 0);

    render(<AltaScreen />);

    await waitFor(() => expect(screen.getByDisplayValue("Pampa")).toBeOnTheScreen());
    // Step 0's own title, proving the restore did not just fill the field but
    // also landed on the step the person was on — trivially true at step 0,
    // so the real assertion is the confirm-step case above, which restores
    // stepIndex 5 and finds "Revisá antes de registrar" rather than "¿Cómo se
    // llama?".
    expect(screen.getByText("¿Cómo se llama?")).toBeOnTheScreen();
  });

  it("restores a draft parked mid-wizard on the step it was left on", async () => {
    await seed(SIGNED_IN_A, VALID_DRAFT, CONFIRM_STEP);

    render(<AltaScreen />);

    await waitFor(() => expect(screen.getByText("Revisá antes de registrar")).toBeOnTheScreen());
    expect(screen.queryByText("¿Cómo se llama?")).toBeNull();
  });

  it("clamps a stored step past this build's last one, rather than rendering an empty body", async () => {
    // `alta-draft-store.ts`'s own `clampStepIndex` only rules out negative and
    // non-integer values — it does not know `WIZARD_STEPS.length`. Without the
    // clamp in `AltaScreen`'s `onRestore`, `WIZARD_STEPS[9]` is `undefined`
    // and the screen renders "Paso 10 de 6" over an empty body with
    // "Continuar" permanently disabled.
    await seed(SIGNED_IN_A, VALID_DRAFT, 9);

    render(<AltaScreen />);

    await waitFor(() => expect(screen.getByText("Revisá antes de registrar")).toBeOnTheScreen());
    expect(screen.getByText("Paso 6 de 6")).toBeOnTheScreen();
  });

  it("clears the draft once the server accepts the registration", async () => {
    await seed(SIGNED_IN_A, VALID_DRAFT, CONFIRM_STEP);
    mockRegisterPet.mockResolvedValue({
      outcome: "ok",
      payload: { publicToken: "DIM-PAMP-0001", wasDuplicate: false },
    });

    render(<AltaScreen />);
    await waitFor(() => expect(screen.getByText("Registrar mascota")).toBeOnTheScreen());

    await act(async () => {
      fireEvent.press(screen.getByText("Registrar mascota"));
    });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/mascotas/DIM-PAMP-0001"));
    await flushStorage();
    expect(await altaDraftKeys()).toHaveLength(0);
  });

  it("does not offer another account's draft once a different person is signed in", async () => {
    await seed(SIGNED_IN_A, { ...EMPTY_DRAFT, name: "Pampa" }, 0);

    // Person A's own phone still restores it — a control, so the negative
    // case below is not just "the screen never restores anything".
    const first = render(<AltaScreen />);
    await waitFor(() => expect(screen.getByDisplayValue("Pampa")).toBeOnTheScreen());
    first.unmount();

    // A second person, same phone. Their storage key carries THEIR id, not
    // A's — see `alta-draft-store.ts`'s header on why the owner segment is
    // the fence a shared phone needs.
    mockSession.userId = SIGNED_IN_B;
    render(<AltaScreen />);

    await waitFor(() => expect(screen.getByText("¿Cómo se llama?")).toBeOnTheScreen());
    expect(screen.queryByDisplayValue("Pampa")).toBeNull();
  });

  it("writes through the REAL path — types a field, the app leaves the foreground, and a remount restores it", async () => {
    // Unlike every case above, nothing here calls `writeAltaDraft` directly:
    // this is `persistNow` itself, so a suite that stayed green with that
    // function deleted would be caught here and nowhere else in this file.
    const { unmount } = render(<AltaScreen />);
    fireEvent.changeText(screen.getByLabelText("Nombre, obligatorio"), "Pampa");

    // THE PHONE RINGS — no unmount, no navigation, just the app leaving
    // `active`. `inactive` counts because on iOS it is the FIRST thing an
    // incoming call raises, same reasoning as `use-event-draft.ts`.
    emitAppState("inactive");
    await flushStorage();
    expect(await altaDraftKeys()).toHaveLength(1);

    unmount();
    render(<AltaScreen />);

    await waitFor(() => expect(screen.getByDisplayValue("Pampa")).toBeOnTheScreen());
  });

  it("wipes the draft the instant 'Salir del alta' is confirmed — this wizard's own definition of explicit discard", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => {
      const salir = buttons?.find((b) => b.text === "Salir");
      salir?.onPress?.();
    });

    render(<AltaScreen />);
    fireEvent.changeText(screen.getByLabelText("Nombre, obligatorio"), "Pampa");
    emitAppState("inactive");
    await flushStorage();
    expect(await altaDraftKeys()).toHaveLength(1);

    const { blocked } = mockNav.pressBack();
    expect(blocked).toBe(true); // dirty, so the guard actually intercepted it
    expect(alert).toHaveBeenCalledTimes(1);

    await flushStorage();
    expect(await altaDraftKeys()).toHaveLength(0);
    // The confirmed action still reaches the navigator — discarding the draft
    // must not also swallow the exit.
    expect(mockNav.dispatched).toHaveLength(1);
    alert.mockRestore();
  });
});

describe("AltaScreen — M4, decision 10A: el aviso se pide en el momento correcto", () => {
  it("does NOT show the priming card, and goes straight to the credential, once permission is already granted", async () => {
    // THE EXISTING-USER CASE. An account that already granted (or already has
    // a live token) must see no change at all from this feature.
    setPushPort(portWithPeek(async () => ({ outcome: "granted" })));
    await seed(SIGNED_IN_A, VALID_DRAFT, CONFIRM_STEP);
    mockRegisterPet.mockResolvedValue({
      outcome: "ok",
      payload: { publicToken: "DIM-PAMP-0001", wasDuplicate: false },
    });

    render(<AltaScreen />);
    await waitFor(() => expect(screen.getByText("Registrar mascota")).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByText("Registrar mascota"));
    });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/mascotas/DIM-PAMP-0001"));
    expect(screen.queryByText("Antes de irnos")).toBeNull();
    expect(mockRequestPushPermissionAndRegister).not.toHaveBeenCalled();
  });

  it("appears after the first successful alta, and holds the navigation until answered", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "undetermined" })));
    await seed(SIGNED_IN_A, VALID_DRAFT, CONFIRM_STEP);
    mockRegisterPet.mockResolvedValue({
      outcome: "ok",
      payload: { publicToken: "DIM-PAMP-0001", wasDuplicate: false },
    });

    render(<AltaScreen />);
    await waitFor(() => expect(screen.getByText("Registrar mascota")).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByText("Registrar mascota"));
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          "¿Querés que te avisemos las vacunas que vencen y si alguien encuentra a tu mascota?",
        ),
      ).toBeOnTheScreen(),
    );
    // The whole point: the credential is not reached until one of the two
    // buttons answers.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("'Sí, avisame' calls requestPushPermissionAndRegister, then goes to the credential", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "undetermined" })));
    await seed(SIGNED_IN_A, VALID_DRAFT, CONFIRM_STEP);
    mockRegisterPet.mockResolvedValue({
      outcome: "ok",
      payload: { publicToken: "DIM-PAMP-0001", wasDuplicate: false },
    });

    render(<AltaScreen />);
    await waitFor(() => expect(screen.getByText("Registrar mascota")).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByText("Registrar mascota"));
    });
    await waitFor(() => expect(screen.getByText("Sí, avisame")).toBeOnTheScreen());

    await act(async () => {
      fireEvent.press(screen.getByText("Sí, avisame"));
    });

    expect(mockRequestPushPermissionAndRegister).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/mascotas/DIM-PAMP-0001"));
    // Never dismissed: "Sí" is a grant, not a decline, so nothing here should
    // block a FUTURE priming offer for this account.
    await expect(readPushPrimingDismissed(SIGNED_IN_A)).resolves.toBe(false);
  });

  it("'Ahora no' stores the dismissal, skips the OS call, and still reaches the credential", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "undetermined" })));
    await seed(SIGNED_IN_A, VALID_DRAFT, CONFIRM_STEP);
    mockRegisterPet.mockResolvedValue({
      outcome: "ok",
      payload: { publicToken: "DIM-PAMP-0001", wasDuplicate: false },
    });

    render(<AltaScreen />);
    await waitFor(() => expect(screen.getByText("Registrar mascota")).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByText("Registrar mascota"));
    });
    await waitFor(() => expect(screen.getByText("Ahora no")).toBeOnTheScreen());

    await act(async () => {
      fireEvent.press(screen.getByText("Ahora no"));
    });

    expect(mockRequestPushPermissionAndRegister).not.toHaveBeenCalled();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/mascotas/DIM-PAMP-0001"));
    await expect(readPushPrimingDismissed(SIGNED_IN_A)).resolves.toBe(true);
  });
});
