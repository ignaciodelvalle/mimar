// `useDocumentTurn` + `TurningSheet` — the behaviour the choreography produces.
//
// WHY A HOST COMPONENT INSTEAD OF THE REAL SCREEN. `PetDocumentScreen` is the
// integration point and keeps its own turn tests; here the sheet holds one
// word, so "which face is painted" is a single unambiguous query instead of a
// question competing with a network read, a libreta fetch and nine sections.
// The three requirements this unit exists to satisfy — the reduced-motion path
// stays instant, the swap is hidden, one face at a time — are all decided in
// this hook.
//
// NOTHING HERE ASSERTS ON ELAPSED TIME, AND THAT IS DELIBERATE. "The face has
// not changed 145ms in" is a true statement about the turn and a coin flip on a
// loaded CI box. What IS asserted is order and count: the face does not change
// on the press (synchronous, no clock involved), and it has changed once the
// turn is over (`findBy*` waits as long as it needs). Waiting LONGER can only
// make those assertions stronger, never flakier.
//
// THE LOG OF PAINTED FACES IS NOT A COUNT OF PAINTS, and this file used to read
// as though it were. Every state update inside ONE `act` window is coalesced
// into a single commit, so a turn that painted `libreta` and then `credencial`
// again inside a `settle()` logs neither — React hands the effect the final
// value and nothing else. The log is therefore evidence about what the reader
// ENDS UP looking at, and about paints that straddle an `act` boundary; it is
// no evidence at all about how many turns ran. That question is asked of the
// spies, whose calls are recorded as they are issued: `Animated.timing` for the
// rotations, `setValue` for the jump.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, Text } from "react-native";

import type { DocumentFace } from "./DocumentChromeNative";
import { TurningSheet, useDocumentTurn } from "./DocumentTurn";
import {
  TURN_EDGE_ON_DEG,
  TURN_PERSPECTIVE,
  TURN_SWAP_AT_MS,
  TURN_TOTAL_MS,
  type TurnStep,
  turnPlan,
} from "./document-turn";

const FRONT = "FRENTE";
const BACK = "DORSO";

/** The rotations the plan declares, in order. The tests below assert the DRIVER
 *  hands exactly these to `Animated.timing` — the plan's own numbers are the
 *  expected values, so the two cannot drift apart silently. */
const PLANNED_ROTATIONS = turnPlan(false).filter(
  (step): step is Extract<TurnStep, { kind: "rotate" }> => step.kind === "rotate",
);

/** The jumps the plan declares — the moves that are NOT `Animated.timing`, and
 *  so the ones no spy on it can see. Same contract as PLANNED_ROTATIONS: the
 *  plan's own numbers are what the driver is held to. */
const PLANNED_JUMPS = turnPlan(false).filter(
  (step): step is Extract<TurnStep, { kind: "jump" }> => step.kind === "jump",
);

/** Where a mounted `Host` publishes the `Animated.Value` its hook created, so a
 *  test can watch the sheet's angle directly. The jump is a `setValue` on this
 *  object and nothing else in the tree touches it. */
type AnglePort = { angle: Animated.Value | null };

/** The smallest thing that can hold a face: one word, a control that asks for
 *  the other one, and a log of every face this sheet has actually painted. */
function Host({ log, port }: { log: DocumentFace[]; port?: AnglePort }) {
  const [face, setFace] = useState<DocumentFace>("credencial");
  const turn = useDocumentTurn(face);
  const painted = turn.paintedFace;
  const { angle } = turn;

  useEffect(() => {
    log.push(painted);
  }, [painted, log]);

  useEffect(() => {
    if (port !== undefined) port.angle = angle;
  }, [angle, port]);

  return (
    <>
      <TurningSheet turn={turn}>
        <Text>{painted === "credencial" ? FRONT : BACK}</Text>
      </TurningSheet>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="girar"
        onPress={() => setFace((current) => (current === "credencial" ? "libreta" : "credencial"))}
      >
        <Text>girar</Text>
      </Pressable>
    </>
  );
}

/** Renders, then lets the motion preference land: React Native answers it with
 *  a promise, and until it resolves the hook assumes "reduced" (see its
 *  header). Every test needs the settled value, so every test comes through
 *  here.
 *
 *  Hands back both channels the turn is visible on: the faces it painted, and
 *  the angle it moved. They are not interchangeable — the paint is React state
 *  and coalesces, the angle does not. */
