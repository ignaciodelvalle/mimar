// The FIRST launch of a fresh install applies a pending OTA before the app is
// usable. Every other launch keeps `fallbackToCacheTimeout: 0`'s never-block
// behaviour untouched.
//
// THE INCIDENT (verified 2026-09-09). A pilot tester installed from Play and
// was shown "Falta completar tu registro — por ahora este paso se hace en la
// web", with a link to the browser and an instruction to sign in again there.
// That screen had been DELETED two days earlier (`4377664b0`), when step 2 of
// signup became native. She saw it because the Play build carries an EMBEDDED
// bundle from the day it was built, and `app.config.ts`'s own comment on
// `fallbackToCacheTimeout: 0` states the trade: "the update downloads in the
// background and applies on the NEXT launch. A hotfix therefore reaches a user
// on their second open after publication." So the first open of ANY fresh
// install runs whatever the binary shipped with, however many OTAs have gone
// out since. The identity route's header records what that costs when the
// stale screen is a sign-in instruction: 8 invalid-credential attempts and 2
// duplicate signups in one hour of GoTrue log, from testers reading a second
// browser login as "confirm your email".
//
// WHY `isEmbeddedLaunch` ALONE IS NOT THE CONDITION. It is true while the
// running bundle is the one baked into the binary — and it STAYS true, on every
// launch, for an install that never receives an update. Gating on it alone
// would tax every cold start of such a device with a network wait, which is
// exactly what `fallbackToCacheTimeout: 0` exists to avoid. The condition is
// therefore "embedded launch AND this install has not run the gate before",
// with a one-time marker persisted whether the attempt succeeded or failed —
// so a dead network on the first open cannot make every later open slow.
//
// WHERE THE MARKER LIVES. AsyncStorage, bound in `launch-gate-marker-store.ts`
// (the native import is isolated there for the reason `expo-updates-port.ts`
// gives), for the reason `credential-cache.ts` gives for the credential: it is
// not a secret, and SecureStore is the Keystore — reserved for the tokens,
// chunked through a 2048-byte limit. A flag that says "this build has already
// asked once" has nothing to protect. The key carries the EMBEDDED update id,
// so a new binary from Play (whose embedded bundle is just as old as its build)
// gets a first-launch check of its own instead of inheriting the marker the
// previous binary wrote.
//
// THE HONEST LIMITATION, and the next reader must not have to rediscover it:
// this gate lives in the JS bundle. It takes effect from the NEXT production
// build onward — the one whose embedded bundle contains this file — and it
// cannot rescue installs that already exist, nor a fresh install of the current
// Play build, whose embedded bundle predates it. Those still get the OTA on
// their second open, exactly as before.
//
// A PORT AND A PURE DECISION, for the reason `update-check.ts` gives: the
// module is native, its check throws under Jest, and a decision written inline
// in a root-layout effect is a decision nobody can test. The outcomes below are
// all reachable with a fake port and a fake marker store.

import { useEffect, useRef, useState } from "react";

import { setUpdateStaged } from "./foreground-update";
import { type UpdatesPort, checkForUpdate, downloadUpdate } from "./update-check";

/**
 * How long the whole check → fetch → reload sequence may hold the first launch.
 *
 * 7 s. The manifest check is one small request (under a second on any
 * connection that works at all) and a bundle for this app is a few megabytes,
 * which the 4G-in-a-veterinary-waiting-room network `app.config.ts` describes
 * moves in two to five seconds. Seven covers a 3G-grade fetch and still lands
 * under the ten or so seconds after which a person decides an app is broken
 * and force-quits it — which would be a worse first impression than the stale
 * bundle. Past the deadline the app opens on what it has, and the fetch that
 * was in flight keeps going natively: if it lands, it is staged for the next
 * launch, the ordinary path.
 */
export const LAUNCH_GATE_TIMEOUT_MS = 7_000;

const MARKER_KEY_PREFIX = "mimar.launch-gate.v1.";

/** The sentence under the spinner while the gate holds the launch. */
export const LAUNCH_GATE_UPDATING_MESSAGE = "Actualizando la app…";

