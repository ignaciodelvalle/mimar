// The PUSH SEAM — everything this app can write without the EAS build.
//
// WHY A SEAM AND NOT AN IMPORT
// ---------------------------------------------------------------------------
// Asking for notification permission and reading a push token needs
// `expo-notifications`, which is a NATIVE module. Under `runtimeVersion:
// { policy: "fingerprint" }` (app.config.ts) adding one changes the fingerprint,
// which means a new EAS build and a store release. That pipeline is PO-gated,
// and — unlike the image picker, which was written against a build that had not
// been cut yet — the build that is on Play TODAY was cut on 2026-09-11 WITHOUT
// this module. So every device in the closed test is running a binary where this
// port's default is the only answer, and that has to be the truthful one rather
// than a crash.
//
// The arrangement is the one `image-picker-port.ts` and `lib/observability/sink.ts`
// already use: an interface, a DEFAULT that says honestly that the module is not
// in this build, and one `setPushPort()` call at app start. The adapter is the
// ONLY file allowed to import `expo-notifications`, because that import evaluates
// a native module at import time and throws in a process that has none.
//
// WHAT AN ADAPTER MUST PROMISE
// ---------------------------------------------------------------------------
//   · `denied` is NOT an error. A person who declines the OS prompt has made a
//     choice, and the app must stop asking rather than retry. It is also not
//     recoverable in-app on either platform: iOS asks once, and Android 13+
//     stops showing the dialog after a refusal. Whatever calls this must not
//     offer "try again" for `denied`.
//   · A token is only meaningful ON A DEVICE. Simulators and emulators can
//     return one on Android and cannot on iOS, so an adapter must map "no token
//     available here" to `unavailable` rather than inventing a string.
//   · The default port answers `unavailable` and nothing else, and
//     `available: false` is what a caller reads BEFORE it offers anything.

/** What one permission request produced. */
export type PushPermissionResult =
  /** The OS will deliver notifications to this install. */
  | { outcome: "granted" }
  /** The person (or a policy) said no. Not an error, and not retryable. */
  | { outcome: "denied" }
  /** The module is not in this build. The honest default's only answer. */
  | { outcome: "unavailable" }
  | { outcome: "failed"; detail: string };

/** What one token read produced. */
export type PushTokenResult =
  | { outcome: "token"; expoPushToken: string }
  /** Permission is not granted, so there is no token to read. */
  | { outcome: "denied" }
  /**
   * No token is obtainable here: the module is absent, or this is a simulator,
   * or the project has no push credential configured. Distinguished from
   * `failed` because none of those is something to retry or report.
   */
  | { outcome: "unavailable" }
  | { outcome: "failed"; detail: string };

/**
 * One tap on a notification, reduced to the only thing this app does with it.
 *
 * `url` IS WHATEVER THE SERVER PUT IN `data.url` AND IS NOT TRUSTED HERE. It is
 * a string off a payload that travelled through Expo, APNs and FCM, so the port
 * carries it verbatim and `push-tap.ts` decides what — if anything — it names.
 * A port that resolved it to a route would be putting the routing table behind
 * the native seam, where no test without a device can reach it.
 *
 * `null` for a notification with no deep link: a tap still means "open the app",
 * which is a real outcome and not an absence.
 */
export type PushTap = { url: string | null };

export type PushPort = {
  /** Stable identifier, e.g. "module-missing" or "expo-notifications". */
  readonly name: string;
  /**
   * Whether push can possibly work in this build. A caller reads this to decide
   * whether to ASK AT ALL — showing somebody a permission prompt whose only
   * outcome is `unavailable` spends the one prompt iOS ever gives, on nothing.
   */
  readonly available: boolean;
  requestPermission(): Promise<PushPermissionResult>;
  getExpoPushToken(): Promise<PushTokenResult>;
  /**
   * The tap that STARTED this process, if one did. `null` otherwise.
   *
   * IT IS A SEPARATE CALL FROM `onTap` AND CANNOT BE FOLDED INTO IT. A person
   * tapping a notification for an app that is not running gets the response
   * delivered to a JS runtime that did not exist when it happened: by the time
   * any listener could be attached, the event is already in the past. The module
   * holds it and answers this instead. Without it the cold-start tap — the most
   * common one, because a phone that has been quiet is a phone whose app is not
   * running — opens the app on the home screen and loses the destination.
   */
  lastTap(): Promise<PushTap | null>;
  /**
   * Taps that happen while this process is alive — from the background, or from
   * the foreground banner. Returns the unsubscribe.
   */
  onTap(listener: (tap: PushTap) => void): () => void;
  /**
   * Whatever the OS needs told before a notification can be DRAWN the way this
   * app intends: on Android, the channel. A no-op everywhere else.
   *
   * SEPARATE FROM REGISTRATION, and on purpose. A channel is about how an
   * arriving notification is presented, which is a property of the INSTALL, not
   * of whoever is signed in — and it must exist before the first one arrives,
   * which can be before anybody has signed in at all.
   */
  ensureNotificationChannel(): Promise<void>;
};

