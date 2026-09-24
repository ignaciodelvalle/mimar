// The sheet that turns — the driver for the choreography in `document-turn.ts`,
// and the one place in this app that animates anything.
//
// CORE `Animated`, NEVER REANIMATED. Not a style preference: this repo lost a
// production build to the worklets runtime (see src/release/release-config.test.ts),
// and the two files this sheet holds together say so in their headers. Core
// `Animated` with `useNativeDriver: true` sends the whole rotation to the UI
// thread, which is what this screen needs anyway — it animates while a fetch
// for the other face is in flight on the JS thread.
//
// THE PREFERENCE IS READ AT TURN TIME, NOT DURING RENDER. React Native answers
// `AccessibilityInfo.isReduceMotionEnabled()` with a PROMISE (verified against
// react-native 0.86.3's AccessibilityInfo — it is not a synchronous getter, and
// there is no RN equivalent of `matchMedia(...).matches`), so the value has to
// be carried in a ref that the turn consults, not in state the render depends
// on. `reduceMotionChanged` keeps it current: a reader who turns the setting on
// in the middle of a session gets the instant swap on their very next turn,
// without remounting this screen.
//
// UNTIL THE ANSWER ARRIVES, ASSUME REDUCED. The promise settles within a frame
// or two of mount, far sooner than anyone can reach the turn button — but the
// window is not zero, and the two ways to be wrong in it are not symmetric.
// Guessing "no preference" spends an unwanted animation on the one reader who
// asked not to have one; guessing "reduced" spends an instant swap on everyone
// else, which is the mechanic this document shipped with and no defect at all.
//
// WHAT THIS DOES NOT DO: move focus. The web's FlipCard has an `onFaceShown`
// callback because its inactive face is `display:none` and `.focus()` on such
// an element is a silent no-op — a DOM problem this app does not have, since
// the inactive face is not mounted. Native focus handling on the turn is
// unchanged from the instant-swap version, and deliberately out of this unit.

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";

import type { DocumentFace } from "./DocumentChromeNative";
import { TURN_EDGE_ON_DEG, TURN_PERSPECTIVE, turnPlan } from "./document-turn";

export type DocumentTurnState = {
  /**
   * The face actually on the sheet. It LAGS the requested face across a turn —
   * it changes at the edge-on midpoint, which is the whole point: the reader
   * never sees the content change, only a sheet that turns over and is now
   * showing its other side.
   */
  readonly paintedFace: DocumentFace;
  /** The sheet's angle in degrees. Owned here; read by `TurningSheet`. */
  readonly angle: Animated.Value;
};

/**
 * Turns the document over when `activeFace` changes.
 *
 * The caller keeps owning the REQUESTED face (it is the thing a button press
 * changes, and the thing the turn button's toggle state reports immediately);
 * this hook owns the painted one and the motion in between.
 */