async function mount(): Promise<{ log: DocumentFace[]; angle: Animated.Value }> {
  const log: DocumentFace[] = [];
  const port: AnglePort = { angle: null };
  render(<Host log={log} port={port} />);
  await act(async () => {});
  expect(screen.getByText(FRONT)).toBeOnTheScreen();
  const { angle } = port;
  if (angle === null) throw new Error("the hook never published its angle");
  return { log, angle };
}

function pressTurn(): void {
  fireEvent.press(screen.getByLabelText("girar"));
}

/** `findBy*` with room for a turn (or two queued ones) on a loaded machine.
 *  The default 1000ms is only ~2× the turn and this suite shares a box with
 *  every other agent's. */
async function findFace(word: string) {
  return screen.findByText(word, {}, { timeout: 5000 });
}

/** Waits out a whole turn with room to spare, inside `act` so the state the
 *  turn's timers set is flushed the way React expects. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TURN_TOTAL_MS + 250));
  });
}

/** Exactly one face on the sheet — the requirement, asserted as a count rather
 *  than as "the other one is absent". */
function expectOnlyFace(word: string): void {
  const other = word === FRONT ? BACK : FRONT;
  expect(screen.getByText(word)).toBeOnTheScreen();
  expect(screen.queryByText(other)).toBeNull();
}

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("useDocumentTurn — a reader who asked for less motion", () => {
  it("gets the swap on the press, with nothing in between", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const { log } = await mount();

    pressTurn();

    // Same tick as the press: no turn, no wait, no window in which the document
    // is neither face. This is the mechanic the two-faced document shipped
    // with, and the animation did not take it away.
    expectOnlyFace(BACK);
    expect(log).toEqual(["credencial", "libreta"]);
  });

  it("changes its mind mid-session when the reader turns the setting on", async () => {
    // `reduceMotionChanged` is the only way to hear about this without
    // remounting, and a preference honoured only at mount is one the reader has
    // to restart the app to apply.
    const listeners: Array<(enabled: boolean) => void> = [];
    jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(((
      event: string,
      handler: (enabled: boolean) => void,
    ) => {
      if (event === "reduceMotionChanged") listeners.push(handler);
      return { remove: () => {} };
    }) as never);

    await mount();
    expect(listeners).toHaveLength(1);
    act(() => listeners[0]?.(true));

    pressTurn();
    expectOnlyFace(BACK);
  });

  it("is not overruled by the mount-time read landing late", async () => {
    // TWO WRITERS, NO ORDERING between them. If the reader turns the setting on
    // while the mount-time read is still in flight, that read is about to
    // answer a question asked BEFORE they changed anything — and answering it
    // last would silently undo them. The failure is invisible in the usual
    // case only because the promise normally settles within a frame.
    let answerTheRead: (enabled: boolean) => void = () => {};
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockReturnValue(
      new Promise<boolean>((resolve) => {
        answerTheRead = resolve;
      }),
    );
    const listeners: Array<(enabled: boolean) => void> = [];
    jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(((
      event: string,
      handler: (enabled: boolean) => void,
    ) => {
      if (event === "reduceMotionChanged") listeners.push(handler);
      return { remove: () => {} };
    }) as never);

    render(<Host log={[]} />);
    await act(async () => {});
    expect(screen.getByText(FRONT)).toBeOnTheScreen();

    // The reader asks for less motion, and only then does the platform get
    // around to answering the older question with the older value.
    act(() => listeners[0]?.(true));
    await act(async () => {
      answerTheRead(false);
    });

    pressTurn();
    // Instant swap — the stale answer did not win.
    expectOnlyFace(BACK);
  });
});