/**
 * The default: this build carries no notifications module, and says so.
 *
 * NOT a no-op and NOT a promise. A default that returned a fake token would
 * register a row that can never receive anything, and the person would see push
 * as "on" in an app that cannot deliver. `available: false` is the truthful
 * answer to "can this build receive a push", and it stays the answer until an
 * EAS build with `expo-notifications` ships and `setPushPort()` runs at app
 * start. Today that is EVERY installed build.
 */
export const moduleMissingPush: PushPort = {
  name: "module-missing",
  available: false,
  requestPermission: async () => ({ outcome: "unavailable" }),
  getExpoPushToken: async () => ({ outcome: "unavailable" }),
  // No module means no notification ever arrived, so there is no tap to have
  // launched this process and none can arrive later. `null` and an unsubscribe
  // that does nothing are the truthful answers, not placeholders.
  lastTap: async () => null,
  onTap: () => () => undefined,
  ensureNotificationChannel: async () => undefined,
};

let activePort: PushPort = moduleMissingPush;

/**
 * Installs the process-wide port. Called once during app bootstrap
 * (`app/_layout.tsx`). Returns the port it replaced so a test can restore it.
 */
export function setPushPort(port: PushPort): PushPort {
  const previous = activePort;
  activePort = port;
  return previous;
}

/** The currently installed port. */
export function getPushPort(): PushPort {
  return activePort;
}

/**
 * One permission request, with the "never throws" half of the contract ACTUALLY
 * ENFORCED.
 *
 * WHY THIS EXISTS. `image-picker-port.ts` learned this the expensive way: the
 * port promised a member of its result union and no other outcome, that promise
 * was enforced nowhere, and one TypeError escaping an adapter turned it into a
 * rejected promise that stranded a screen on a spinner with no sentence and no
 * retry. The fix there closed one instance; this closes the CLASS for push,
 * before there is an adapter to get it wrong — including for a fake a test
 * installs.
 */
export async function requestPushPermissionSafely(): Promise<PushPermissionResult> {
  try {
    return await activePort.requestPermission();
  } catch (error) {
    return {
      outcome: "failed",
      // Diagnostic, never shown. The prefix names the port so a breadcrumb says
      // WHICH implementation broke its promise.
      detail: `${activePort.name} threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** One token read, with the same enforcement and for the same reason. */
export async function getExpoPushTokenSafely(): Promise<PushTokenResult> {
  try {
    return await activePort.getExpoPushToken();
  } catch (error) {
    return {
      outcome: "failed",
      detail: `${activePort.name} threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The launch tap, with the same "never throws" enforcement the two above get.
 *
 * A REJECTION HERE IS A COLD START THAT NEVER FINISHES ROUTING, which is worse
 * than a lost destination: the caller awaits this before it decides where to go.
 * `null` is the safe answer — the app opens where it would have opened anyway.
 */
export async function lastPushTapSafely(): Promise<PushTap | null> {
  try {
    return await activePort.lastTap();
  } catch {
    return null;
  }
}

/**
 * Subscribing, enforced the same way. A port that throws while being subscribed
 * to must not take the layout that subscribed with it, so this answers a no-op
 * unsubscribe and the app runs on without tap handling rather than not at all.
 */
export function onPushTapSafely(listener: (tap: PushTap) => void): () => void {
  try {
    return activePort.onTap(listener);
  } catch {
    return () => undefined;
  }
}

/**
 * The channel, enforced the same way — and this one is the likeliest to throw,
 * because it is the first call in the whole seam that touches the native module
 * on a build whose Android configuration is incomplete.
 */
export async function ensureNotificationChannelSafely(): Promise<void> {
  try {
    await activePort.ensureNotificationChannel();
  } catch {
    // Nothing to do and nobody to tell: a channel that could not be created
    // means Android draws the notification in its fallback channel, which is
    // duller than intended and still arrives.
  }
}

/** Restores the honest default. Primarily for tests. */
export function resetPushPort(): void {
  activePort = moduleMissingPush;
}