/**
 * The one-time marker, as a port. `has` answers whether THIS embedded build has
 * run the gate; `write` records that it has. Both are best-effort: a store that
 * cannot be read is treated as "never ran" (one slow launch), and one that
 * cannot be written is swallowed (see `runLaunchUpdateGate`). The real binding
 * is `launch-gate-marker-store.ts`; this module stays native-free.
 */
export type LaunchGateMarkerStore = {
  has(key: string): Promise<boolean>;
  write(key: string): Promise<void>;
};

/**
 * The marker key for the running embedded bundle.
 *
 * `updateId` is `null` where updates are disabled — a dev client — and the
 * gate never reaches this function there (`isEnabled` is checked first), but
 * a key is answered anyway rather than throwing on a state the port allows.
 */
export function launchGateMarkerKey(updateId: string | null): string {
  return `${MARKER_KEY_PREFIX}${updateId ?? "unknown"}`;
}

/**
 * Whether the gate should run on this launch. The decision, without a device.
 *
 * `isEnabled` first: `checkForUpdateAsync` REJECTS in a dev client rather than
 * answering "no", and a first launch that waited seven seconds on that
 * rejection would be the exact tax this file exists not to pay.
 */
export function shouldRunLaunchGate(args: {
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  hasRunBefore: boolean;
}): boolean {
  if (!args.isEnabled) return false;
  if (!args.isEmbeddedLaunch) return false;
  return !args.hasRunBefore;
}

export type LaunchGateOutcome =
  /** The gate did not run: not embedded, already ran, or updates disabled. */
  | { outcome: "skipped" }
  /** A bundle was fetched and `reloadAsync` was called. */
  | { outcome: "reloading" }
  /** The app should open on the bundle it has, and why. */
  | {
      outcome: "proceed";
      reason: "up-to-date" | "nothing-staged" | "timeout" | "failed" | "reload-failed";
    };

const TIMED_OUT = Symbol("launch-gate-timeout");

/**
 * Race a promise against what is left of the deadline. The underlying promise
 * is NOT cancelled — a native fetch keeps running — which is why the fetch arm
 * below attaches its own continuation for the late case.
 */
