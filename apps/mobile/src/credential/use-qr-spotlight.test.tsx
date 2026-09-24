// `useQrSpotlight` — capture, raise, RELEASE, and never crash.
//
// The contract worth pinning is the RELEASE, and it is pinned in three
// dimensions now, because the hook was wrong in two of them at once:
//
//   WHAT it calls    Android and iOS need DIFFERENT calls to hand brightness
//                    back, and the one that reads as obvious is the wrong one
//                    on Android. See `releaseSpotlight` in the hook.
//   WHEN it fires    Focus and app state, not only unmount — a native-stack
//                    screen stays mounted under whatever is pushed on top.
//   WHETHER it fires A failed capture must leave the platform alone entirely;
//                    the emulator and the pre-D2-build phone have no
//                    brightness service and the credential screen must not care.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import { AppState, type AppStateStatus, Platform } from "react-native";

/** Every keep-awake tag this hook emits is per-instance now (item 6, fresh-
 *  context review pre-push): `qr-spotlight-<useId()>`, not a shared literal. */
const ANY_QR_SPOTLIGHT_TAG = expect.stringMatching(/^qr-spotlight-/);

const mockGet = jest.fn<() => Promise<number>>();
const mockSet = jest.fn<(value: number) => Promise<void>>();
const mockRestore = jest.fn<() => Promise<void>>();
const mockActivateKeepAwake = jest.fn<(tag?: string) => Promise<void>>();
const mockDeactivateKeepAwake = jest.fn<(tag?: string) => Promise<void>>();

jest.mock("expo-brightness", () => ({
  getBrightnessAsync: () => mockGet(),
  setBrightnessAsync: (value: number) => mockSet(value),
  restoreSystemBrightnessAsync: () => mockRestore(),
}));

jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: (tag?: string) => mockActivateKeepAwake(tag),
  deactivateKeepAwake: (tag?: string) => mockDeactivateKeepAwake(tag),
}));

/**
 * A focus store the tests can drive, and the reason this file does not use the
 * one-liner stand-in the other screen tests use
 * (`useFocusEffect: (cb) => useEffect(cb, [cb])`).
 *
 * That stand-in models focus as "runs on mount", which is true of the FIRST
 * focus and of nothing else — and blur-without-unmount is precisely the
 * property being added here. A hook that released only on unmount would pass
 * the simple stand-in and still leave the screen pinned all the way down a
 * navigation stack, which is the defect measured on the device.
 *
 * Names start with `mock` because jest hoists `jest.mock` factories above every
 * other statement and rejects out-of-scope references that are not spelled that
 * way.
 */
const mockFocusState = { current: true };
const mockFocusSubscribers = new Set<(focused: boolean) => void>();

jest.mock("expo-router", () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    const { useEffect, useState } = require("react") as typeof import("react");
    const [isFocused, setIsFocused] = useState(() => mockFocusState.current);
    useEffect(() => {
      mockFocusSubscribers.add(setIsFocused);
      // Re-read on mount: a screen can be created while already blurred, and
      // the lazy initial state above was evaluated a render earlier.
      setIsFocused(mockFocusState.current);
      return () => {
        mockFocusSubscribers.delete(setIsFocused);
      };
    }, []);
    useEffect(() => {
      if (!isFocused) return;
      return callback();
    }, [callback, isFocused]);
  },
}));

import { useQrSpotlight } from "./use-qr-spotlight";

/** Blur or focus every mounted screen, the way a navigator would. */
function setFocus(focused: boolean): void {
  mockFocusState.current = focused;
  act(() => {
    for (const notify of mockFocusSubscribers) notify(focused);
  });
}

/**
 * SPIED ON THE PUBLIC API rather than mocked by internal file path — the rule
 * `foreground-update.test.tsx` states for the same platform surface.
 */
const addEventListener = jest.spyOn(AppState, "addEventListener");
const removeSubscription = jest.fn();

/** Drive the platform's app-state changes. */
function emitAppState(next: AppStateStatus): void {
  const listener = addEventListener.mock.calls.at(-1)?.[1] as
    | ((state: AppStateStatus) => void)
    | undefined;
  if (listener === undefined) throw new Error("the hook registered no AppState listener");
  act(() => listener(next));
}

