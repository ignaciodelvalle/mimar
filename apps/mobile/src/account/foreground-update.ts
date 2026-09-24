// The half of OTA distribution that a RESIDENT app never reaches
// (A6-cuenta-resiliencia-08).
//
// WHAT WAS MISSING. `app.config.ts` leaves `updates.checkAutomatically` at its
// default (`ON_LOAD`) with `fallbackToCacheTimeout: 0`, so expo-updates looks
// for a bundle exactly once — while the app is starting — and applies what it
// found on the launch AFTER that. Every word of that sentence assumes the app
// gets launched. A phone that keeps miMAR resident for days never runs the
// check at all: the PO publishes a hotfix, tells fourteen testers "ya está",
// and half of them see the same bug all day while support reads "integrada" in
// Acerca de and has nothing to tell them.
//
// `AboutSection`'s "Buscar actualización" button (shipped 2026-09-07) is the
// MANUAL half and it is not a distribution mechanism: it requires knowing the
// button exists, and it is three taps down a settings screen. This is the half
// that runs on its own.
//
// IT STAGES AND SAYS NOTHING. Nothing here calls `reloadAsync`: replacing the
// running JS context under somebody's thumb — mid-form, mid-search for a lost
// animal — is a worse failure than the one this fixes, and the OTA policy's
// "subtractive only" rule is about not surprising people. What it buys is that
// the bundle is DOWNLOADED before the next launch, so the update applies on the
// first restart instead of the second. `AboutSection` reads the staged flag
// (`isUpdatePending`) and is where a person can restart deliberately.
//
// A PORT AND A PURE PREDICATE, for the reason `update-check.ts` gives: the
// module is native, its check throws under Jest, and a decision written inline
// in an effect is a decision nobody can test.

import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { type UpdatesPort, checkForUpdate, downloadUpdate } from "./update-check";

/**
 * How long to wait between two foreground checks.
 *
 * Somebody switching to WhatsApp to answer a message and back produces an
 * `active` transition every few seconds, and each one would be a request to the
 * update server on a phone plan somebody pays for. Five minutes is far shorter
 * than the interval this exists to fix (a hotfix published mid-morning reaching
 * a resident app the same morning) and long enough that app-switching costs
 * nothing.
 */
export const FOREGROUND_CHECK_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Whether a foreground check has STAGED a bundle in this session.
 *
 * MODULE STATE AND NOT `Updates.isUpdatePending`, because that flag is not on
 * the module: expo-updates 57 exposes `isUpdatePending` only through the
 * `useUpdates()` hook's state and its own native interface, never as
 * `Updates.isUpdatePending` (verified against
 * `expo-updates/build/Updates.d.ts`, whose module-level constants are
 * isEnabled/updateId/channel/runtimeVersion/…). Inventing a port member for a
 * capability the module does not have would be a port that describes something
 * else.
 *
 * What this flag actually answers is narrower AND is the thing `AboutSection`
 * needs: "did THIS app download something while it was running". A bundle
 * staged by the launch-time check belongs to the launch that is already
 * running, and the card is already honest about that one — it says "integrada"
 * or names the running update id.
 */
let stagedThisSession = false;

/**
 * Who wants to know when it flips (finding F8, review 2026-09-07).
 *
 * `AboutSection` read `isUpdateStaged()` ONCE, in a `useState` initializer, so
 * a bundle staged while somebody had Ajustes open never reached the card: it
 * went on offering "Buscar actualización", and pressing it answered "Ya tenés la
 * última versión" — the exact sentence this whole feature exists to eliminate,
 * produced by the feature itself. A module-level flag that nobody can subscribe
 * to is a flag that is only ever right at mount.
 */
const stagedListeners = new Set<() => void>();

export function isUpdateStaged(): boolean {
  return stagedThisSession;
}

/** Set by the hook when a download lands. Exported so a test can arrange it. */
export function setUpdateStaged(value: boolean): void {
  if (stagedThisSession === value) return;
  stagedThisSession = value;
  // A COPY, because a listener that unsubscribes while this runs would
  // otherwise mutate the set underneath the loop.
  for (const listener of [...stagedListeners]) listener();
}

/**
 * Watch the flag. Returns the unsubscribe; shaped for `useSyncExternalStore`,
 * which is why the identity of this function must stay stable.
 */
export function subscribeUpdateStaged(listener: () => void): () => void {
  stagedListeners.add(listener);
  return () => {
    stagedListeners.delete(listener);
  };
}

