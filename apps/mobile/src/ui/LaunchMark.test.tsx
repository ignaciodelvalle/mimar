import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as SplashScreen from "expo-splash-screen";
import { AccessibilityInfo, Animated, Text, View } from "react-native";

import {
  LAUNCH_MARK_FADE_MS,
  LAUNCH_MARK_HANDOFF_FALLBACK_MS,
  LAUNCH_MARK_REST_SCALE,
  LAUNCH_MARK_SHRINK_MS,
  LAUNCH_MARK_SIZE_DP,
  LAUNCH_MARK_TIMEOUT_MS,
  LaunchMark,
  NATIVE_SPLASH_BACKGROUND,
  NATIVE_SPLASH_FADE_MS,
  holdNativeSplash,
  launchMarkReady,
  launchWaitsForSession,
} from "./LaunchMark";
import { COLORS } from "./theme";

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve(true)),
  setOptions: jest.fn(),
  hide: jest.fn(),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

const hide = SplashScreen.hide as jest.Mock;
const LAYOUT = { nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 640 } } };
/** Everything the hand-off can take before the logo is at rest. */
const UNTIL_SETTLED = NATIVE_SPLASH_FADE_MS + LAUNCH_MARK_SHRINK_MS + 50;

function reduceMotion(value: boolean) {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(value);
}