/**
 * The platform, temporarily. Same shape as `expo-push-adapter.test.ts`'s
 * helper: `Platform.OS` is read at release time, not at import time, so
 * redefining the property is enough and no module has to be re-required.
 */
const originalOs = Platform.OS;
function setPlatform(os: "ios" | "android"): void {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
}

function Harness({ enabled }: { enabled?: boolean }) {
  useQrSpotlight(enabled);
  return null;
}

/** Let the mount effect's async capture-and-raise settle. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue(0.35);
  mockSet.mockReset().mockResolvedValue(undefined);
  mockRestore.mockReset().mockResolvedValue(undefined);
  mockActivateKeepAwake.mockReset().mockResolvedValue(undefined);
  mockDeactivateKeepAwake.mockReset().mockResolvedValue(undefined);
  mockFocusState.current = true;
  mockFocusSubscribers.clear();
  addEventListener.mockReset();
  addEventListener.mockReturnValue({ remove: removeSubscription } as ReturnType<
    typeof AppState.addEventListener
  >);
  removeSubscription.mockReset();
  // Most assertions here do not care which platform they are on. The ones that
  // do say so; this keeps the rest from inheriting whatever jest-expo picked.
  setPlatform(originalOs === "android" ? "android" : "ios");
});

describe("the spotlight", () => {
  it("keeps the screen awake and raises the window to full brightness", async () => {
    render(<Harness />);
    await flush();
    expect(mockActivateKeepAwake).toHaveBeenCalledWith(ANY_QR_SPOTLIGHT_TAG);
    expect(mockSet).toHaveBeenCalledWith(1);
  });

  it("restores nothing it never captured — the failed-read path stays silent", async () => {
    mockGet.mockRejectedValue(new Error("no brightness service"));
    const screen = render(<Harness />);
    await flush();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
    screen.unmount();
    await flush();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("survives a set that rejects — the screen behaves as always, no crash", async () => {
    mockSet.mockRejectedValue(new Error("no brightness service"));
    const screen = render(<Harness />);
    await flush();
    expect(() => screen.unmount()).not.toThrow();
    await flush();
  });

  it("survives a restore that rejects on the way out", async () => {
    setPlatform("android");
    mockRestore.mockRejectedValue(new Error("no brightness service"));
    const screen = render(<Harness />);
    await flush();
    expect(() => screen.unmount()).not.toThrow();
    await flush();
  });
});

// THE PLATFORM SPLIT, and the assertion this file used to get backwards.
//
// It read `expect(mockSet).toHaveBeenLastCalledWith(0.35)` on the way out, on
// every platform. That is right on iOS and WRONG on Android, where writing the
// captured level back is still an override — the app goes on dictating the
// screen, just at a dimmer value. The old assertion was green the whole time
// the device was leaking, because it described what the hook did rather than
// what the hook needed to achieve. Measured on a Samsung SM-J710MN via
// `adb shell dumpsys power`; the numbers are in `releaseSpotlight`'s docblock.
describe("handing brightness back", () => {
  it("RELEASES the override on Android instead of pinning the captured level", async () => {
    setPlatform("android");
    const screen = render(<Harness />);
    await flush();
    expect(mockSet).toHaveBeenCalledWith(1);

    screen.unmount();
    await flush();
    expect(mockRestore).toHaveBeenCalled();
    // The raise, and nothing after it. A second `setBrightnessAsync` here would
    // be the bug: a dim pin in place of a bright one.
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it("RESTORES the level it captured on iOS, where there is no override to release", async () => {
    setPlatform("ios");
    const screen = render(<Harness />);
    await flush();
    screen.unmount();
    await flush();
    expect(mockSet).toHaveBeenLastCalledWith(0.35);
    // Calling it would do nothing at all — expo-brightness returns early off
    // Android — so an iOS path that relied on it would leave the screen at full.
    expect(mockRestore).not.toHaveBeenCalled();
  });
});

// THE LIFETIME, the other half of the same defect. A native-stack screen does
// not unmount when something is pushed on top of it, so an unmount-only release
// meant: open the credential, tap through to anything else, and the phone stays
// pinned for the rest of the visit.
describe("while the screen is not the one in front", () => {
  it("releases on blur, without waiting for an unmount", async () => {
    setPlatform("android");
    render(<Harness />);
    await flush();
    expect(mockSet).toHaveBeenCalledWith(1);

    setFocus(false);
    await flush();
    expect(mockRestore).toHaveBeenCalled();
  });

  it("raises again when the owner comes back to it", async () => {
    setPlatform("android");
    render(<Harness />);
    await flush();
    setFocus(false);
    await flush();
    mockSet.mockClear();

    setFocus(true);
    await flush();
    expect(mockSet).toHaveBeenCalledWith(1);
  });

  it("releases when the app goes to the background", async () => {
    setPlatform("android");
    render(<Harness />);
    await flush();
    expect(mockSet).toHaveBeenCalledWith(1);

    emitAppState("background");
    await flush();
    expect(mockRestore).toHaveBeenCalled();
  });

  it("raises again on the way back to the foreground", async () => {
    setPlatform("android");
    render(<Harness />);
    await flush();
    emitAppState("background");
    await flush();
    mockSet.mockClear();

    emitAppState("active");
    await flush();
    expect(mockSet).toHaveBeenCalledWith(1);
  });

  it("does NOT release on `inactive` — that is a Control Centre pull, not a departure", async () => {
    setPlatform("android");
    render(<Harness />);
    await flush();

    emitAppState("inactive");
    await flush();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("does not raise at all while blurred", async () => {
    mockFocusState.current = false;
    render(<Harness />);
    await flush();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

// KEEP-AWAKE RIDES THE SAME FOCUS WINDOW (T4-M3). `useKeepAwake()` used to run
// for as long as the component stayed MOUNTED — the KNOWN ASYMMETRY the
// brightness effect's own header comment used to name — so the phone stayed
// awake under whatever got pushed on top of the credential. It is now on
// `focused`, the exact boolean the brightness raise above already answers to.
describe("keep-awake, on the same focus window as the brightness raise", () => {
  it("does not activate at all while blurred", async () => {
    mockFocusState.current = false;
    render(<Harness />);
    await flush();
    expect(mockActivateKeepAwake).not.toHaveBeenCalled();
  });

  it("deactivates on blur, without waiting for an unmount", async () => {
    render(<Harness />);
    await flush();
    expect(mockActivateKeepAwake).toHaveBeenCalledWith(ANY_QR_SPOTLIGHT_TAG);

    setFocus(false);
    await flush();
    expect(mockDeactivateKeepAwake).toHaveBeenCalledWith(ANY_QR_SPOTLIGHT_TAG);
  });

  it("activates again when the owner comes back to the screen", async () => {
    render(<Harness />);
    await flush();
    setFocus(false);
    await flush();
    mockActivateKeepAwake.mockClear();

    setFocus(true);
    await flush();
    expect(mockActivateKeepAwake).toHaveBeenCalledWith(ANY_QR_SPOTLIGHT_TAG);
  });

  it("deactivates on unmount", async () => {
    const screen = render(<Harness />);
    await flush();
    expect(mockActivateKeepAwake).toHaveBeenCalledWith(ANY_QR_SPOTLIGHT_TAG);

    screen.unmount();
    await flush();
    expect(mockDeactivateKeepAwake).toHaveBeenCalledWith(ANY_QR_SPOTLIGHT_TAG);
  });

  // UNLIKE THE BRIGHTNESS RAISE, backgrounding the app does NOT deactivate
  // keep-awake — the contract asked for is "the same focus window `useQrSpotlight`
  // already uses" for the FOCUS half of that hook, and background/foreground
  // is a separate axis the brightness effect tracks on its own for a reason
  // (see its own header: an iOS system-brightness write, with no window to
  // release, that a locked screen does not undo by itself). A screen that
  // stays awake for a few extra seconds while the owner is in another app for
  // a moment is not the defect this task exists to fix.
  it("does NOT deactivate merely because the app backgrounds — that is a different axis", async () => {
    render(<Harness />);
    await flush();
    mockDeactivateKeepAwake.mockClear();

    emitAppState("background");
    await flush();
    expect(mockDeactivateKeepAwake).not.toHaveBeenCalled();
  });

  it("keeps the screen awake even when the owner has declined the brightness spotlight", async () => {
    render(<Harness enabled={false} />);
    await flush();
    expect(mockActivateKeepAwake).toHaveBeenCalledWith(ANY_QR_SPOTLIGHT_TAG);
  });

  // Item 5, fresh-context review pre-push: activateKeepAwakeAsync's rejection
  // must be handled the same BEST-EFFORT way every platform call in this file
  // already is (module docblock) — an emulator or pre-D2-build phone with no
  // keep-awake service must degrade silently, not surface an unhandled
  // rejection on the most public screen in the app.
  it("survives an activation that rejects — no unhandled rejection, no crash", async () => {
    mockActivateKeepAwake.mockRejectedValue(new Error("no keep-awake service"));
    const screen = render(<Harness />);
    await flush();
    expect(() => screen.unmount()).not.toThrow();
    await flush();
  });

  // Item 6, fresh-context review pre-push. MUTATION PROOF: this test turns
  // red the moment the per-instance tag (`useId()`-derived) is reverted to
  // the old shared literal `"qr-spotlight"` — both calls would then report
  // the SAME tag and `.not.toBe` would fail.
  it("gives two mounted instances DISTINCT keep-awake tags — one cannot release the other's lock", async () => {
    render(<Harness />);
    await flush();
    render(<Harness />);
    await flush();

    expect(mockActivateKeepAwake).toHaveBeenCalledTimes(2);
    const tag1 = mockActivateKeepAwake.mock.calls[0]?.[0];
    const tag2 = mockActivateKeepAwake.mock.calls[1]?.[0];
    expect(tag1).toEqual(ANY_QR_SPOTLIGHT_TAG);
    expect(tag2).toEqual(ANY_QR_SPOTLIGHT_TAG);
    expect(tag1).not.toBe(tag2);
  });

  it("unmounting one instance does not deactivate the other instance's tag", async () => {
    const screen1 = render(<Harness />);
    await flush();
    const screen2 = render(<Harness />);
    await flush();

    const tag1 = mockActivateKeepAwake.mock.calls[0]?.[0];
    const tag2 = mockActivateKeepAwake.mock.calls[1]?.[0];

    screen1.unmount();
    await flush();

    expect(mockDeactivateKeepAwake).toHaveBeenCalledWith(tag1);
    expect(mockDeactivateKeepAwake).not.toHaveBeenCalledWith(tag2);

    screen2.unmount();
    await flush();
  });
});

// The escape hatch (a11y audit 2026-09-16). Raising the brightness with no way
// out made the credential unusable for someone with photophobia: the only way
// to stop the glare was to leave the screen they were trying to show.
describe("when the owner has declined the spotlight", () => {
  it("does not touch the brightness at all", async () => {
    render(<Harness enabled={false} />);
    await flush();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("still keeps the screen awake — the refusal is about glare, not locking", async () => {
    render(<Harness enabled={false} />);
    await flush();
    expect(mockActivateKeepAwake).toHaveBeenCalledWith(ANY_QR_SPOTLIGHT_TAG);
  });

  it("HANDS THE SCREEN BACK the moment it is turned off mid-screen, on Android", async () => {
    // The whole point of the control: a tap must undo the glare now, not on the
    // way out of the screen. And "undo" has to mean released — the person
    // reaching for this switch has a migraine, and swapping a bright pin for a
    // dim one still leaves their phone refusing to behave the way they set it up.
    setPlatform("android");
    const screen = render(<Harness enabled={true} />);
    await flush();
    expect(mockSet).toHaveBeenCalledWith(1);

    screen.rerender(<Harness enabled={false} />);
    await flush();
    expect(mockRestore).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it("restores the captured level the moment it is turned off mid-screen, on iOS", async () => {
    setPlatform("ios");
    const screen = render(<Harness enabled={true} />);
    await flush();
    expect(mockSet).toHaveBeenCalledWith(1);

    screen.rerender(<Harness enabled={false} />);
    await flush();
    expect(mockSet).toHaveBeenLastCalledWith(0.35);
  });
});