describe("useDocumentTurn — the turn, for a reader who wants one", () => {
  it("keeps the old face painted until the sheet is edge-on", async () => {
    const { log } = await mount();

    pressTurn();

    // The press registered; the content has NOT changed. That gap is the whole
    // animation — the reader is looking at the front of the document while it
    // stands up, and the swap happens where they cannot see it.
    expectOnlyFace(FRONT);
    expect(log).toEqual(["credencial"]);

    expect(await findFace(BACK)).toBeOnTheScreen();
    expectOnlyFace(BACK);
    // One change, not a flicker through some third state.
    expect(log).toEqual(["credencial", "libreta"]);
  });

  it("turns back, and lands flat both times", async () => {
    await mount();

    pressTurn();
    await findFace(BACK);
    // This second press lands while phase 2 of the first turn is still running,
    // so it is the RECONCILE at the end of that turn that serves it — the path
    // a reader who taps twice actually takes.
    pressTurn();
    expect(await findFace(FRONT)).toBeOnTheScreen();
    expectOnlyFace(FRONT);
  });

  it("reconciles a second press instead of stacking a second turn", async () => {
    const timing = jest.spyOn(Animated, "timing");
    const { log } = await mount();

    // Two presses inside one turn: the reader asked for the back, then for the
    // front again before the sheet came down. The turn in flight delivers the
    // LAST request, so the face that was never asked for at the end is never
    // painted — the document does not turn twice to catch up.
    pressTurn();
    pressTurn();
    // Two turns' worth of room. This case is about something the driver must
    // NOT do, so the wait has to be long enough for it to have done it.
    await settle();
    await settle();

    expectOnlyFace(FRONT);

    // THE COUNT IS THE DISCRIMINATOR, AND `log` ALONE IS NOT — measured, not
    // assumed. A single `act` window COALESCES every paint inside it: a driver
    // that turned twice, painting `libreta` at ~205ms and `credencial` again at
    // ~690ms, commits one value to React and logs exactly what a correct
    // reconcile logs. With the swap made to paint the opposite of the painted
    // face rather than the latest request, this suite ran two full turns and
    // stayed green on `log` and on the final face alike. Rotations are counted
    // as they are ISSUED and cannot coalesce: one turn is two of them, and a
    // stacked second turn is four.
    expect(timing).toHaveBeenCalledTimes(PLANNED_ROTATIONS.length);
    expect(log).toEqual(["credencial"]);
  });
});

// The plan is data, and asserting on data proves only that the data is right.
// Everything below asserts what the DRIVER does with it — the wiring between
// `document-turn.ts` and the sheet on screen, which the geometry fences in
// document-turn.test.ts cannot see and which five separate one-line mutations
// to DocumentTurn.tsx used to survive untouched.

/** The transform React Native is actually handed. `Animated.View` resolves its
 *  animated style into the host view's props, so the rendered tree carries real
 *  numbers and a real `rotateY` string rather than animated nodes. */
function sheetTransform(angle: Animated.Value): unknown {
  const tree = render(
    <TurningSheet turn={{ paintedFace: "credencial", angle }}>
      <Text>{FRONT}</Text>
    </TurningSheet>,
  ).toJSON();
  const node = Array.isArray(tree) ? tree[0] : tree;
  return (node as unknown as { props: { style: { transform: unknown } } }).props.style.transform;
}

/** The `Animated.timing` configs of one whole turn, in the order issued. */
async function rotationConfigs(
  timing: ReturnType<typeof jest.spyOn>,
): Promise<Array<Record<string, unknown>>> {
  pressTurn();
  await findFace(BACK);
  await settle();
  return (timing.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>).map(
    ([, config]) => config,
  );
}

describe("useDocumentTurn — the driver runs the plan it was given", () => {
  it("rotates to the plan's own angles, for the plan's own durations", async () => {
    // Without this, `toValue: 180` is a green mutation — and 180° is the
    // credential seen from behind, mirrored, which is the exact thing the 87°
    // geometry exists to prevent. The plan can be perfect and the sheet still
    // turn to the wrong place.
    const timing = jest.spyOn(Animated, "timing");
    await mount();

    const configs = await rotationConfigs(timing);

    expect(configs).toHaveLength(PLANNED_ROTATIONS.length);
    configs.forEach((config, index) => {
      expect(config.toValue).toBe(PLANNED_ROTATIONS[index]?.toDeg);
      expect(config.duration).toBe(PLANNED_ROTATIONS[index]?.durationMs);
      // The reason this file exists rather than a Reanimated one: the whole
      // rotation belongs to the UI thread, because a libreta fetch is in
      // flight on the JS thread while it runs.
      expect(config.useNativeDriver).toBe(true);
    });
  });

  it("eases in on the way out and out on the way back, not the reverse", async () => {
    const timing = jest.spyOn(Animated, "timing");
    await mount();

    const configs = await rotationConfigs(timing);

    // Compared by BEHAVIOUR, not identity: `Easing.in(Easing.ease)` builds a
    // fresh closure per call, so there is no reference to match. An ease-in is
    // behind the clock at its midpoint and an ease-out ahead of it — measured
    // against this RN build, 0.315 and 0.685 — which separates the two
    // directions cleanly without pinning the exact curve.
    const midpoints = configs.map((config) => {
      const easing = config.easing;
      expect(typeof easing).toBe("function");
      return (easing as (value: number) => number)(0.5);
    });

    expect(midpoints[0]).toBeLessThan(0.5);
    expect(midpoints[1]).toBeGreaterThan(0.5);
  });

  it("jumps the sheet across to the other edge, and does not animate the crossing", async () => {
    // THE ONE MOVE A SPY ON `Animated.timing` CANNOT SEE. `jump` is a bare
    // `setValue`, so both cases above stayed green with the driver's
    // `angle.setValue(move.toDeg)` deleted outright, and green again with a
    // different number in it. What the jump buys is the RETURN EDGE: without
    // it the sheet comes back the way it went out, and the reader watches the
    // face they just left swing back at them before the new one arrives.
    //
    // `setValue` is the honest instrument here rather than an angle listener:
    // the rotations run on the native driver, so the only writes this value
    // sees from JS are the driver's own jumps — measured as exactly one per
    // turn on this RN build.
    const { angle } = await mount();
    const jumped = jest.spyOn(angle, "setValue");

    pressTurn();
    await findFace(BACK);
    await settle();

    // The plan's own number, so the driver and the plan cannot drift apart
    // silently — and the sign is the whole point: +87 would be the edge it is
    // already standing at.
    expect(jumped.mock.calls).toEqual(PLANNED_JUMPS.map((step) => [step.toDeg]));
  });
});