/** Lets the reduced-motion query's promise land. */
async function settleQuery() {
  await act(async () => {});
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/** The overlay is laid out AND its image has painted — the hand-off's trigger. */
function handOff() {
  fireEvent(screen.getByTestId("launch-mark"), "layout", LAYOUT);
  fireEvent(screen.getByTestId("launch-mark-logo"), "load");
}

function shrinkCalls(timing: jest.SpiedFunction<typeof Animated.timing>) {
  return timing.mock.calls.filter(([, config]) => config.toValue === LAUNCH_MARK_REST_SCALE);
}

beforeEach(() => {
  jest.useFakeTimers();
  hide.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("LaunchMark — the same picture as the native splash", () => {
  it("is sized by the splash plugin's imageWidth, on the splash's own ground", () => {
    // The hand-off is invisible only if both of these match what the native
    // build rasterised; a mismatch is a jump on every cold start.
    expect(LAUNCH_MARK_SIZE_DP).toBe(144);
    expect(String(NATIVE_SPLASH_BACKGROUND).toLowerCase()).toBe(COLORS.canvas.toLowerCase());
  });
});

describe("launchMarkReady — a public route does not wait for the session", () => {
  const QR = "/p/DIM-ABCD-2345";
  const done = { fontsReady: true, launchGate: "done" as const };

  it("reads 'public' off the deep-link map, not off a list of its own", () => {
    expect(launchWaitsForSession(QR)).toBe(false);
    expect(launchWaitsForSession(`${QR}/encontre`)).toBe(false);
    // Paths the map does not know, or knows as session-only, wait.
    expect(launchWaitsForSession("/")).toBe(true);
    expect(launchWaitsForSession("/mascotas")).toBe(true);
    expect(launchWaitsForSession("/mis-mascotas")).toBe(true);
  });

  it("leaves a QR landing as soon as fonts and the update check are done", () => {
    expect(launchMarkReady({ ...done, sessionStarting: true, pathname: QR })).toBe(true);
  });

  it("still holds a QR landing for the fonts and the update check", () => {
    const qr = { sessionStarting: false, pathname: QR };
    expect(launchMarkReady({ ...qr, fontsReady: false, launchGate: "done" })).toBe(false);
    expect(launchMarkReady({ ...qr, fontsReady: true, launchGate: "deciding" })).toBe(false);
  });

  it("holds a signed-in route until the session's first answer", () => {
    expect(launchMarkReady({ ...done, sessionStarting: true, pathname: "/" })).toBe(false);
    expect(launchMarkReady({ ...done, sessionStarting: false, pathname: "/" })).toBe(true);
  });

  it("gives way to the OTA download sentence", () => {
    const cold = { fontsReady: false, sessionStarting: true, pathname: "/" };
    expect(launchMarkReady({ ...cold, launchGate: "updating" })).toBe(true);
  });
});

describe("LaunchMark — the hand-off", () => {
  it("hides the native splash exactly once, after layout AND the image's load", async () => {
    reduceMotion(false);
    const { rerender } = render(<LaunchMark ready={false} />);
    await settleQuery();
    expect(hide).not.toHaveBeenCalled();

    handOff();
    handOff();
    rerender(<LaunchMark ready={false} />);
    handOff();
    advance(UNTIL_SETTLED + LAUNCH_MARK_HANDOFF_FALLBACK_MS);

    expect(hide).toHaveBeenCalledTimes(1);
  });

  // J7, EAS preview (2026-10-06): releasing on layout alone let the native
  // fade uncover an overlay whose image had not painted — a visible dip.
  it("does not hide the native splash on layout alone — only once the image has loaded", async () => {
    reduceMotion(false);
    render(<LaunchMark ready={false} />);
    await settleQuery();
    fireEvent(screen.getByTestId("launch-mark"), "layout", LAYOUT);
    advance(LAUNCH_MARK_HANDOFF_FALLBACK_MS - 1);
    expect(hide).not.toHaveBeenCalled();

    fireEvent(screen.getByTestId("launch-mark-logo"), "load");
    expect(hide).toHaveBeenCalledTimes(1);
    advance(LAUNCH_MARK_HANDOFF_FALLBACK_MS);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("waits for layout even when the image loads first", async () => {
    reduceMotion(false);
    render(<LaunchMark ready={false} />);
    await settleQuery();
    fireEvent(screen.getByTestId("launch-mark-logo"), "load");
    expect(hide).not.toHaveBeenCalled();

    fireEvent(screen.getByTestId("launch-mark"), "layout", LAYOUT);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("releases the native splash on the fallback when the image never reports a load", async () => {
    reduceMotion(false);
    render(<LaunchMark ready={false} />);
    await settleQuery();
    fireEvent(screen.getByTestId("launch-mark"), "layout", LAYOUT);
    advance(LAUNCH_MARK_HANDOFF_FALLBACK_MS - 1);
    expect(hide).not.toHaveBeenCalled();

    advance(1);
    expect(hide).toHaveBeenCalledTimes(1);
    // A late load does not hand off a second time.
    fireEvent(screen.getByTestId("launch-mark-logo"), "load");
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("shrinks to its resting size when the system allows motion", async () => {
    reduceMotion(false);
    const timing = jest.spyOn(Animated, "timing");
    render(<LaunchMark ready={false} />);
    await settleQuery();
    handOff();
    advance(UNTIL_SETTLED);

    const shrinks = shrinkCalls(timing);
    expect(shrinks).toHaveLength(1);
    expect(shrinks[0]?.[1]).toMatchObject({
      duration: LAUNCH_MARK_SHRINK_MS,
      // Not before the native splash's own fade is over: two logos of
      // different sizes cross-fading is a double image.
      delay: NATIVE_SPLASH_FADE_MS,
      useNativeDriver: true,
    });
    // And it STAYS: not ready, so still on screen at rest.
    expect(screen.getByTestId("launch-mark-logo")).toBeTruthy();
  });

  it("does not shrink under reduced motion, and still leaves when ready", async () => {
    reduceMotion(true);
    const timing = jest.spyOn(Animated, "timing");
    const { rerender } = render(<LaunchMark ready={false} />);
    await settleQuery();
    handOff();
    advance(UNTIL_SETTLED);
    expect(shrinkCalls(timing)).toHaveLength(0);

    rerender(<LaunchMark ready />);
    advance(LAUNCH_MARK_FADE_MS + 50);
    expect(screen.queryByTestId("launch-mark")).toBeNull();
  });

  it("does not shrink while the reduced-motion answer is still unknown", async () => {
    jest
      .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
      .mockReturnValue(new Promise<boolean>(() => {}));
    const timing = jest.spyOn(Animated, "timing");
    render(<LaunchMark ready={false} />);
    handOff();
    advance(UNTIL_SETTLED);
    expect(shrinkCalls(timing)).toHaveLength(0);
  });
});

describe("LaunchMark — survives the root layout's loading → app switch", () => {
  // The root layout returns one tree while fonts/launch gate load and another
  // once they are done, with the overlay at a different child position in each.
  // This is that shape in miniature: the shared `key` must keep it ONE overlay.
  function Root({ loading, ready }: { loading: boolean; ready: boolean }) {
    const mark = <LaunchMark key="launch-mark" ready={ready} />;
    if (loading) {
      return (
        <View>
          <Text>cargando</Text>
          {mark}
        </View>
      );
    }
    return (
      <View>
        <Text>banner</Text>
        <Text>stack</Text>
        {mark}
      </View>
    );
  }

  it("is not remounted: no second hand-off, no second shrink", async () => {
    reduceMotion(false);
    const timing = jest.spyOn(Animated, "timing");
    const { rerender } = render(<Root loading ready={false} />);
    await settleQuery();
    handOff();
    advance(UNTIL_SETTLED);

    rerender(<Root loading={false} ready={false} />);
    handOff();
    await settleQuery();
    advance(UNTIL_SETTLED);

    expect(hide).toHaveBeenCalledTimes(1);
    expect(shrinkCalls(timing)).toHaveLength(1);
  });
});

describe("LaunchMark — leaving", () => {
  it("stays while loading, and unmounts once the app is ready", async () => {
    reduceMotion(false);
    const { rerender } = render(<LaunchMark ready={false} />);
    await settleQuery();
    handOff();
    advance(UNTIL_SETTLED + 2000);
    expect(screen.getByTestId("launch-mark")).toBeTruthy();

    rerender(<LaunchMark ready />);
    advance(LAUNCH_MARK_FADE_MS + 50);
    expect(screen.queryByTestId("launch-mark")).toBeNull();
  });

  it("waits for the shrink to land before fading, even when ready at once", async () => {
    reduceMotion(false);
    render(<LaunchMark ready />);
    await settleQuery();
    handOff();
    advance(NATIVE_SPLASH_FADE_MS);
    expect(screen.getByTestId("launch-mark")).toBeTruthy();

    // The shrink lands; only THEN does the fade start (its own act turn).
    advance(LAUNCH_MARK_SHRINK_MS + 50);
    expect(screen.getByTestId("launch-mark")).toBeTruthy();
    advance(LAUNCH_MARK_FADE_MS + 50);
    expect(screen.queryByTestId("launch-mark")).toBeNull();
  });

  it("finishes leaving once it has started, even if ready flips back", async () => {
    reduceMotion(false);
    // The fade is held open by hand: under jest the real timing lands within a
    // tick, so "mid-fade" only exists if the test owns the animation.
    const realTiming = Animated.timing;
    let finishFade: Animated.EndCallback | undefined;
    const stopFade = jest.fn();
    jest.spyOn(Animated, "timing").mockImplementation((value, config) => {
      if (config.toValue !== 0) return realTiming(value, config);
      return {
        start: (callback?: Animated.EndCallback) => {
          finishFade = callback;
        },
        stop: stopFade,
        reset: () => {},
      };
    });
    const { rerender } = render(<LaunchMark ready={false} />);
    await settleQuery();
    handOff();
    advance(UNTIL_SETTLED);

    rerender(<LaunchMark ready />);
    expect(finishFade).toBeDefined();
    expect(screen.getByTestId("launch-mark").props.pointerEvents).toBe("none");

    // Mid-fade, the app un-readies. The exit is latched: the fade is not
    // stopped, the overlay stays transparent to touch, and when the fade runs
    // out the overlay goes — not stuck half-faded until the 8 s ceiling.
    rerender(<LaunchMark ready={false} />);
    expect(stopFade).not.toHaveBeenCalled();
    expect(screen.getByTestId("launch-mark").props.pointerEvents).toBe("none");
    act(() => finishFade?.({ finished: true }));
    expect(screen.queryByTestId("launch-mark")).toBeNull();
  });

  it("unmounts on the timeout when the app never gets ready", async () => {
    reduceMotion(false);
    render(<LaunchMark ready={false} />);
    await settleQuery();
    handOff();
    advance(LAUNCH_MARK_TIMEOUT_MS - 1);
    expect(screen.getByTestId("launch-mark")).toBeTruthy();

    advance(1);
    expect(screen.queryByTestId("launch-mark")).toBeNull();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("releases the native splash on the timeout even if it never laid out", async () => {
    reduceMotion(false);
    render(<LaunchMark ready={false} />);
    await settleQuery();
    advance(LAUNCH_MARK_TIMEOUT_MS);
    expect(screen.queryByTestId("launch-mark")).toBeNull();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});

describe("holdNativeSplash", () => {
  it("holds the native splash, shortens its exit fade, and arms a deadline", () => {
    holdNativeSplash();
    expect(SplashScreen.preventAutoHideAsync).toHaveBeenCalledTimes(1);
    expect(SplashScreen.setOptions).toHaveBeenCalledWith({
      duration: NATIVE_SPLASH_FADE_MS,
      fade: true,
    });
    expect(hide).not.toHaveBeenCalled();

    // Nothing ever took over (a render that threw above the overlay): the
    // deadline lets the person through anyway.
    advance(LAUNCH_MARK_TIMEOUT_MS);
    expect(hide).toHaveBeenCalledTimes(1);
  });
});