/**
 * Whether a state transition should trigger a check.
 *
 * ONLY ON THE EDGE INTO `active`. React Native emits `inactive` on iOS for
 * transient interruptions (the control centre, an incoming call banner), and a
 * rule that fired on "is active now" would run on the way back from each of
 * them; `previous` is what makes this an edge and not a level.
 *
 * `previous === null` means nothing has been observed yet, and it deliberately
 * does NOT check: that is the launch, which `checkAutomatically: ON_LOAD`
 * already covers, and duplicating it would send two requests on every cold
 * start. The hook seeds `previous` from `AppState.currentState` at mount, so
 * this arm is the one that answers when the platform has no current state to
 * give — not a case the hook normally reaches, and the safe answer either way.
 */
export function shouldCheckOnForeground(args: {
  previous: AppStateStatus | null;
  next: AppStateStatus;
  isEnabled: boolean;
  /** `Date.now()` of the last check this session, or `null` if there was none. */
  lastCheckedAt: number | null;
  now: number;
}): boolean {
  if (!args.isEnabled) return false;
  if (args.next !== "active") return false;
  if (args.previous === null || args.previous === "active") return false;
  if (args.lastCheckedAt === null) return true;
  return args.now - args.lastCheckedAt >= FOREGROUND_CHECK_MIN_INTERVAL_MS;
}

/**
 * Fetch a new bundle when the app comes back to the foreground.
 *
 * Mounted once, at the root layout. The result is deliberately dropped:
 * `checkForUpdate` and `downloadUpdate` never throw, they answer a state, and
 * there is no screen here to render it on — the point of this hook is that the
 * bytes are on the device, not that anybody is told.
 *
 * AND SO IS THE REPORT, which the first version of this hook was not (finding
 * F3). "Dropped" has to include the SIDE EFFECT, not just the return value: both
 * functions report every failure arm to Sentry by default because both were
 * written for a button somebody presses. `{ report: false }` is what makes this
 * call site silent in the way its own docblock already claimed to be.
 */
export function useForegroundUpdateCheck(
  port: UpdatesPort,
  options: {
    /**
     * True while `useLaunchUpdateGate` holds the launch. The gate is a
     * check → fetch → reload of its own; somebody who backgrounds the app
     * during those seconds and comes back would otherwise start a SECOND
     * fetch into the same staging directory. `running` cannot see the gate's
     * fetch — it lives in a different hook — so the layout says so here.
     * Read through a ref so the platform listener sees the current value
     * without being re-registered on every render.
     */
    suspended?: boolean;
  } = {},
): void {
  const previous = useRef<AppStateStatus | null>(null);
  const lastCheckedAt = useRef<number | null>(null);
  const running = useRef(false);
  const suspended = useRef(options.suspended === true);
  suspended.current = options.suspended === true;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const decision = shouldCheckOnForeground({
        previous: previous.current,
        next,
        isEnabled: port.isEnabled,
        lastCheckedAt: lastCheckedAt.current,
        now: Date.now(),
      });
      previous.current = next;
      // `running` is not the throttle — it is the overlap guard. A check that is
      // slow on a bad connection must not have a second one started on top of
      // it, because `fetchUpdateAsync` writes into the same staging directory.
      // `suspended` is the same guard for a fetch this hook cannot see: the
      // launch gate's. A suspended edge is DROPPED, not deferred — the launch
      // gate's own check is fresher than anything this one would find.
      if (!decision || running.current || suspended.current) return;
      running.current = true;
      lastCheckedAt.current = Date.now();
      void (async () => {
        try {
          // `report: false` — SEE `UpdateCallOptions` (finding F3). The result
          // is dropped here, but the Sentry event those two functions write was
          // NOT, and they were written for a deliberate tap: unattended, on
          // every foreground edge, a dead spot on the way to the office becomes
          // up to twelve `update-check-failed` events an hour per device. That
          // is the tag OBS-2 exists to make legible, drowned in the ordinary
          // connectivity of the country the app runs in.
          const checked = await checkForUpdate(port, { report: false });
          if (checked.phase !== "downloading") return;
          const downloaded = await downloadUpdate(port, { report: false });
          // The ONE thing this hook tells anybody. `AboutSection` reads it at
          // mount so the card opens on "Reiniciar ahora" rather than offering to
          // look for a bundle already sitting on the device.
          if (downloaded.phase === "ready") setUpdateStaged(true);
        } finally {
          running.current = false;
        }
      })();
    });
    // The FIRST state is seeded here rather than left null forever: without it
    // the transition out of the launch state would look like the first call and
    // be skipped a second time.
    previous.current = AppState.currentState;
    return () => subscription.remove();
  }, [port]);
}