describe("TurningSheet — the sheet the reader actually looks at", () => {
  it("turns about its vertical axis, on the web's perspective", async () => {
    // A bare `<Animated.View>{children}</Animated.View>` renders every one of
    // this unit's behaviour tests green: the faces still swap, because the swap
    // is state, not transform. The turn is the part only this assertion sees.
    expect(sheetTransform(new Animated.Value(0))).toEqual([
      { perspective: TURN_PERSPECTIVE },
      { rotateY: "0deg" },
    ]);
  });

  it("clamps an angle the geometry never planned instead of rendering it", async () => {
    // The guarantee the driver's header claims, asserted rather than asserted
    // ABOUT. React Native's default extrapolation is `"extend"` on both ends
    // (AnimatedInterpolation.js:59 and :66), and this mapping is the identity,
    // so without `extrapolate: "clamp"` an angle of 180 renders as `180deg` —
    // a mirrored credential. Clamped, the worst case is a sheet stalled at the
    // edge: wrong, but never legible from behind.
    expect(sheetTransform(new Animated.Value(180))).toEqual([
      { perspective: TURN_PERSPECTIVE },
      { rotateY: `${TURN_EDGE_ON_DEG}deg` },
    ]);
    expect(sheetTransform(new Animated.Value(-180))).toEqual([
      { perspective: TURN_PERSPECTIVE },
      { rotateY: `-${TURN_EDGE_ON_DEG}deg` },
    ]);
  });
});

describe("useDocumentTurn — leaving the screen mid-turn", () => {
  it("drops the rest of the turn instead of running it on a sheet that is gone", async () => {
    const timing = jest.spyOn(Animated, "timing");
    await mount();

    pressTurn();
    // Phase 1 has been issued; phase 2 is behind a timer that has a state
    // update on the other end of it.
    expect(timing).toHaveBeenCalledTimes(1);

    screen.unmount();
    await settle();

    // Still one. The rest of the turn was never issued — the observable proof
    // that the cleanup runs, which a console-warning check cannot give: React
    // 19 no longer complains about updates to an unmounted tree.
    //
    // This is the OUTCOME (the turn stopped); the case below pins the
    // MECHANISM (the timer was disarmed, by handle). Both, because an outcome
    // assertion cannot say which of several things delivered it — the reason
    // the hook now carries exactly one cleanup rather than two overlapping
    // ones. See the cleanup effect's header.
    expect(timing).toHaveBeenCalledTimes(1);
  });

  it("cancels the turn's pending timer, by handle", async () => {
    // The discriminator the case above lacks: it names the one line that does
    // the work, so deleting the `clearTimeout` loop turns THIS red rather than
    // leaving a second guard to keep the outcome looking correct.
    //
    // Asserted by HANDLE rather than by a timer count: `Animated` arms timers
    // of its own (a bare `jest.getTimerCount()` reads 3 here, none of them
    // this hook's), so the only noise-proof question is whether the specific
    // handle this turn created was the one passed to `clearTimeout`.
    const setSpy = jest.spyOn(global, "setTimeout");
    const clearSpy = jest.spyOn(global, "clearTimeout");
    await mount();

    pressTurn();

    // The swap sits behind the one timer armed for exactly TURN_SWAP_AT_MS —
    // a delay nothing else in this tree uses.
    const armed = setSpy.mock.results
      .filter((_result, index) => setSpy.mock.calls[index]?.[1] === TURN_SWAP_AT_MS)
      .map((result) => result.value);
    expect(armed).toHaveLength(1);

    screen.unmount();

    expect(clearSpy).toHaveBeenCalledWith(armed[0]);
  });
});