export function useDocumentTurn(activeFace: DocumentFace): DocumentTurnState {
  const [paintedFace, setPaintedFace] = useState<DocumentFace>(activeFace);
  const paintedRef = useRef<DocumentFace>(activeFace);
  const activeRef = useRef<DocumentFace>(activeFace);
  const turningRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // See the header: reduced until React Native says otherwise.
  const reducedMotionRef = useRef(true);
  const angle = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let listening = true;
    // TWO WRITERS, AND THEY ARE NOT EQUALLY FRESH. The mount-time promise and
    // the change event both answer the same question, and nothing orders them:
    // a reader who flips the setting while the promise is still in flight can
    // have their change overwritten by the answer to a question asked before
    // they made it. The event is by definition the later news, so once it has
    // spoken the promise is stale and may not land.
    let answeredByEvent = false;

    // Subscribed BEFORE the read, so a change arriving in that window is heard
    // rather than dropped.
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      if (!listening) return;
      answeredByEvent = true;
      reducedMotionRef.current = enabled;
    });

    AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (listening && !answeredByEvent) reducedMotionRef.current = enabled;
      },
      () => {
        // A platform that cannot answer leaves the ref at its "reduced"
        // default — the safe side, per the header. Handled rather than left to
        // surface as an unhandled rejection.
      },
    );

    return () => {
      listening = false;
      subscription.remove();
    };
  }, []);

  const paint = useCallback((face: DocumentFace) => {
    paintedRef.current = face;
    setPaintedFace(face);
  }, []);

  const runTurn = useCallback(() => {
    // Re-entrancy guard: a second press while the sheet is in flight is not
    // dropped, it is RECONCILED at the end of the current turn.
    if (turningRef.current) return;
    if (activeRef.current === paintedRef.current) return;

    turningRef.current = true;
    const plan = turnPlan(reducedMotionRef.current);

    const step = (index: number): void => {
      const move = plan[index];
      if (move === undefined) {
        turningRef.current = false;
        // The reader may have asked for the other face again while this turn
        // was running; that request is still owed a turn of its own.
        runTurn();
        return;
      }
      switch (move.kind) {
        case "rotate":
          Animated.timing(angle, {
            toValue: move.toDeg,
            duration: move.durationMs,
            easing: move.easing === "in" ? Easing.in(Easing.ease) : Easing.out(Easing.ease),
            useNativeDriver: true,
          }).start();
          step(index + 1);
          return;
        case "jump":
          angle.setValue(move.toDeg);
          step(index + 1);
          return;
        case "swap":
          // The LATEST request, not the one that opened this turn — if the
          // reader pressed twice, the face that lands is the one they asked
          // for last, and the turn in flight is the one that delivers it.
          paint(activeRef.current);
          step(index + 1);
          return;
        case "wait": {
          // The list exists ONLY so unmount can cancel what is still pending,
          // so a spent handle drops out of it. Pushing without pruning leaked
          // two dead handles per turn for the life of the screen — unbounded in
          // the one input the reader controls, which is how often they turn the
          // document over.
          const timers = timersRef.current;
          const handle = setTimeout(() => {
            const at = timers.indexOf(handle);
            if (at !== -1) timers.splice(at, 1);
            step(index + 1);
          }, move.ms);
          timers.push(handle);
          return;
        }
      }
    };

    step(0);
  }, [angle, paint]);

  // Sync the ref HERE rather than during render, so the swap and the reconcile
  // both read the latest request no matter when they run.
  useEffect(() => {
    activeRef.current = activeFace;
    runTurn();
  }, [activeFace, runTurn]);

  // Unmount only — clearing on an `activeFace` change would cancel a turn
  // mid-flight and strand the sheet edge-on.
  //
  // CANCELLING THE TIMERS IS THE WHOLE CLEANUP, and there is deliberately no
  // `isMounted` flag beside it. There was one; a mutation run proved no test
  // could observe its removal, and the reason is structural rather than a gap
  // in the tests: after unmount the ONLY way back into `step` is a timer
  // callback, and this loop has just disarmed every one of them. The
  // synchronous entry (`step(0)`) and the reconcile both descend from a live
  // render. A guard that cannot be reached is not defence in depth, it is a
  // second thing to keep true — and it reads as a protection the code does not
  // actually depend on.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    };
  }, []);

  return { paintedFace, angle };
}

/**
 * The rotating sheet — the native `.ln-doc-stage` + `.ln-doc-turn`.
 *
 * The perspective lives in the same transform array as the rotation because
 * that is where React Native reads it; without it the turn reads as a
 * horizontal squash rather than a sheet standing up in space.
 */
export function TurningSheet({
  turn,
  children,
}: {
  turn: DocumentTurnState;
  children: ReactNode;
}) {
  const style = useMemo(
    () => ({
      transform: [
        { perspective: TURN_PERSPECTIVE },
        {
          // The interpolation range is derived from the same constant the plan
          // rotates to, and `extrapolate: "clamp"` is what makes that a
          // GUARANTEE rather than a coincidence of the two agreeing today.
          //
          // Without it this mapping is the identity over [-87, 87] and React
          // Native's default extrapolation on both ends is `"extend"`
          // (AnimatedInterpolation.js:59 and :66 in the installed 0.86.3), so a
          // driver bug that sent the angle to 180 would render `180deg` — the
          // credential seen from behind, mirrored, which is the one thing the
          // 87° geometry exists to prevent. Clamping makes the sheet's WORST
          // case a stall at the edge instead of a mirrored face: the fence now
          // holds at the last line that can still enforce it, rather than
          // trusting every future caller of `angle`.
          rotateY: turn.angle.interpolate({
            inputRange: [-TURN_EDGE_ON_DEG, TURN_EDGE_ON_DEG],
            outputRange: [`-${TURN_EDGE_ON_DEG}deg`, `${TURN_EDGE_ON_DEG}deg`],
            extrapolate: "clamp",
          }),
        },
      ],
    }),
    [turn.angle],
  );

  return <Animated.View style={style}>{children}</Animated.View>;
}