function withDeadline<T>(promise: Promise<T>, deadlineAt: number, now: () => number) {
  const remaining = Math.max(0, deadlineAt - now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Run the sequence: check → fetch → reload, bounded as a whole.
 *
 * NEVER THROWS, and never leaves a person on a spinner: every arm resolves to
 * an outcome the caller can render its way out of, and `reloadAsync` — the one
 * call whose success is invisible because it replaces the JS context — is the
 * last thing that happens.
 *
 * THE MARKER IS WRITTEN FIRST, before the network is touched, and regardless
 * of how the attempt ends. A gate that wrote it only on success would re-run on
 * every launch of a phone that installed the app in a dead spot, and a gate
 * that wrote it after the sequence would miss the reload arm entirely (the
 * context is gone before the write could run).
 *
 * `report: false` on both calls, for the reason `foreground-update.ts` gives
 * (finding F3): nobody tapped anything, and a first launch on a bad connection
 * is not evidence that the update URL is broken. The next tap on "Buscar
 * actualización" reports it anyway.
 */
export async function runLaunchUpdateGate(
  port: UpdatesPort,
  store: LaunchGateMarkerStore,
  options: {
    timeoutMs?: number;
    now?: () => number;
    /** Called once the gate has decided to run, before the network is touched. */
    onStart?: () => void;
  } = {},
): Promise<LaunchGateOutcome> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? LAUNCH_GATE_TIMEOUT_MS;
  const key = launchGateMarkerKey(port.updateId);

  let hasRunBefore = false;
  try {
    hasRunBefore = await store.has(key);
  } catch {
    // Unreadable store: treat as never ran. One slow launch, not a crash.
  }
  if (
    !shouldRunLaunchGate({
      isEnabled: port.isEnabled,
      isEmbeddedLaunch: port.isEmbeddedLaunch,
      hasRunBefore,
    })
  ) {
    return { outcome: "skipped" };
  }

  try {
    await store.write(key);
  } catch {
    // A marker that cannot be written costs one more gated launch next time.
    // Nothing to tell a person about that, and nothing to stop for.
  }
  options.onStart?.();

  const deadlineAt = now() + timeoutMs;
  try {
    const checked = await withDeadline(checkForUpdate(port, { report: false }), deadlineAt, now);
    if (checked === TIMED_OUT) return { outcome: "proceed", reason: "timeout" };
    if (checked.phase === "failed") return { outcome: "proceed", reason: "failed" };
    if (checked.phase !== "downloading") return { outcome: "proceed", reason: "up-to-date" };

    const download = downloadUpdate(port, { report: false });
    // THE LATE CASE. If the deadline wins the race the fetch does not stop;
    // when it lands, the bundle IS on the device and `AboutSection` should
    // say "Reiniciar ahora" rather than offer to look for it. Attached before
    // the race so it fires whichever way the race goes; harmless when the
    // reload below wins, because the context is gone.
    void download.then((result) => {
      if (result.phase === "ready") setUpdateStaged(true);
    });
    const downloaded = await withDeadline(download, deadlineAt, now);
    if (downloaded === TIMED_OUT) return { outcome: "proceed", reason: "timeout" };
    // `downloadUpdate` already folds finding H2: a fetch that resolved having
    // staged nothing (`isNew: false` and not a roll-back) answers `failed`,
    // and a reload over nothing would be a restart that changes nothing.
    if (downloaded.phase !== "ready") return { outcome: "proceed", reason: "nothing-staged" };

    // Not bounded by the deadline: a reload is local, and racing a timer
    // against a call that is already replacing the JS context is how a phone
    // ends up rendering the old app for one frame over the new one.
    try {
      await port.reloadAsync();
      return { outcome: "reloading" };
    } catch {
      // Staged and not applied. The flag above is already true, so the card
      // offers the restart; the next launch applies it anyway.
      return { outcome: "proceed", reason: "reload-failed" };
    }
  } catch {
    return { outcome: "proceed", reason: "failed" };
  }
}

export type LaunchGatePhase =
  /** Reading the marker. A local read, milliseconds; the spinner covers it. */
  | "deciding"
  /** The network sequence is running and the launch is held. */
  | "updating"
  /** The app may render. Also the phase while `reloadAsync` replaces the context. */
  | "done";

/**
 * Hold the first launch of a fresh install while a pending OTA is applied.
 *
 * Mounted once, at the root layout, BEFORE `useForegroundUpdateCheck`, which
 * takes `suspended: phase !== "done"` so a person who backgrounds the app
 * during the gate and comes back cannot start a second fetch into the same
 * staging directory the gate is writing.
 *
 * The synchronous first answer matters: a port that is not enabled or not
 * embedded answers `done` on the FIRST render, so a launch this gate does not
 * apply to never sees the deciding frame at all.
 */
export function useLaunchUpdateGate(
  port: UpdatesPort,
  store: LaunchGateMarkerStore,
): LaunchGatePhase {
  const [phase, setPhase] = useState<LaunchGatePhase>(() =>
    shouldRunLaunchGate({
      isEnabled: port.isEnabled,
      isEmbeddedLaunch: port.isEmbeddedLaunch,
      hasRunBefore: false,
    })
      ? "deciding"
      : "done",
  );
  const started = useRef(false);

  // NO `mounted` FLAG AND NO `phase` IN THE DEPS, and both are deliberate. A
  // first draft keyed this effect on `phase`; the `deciding → updating`
  // transition then ran the previous effect's cleanup, which cleared the
  // mounted flag, and the closing `setPhase("done")` never fired — a spinner
  // nobody could leave, on the first launch, which is the one outcome this
  // file forbids. The `started` ref is what keeps StrictMode's mount →
  // unmount → mount from running the sequence twice; a `setState` after
  // unmount is a no-op in React 19, so nothing else is needed.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (
      !shouldRunLaunchGate({
        isEnabled: port.isEnabled,
        isEmbeddedLaunch: port.isEmbeddedLaunch,
        hasRunBefore: false,
      })
    ) {
      return;
    }
    void (async () => {
      // The pure function is the whole rule; the hook adds only the render
      // phases around it. `onStart` is the moment the marker read came back
      // "never ran" — before that the spinner is covering a local read.
      await runLaunchUpdateGate(port, store, { onStart: () => setPhase("updating") });
      // EVERY outcome lands on `done`, `reloading` included: if the context
      // survives long enough to render after `reloadAsync`, the reload did
      // not happen, and a spinner nobody can leave is what this guards.
      setPhase("done");
    })();
  }, [port, store]);

  return phase;
}
